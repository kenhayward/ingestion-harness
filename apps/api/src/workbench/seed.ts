import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { stableJson } from '@ih/shared';

/**
 * Seeds `count` Workbench projects straight into Postgres, for the project list's load test and
 * for trying the list UI at scale (`npm run seed:workbench -w @ih/api -- 1000`). Ids are
 * `${prefix}-0001` …; the variety is deterministic by index:
 * - every project has a template; every 3rd has a published v1, and of those every 2nd (every
 *   6th project) has no open draft (published), the rest an open draft (v1 or v2);
 * - 1–8 samples, each a `documents` row with a succeeded `prepare` job (a third of the samples
 *   of projects with 3 or more are holdout); every 23rd project has one sample still preparing
 *   (`running`) and every 37th one whose preparation failed;
 * - a brief on every 2nd project;
 * - 0–4 of the first stages done, alternately an accepted proposal and a skip; every 5th
 *   unfinished project has an undecided proposal for the next stage, every 11th one running;
 * - every 4th project with holdout samples and an open draft has a holdout iteration of that
 *   draft with a finished `process` job per holdout sample; every 8th also has a matching
 *   `gate_cache` with a score of 0.75–0.99 (so some pass the gate);
 * - every 4th project allows external models, every 7th has a 0.8 publish threshold.
 * Nothing is written to the object store (no prepared text, triage or proposal bodies): the
 * API reads those as missing. Writes everything in one transaction.
 */
export async function seedWorkbenchProjects(
  pool: pg.Pool,
  count: number,
  prefix = 'seed',
): Promise<string[]> {
  const rows = build(count, prefix);
  const client = await pool.connect();
  let failed: unknown = undefined;
  try {
    await client.query('BEGIN');
    await insert(client, 'workbench_projects', rows.projects, {
      id: 'text',
      name: 'text',
      created_at: 'timestamptz',
      data_policy: 'text',
      publish_threshold: 'numeric',
    });
    await insert(client, 'templates', rows.templates, {
      id: 'text',
      version: 'int',
      status: 'text',
      definition: 'jsonb',
      created_at: 'timestamptz',
      updated_at: 'timestamptz',
      published_at: 'timestamptz',
    });
    await insert(client, 'documents', rows.documents, {
      id: 'uuid',
      filename: 'text',
      sha256: 'text',
      size_bytes: 'bigint',
      spec_id: 'text',
      spec_version: 'int',
      bucket: 'text',
      object_key: 'text',
      created_at: 'timestamptz',
    });
    await insert(client, 'jobs', rows.jobs, {
      id: 'uuid',
      document_id: 'uuid',
      project_id: 'text',
      status: 'job_status',
      task: 'text',
      test: 'boolean',
      priority: 'smallint',
      params: 'jsonb',
      error: 'text',
      created_at: 'timestamptz',
      updated_at: 'timestamptz',
    });
    await insert(client, 'workbench_samples', rows.samples, {
      project_id: 'text',
      document_id: 'uuid',
      role: 'text',
      added_for_version: 'int',
      created_at: 'timestamptz',
    });
    await insert(client, 'workbench_briefs', rows.briefs, {
      project_id: 'text',
      version: 'int',
      body: 'jsonb',
      created_at: 'timestamptz',
    });
    await insert(client, 'workbench_proposals', rows.proposals, {
      id: 'uuid',
      project_id: 'text',
      stage: 'text',
      brief_version: 'int',
      decision: 'text',
      decided_at: 'timestamptz',
      created_at: 'timestamptz',
    });
    await insert(client, 'workbench_stage_skips', rows.skips, {
      project_id: 'text',
      stage: 'text',
      skipped_at: 'timestamptz',
    });
    await insert(client, 'workbench_iterations', rows.iterations, {
      project_id: 'text',
      template_version: 'int',
      definition: 'jsonb',
      eval_set: 'text',
      job_ids: 'uuid[]',
      sample_shas: 'text[]',
      scores: 'jsonb',
      gate_cache: 'jsonb',
      created_at: 'timestamptz',
    });
    await client.query('COMMIT');
  } catch (err) {
    failed = err;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release(failed instanceof Error ? failed : undefined);
  }
  return rows.projects.map((p) => p.id as string);
}

type Row = Record<string, unknown>;

/**
 * Inserts rows with one `unnest` per column (one round trip per 2,000 rows). Array columns
 * travel as JSON text and are unpacked per row, since `unnest` would flatten them.
 */
async function insert(
  client: pg.PoolClient,
  table: string,
  rows: Row[],
  columns: Record<string, string>,
): Promise<void> {
  const names = Object.keys(columns);
  for (let at = 0; at < rows.length; at += 2000) {
    const chunk = rows.slice(at, at + 2000);
    const select = names.map((name, n) => {
      const type = columns[name]!;
      if (type.endsWith('[]')) {
        const element = type.slice(0, -2);
        return `ARRAY(SELECT jsonb_array_elements_text(c${n}::jsonb)::${element})`;
      }
      return `c${n}::${type}`;
    });
    const values = names.map((name) =>
      chunk.map((row) => {
        const value = row[name] ?? null;
        if (value === null) return null;
        const type = columns[name]!;
        return type === 'jsonb' || type.endsWith('[]') ? JSON.stringify(value) : String(value);
      }),
    );
    await client.query(
      `INSERT INTO ${table} (${names.join(', ')})
       SELECT ${select.join(', ')}
         FROM unnest(${names.map((_, n) => `$${n + 1}::text[]`).join(', ')})
           AS t(${names.map((_, n) => `c${n}`).join(', ')})`,
      values,
    );
  }
}

const KINDS = [
  'Invoice',
  'Certificate of analysis',
  'Purchase order',
  'Bank statement',
  'Delivery note',
  'Lab report',
  'Customs declaration',
  'Insurance claim',
  'Payslip',
  'Utility bill',
];
const STAGES = ['survey', 'outputs', 'sections', 'steps'] as const;
const DAY = 86_400_000;
/** The publish gate's fingerprint of an iteration's jobs (`gateFingerprint` in the routes). */
const gateFingerprint = (jobs: Row[]) =>
  createHash('sha256')
    .update(stableJson(jobs.map((j) => [j.id, j.status, j.updated_at, null])))
    .digest('hex');

/** A deterministic hash of the index and a salt (murmur3's finaliser): the same variety per run. */
function pick(i: number, salt: number, mod: number): number {
  let h = Math.imul(i, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) % mod;
}

/** A small valid template (the shape `skeleton()` produces), richer on every 2nd project. */
function definition(id: string, name: string, version: number, i: number) {
  const rich = i % 2 === 0;
  return {
    id,
    version,
    name,
    document: { ocr: 'auto', sections: [{ id: 'all', anchor: '\\A' }] },
    outputs: rich
      ? {
          fields: [
            { id: 'issuer', type: 'text' },
            { id: 'issued_on', type: 'date' },
          ],
          tables: [],
        }
      : { fields: [], tables: [] },
    pipeline: rich
      ? [{ type: 'extract', id: 'head', fields: ['issuer', 'issued_on'], sections: ['all'] }]
      : [],
    review: { required: 'on_warnings' },
  };
}

function build(count: number, prefix: string) {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const projects: Row[] = [];
  const templates: Row[] = [];
  const documents: Row[] = [];
  const jobs: Row[] = [];
  const samples: Row[] = [];
  const briefs: Row[] = [];
  const proposals: Row[] = [];
  const skips: Row[] = [];
  const iterations: Row[] = [];

  for (let i = 1; i <= count; i++) {
    const id = `${prefix}-${String(i).padStart(4, '0')}`;
    const name = `${KINDS[i % KINDS.length]} ${String(i).padStart(4, '0')}`;
    const dataPolicy = i % 4 === 0 ? 'external' : 'local';
    // Created 20–140 days ago; every later event 1–8 hours after the one before it (at most
    // ~40 events, so all in the past).
    const created = now - (20 + pick(i, 1, 120)) * DAY - pick(i, 2, 1440) * 60_000;
    let clock = created;
    const later = () => (clock += (1 + pick(i, clock % 9973, 8)) * 3_600_000);
    projects.push({
      id,
      name,
      created_at: iso(created),
      data_policy: dataPolicy,
      publish_threshold: i % 7 === 0 ? 0.8 : 0.9,
    });

    const published = i % 3 === 0;
    const openDraft = !published || i % 6 !== 0;
    const draftVersion = openDraft ? (published ? 2 : 1) : null;
    const liveVersion = draftVersion ?? 1;
    if (published) {
      const at = iso(later());
      templates.push({
        id,
        version: 1,
        status: 'published',
        definition: definition(id, name, 1, i),
        created_at: iso(created),
        updated_at: at,
        published_at: at,
      });
    }
    if (draftVersion !== null) {
      templates.push({
        id,
        version: draftVersion,
        status: 'draft',
        definition: definition(id, name, draftVersion, i),
        created_at: iso(clock),
        updated_at: iso(later()),
        published_at: null,
      });
    }

    const sampleCount = 1 + pick(i, 3, 8);
    const holdoutCount = sampleCount >= 3 ? Math.floor(sampleCount / 3) : 0;
    const holdout: { documentId: string; sha256: string }[] = [];
    for (let k = 0; k < sampleCount; k++) {
      const documentId = randomUUID();
      const sha256 = createHash('sha256').update(`${prefix}/${i}/${k}`).digest('hex');
      const at = iso(later());
      const role = k >= sampleCount - holdoutCount ? 'holdout' : 'dev';
      if (role === 'holdout') holdout.push({ documentId, sha256 });
      documents.push({
        id: documentId,
        filename: `${id}-sample-${k + 1}.pdf`,
        sha256,
        size_bytes: 40_000 + pick(i, 10 + k, 900_000),
        spec_id: id,
        spec_version: liveVersion,
        bucket: 'inbox',
        object_key: `${documentId}.pdf`,
        created_at: at,
      });
      const last = k === sampleCount - 1;
      const status =
        last && i % 23 === 0 ? 'running' : last && i % 37 === 0 ? 'failed' : 'succeeded';
      jobs.push({
        id: randomUUID(),
        document_id: documentId,
        project_id: id,
        status,
        task: 'prepare',
        test: true,
        priority: -10,
        params: { dataPolicy },
        error: status === 'failed' ? 'seeded: preparation failed' : null,
        created_at: at,
        updated_at: status === 'running' ? at : iso(later()),
      });
      samples.push({
        project_id: id,
        document_id: documentId,
        role,
        added_for_version: liveVersion,
        created_at: at,
      });
    }

    const brief = i % 2 === 0;
    if (brief) {
      briefs.push({
        project_id: id,
        version: 1,
        body: {
          purpose: `Extract the header and line items of each ${name.toLowerCase()}.`,
          outputs: 'One row per line item.',
          exampleOutput: '',
          glossary: '',
          variants: '',
          rules: '',
          answers: [],
        },
        created_at: iso(later()),
      });
    }

    const draftJob = (stage: string, status: string) => {
      const jobId = randomUUID();
      const at = later();
      jobs.push({
        id: jobId,
        document_id: null,
        project_id: id,
        status,
        task: 'draft',
        test: true,
        priority: -10,
        params: { stage, dataPolicy },
        error: null,
        created_at: iso(at),
        updated_at: iso(status === 'running' ? at : later()),
      });
      return { jobId, finishedAt: iso(clock) };
    };
    const done = published ? STAGES.length : pick(i, 4, STAGES.length + 1);
    STAGES.slice(0, done).forEach((stage, n) => {
      if (n % 2 === 0) {
        const { jobId, finishedAt } = draftJob(stage, 'succeeded');
        proposals.push({
          id: jobId,
          project_id: id,
          stage,
          brief_version: brief ? 1 : null,
          decision: 'accepted',
          decided_at: iso(later()),
          created_at: finishedAt,
        });
      } else {
        skips.push({ project_id: id, stage, skipped_at: iso(later()) });
      }
    });
    const nextStage = STAGES[done];
    const pending = i % 11 === 3 ? 'running' : i % 5 === 1 ? 'succeeded' : null;
    if (nextStage && pending) {
      const { jobId, finishedAt } = draftJob(nextStage, pending);
      proposals.push({
        id: jobId,
        project_id: id,
        stage: nextStage,
        brief_version: brief ? 1 : null,
        decision: null,
        decided_at: null,
        created_at: finishedAt,
      });
    }

    if (draftVersion !== null && holdout.length > 0 && i % 4 === 0) {
      // One finished evaluation job per holdout sample. Without their documents in the store
      // the API scores them as uncompared, so the score lives only in `gate_cache` (on half).
      const startedAt = iso(later());
      const runs = holdout.map(({ documentId }) => {
        const at = later();
        const job: Row = {
          id: randomUUID(),
          document_id: documentId,
          project_id: id,
          status: 'succeeded',
          task: 'process',
          test: true,
          priority: -10,
          params: { dataPolicy },
          error: null,
          created_at: iso(at),
          updated_at: iso(later()),
        };
        jobs.push(job);
        return job;
      });
      const score = (75 + pick(i, 5, 25)) / 100;
      const total = runs.length;
      iterations.push({
        project_id: id,
        template_version: draftVersion,
        definition: definition(id, name, draftVersion, i),
        eval_set: 'holdout',
        job_ids: runs.map((j) => j.id),
        sample_shas: holdout.map((h) => h.sha256),
        scores: null,
        gate_cache:
          i % 8 === 0
            ? { fingerprint: gateFingerprint(runs), score, completed: total, total }
            : null,
        created_at: startedAt,
      });
    }
  }
  return { projects, templates, documents, jobs, samples, briefs, proposals, skips, iterations };
}
