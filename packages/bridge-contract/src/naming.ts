/**
 * Name patterns for a sink's pattern destination fields (a document name, a folder), resolved for
 * each document from the package's `naming` inputs.
 *
 * - Literal text, and `{…}` placeholders. `{{` and `}}` are literal braces.
 * - A placeholder lists alternatives separated by `|`; the first that resolves to a non-empty
 *   value wins. An alternative is a variable or a quoted literal (`'untitled'`).
 * - The variables are `field:<id>`, `source.filename`, `source.stem`, `source.sha256`,
 *   `recipe.id`, `recipe.version`, `job.id` and `date` (UTC `YYYY-MM-DD` of publishing).
 *
 * Values are inserted as they are: each sink makes its own destination values safe.
 */

/** The variables a pattern may name, besides `field:<id>`. */
export const NAMING_VARIABLES = [
  'source.filename',
  'source.stem',
  'source.sha256',
  'recipe.id',
  'recipe.version',
  'job.id',
  'date',
] as const;

const KNOWN = new Set<string>(NAMING_VARIABLES);
const FIELD = /^field:[A-Za-z0-9_.-]+$/;

type Alternative = { variable: string } | { literal: string };
type Part = { text: string } | { alternatives: Alternative[] };
export interface Pattern {
  parts: Part[];
}
export interface PatternError {
  error: string;
}

/** A pattern's parts, or why it is not one: "`<pattern>`: <what> at <position>". */
export function parsePattern(pattern: string): Pattern | PatternError {
  const fail = (what: string, at: number): PatternError => ({
    error: `\`${pattern}\`: ${what} at ${at}`,
  });
  const parts: Part[] = [];
  let text = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '{' && pattern[i + 1] === '{') {
      text += '{';
      i += 2;
      continue;
    }
    if (c === '}' && pattern[i + 1] === '}') {
      text += '}';
      i += 2;
      continue;
    }
    if (c === '}') return fail('} with no {', i);
    if (c !== '{') {
      text += c;
      i += 1;
      continue;
    }
    // A placeholder: its alternatives, split on `|` outside quoted literals, up to its `}`.
    const start = i;
    const pieces: { text: string; at: number }[] = [];
    let piece = '';
    let pieceAt = i + 1;
    let closed = false;
    i += 1;
    while (i < pattern.length) {
      const d = pattern[i]!;
      if (d === "'") {
        const end = pattern.indexOf("'", i + 1);
        if (end < 0) return fail("unclosed '", i);
        piece += pattern.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (d === '{') return fail('{ inside a placeholder', i);
      if (d === '|' || d === '}') {
        pieces.push({ text: piece, at: pieceAt });
        piece = '';
        pieceAt = i + 1;
        i += 1;
        if (d === '}') {
          closed = true;
          break;
        }
        continue;
      }
      piece += d;
      i += 1;
    }
    if (!closed) return fail('unclosed {', start);
    if (pieces.length === 1 && pieces[0]!.text.trim() === '') {
      return fail('an empty placeholder', start);
    }
    const alternatives: Alternative[] = [];
    for (const { text: raw, at } of pieces) {
      const t = raw.trim();
      const offset = at + raw.indexOf(t);
      if (t === '') return fail('an empty alternative', at);
      if (t.startsWith("'")) {
        if (!t.endsWith("'") || t.length < 2 || t.slice(1, -1).includes("'")) {
          return fail('text beside a literal', offset);
        }
        alternatives.push({ literal: t.slice(1, -1) });
      } else if (KNOWN.has(t) || FIELD.test(t)) {
        alternatives.push({ variable: t });
      } else {
        return fail(`unknown variable ${t}`, offset);
      }
    }
    if (text) parts.push({ text });
    text = '';
    parts.push({ alternatives });
  }
  if (text) parts.push({ text });
  return { parts };
}

const isError = (p: Pattern | PatternError): p is PatternError => 'error' in p;

/** The variables a pattern names, once each, in order (none for a pattern that doesn't parse). */
export function patternVariables(pattern: string): string[] {
  const parsed = parsePattern(pattern);
  if (isError(parsed)) return [];
  const seen: string[] = [];
  for (const part of parsed.parts) {
    if ('text' in part) continue;
    for (const a of part.alternatives) {
      if ('variable' in a && !seen.includes(a.variable)) seen.push(a.variable);
    }
  }
  return seen;
}

/**
 * The pattern with `naming` applied, or the variables of every placeholder that resolved to
 * nothing. Throws the parse error for a pattern that is not one (check them with parsePattern
 * before saving).
 */
export function resolvePattern(
  pattern: string,
  naming: Record<string, string>,
): { value: string } | { unresolved: string[] } {
  const parsed = parsePattern(pattern);
  if (isError(parsed)) throw new Error(parsed.error);
  let value = '';
  const unresolved: string[] = [];
  for (const part of parsed.parts) {
    if ('text' in part) {
      value += part.text;
      continue;
    }
    const hit = part.alternatives
      .map((a) => ('literal' in a ? a.literal : (naming[a.variable] ?? '')))
      .find((v) => v !== '');
    if (hit === undefined) {
      for (const a of part.alternatives) {
        if ('variable' in a && !unresolved.includes(a.variable)) unresolved.push(a.variable);
      }
      continue;
    }
    value += hit;
  }
  return unresolved.length ? { unresolved } : { value };
}

/** A field value as a naming input: none for null, a blank, or a structured value. */
function textOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const items = v.map(textOf).filter((t): t is string => t !== null);
    return items.length ? items.join(', ') : null;
  }
  return null;
}

/**
 * The naming inputs of one document's package (`package.naming`): each field's value as text
 * (`field:<id>`), the source, the recipe, the job and the publishing date. The worker builds the
 * same map (`ingest_worker.bridge.naming.naming_inputs`), pinned by the fixture `naming.json`.
 */
export function namingInputs(d: {
  fields: Record<string, { value?: unknown } | null | undefined>;
  jobId: string;
  recipe: { id: string; version: number };
  source: { filename: string; sha256: string };
  publishedAt: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, f] of Object.entries(d.fields)) {
    const t = textOf(f?.value);
    if (t !== null) out[`field:${id}`] = t;
  }
  const dot = d.source.filename.lastIndexOf('.');
  out['source.filename'] = d.source.filename;
  out['source.stem'] = dot > 0 ? d.source.filename.slice(0, dot) : d.source.filename;
  out['source.sha256'] = d.source.sha256;
  out['recipe.id'] = d.recipe.id;
  out['recipe.version'] = String(d.recipe.version);
  out['job.id'] = d.jobId;
  out.date = new Date(d.publishedAt).toISOString().slice(0, 10);
  return out;
}
