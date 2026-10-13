import type { BriefBody } from './workbench.js';

const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whether the brief already asks for a survey candidate (handoff SV2, "In brief"): the words of
 * its name (snake_case, camelCase or spaced) appear together, as whole words, in the brief's
 * outputs wanted, example output or saved survey answers. Derived when shown, never stored: the
 * brief changes after the survey (saving answers makes a new version).
 */
export function candidateInBrief(name: string, brief: BriefBody | null): boolean {
  const wanted = words(name);
  if (!brief || !wanted.length) return false;
  const text = [brief.outputs, brief.exampleOutput, ...brief.answers.map((a) => a.answer)].join(
    '\n',
  );
  return ` ${words(text).join(' ')} `.includes(` ${wanted.join(' ')} `);
}
