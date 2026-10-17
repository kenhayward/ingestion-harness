/**
 * Migration file names (ADR 0014). The first 49 are numbered and keep their names (the runner
 * tracks applied files by name, so a rename would apply one again); every later one is
 * `YYYYMMDDHHMM_description.sql`, the UTC time it was written, so parallel PRs never collide.
 */
export const LAST_NUMBERED_MIGRATION = 49;

const NUMBERED = /^(\d{4})_[a-z0-9_]+\.sql$/;
const TIMESTAMPED = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9_]+\.sql$/;
const RULE = 'name new migrations YYYYMMDDHHMM_description.sql (UTC, description in snake_case)';

/** A real UTC date-time: Date.UTC rolls 30 February over, so compare the parts back. */
function realTime(y: number, mo: number, d: number, h: number, mi: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi
  );
}

/** What is wrong with these `db/migrations` file names; `[]` when nothing is. */
export function migrationNameProblems(files: string[]): string[] {
  const problems: string[] = [];
  const byStamp = new Map<string, string[]>();
  for (const file of files.filter((f) => f.endsWith('.sql')).sort()) {
    const numbered = NUMBERED.exec(file);
    if (numbered) {
      if (Number(numbered[1]) > LAST_NUMBERED_MIGRATION) {
        problems.push(`${file}: migrations are no longer numbered; ${RULE}`);
      }
      continue;
    }
    const stamped = TIMESTAMPED.exec(file);
    if (!stamped) {
      problems.push(`${file}: ${RULE}`);
      continue;
    }
    const [y, mo, d, h, mi] = stamped.slice(1, 6).map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    if (!realTime(y, mo, d, h, mi)) {
      problems.push(`${file}: ${file.slice(0, 12)} is not a real UTC date and time; ${RULE}`);
      continue;
    }
    const stamp = file.slice(0, 12);
    byStamp.set(stamp, [...(byStamp.get(stamp) ?? []), file]);
  }
  for (const [stamp, same] of byStamp) {
    if (same.length > 1) {
      problems.push(`${same.join(', ')}: share the timestamp ${stamp}; give each its own minute`);
    }
  }
  return problems;
}
