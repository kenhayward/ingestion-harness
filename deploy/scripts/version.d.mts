// Types for the pure exports of version.mjs (its tests live in apps/api/test).
export function isCalendarTag(tag: string): boolean;
export function compareCalendarTags(a: string, b: string): number;
export function nextCalendarTag(now: Date, tags: string[]): string;
export function resolveVersion(input: {
  headTag: string | null;
  nearestTag: string | null;
  previousTag: string | null;
  commit: string;
  dirty: boolean;
}): { version: string; previous: string; commit: string; imageTag: string };
export function shouldWait(input: {
  headTag: string | null;
  onMain: boolean;
  taggedLater: boolean;
  fetched: boolean;
  untagged: boolean;
}): boolean;
export function nearestCalendarTag(rev: string, cwd?: string): string | null;
export function onFirstParent(rev: string, branch: string, cwd?: string): boolean;
export function containedByCalendarTag(rev: string, cwd?: string): boolean;
export function noBuildImageTag(cwd?: string): string;
export function waitForTag(opts: {
  check: () => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<string | null>;
