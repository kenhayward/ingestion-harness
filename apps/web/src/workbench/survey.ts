import {
  STAGE_ORDER,
  type BriefBody,
  type DraftStage,
  type ProposalView,
  type SeenIn,
  type StageView,
  type SurveyBody,
} from '@ih/shared';
import { plural } from './samples.js';

export interface AnswerProgress {
  answered: number;
  of: number;
  /** Typed answers that differ from the brief's (trimmed): what Save writes; blank = remove. */
  unsaved: { question: string; answer: string }[];
}

/** The questions card's counts (handoff §3): answered = shown answer non-blank. */
export function answerProgress(
  questions: SurveyBody['questions'],
  saved: BriefBody['answers'],
  typed: Record<string, string>,
): AnswerProgress {
  const savedAnswer = (q: string) => saved.find((a) => a.question === q)?.answer ?? '';
  const shown = questions.map((q) => typed[q.question] ?? savedAnswer(q.question));
  return {
    answered: shown.filter((a) => a.trim() !== '').length,
    of: questions.length,
    unsaved: questions
      .filter((q) => typed[q.question] !== undefined)
      .map((q) => ({ question: q.question, answer: (typed[q.question] ?? '').trim() }))
      .filter((a) => a.answer !== savedAnswer(a.question)),
  };
}

/** "Save 2 answers to brief (v4)"; each save is a new brief version. */
export function saveAnswersLabel(count: number, nextVersion: number): string {
  const what = count === 0 ? 'answers' : plural(count, 'answer');
  return `Save ${what} to brief (v${nextVersion})`;
}

export interface SkipBannerInfo {
  skippedAt: string;
  /** Later stages already completed: accepting the survey will make them stale. */
  later: DraftStage[];
}

/**
 * Handoff SV1: the survey was skipped (and the skip still completes it) and has been run again
 * since; null otherwise.
 */
export function skipBanner(
  stages: readonly StageView[],
  proposal: Pick<ProposalView, 'status' | 'createdAt'> | null,
): SkipBannerInfo | null {
  const survey = stages.find((s) => s.stage === 'survey');
  if (!survey?.skippedAt || !proposal || survey.completedAt !== survey.skippedAt) return null;
  if (proposal.status !== 'ready' && proposal.status !== 'running') return null;
  if (proposal.createdAt <= survey.skippedAt) return null;
  const later = STAGE_ORDER.slice(1).filter(
    (stage) => (stages.find((s) => s.stage === stage)?.completedAt ?? null) !== null,
  );
  return { skippedAt: survey.skippedAt, later };
}

const STAGE_NAME: Partial<Record<DraftStage, string>> = {
  outputs: 'Outputs',
  sections: 'Sections',
  steps: 'Pipeline',
};
const listOf = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export function skipBannerText(info: SkipBannerInfo): string {
  const day = new Date(info.skippedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
  const head = `You skipped this stage on ${day}, then ran it again. Accepting replaces the skip`;
  if (!info.later.length) return `${head}.`;
  const one = info.later.length === 1;
  const names = listOf(info.later.map((s) => STAGE_NAME[s] ?? s));
  return `${head} — ${names} ${one ? 'was' : 'were'} completed without it and will be marked stale so you can re-propose ${one ? 'it' : 'them'}.`;
}

/** "3 of 6 samples" (handoff SV2); null for surveys without it. */
export function seenInText(seen: SeenIn | undefined): string | null {
  return seen && seen.of > 0 ? `${seen.n} of ${plural(seen.of, 'sample')}` : null;
}

export function candidateCounts(candidates: SurveyBody['candidates']): string {
  const tables = candidates.filter((c) => c.kind === 'table').length;
  return `${plural(candidates.length - tables, 'field')} · ${plural(tables, 'table')}`;
}
