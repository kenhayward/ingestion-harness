/**
 * Opt-in end to end of conversion batches (decomposition phase 3, spec §11): batches go through
 * the API's routes, the worker's `decompose` job and the bridge to the fake document sink, and
 * the bridge's events settle each row. Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY
 * database (it applies db/migrations and deletes batches, items, decompose jobs and the `docs`
 * sink's register entries). It needs `uv` and the worker's environment (`uv sync` in worker/).
 *
 * What is real and what is faked:
 * - real: the API (`buildApp` on PgRepo: batch, upload, start, accept, detach and the signed
 *   `/api/bridge/events` route, listening on a port); the worker's `run_once` claiming the
 *   `decompose` jobs from the same Postgres with its Pg item and register stores and its HTTP
 *   bridge client (`worker/tests/conversion_e2e_worker.py`, one process per run), and the PDF
 *   reader with its holds for review, approved and rejected through the API; the bridge's
 *   routes, runner and event dispatcher over HTTP, delivering through `HttpSink` to the fake
 *   document sink's server (`FAKE_SINK_MODE=documents`, with `/_edit`)
 *   (`apps/bridge/test/conversion-bridge.ts`);
 * - faked: object storage (the API's MemoryObjectStore, copied to the worker's for each run and
 *   back), the worker's layout analyser (answering the PDF fixtures with their saved Docling output),
 *   the bridge's own stores (memory), the API's view of the bridge's catalog and targets
 *   (FakeBridgeApi) and the worker's target cache (a fixed lookup). Each is proven by its own
 *   tests (S3 stores, the bridge's Pg repos, the target sync).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { DecompositionProvenance } from '@ih/bridge-contract';
import {
  AcceptPreviewSchema,
  BatchDetailSchema,
  BatchSchema,
  ConversionReviewSchema,
  decompositionHeldManifestKey,
  GONE_DETAIL,
  ItemSchema,
  sourceContentType,
  type Item,
} from '@ih/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { MemoryPublishTargetRepo } from '../../src/publish-targets/repo.js';
import { PgRepo } from '../../src/repositories/pg.js';
import { docx, para } from '../docx-fixtures.js';
import { FAKE_DOCUMENT_SINK } from '../fake-sink.js';
import { multipart, TEST_BRIDGE_KEY, testApp } from '../helpers.js';

const run = promisify(execFile);
const url = process.env.IH_TEST_DATABASE_URL;
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const migrations = join(root, 'db', 'migrations');
const workerDir = join(root, 'worker');
/** The bridge side of the harness (bridge package: typechecked there, loaded here at run time). */
const BRIDGE_HARNESS = pathToFileURL(join(root, 'apps', 'bridge', 'test', 'conversion-bridge.ts'));

/** What `startConversionBridge` (apps/bridge/test/conversion-bridge.ts) gives back. */
interface ConversionBridge {
  url: string;
  edit(persistentId: string, componentId: string): Promise<{ version: string } | null>;
  remove(persistentId: string): Promise<boolean>;
  documents(): string[];
  text(persistentId: string): string | null;
  provenance(persistentId: string): DecompositionProvenance | null;
  settle(): Promise<void>;
  close(): Promise<void>;
}
type StartBridge = (opts: {
  key: string;
  eventsUrl: string;
  target: { id: string; label: string; sinkId: string; destination: Record<string, string> };
}) => Promise<ConversionBridge>;

/** The sink id the target delivers through, on the bridge, the worker and the register. */
const SINK = FAKE_DOCUMENT_SINK.id;

/** The worker's PDF fixtures, which its fake layout analyser answers with their saved Docling output. */
const PDF_FIXTURES = join(workerDir, 'tests', 'decompose', 'pdf', 'fixtures');
const pdf = (name: string) => readFileSync(join(PDF_FIXTURES, name));

/** A Word file of one heading and a paragraph: `text` makes it this file and no other. */
const word = (text: string) =>
  docx({
    body:
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Scope</w:t></w:r></w:p>' +
      para(text),
  });

describe.skipIf(!url)('conversion batches end to end', { timeout: 300_000 }, () => {
  let pool: pg.Pool;
  let repo: PgRepo;
  let c: Awaited<ReturnType<typeof testApp>>;
  let bridge: ConversionBridge;
  let objects: string;
  let targetId: string;

  const clear = async () => {
    await pool.query('DELETE FROM register_actions');
    await pool.query('DELETE FROM decomposition_register WHERE sink_id = $1', [SINK]);
    await pool.query('DELETE FROM decomposition_items');
    await pool.query('DELETE FROM decomposition_batches');
    const jobs = `SELECT id FROM jobs WHERE task = 'decompose'`;
    await pool.query(`DELETE FROM job_deliveries WHERE job_id IN (${jobs})`);
    await pool.query(`DELETE FROM job_events WHERE job_id IN (${jobs})`);
    await pool.query(`DELETE FROM jobs WHERE task = 'decompose'`);
  };

  beforeAll(async () => {
    await migrate(url!, migrations);
    const options = { connectionString: url, max: 4, connectionTimeoutMillis: 5_000 };
    pool = new pg.Pool(options);
    repo = new PgRepo(new pg.Pool(options));
    await clear();
    // Its own target repo: the helper's default counts usage from a memory repo.
    c = await testApp({ repo, targets: new MemoryPublishTargetRepo() });
    c.bridge.sinkViews = [FAKE_DOCUMENT_SINK];
    const created = await c.app.inject({
      method: 'POST',
      url: '/api/publish-targets',
      payload: { kind: 'sink', label: 'Manuals', sinkId: SINK, destination: { space: 'lib' } },
    });
    if (created.statusCode !== 201) throw new Error(`target: ${created.body}`);
    targetId = (created.json() as { id: string }).id;
    const api = await c.app.listen({ host: '127.0.0.1', port: 0 });
    const { startConversionBridge } = (await import(BRIDGE_HARNESS.href)) as {
      startConversionBridge: StartBridge;
    };
    bridge = await startConversionBridge({
      key: TEST_BRIDGE_KEY,
      eventsUrl: `${api}/api/bridge/events`,
      target: { id: targetId, label: 'Manuals', sinkId: SINK, destination: { space: 'lib' } },
    });
    objects = mkdtempSync(join(tmpdir(), 'conversion-e2e-'));
  });

  afterAll(async () => {
    await bridge?.close();
    await c?.app.close();
    if (pool) await clear();
    await pool?.end();
    await repo?.close();
    if (objects) rmSync(objects, { recursive: true, force: true });
  });

  /**
   * The worker's run: every queued `decompose` job, claimed and run by the worker's own loop. Run
   * asynchronously: the bridge it calls is served from this process. What the worker's store
   * holds at the end (a hold's files written, or deleted) becomes the API's store.
   */
  async function runWorker(): Promise<void> {
    const listed: Array<{ bucket: string; key: string; path: string }> = [];
    for (const [name, { body }] of c.store.objects) {
      const slash = name.indexOf('/');
      const path = join(objects, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
      listed.push({ bucket: name.slice(0, slash), key: name.slice(slash + 1), path });
    }
    const manifest = join(objects, 'objects.json');
    writeFileSync(manifest, JSON.stringify(listed));
    const after = join(objects, 'objects-after.json');
    try {
      await run(
        'uv',
        ['run', '--directory', workerDir, 'python', '-m', 'tests.conversion_e2e_worker'],
        {
          timeout: 120_000,
          env: {
            ...process.env,
            E2E_DATABASE_URL: url!,
            E2E_BRIDGE_URL: bridge.url,
            E2E_BRIDGE_KEY: TEST_BRIDGE_KEY,
            E2E_OBJECTS: manifest,
            E2E_OBJECTS_AFTER: after,
            E2E_TARGET: JSON.stringify({ id: targetId, sinkId: SINK }),
          },
        },
      );
    } catch (err) {
      const { stderr = '' } = err as { stderr?: string };
      throw new Error(`the worker failed: ${String(err)}\n${stderr}`);
    }
    const stored = JSON.parse(readFileSync(after, 'utf8')) as Array<{
      bucket: string;
      key: string;
      contentType: string;
      body: string;
    }>;
    c.store.objects.clear();
    for (const o of stored) {
      await c.store.put(o.bucket, o.key, Buffer.from(o.body, 'base64'), o.contentType);
    }
  }

  /** A batch of `files` (source key → bytes) through the Conversion tab's calls, to its end. */
  async function convert(files: Record<string, Buffer>): Promise<Record<string, Item>> {
    const batch = BatchSchema.parse(
      (
        await c.app.inject({
          method: 'POST',
          url: '/api/conversions/batches',
          payload: { targetId },
        })
      ).json(),
    );
    for (const [sourceKey, content] of Object.entries(files)) {
      const form = multipart(
        { sourceKey },
        {
          filename: sourceKey.split('/').pop()!,
          content,
          contentType: sourceContentType(sourceKey),
        },
      );
      const res = await c.app.inject({
        method: 'POST',
        url: `/api/conversions/batches/${batch.id}/items`,
        ...form,
      });
      if (res.statusCode !== 201 && res.statusCode !== 200) {
        throw new Error(`upload ${sourceKey}: ${res.statusCode} ${res.body}`);
      }
    }
    const started = await c.app.inject({
      method: 'POST',
      url: `/api/conversions/batches/${batch.id}/start`,
    });
    if (started.statusCode !== 200) throw new Error(`start: ${started.body}`);
    await runWorker();
    await bridge.settle();
    const detail = BatchDetailSchema.parse(
      (await c.app.inject(`/api/conversions/batches/${batch.id}`)).json(),
    );
    return Object.fromEntries(detail.items.map((i) => [i.sourceKey, i]));
  }

  /** Each row's outcome by source key; a failed one with its reason, so a failure says why. */
  const outcomes = (items: Record<string, Item>) =>
    Object.fromEntries(
      Object.entries(items).map(([k, i]) => [
        k,
        i.outcome === 'failed' ? `failed: ${i.detail}` : i.outcome,
      ]),
    );

  /** The document an item's register entry holds, and its first section, from the register. */
  async function documentOf(item: Item): Promise<{ persistentId: string; section: string }> {
    const { rows } = await pool.query<{ persistent_id: string; last_receipt: unknown }>(
      'SELECT persistent_id, last_receipt FROM decomposition_register WHERE id = $1',
      [item.registerEntryId],
    );
    const receipt = rows[0]?.last_receipt as {
      document: { components: Array<{ kind: string; id: string }> };
    };
    const section = receipt.document.components.find((x) => x.kind === 'section')!;
    return { persistentId: rows[0]!.persistent_id, section: section.id };
  }

  /** An edit in the target: one section of the item's document changes there. */
  async function editInTarget(item: Item): Promise<void> {
    const { persistentId, section } = await documentOf(item);
    expect(await bridge.edit(persistentId, section)).not.toBeNull();
  }

  async function accept(item: Item): Promise<void> {
    const preview = AcceptPreviewSchema.parse(
      (await c.app.inject(`/api/conversions/items/${item.id}/accept`)).json(),
    );
    expect(preview.acceptable).toBe(true);
    const res = await c.app.inject({
      method: 'POST',
      url: `/api/conversions/items/${item.id}/accept`,
      payload: { confirm: true, seen: preview.updatedAt },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  /**
   * A row action that starts a new batch of one (force-load, reload), run to its end: the new
   * batch's item.
   */
  async function rerunOf(item: Item, action: 'force' | 'reload'): Promise<Item> {
    const res = await c.app.inject({
      method: 'POST',
      url: `/api/conversions/items/${item.id}/${action}`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const { batch } = BatchDetailSchema.parse(res.json());
    await runWorker();
    await bridge.settle();
    const detail = BatchDetailSchema.parse(
      (await c.app.inject(`/api/conversions/batches/${batch.id}`)).json(),
    );
    return detail.items[0]!;
  }

  async function detach(item: Item): Promise<void> {
    const res = await c.app.inject({
      method: 'POST',
      url: `/api/conversions/items/${item.id}/detach`,
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  it('a single file, then a folder, go through to the fake sink with one row per document', async () => {
    // 1. A one-file batch creates its document.
    const single = await convert({ 'notes.docx': word('A single note') });
    expect(outcomes(single)).toEqual({ 'notes.docx': 'created' });
    expect(single['notes.docx']!.detail).toBe('document doc-1');
    // Timed by the worker's start and the settle of its delivery.
    const { startedAt, finishedAt } = single['notes.docx']!;
    expect(Date.parse(finishedAt!)).toBeGreaterThanOrEqual(Date.parse(startedAt!));
    expect(bridge.documents()).toHaveLength(1);

    // 2. A folder of three: created ×3, one document each.
    const folder = {
      'manual/a.docx': word('Pumps'),
      'manual/b.docx': word('Valves'),
      'manual/c.docx': word('Seals'),
    };
    const first = await convert(folder);
    expect(outcomes(first)).toEqual({
      'manual/a.docx': 'created',
      'manual/b.docx': 'created',
      'manual/c.docx': 'created',
    });
    expect(bridge.documents()).toHaveLength(4);

    // 3. The same folder again: already loaded ×3, nothing written.
    const again = await convert(folder);
    expect(outcomes(again)).toEqual({
      'manual/a.docx': 'already_loaded',
      'manual/b.docx': 'already_loaded',
      'manual/c.docx': 'already_loaded',
    });
    // Decided by the worker without a delivery: the worker finishes it.
    expect(again['manual/a.docx']!.finishedAt).not.toBeNull();

    // 4. One file changed: that one is updated, in place, and the target now holds its text.
    const bFirst = (await documentOf(first['manual/b.docx']!)).persistentId;
    expect(bridge.text(bFirst)).toContain('Valves');
    expect(bridge.text(bFirst)).not.toContain('revised');
    const changed = await convert({ ...folder, 'manual/b.docx': word('Valves, revised') });
    expect(outcomes(changed)).toEqual({
      'manual/a.docx': 'already_loaded',
      'manual/b.docx': 'updated',
      'manual/c.docx': 'already_loaded',
    });
    const b = (await documentOf(changed['manual/b.docx']!)).persistentId;
    expect(b).toBe(bFirst);
    expect(bridge.text(b)).toContain('Valves, revised');
    expect(bridge.documents()).toHaveLength(4);

    // 5. Someone edits b in the target; the next run of a changed b is refused.
    await editInTarget(changed['manual/b.docx']!);
    const bThird = { 'manual/b.docx': word('Valves, third edition') };
    const refused = await convert(bThird);
    expect(outcomes(refused)).toEqual({ 'manual/b.docx': 'changed_in_target' });

    // 6. Accepting the target's state lets the same file update the document.
    await accept(refused['manual/b.docx']!);
    const accepted = await convert(bThird);
    expect(outcomes(accepted)).toEqual({ 'manual/b.docx': 'updated' });
    expect((await documentOf(accepted['manual/b.docx']!)).persistentId).toBe(b);
    expect(bridge.text(b)).toContain('Valves, third edition');
    expect(bridge.documents()).toHaveLength(4);

    // 7. Detach: a refused a is detached, and its original file then makes a NEW document. The
    //    sink replays a key it has seen, so without the detach token in the create's key this
    //    would answer with a's first document.
    const aFirst = (await documentOf(first['manual/a.docx']!)).persistentId;
    await editInTarget(first['manual/a.docx']!);
    const aRefused = await convert({ 'manual/a.docx': word('Pumps, revised') });
    expect(outcomes(aRefused)).toEqual({ 'manual/a.docx': 'changed_in_target' });
    await detach(aRefused['manual/a.docx']!);
    const reloaded = await convert({ 'manual/a.docx': folder['manual/a.docx'] });
    expect(outcomes(reloaded)).toEqual({ 'manual/a.docx': 'created' });
    const aNew = (await documentOf(reloaded['manual/a.docx']!)).persistentId;
    expect(aNew).not.toBe(aFirst);
    expect(bridge.documents()).toHaveLength(5);

    // One register row per live document: the detached one is no longer the source's.
    const { rows } = await pool.query<{ source_key: string; persistent_id: string }>(
      `SELECT source_key, persistent_id FROM decomposition_register
        WHERE sink_id = $1 AND state <> 'detached' ORDER BY source_key`,
      [SINK],
    );
    expect(rows.map((r) => r.source_key)).toEqual([
      'manual/a.docx',
      'manual/b.docx',
      'manual/c.docx',
      'notes.docx',
    ]);
    expect(new Set(rows.map((r) => r.persistent_id)).size).toBe(4);
    expect(rows.find((r) => r.source_key === 'manual/a.docx')?.persistent_id).toBe(aNew);
  });

  /** The item, as its batch's detail shows it now. */
  async function itemNow(item: Item): Promise<Item> {
    const detail = BatchDetailSchema.parse(
      (await c.app.inject(`/api/conversions/batches/${item.batchId}`)).json(),
    );
    return detail.items.find((i) => i.id === item.id)!;
  }

  /** The keys of the item's held files in the API's store. */
  const heldFiles = (item: Item) => {
    const prefix = decompositionHeldManifestKey(item.batchId, item.id).replace(
      /manifest\.json$/,
      '',
    );
    return [...c.store.objects.keys()].filter((name) => name.includes(`/${prefix}`));
  };

  it('PDFs are held for review: one approved to the fake sink, one rejected, a Word file straight through', async () => {
    const before = bridge.documents().length;
    const files = {
      'pdf/two-pages.pdf': pdf('two-pages.pdf'),
      'pdf/rotated-table.pdf': pdf('rotated-table.pdf'),
      'pdf/beside.docx': word('Beside the PDFs'),
    };
    const held = await convert(files);
    expect(outcomes(held)).toEqual({
      'pdf/two-pages.pdf': 'awaiting_review',
      'pdf/rotated-table.pdf': 'awaiting_review',
      'pdf/beside.docx': 'created',
    });
    // Only the Word file reached the target; each PDF waits with its held files.
    expect(bridge.documents()).toHaveLength(before + 1);
    const approve = held['pdf/two-pages.pdf']!;
    const reject = held['pdf/rotated-table.pdf']!;
    expect(heldFiles(approve)).not.toHaveLength(0);
    expect(heldFiles(reject)).not.toHaveLength(0);

    // The review reads the worker's own manifest, and serves the pages it rendered.
    const review = await c.app.inject(`/api/conversions/items/${approve.id}/review`);
    expect(review.statusCode, review.body).toBe(200);
    const shown = ConversionReviewSchema.parse(review.json());
    expect(shown.item).toMatchObject({ outcome: 'awaiting_review', held: true });
    expect(shown.pageCount).toBe(2);
    expect(Object.keys(shown.pageMap)).not.toHaveLength(0);
    const page = await c.app.inject(`/api/conversions/items/${approve.id}/pages/1`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.headers['content-type']).toBe('image/jpeg');
    expect(page.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    // Approved: the held decomposition is delivered, under the PDF's decomposer version.
    const approved = await c.app.inject({
      method: 'POST',
      url: `/api/conversions/items/${approve.id}/approve`,
      payload: { note: 'reads well' },
    });
    expect(approved.statusCode, approved.body).toBe(202);
    await runWorker();
    await bridge.settle();
    const delivered = await itemNow(approve);
    expect(delivered.outcome, delivered.detail ?? '').toBe('created');
    const { persistentId } = await documentOf(delivered);
    expect(bridge.provenance(persistentId)).toMatchObject({
      sourceKey: 'pdf/two-pages.pdf',
      decomposerVersion: 1001,
    });
    expect(bridge.documents()).toHaveLength(before + 2);
    expect(heldFiles(approve)).toEqual([]);

    // Rejected: final, its held files gone, nothing sent.
    const rejected = await c.app.inject({
      method: 'POST',
      url: `/api/conversions/items/${reject.id}/reject`,
      payload: { note: 'the table is misread' },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    const rejectedItem = ItemSchema.parse(rejected.json());
    expect(rejectedItem).toMatchObject({ outcome: 'rejected', held: false });
    expect(rejectedItem.finishedAt).not.toBeNull();
    await runWorker();
    await bridge.settle();
    expect((await itemNow(reject)).outcome).toBe('rejected');
    expect(heldFiles(reject)).toEqual([]);
    expect(bridge.documents()).toHaveLength(before + 2);
    const sent = bridge.documents().map((pid) => bridge.provenance(pid)?.sourceKey);
    expect(sent).not.toContain('pdf/rotated-table.pdf');
  });

  it('a document deleted in the target is gone, and loads again as a new document', async () => {
    const created = (await convert({ 'gone.docx': word('Gaskets') }))['gone.docx']!;
    expect(created.outcome).toBe('created');
    const { persistentId: first } = await documentOf(created);

    // Someone deletes it in the target: a force-load's update is refused as not found.
    expect(await bridge.remove(first)).toBe(true);
    const forced = await rerunOf(created, 'force');
    expect(forced).toMatchObject({
      outcome: 'unresolved',
      gone: true,
      reloadable: true,
      detail: GONE_DETAIL,
    });
    // The sink's marker reached the register unchanged, through the bridge and its event.
    const marker = await pool.query<{ last_error: { details?: unknown } }>(
      'SELECT last_error FROM decomposition_register WHERE id = $1',
      [forced.registerEntryId],
    );
    expect(marker.rows[0]?.last_error).toMatchObject({
      code: 'not_found',
      details: { reason: 'document_missing', persistentId: first },
    });

    // Running it again sends no update: still unresolved, still gone.
    const again = await rerunOf(forced, 'force');
    expect(again).toMatchObject({ outcome: 'unresolved', gone: true, detail: GONE_DETAIL });

    // Load as a new document: detached, then created again under a new persistent id.
    const reloaded = await rerunOf(again, 'reload');
    expect(reloaded.outcome, reloaded.detail ?? '').toBe('created');
    const { persistentId: second } = await documentOf(reloaded);
    expect(second).not.toBe(first);
    expect(bridge.documents()).toContain(second);
    expect(bridge.documents()).not.toContain(first);
    const { rows } = await pool.query<{ action: string; details: { reason?: string } }>(
      `SELECT action, details FROM register_actions ORDER BY at DESC LIMIT 1`,
    );
    expect(rows[0]).toMatchObject({ action: 'detach', details: { reason: 'gone' } });
  });
});
