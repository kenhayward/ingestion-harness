import { z } from 'zod';
import type { ProposalDecision } from './drafting.js';
import {
  DRAFT_STAGES,
  EMPTY_BRIEF,
  type Brief,
  type BriefBody,
  type DraftStage,
} from './workbench.js';

/** The brief's sections in the Brief tab's order (handoff §2); `answers` is filled by Survey. */
export const BRIEF_SECTIONS = [
  'purpose',
  'outputs',
  'glossary',
  'exampleOutput',
  'variants',
  'rules',
  'answers',
  'ontologies',
] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export interface BriefSectionDiff {
  section: BriefSection;
  before: string;
  after: string;
}

/**
 * A section as text: the survey answers one `question: answer` per line; the ontologies one
 * pick per line, then their guidance.
 */
export function briefSectionText(body: BriefBody, section: BriefSection): string {
  if (section === 'answers')
    return body.answers.map((a) => `${a.question}: ${a.answer}`).join('\n');
  if (section === 'ontologies') {
    const picks = (body.ontologies ?? []).map((o) => `${o.ontologyId} v${o.version} (${o.role})`);
    const guidance = (body.ontologyGuidance ?? '').trim();
    return [...picks, ...(guidance ? [`Guidance: ${guidance}`] : [])].join('\n');
  }
  return body[section];
}

const same = (a: BriefBody, b: BriefBody, section: BriefSection) =>
  section === 'answers'
    ? JSON.stringify(a.answers) === JSON.stringify(b.answers)
    : section === 'ontologies'
      ? JSON.stringify([a.ontologies ?? [], a.ontologyGuidance ?? '']) ===
        JSON.stringify([b.ontologies ?? [], b.ontologyGuidance ?? ''])
      : a[section] === b[section];

/** The vocabulary ontologies the brief chooses, sorted (shapes are for validation only). */
export function vocabularyOf(body: BriefBody): { ontologyId: string; version: number }[] {
  return (body.ontologies ?? [])
    .filter((o) => o.role === 'vocabulary')
    .map(({ ontologyId, version }) => ({ ontologyId, version }))
    .sort((x, y) => x.ontologyId.localeCompare(y.ontologyId) || x.version - y.version);
}

/** What the mapping stage depends on in the brief: its vocabulary picks and guidance. */
export function ontologySelectionKey(body: BriefBody): string {
  return JSON.stringify([vocabularyOf(body), (body.ontologyGuidance ?? '').trim()]);
}

/**
 * The sections that differ between two versions of a brief, in `BRIEF_SECTIONS` order.
 * `before` null: the first version, compared with an empty brief.
 */
export function briefDiff(before: BriefBody | null, after: BriefBody): BriefSectionDiff[] {
  const from = before ?? EMPTY_BRIEF;
  return BRIEF_SECTIONS.flatMap((section) =>
    same(from, after, section)
      ? []
      : [
          {
            section,
            before: briefSectionText(from, section),
            after: briefSectionText(after, section),
          },
        ],
  );
}

/** GET /api/workbench/projects/:id/briefs (handoff BR1), newest first. */
export const BriefVersionViewSchema = z.object({
  version: z.number().int().positive(),
  createdAt: z.string(),
  /** Sections changed from the previous version (the first: sections with text). */
  changedSections: z.array(z.enum(BRIEF_SECTIONS)),
  /** Stages whose newest accepted or partially accepted proposal was drafted from it. */
  usedBy: z.array(z.enum(DRAFT_STAGES)),
});
export type BriefVersionView = z.infer<typeof BriefVersionViewSchema>;

/** What `briefVersions` reads of a proposal (`ProposalRecord` has these fields). */
export interface BriefUse {
  stage: DraftStage;
  briefVersion: number | null;
  decision: ProposalDecision | null;
  createdAt: string;
}

/** Each brief version with what it changed and which stages' applied proposals used it. */
export function briefVersions(
  briefs: readonly Brief[],
  proposals: readonly BriefUse[],
): BriefVersionView[] {
  const inForce = new Map<DraftStage, number | null>();
  const applied = proposals
    .filter((p) => p.decision === 'accepted' || p.decision === 'partially_accepted')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const p of applied) inForce.set(p.stage, p.briefVersion);
  const sorted = [...briefs].sort((a, b) => a.version - b.version);
  return sorted
    .map((b, i) => ({
      version: b.version,
      createdAt: b.createdAt,
      changedSections: briefDiff(i === 0 ? null : sorted[i - 1]!.body, b.body).map(
        (d) => d.section,
      ),
      usedBy: DRAFT_STAGES.filter((s) => inForce.get(s) === b.version),
    }))
    .reverse();
}
