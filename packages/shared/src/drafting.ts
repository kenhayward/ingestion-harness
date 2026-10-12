import { z } from 'zod';
import { CopySelectionSchema, SectionSchema } from './spec.js';
import { StepSchema, TableDefSchema, ValueDefSchema } from './template.js';
import {
  SegmentationResultSchema,
  type DraftStage,
  type ProposalStatus,
  type ProposalView,
  type SurveyBody,
} from './workbench.js';

/**
 * Drafting stages that propose changes to the draft template (ADR 0007, phase 3b).
 * Mirrors worker/src/ingest_worker/draft_changes.py (apply) and draft_stages.py (ops per stage).
 */
export const CHANGE_STAGES = ['outputs', 'sections', 'steps'] as const;
export type ChangeStage = (typeof CHANGE_STAGES)[number];
export const isChangeStage = (stage: DraftStage): stage is ChangeStage =>
  (CHANGE_STAGES as readonly string[]).includes(stage);

const reason = z.string();
export const DraftChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('putField'), field: ValueDefSchema, reason }).strict(),
  z.object({ op: z.literal('putTable'), table: TableDefSchema, reason }).strict(),
  z.object({ op: z.literal('removeOutput'), id: z.string(), reason }).strict(),
  z.object({ op: z.literal('putSection'), section: SectionSchema, reason }).strict(),
  z.object({ op: z.literal('removeSection'), id: z.string(), reason }).strict(),
  z.object({ op: z.literal('setCopies'), copies: CopySelectionSchema.nullable(), reason }).strict(),
  z.object({ op: z.literal('putStep'), step: StepSchema, reason }).strict(),
  z.object({ op: z.literal('removeStep'), id: z.string(), reason }).strict(),
  z.object({ op: z.literal('setPreamble'), preamble: z.string(), reason }).strict(),
]);
export type DraftChange = z.infer<typeof DraftChangeSchema>;

export const STAGE_OPS: Record<ChangeStage, readonly DraftChange['op'][]> = {
  outputs: ['putField', 'putTable', 'removeOutput'],
  sections: ['putSection', 'removeSection', 'setCopies'],
  steps: ['putStep', 'removeStep', 'setPreamble'],
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

/** A stage body, or null if it is malformed or uses an op the stage may not. */
export function parseChangeBody(stage: ChangeStage, body: unknown): ChangeBody | null {
  const parsed = ChangeBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.changes.every((c) => STAGE_OPS[stage].includes(c.op)) ? parsed.data : null;
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
  }
}

function valueAt(def: Def, target: string): unknown {
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
  for (const c of changes) {
    switch (c.op) {
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
  return out;
}

/** Drafting stages in order (3b; `references` joins in phase 4). */
export const STAGE_ORDER: readonly DraftStage[] = ['survey', 'outputs', 'sections', 'steps'];

export type StageState = 'pending' | 'running' | 'proposed' | 'accepted' | 'skipped' | 'stale';

export interface StageView {
  stage: DraftStage;
  state: StageState;
  /** Last time the stage was accepted (fully or partly) or skipped; null if never. */
  completedAt: string | null;
}

export interface StageSkip {
  stage: DraftStage;
  skippedAt: string;
}

type ProposalLike = {
  stage: DraftStage;
  status: ProposalStatus;
  createdAt: string;
  decidedAt: string | null;
};

/**
 * Stage state, derived (never stored): a stage is complete once accepted or skipped; it is
 * stale when an earlier stage completed after it; newer running/ready work shows over it.
 */
export function stageStates(proposals: ProposalLike[], skips: StageSkip[]): StageView[] {
  const completions = STAGE_ORDER.map((stage) => {
    const done = [
      ...proposals
        .filter(
          (p) =>
            p.stage === stage &&
            (p.status === 'accepted' || p.status === 'partially_accepted') &&
            p.decidedAt !== null,
        )
        .map((p) => ({ kind: 'accepted' as const, at: p.decidedAt! })),
      ...skips
        .filter((s) => s.stage === stage)
        .map((s) => ({ kind: 'skipped' as const, at: s.skippedAt })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    return done[0] ?? null;
  });
  return STAGE_ORDER.map((stage, i) => {
    const done = completions[i] ?? null;
    const latest = proposals
      .filter((p) => p.stage === stage)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const active =
      latest !== undefined &&
      (latest.status === 'running' || latest.status === 'ready') &&
      (done === null || latest.createdAt > done.at);
    const stale =
      done !== null && completions.slice(0, i).some((c) => c !== null && c.at > done.at);
    const state: StageState = active
      ? latest.status === 'running'
        ? 'running'
        : 'proposed'
      : done
        ? stale
          ? 'stale'
          : done.kind
        : 'pending';
    return { stage, state, completedAt: done?.at ?? null };
  });
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
 * reference; it is derived from samples and references, not from proposals.
 */
export function referencesStage(
  earlier: StageView[],
  input: {
    devSamples: number;
    verified: number;
    lastVerifiedAt: string | null;
    running: boolean;
    hasRuns: boolean;
    skippedAt: string | null;
  },
): StageView {
  const verifiedAt =
    input.devSamples > 0 && input.verified >= input.devSamples ? input.lastVerifiedAt : null;
  const skipped = input.skippedAt !== null && (verifiedAt === null || input.skippedAt > verifiedAt);
  const completedAt = skipped ? input.skippedAt : verifiedAt;
  const stale =
    completedAt !== null &&
    earlier.some((s) => s.completedAt !== null && s.completedAt > completedAt);
  const state: StageState = input.running
    ? 'running'
    : completedAt !== null
      ? stale
        ? 'stale'
        : skipped
          ? 'skipped'
          : 'accepted'
      : input.hasRuns || input.verified > 0
        ? 'proposed'
        : 'pending';
  return { stage: 'references', state, completedAt };
}
