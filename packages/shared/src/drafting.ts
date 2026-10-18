import { z } from 'zod';
import { CopySelectionSchema, SectionSchema } from './spec.js';
import {
  LocalTermSchema,
  OntologyPinSchema,
  OutputMappingSchema,
  StepSchema,
  TableDefSchema,
  TableMappingSchema,
  ValueDefSchema,
  ValueNodeDefaultsSchema,
} from './template.js';
import {
  DRAFT_STAGES,
  ProposalStatusSchema,
  SegmentationResultSchema,
  SurveyBodySchema,
  type DraftStage,
  type ProposalStatus,
  type SurveyBody,
} from './workbench.js';

/**
 * Drafting stages that propose changes to the draft template (ADR 0007, phase 3b).
 * Mirrors worker/src/ingest_worker/draft_changes.py (apply) and draft_stages.py (ops per stage).
 */
export const CHANGE_STAGES = ['outputs', 'sections', 'steps', 'revise', 'mapping'] as const;
export type ChangeStage = (typeof CHANGE_STAGES)[number];
export const isChangeStage = (stage: DraftStage): stage is ChangeStage =>
  (CHANGE_STAGES as readonly string[]).includes(stage);

const reason = z.string();
/**
 * Revise (handoff RV2): the ids of the feedback items a change answers. Optional, so bodies
 * stored before RV2 parse; `parseChangeBody` refuses it on the other stages.
 */
const answers = z.array(z.string().min(1)).optional();
/**
 * Mapping stage (ADR 0011): how sure the model is, the observed values behind a change, the
 * shortlisted terms it chose from, and the remembered mapping it came from. Shown on the
 * proposal, never written to the draft.
 */
const RememberedMeta = z
  .object({
    entryId: z.string(),
    votes: z.number().int(),
    status: z.enum(['learned', 'confirmed']),
  })
  .strict();
const mappingMeta = {
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  evidence: z.array(z.string()).optional(),
  alternatives: z
    .array(z.object({ iri: z.string(), label: z.string(), score: z.number() }).strict())
    .optional(),
  /** The change came from the mapping memory (docs/design/mapping-memory.md): its entry. */
  remembered: RememberedMeta.optional(),
  /** A table change's columns that came from the mapping memory: column id -> its entry. */
  rememberedColumns: z.record(z.string(), RememberedMeta).optional(),
};
export const DraftChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('putField'), field: ValueDefSchema, reason, answers }).strict(),
  z.object({ op: z.literal('putTable'), table: TableDefSchema, reason, answers }).strict(),
  z.object({ op: z.literal('removeOutput'), id: z.string(), reason, answers }).strict(),
  z.object({ op: z.literal('putSection'), section: SectionSchema, reason, answers }).strict(),
  z.object({ op: z.literal('removeSection'), id: z.string(), reason, answers }).strict(),
  z
    .object({ op: z.literal('setCopies'), copies: CopySelectionSchema.nullable(), reason, answers })
    .strict(),
  z.object({ op: z.literal('putStep'), step: StepSchema, reason, answers }).strict(),
  z.object({ op: z.literal('removeStep'), id: z.string(), reason, answers }).strict(),
  z.object({ op: z.literal('setPreamble'), preamble: z.string(), reason, answers }).strict(),
  z
    .object({
      op: z.literal('setDocumentMapping'),
      document: z.object({ class: z.string().min(1), iri: z.string().min(1) }).strict(),
      ontologies: z.array(OntologyPinSchema),
      prefixes: z.record(z.string().regex(/^[A-Za-z][\w-]*$/), z.string().url()),
      /** The value-node defaults (absent: the draft's are kept). */
      valueNodes: ValueNodeDefaultsSchema.optional(),
      reason,
      answers,
      ...mappingMeta,
    })
    .strict(),
  z
    .object({
      op: z.literal('putFieldMapping'),
      field: z.string().min(1),
      mapping: OutputMappingSchema,
      reason,
      answers,
      ...mappingMeta,
    })
    .strict(),
  z
    .object({
      op: z.literal('putTableMapping'),
      table: z.string().min(1),
      mapping: TableMappingSchema,
      reason,
      answers,
      ...mappingMeta,
    })
    .strict(),
  z
    .object({
      op: z.literal('removeMapping'),
      /** A field or table id, or `table.column`. */
      id: z.string().min(1),
      reason,
      answers,
      ...mappingMeta,
    })
    .strict(),
  z
    .object({
      op: z.literal('putLocalTerm'),
      term: LocalTermSchema,
      reason,
      answers,
      ...mappingMeta,
    })
    .strict(),
]);
export type DraftChange = z.infer<typeof DraftChangeSchema>;

const OUTPUT_OPS = ['putField', 'putTable', 'removeOutput'] as const;
const SECTION_OPS = ['putSection', 'removeSection', 'setCopies'] as const;
const STEP_OPS = ['putStep', 'removeStep', 'setPreamble'] as const;
const MAPPING_OPS = [
  'setDocumentMapping',
  'putFieldMapping',
  'putTableMapping',
  'removeMapping',
  'putLocalTerm',
] as const;

/** `revise` (phase 4c) may touch anything the three authoring stages can. */
export const STAGE_OPS: Record<ChangeStage, readonly DraftChange['op'][]> = {
  outputs: OUTPUT_OPS,
  sections: SECTION_OPS,
  steps: STEP_OPS,
  revise: [...OUTPUT_OPS, ...SECTION_OPS, ...STEP_OPS],
  mapping: MAPPING_OPS,
};

/** Body of an outputs/sections/steps proposal (worker draft task, runs bucket). */
export const ChangeBodySchema = z
  .object({
    notes: z.string(),
    changes: z.array(DraftChangeSchema),
    /** sections stage: the proposal's anchors applied to every dev sample (worker). */
    anchorCheck: SegmentationResultSchema.nullable().optional(),
  })
  .strict();
export type ChangeBody = z.infer<typeof ChangeBodySchema>;

/**
 * A running drafting stage's progress (issue #151): the worker's `drafting progress` job events
 * (worker drafting.DRAFT_PROGRESS; shared fixture draft-progress.json), one per phase and per
 * model call. `samples` = dev samples whose text is sent; `attempt` of `of` for a model call;
 * `round` 2 = the sections stage's anchor round; `tokens` = a streamed reply's estimated tokens
 * so far (model phase; about four characters each, thinking included; absent from workers
 * before streaming, null when not counted). Advisory: a run may have none.
 */
export const DRAFT_PROGRESS_EVENT = 'drafting progress';
export const DRAFT_PHASES = ['reading', 'model', 'anchors', 'suggestions'] as const;
export type DraftPhase = (typeof DRAFT_PHASES)[number];
export const DraftProgressSchema = z.object({
  stage: z.enum(DRAFT_STAGES),
  phase: z.enum(DRAFT_PHASES),
  samples: z.number().int().nonnegative(),
  attempt: z.number().int().positive().nullable(),
  of: z.number().int().positive().nullable(),
  round: z.number().int().positive(),
  tokens: z.number().int().nonnegative().nullable().optional(),
  /**
   * A conversation with tools (an endpoint allowing tool calls; sections, revise, mapping): the
   * tool running now, with the line saying what it does, or null between tools. Absent for a
   * run without tools and from older workers.
   */
  tool: z.object({ name: z.string(), summary: z.string() }).strict().nullable().optional(),
  /** The tool calls the model has made so far in this conversation. */
  toolCalls: z.number().int().nonnegative().optional(),
});
export type DraftProgress = z.infer<typeof DraftProgressSchema>;

/**
 * A drafting run's model log (`draftLogKey`, worker `DraftLog`; shared fixture
 * draft-log.json): each proposal round (the sections stage's anchor round is a second one) as the
 * model saw it: the prompt, each reply, the tools it called and what they returned, the answers
 * rejected and why, and the error that ended the run. `legacy`: rebuilt from the per-attempt
 * audit of a run from before the log (no tool calls, no errors).
 */
export const DraftLogEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prompt'), text: z.string(), images: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('reply'),
    text: z.string(),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal('toolCall'),
    id: z.string(),
    name: z.string(),
    /** The arguments, or the raw text when they were not JSON. */
    input: z.unknown(),
    summary: z.string(),
  }),
  z.object({
    kind: z.literal('toolResult'),
    id: z.string(),
    name: z.string(),
    text: z.string(),
    isError: z.boolean(),
  }),
  z.object({ kind: z.literal('rejected'), errors: z.array(z.string()) }),
  z.object({ kind: z.literal('note'), text: z.string() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export type DraftLogEntry = z.infer<typeof DraftLogEntrySchema>;

export const DraftLogSchema = z.object({
  stage: z.enum(DRAFT_STAGES),
  /** The drafting model's `endpoint/model` ref; null in a legacy log. */
  model: z.string().nullable(),
  /** The run held a conversation with tools. */
  tools: z.boolean(),
  rounds: z.array(z.object({ label: z.string(), entries: z.array(DraftLogEntrySchema) })),
  legacy: z.boolean().default(false),
});
export type DraftLog = z.infer<typeof DraftLogSchema>;

/** A proposal whose job has not finished: where it is (issue #151). */
export const DraftRunSchema = z.object({
  status: z.enum(['queued', 'running']),
  /** Queued: when it was queued (or requeued). Running: when a worker claimed it. */
  since: z.string(),
  /**
   * This attempt's latest progress and when it was reported; null before the first. `phaseAt`:
   * when its phase (and model try) began, which a streamed reply's token counts leave alone.
   */
  progress: DraftProgressSchema.extend({ at: z.string(), phaseAt: z.string() }).nullable(),
  /** Queued while the job queue is paused (a restore): it starts once an admin resumes it. */
  paused: z.boolean().optional(),
  /** Queued again after a failed try: the try it waits for, of how many, and the error. */
  retry: z
    .object({
      attempt: z.number().int().positive(),
      of: z.number().int().positive(),
      error: z.string(),
    })
    .nullable()
    .optional(),
});
export type DraftRun = z.infer<typeof DraftRunSchema>;

export const ProposalViewSchema = z.object({
  id: z.string().uuid(),
  stage: z.enum(DRAFT_STAGES),
  status: ProposalStatusSchema,
  error: z.string().nullable(),
  briefVersion: z.number().int().nullable(),
  /** Resolved model that produced it (once ready). */
  model: z.string().nullable(),
  /** survey: SurveyBody; outputs/sections/steps/revise: ChangeBody. Null until ready. */
  body: z.union([SurveyBodySchema, ChangeBodySchema]).nullable(),
  /** Indexes of the changes applied to the draft (accepted / partially_accepted). */
  acceptedChanges: z.array(z.number().int()).nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /** While its job is queued or running; null once it finished. */
  run: DraftRunSchema.nullable(),
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;

/** A stage body, or null if it is malformed, uses an op the stage may not, or answers feedback outside revise. */
export function parseChangeBody(stage: ChangeStage, body: unknown): ChangeBody | null {
  const parsed = ChangeBodySchema.safeParse(body);
  if (!parsed.success) return null;
  const { changes } = parsed.data;
  if (!changes.every((c) => STAGE_OPS[stage].includes(c.op))) return null;
  if (stage !== 'revise' && changes.some((c) => c.answers !== undefined)) return null;
  return parsed.data;
}

/**
 * The feedback an accepted revise proposal resolves (RV2). When any change names the feedback
 * it answers, only the `sent` ids named by the applied changes (indexes into `changes`); when
 * none does (stored before RV2, or the model named none), everything it was sent. In `sent` order.
 */
export function answeredFeedback(
  changes: readonly DraftChange[],
  applied: readonly number[],
  sent: readonly string[],
): string[] {
  if (!changes.some((c) => c.answers?.length)) return [...sent];
  const named = new Set(applied.flatMap((i) => changes[i]?.answers ?? []));
  return sent.filter((id) => named.has(id));
}

export type ProposalDecision = 'accepted' | 'partially_accepted' | 'rejected';

type Def = Record<string, unknown>;
const obj = (v: unknown): Def =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {};
const list = (v: unknown): Def[] => (Array.isArray(v) ? (v as Def[]) : []);
const put = (items: Def[], item: Def) => {
  const i = items.findIndex((x) => x.id === item.id);
  return i < 0 ? [...items, item] : items.map((x, j) => (j === i ? item : x));
};
const drop = (items: Def[], id: unknown) => items.filter((x) => x.id !== id);

/** The part of a definition a change touches (conflict detection). */
export function changeTarget(c: DraftChange): string {
  switch (c.op) {
    case 'putField':
      return `output:${c.field.id}`;
    case 'putTable':
      return `output:${c.table.id}`;
    case 'removeOutput':
      return `output:${c.id}`;
    case 'putSection':
      return `section:${c.section.id}`;
    case 'removeSection':
      return `section:${c.id}`;
    case 'setCopies':
      return 'copies';
    case 'putStep':
      return `step:${c.step.id}`;
    case 'removeStep':
      return `step:${c.id}`;
    case 'setPreamble':
      return 'preamble';
    case 'setDocumentMapping':
      return 'mapping:document';
    case 'putFieldMapping':
      return `mapping:output:${c.field}`;
    case 'putTableMapping':
      return `mapping:output:${c.table}`;
    case 'removeMapping':
      return `mapping:output:${c.id.split('.')[0]}`;
    case 'putLocalTerm':
      return `mapping:local:${c.term.iri}`;
  }
}

function valueAt(def: Def, target: string): unknown {
  if (target.startsWith('mapping:')) {
    const semantics = obj(def.semantics);
    const [, part, ...rest] = target.split(':');
    const id = rest.join(':');
    if (part === 'document') {
      const { document, ontologies, prefixes } = semantics;
      return {
        document: document ?? null,
        ontologies: ontologies ?? null,
        prefixes: prefixes ?? null,
      };
    }
    if (part === 'local') return list(semantics.local).find((t) => t.iri === id) ?? null;
    return obj(semantics.fields)[id] ?? obj(semantics.tables)[id] ?? null;
  }
  const [kind, id] = target.split(':', 2) as [string, string | undefined];
  const outputs = obj(def.outputs);
  const document = obj(def.document);
  if (kind === 'output') {
    return [...list(outputs.fields), ...list(outputs.tables)].find((o) => o.id === id) ?? null;
  }
  if (kind === 'section') return list(document.sections).find((s) => s.id === id) ?? null;
  if (kind === 'copies') return document.copies ?? null;
  if (kind === 'step') return list(def.pipeline).find((s) => s.id === id) ?? null;
  return def.preamble ?? null;
}

/** JSON with object keys sorted, so key order (which jsonb does not keep) never matters. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Def;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Indexes of changes whose target differs between the proposal's base and the current draft. */
export function conflictingChanges(base: Def, current: Def, changes: DraftChange[]): number[] {
  return changes.flatMap((c, i) => {
    const target = changeTarget(c);
    return stableJson(valueAt(base, target)) === stableJson(valueAt(current, target)) ? [] : [i];
  });
}

/** Apply changes to a definition (pure). Mirrors worker draft_changes.apply_changes. */
export function applyChanges(definition: Def, changes: DraftChange[]): Def {
  const outputsIn = obj(definition.outputs);
  let fields = list(outputsIn.fields);
  let tables = list(outputsIn.tables);
  const document: Def = { ...obj(definition.document) };
  let sections = list(document.sections);
  let pipeline = list(definition.pipeline);
  let preamble = definition.preamble;
  let semantics: Def | null = definition.semantics ? { ...obj(definition.semantics) } : null;
  /** The mapping to change: the recipe's, else a new one with no document class yet. */
  const mapping = (): Def =>
    (semantics ??= {
      ontologies: [],
      shapes: [],
      prefixes: {},
      document: { class: '', iri: 'doc/{source}' },
      fields: {},
      tables: {},
      local: [],
    });
  for (const c of changes) {
    switch (c.op) {
      case 'setDocumentMapping': {
        const m = mapping();
        m.document = c.document;
        m.ontologies = c.ontologies;
        m.prefixes = { ...obj(m.prefixes), ...c.prefixes };
        if (c.valueNodes) m.valueNodes = c.valueNodes;
        break;
      }
      case 'putFieldMapping': {
        const m = mapping();
        m.fields = { ...obj(m.fields), [c.field]: c.mapping };
        break;
      }
      case 'putTableMapping': {
        const m = mapping();
        m.tables = { ...obj(m.tables), [c.table]: c.mapping };
        break;
      }
      case 'removeMapping': {
        const m = mapping();
        const [table, column] = c.id.split('.', 2) as [string, string | undefined];
        if (column !== undefined) {
          const tables = obj(m.tables);
          if (tables[table]) {
            const t = obj(tables[table]);
            const columns = { ...obj(t.columns) };
            delete columns[column];
            m.tables = { ...tables, [table]: { ...t, columns } };
          }
        } else {
          const fields = { ...obj(m.fields) };
          const tables = { ...obj(m.tables) };
          delete fields[c.id];
          delete tables[c.id];
          m.fields = fields;
          m.tables = tables;
        }
        break;
      }
      case 'putLocalTerm': {
        const m = mapping();
        const local = list(m.local);
        const i = local.findIndex((t) => t.iri === c.term.iri);
        m.local = i < 0 ? [...local, c.term] : local.map((t, j) => (j === i ? c.term : t));
        break;
      }
      case 'putField':
        fields = put(fields, c.field as Def);
        tables = drop(tables, c.field.id);
        break;
      case 'putTable':
        tables = put(tables, c.table as Def);
        fields = drop(fields, c.table.id);
        break;
      case 'removeOutput':
        fields = drop(fields, c.id);
        tables = drop(tables, c.id);
        break;
      case 'putSection':
        sections = put(sections, c.section as Def);
        break;
      case 'removeSection':
        sections = drop(sections, c.id);
        break;
      case 'setCopies':
        if (c.copies === null) delete document.copies;
        else document.copies = c.copies;
        break;
      case 'putStep':
        pipeline = put(pipeline, c.step as Def);
        break;
      case 'removeStep':
        pipeline = drop(pipeline, c.id);
        break;
      case 'setPreamble':
        preamble = c.preamble;
        break;
    }
  }
  const out: Def = {
    ...definition,
    document: { ...document, sections },
    outputs: { ...outputsIn, fields, tables },
    pipeline,
  };
  if (preamble) out.preamble = preamble;
  else delete out.preamble;
  if (semantics) out.semantics = semantics;
  return out;
}

/** Drafting stages in order (3b; `references` joins in phase 4). */
export const STAGE_ORDER: readonly DraftStage[] = ['survey', 'outputs', 'sections', 'steps'];

export const StageStateSchema = z.enum([
  'pending',
  'running',
  'proposed',
  'accepted',
  'skipped',
  'stale',
]);
export type StageState = z.infer<typeof StageStateSchema>;

export const StageViewSchema = z.object({
  stage: z.enum(DRAFT_STAGES),
  state: StageStateSchema,
  /** Last time the stage was accepted (fully or partly) or skipped; null if never. */
  completedAt: z.string().nullable(),
  /** The stage's newest skip, kept after later runs and acceptances (handoff SV1); null if never. */
  skippedAt: z.string().nullable(),
});
export type StageView = z.infer<typeof StageViewSchema>;

export interface StageSkip {
  stage: DraftStage;
  skippedAt: string;
}

/** Stages whose stale state can be cleared without a new proposal (handoff SC1, migration 0026). */
export const KEEPABLE_STAGES = ['outputs', 'sections', 'steps', 'mapping'] as const;
export type KeepableStage = (typeof KEEPABLE_STAGES)[number];

/**
 * "Keep" on a stale stage (handoff SC1): the stage's content is confirmed against the earlier
 * stages' completions up to `upTo`. It is not stale for those; a later one makes it stale again.
 * It never changes `completedAt`, so the stages after it are unaffected.
 */
export interface StageConfirm {
  stage: DraftStage;
  confirmedAt: string;
  upTo: string;
}

const newest = (times: string[]) => times.sort().at(-1) ?? null;

type ProposalLike = {
  stage: DraftStage;
  status: ProposalStatus;
  createdAt: string;
  decidedAt: string | null;
  /** The changes applied on accepting; `[]` = accepted with none (null for a survey). */
  acceptedChanges?: readonly number[] | null;
};

/**
 * Stage state, derived (never stored): a stage is complete once accepted or skipped; it is
 * stale when an earlier stage completed after it and after the newest confirmation of it; newer
 * running/ready work shows over it.
 */
export function stageStates(
  proposals: ProposalLike[],
  skips: StageSkip[],
  confirms: readonly StageConfirm[] = [],
): StageView[] {
  // Accepting a proposal with no changes leaves the stage as it was: once the stage is complete
  // it confirms it ("Keep") up to that moment instead of completing it again, so the stages
  // after it do not go stale over nothing.
  const kept: StageConfirm[] = [];
  const completions = STAGE_ORDER.map((stage) => {
    const decided = proposals
      .filter(
        (p) =>
          p.stage === stage &&
          (p.status === 'accepted' || p.status === 'partially_accepted') &&
          p.decidedAt !== null,
      )
      .sort((a, b) => a.decidedAt!.localeCompare(b.decidedAt!));
    const skipped = skips.filter((s) => s.stage === stage).map((s) => s.skippedAt);
    const done: { kind: 'accepted' | 'skipped'; at: string }[] = [];
    for (const p of decided) {
      const at = p.decidedAt!;
      const empty = Array.isArray(p.acceptedChanges) && p.acceptedChanges.length === 0;
      if (empty && (done.length > 0 || skipped.some((x) => x < at))) {
        kept.push({ stage, confirmedAt: at, upTo: at });
      } else {
        done.push({ kind: 'accepted', at });
      }
    }
    done.push(...skipped.map((at) => ({ kind: 'skipped' as const, at })));
    done.sort((a, b) => b.at.localeCompare(a.at));
    return done[0] ?? null;
  });
  const allConfirms = [...confirms, ...kept];
  return STAGE_ORDER.map((stage, i) => {
    const done = completions[i] ?? null;
    const latest = proposals
      .filter((p) => p.stage === stage)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const active =
      latest !== undefined &&
      (latest.status === 'running' || latest.status === 'ready') &&
      (done === null || latest.createdAt > done.at);
    const keptUpTo = newest(allConfirms.filter((c) => c.stage === stage).map((c) => c.upTo));
    const since =
      done === null ? null : keptUpTo !== null && keptUpTo > done.at ? keptUpTo : done.at;
    const stale = since !== null && completions.slice(0, i).some((c) => c !== null && c.at > since);
    const state: StageState = active
      ? latest.status === 'running'
        ? 'running'
        : 'proposed'
      : done
        ? stale
          ? 'stale'
          : done.kind
        : 'pending';
    const skippedAt = newest(skips.filter((s) => s.stage === stage).map((s) => s.skippedAt));
    return { stage, state, completedAt: done?.at ?? null, skippedAt };
  });
}

/**
 * The mapping stage (ADR 0011): outside `STAGE_ORDER`, so it never makes other stages stale.
 * It completes like the others (accepted or skipped; an empty acceptance after a completion
 * keeps it), and it is stale when the outputs stage completed after it, or the brief's ontology
 * selection or guidance changed after it, and after its newest keep.
 */
export function mappingStage(input: {
  proposals: readonly ProposalLike[];
  skips: readonly StageSkip[];
  confirms: readonly StageConfirm[];
  outputsCompletedAt: string | null;
  /** When the brief's vocabulary picks or guidance last changed (`ontologySelectionChangedAt`). */
  briefChangedAt: string | null;
}): StageView {
  const mine = input.proposals.filter((p) => p.stage === 'mapping');
  const skipped = input.skips.filter((s) => s.stage === 'mapping').map((s) => s.skippedAt);
  const decided = mine
    .filter(
      (p) => (p.status === 'accepted' || p.status === 'partially_accepted') && p.decidedAt !== null,
    )
    .sort((a, b) => a.decidedAt!.localeCompare(b.decidedAt!));
  const done: { kind: 'accepted' | 'skipped'; at: string }[] = [];
  const keeps = input.confirms.filter((c) => c.stage === 'mapping').map((c) => c.upTo);
  for (const p of decided) {
    const at = p.decidedAt!;
    const empty = Array.isArray(p.acceptedChanges) && p.acceptedChanges.length === 0;
    if (empty && (done.length > 0 || skipped.some((x) => x < at))) keeps.push(at);
    else done.push({ kind: 'accepted', at });
  }
  done.push(...skipped.map((at) => ({ kind: 'skipped' as const, at })));
  done.sort((a, b) => b.at.localeCompare(a.at));
  const completed = done[0] ?? null;
  const latest = [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const active =
    latest !== undefined &&
    (latest.status === 'running' || latest.status === 'ready') &&
    (completed === null || latest.createdAt > completed.at);
  const keptUpTo = newest(keeps);
  const since =
    completed === null
      ? null
      : keptUpTo !== null && keptUpTo > completed.at
        ? keptUpTo
        : completed.at;
  const stale =
    since !== null &&
    [input.outputsCompletedAt, input.briefChangedAt].some((t) => t !== null && t > since);
  const state: StageState = active
    ? latest.status === 'running'
      ? 'running'
      : 'proposed'
    : completed
      ? stale
        ? 'stale'
        : completed.kind
      : 'pending';
  return {
    stage: 'mapping',
    state,
    completedAt: completed?.at ?? null,
    skippedAt: newest(skipped),
  };
}

/** What a keep of the mapping is confirmed against: the later of its two causes of staleness. */
export function mappingKeepUpTo(
  outputsCompletedAt: string | null,
  briefChangedAt: string | null,
): string | null {
  return newest([outputsCompletedAt, briefChangedAt].filter((t): t is string => t !== null));
}

/** The first earlier stage that is not complete, or null when `stage` may run. */
export function blockingStage(states: StageView[], stage: DraftStage): DraftStage | null {
  const index = STAGE_ORDER.indexOf(stage);
  return states.slice(0, Math.max(index, 0)).find((s) => s.completedAt === null)?.stage ?? null;
}

export const surveyBodyOf = (p: Pick<ProposalView, 'stage' | 'body'>): SurveyBody | null =>
  p.stage === 'survey' ? (p.body as SurveyBody | null) : null;
export const changeBodyOf = (p: Pick<ProposalView, 'stage' | 'body'>): ChangeBody | null =>
  p.stage !== 'survey' ? (p.body as ChangeBody | null) : null;

/** The first proposal stage that is neither accepted nor skipped (references needs all four). */
export function firstIncomplete(states: StageView[]): DraftStage | null {
  return STAGE_ORDER.find((stage) => !states.find((s) => s.stage === stage)?.completedAt) ?? null;
}

/**
 * The references stage (phase 4a) is complete once every ready dev sample has a verified
 * reference; it is derived from samples and references, not from proposals. It is never stale:
 * a reference holds the outputs' true values, which later sections or steps do not change, and
 * an outputs change that does makes the reference itself outdated (unverified).
 */
export function referencesStage(input: {
  devSamples: number;
  verified: number;
  lastVerifiedAt: string | null;
  running: boolean;
  hasRuns: boolean;
  skippedAt: string | null;
}): StageView {
  const verifiedAt =
    input.devSamples > 0 && input.verified >= input.devSamples ? input.lastVerifiedAt : null;
  const skipped = input.skippedAt !== null && (verifiedAt === null || input.skippedAt > verifiedAt);
  const completedAt = skipped ? input.skippedAt : verifiedAt;
  const state: StageState = input.running
    ? 'running'
    : completedAt !== null
      ? skipped
        ? 'skipped'
        : 'accepted'
      : input.hasRuns || input.verified > 0
        ? 'proposed'
        : 'pending';
  return { stage: 'references', state, completedAt, skippedAt: input.skippedAt };
}
