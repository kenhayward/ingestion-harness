/**
 * Whether a pattern written in Python `re` syntax (constraint patterns, as section anchors) is
 * one the worker's `re.compile` accepts, judged in JavaScript. The pattern is compiled without the
 * `u` flag, whose lax (Annex B) parsing takes what Python takes (`\-`, `\ `, `\A`, `\Z`, a lone
 * `{`), after refusing what JavaScript takes and Python does not: unknown letter escapes (`\p`,
 * `\k`, `\c`), short hex escapes, `(?<name>`, backreferences to groups not yet opened, empty
 * classes (`[]`, `[^]`) and lookbehinds of no fixed width. Translated first: a leading `(?ims)`
 * flag group, `(?P<name>` and `(?P=name)`. Held in step with the worker by
 * `packages/shared/test/fixtures/value-constraints.json`; when in doubt it refuses, so a pattern
 * that saves always runs.
 */
export function pythonPatternCompiles(pattern: string): boolean {
  const flags = /^\(\?([ims]+)\)/.exec(pattern);
  const body = flags ? pattern.slice(flags[0].length) : pattern;
  if (!pythonOnlyOk(body)) return false;
  const translated = body.replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
  try {
    new RegExp(translated, flags?.[1] ?? '');
    return true;
  } catch {
    return false;
  }
}

/** Letters Python takes after a backslash with nothing after them. */
const LETTER_ESCAPES = new Set('abBdDfnrsStvwWAZ');
const HEX_DIGITS: Record<string, number> = { x: 2, u: 4, U: 8 };

function pythonOnlyOk(p: string): boolean {
  let groups = 0;
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '\\') {
      const next = p[i + 1];
      if (next === undefined) return false;
      if (/[A-Za-z]/.test(next)) {
        const hex = HEX_DIGITS[next];
        if (hex !== undefined) {
          if (!new RegExp(`^[0-9A-Fa-f]{${hex}}`).test(p.slice(i + 2))) return false;
          i += 1 + hex;
          continue;
        }
        if (next === 'N') {
          if (p[i + 2] !== '{' || !p.includes('}', i + 3)) return false;
        } else if (!LETTER_ESCAPES.has(next)) {
          return false;
        }
      } else if (!inClass && /[1-9]/.test(next)) {
        const ref = /^\d{1,2}/.exec(p.slice(i + 1))![0];
        if (Number(ref) > groups) return false;
        i += ref.length;
        continue;
      }
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      if (p[i + 1] === ']' || (p[i + 1] === '^' && p[i + 2] === ']')) return false;
      inClass = true;
      continue;
    }
    if (c !== '(') continue;
    if (p[i + 1] !== '?') {
      groups += 1;
      continue;
    }
    const ext = p.slice(i + 2, i + 4);
    if (p.startsWith('P<', i + 2)) groups += 1;
    else if (ext === '<=' || ext === '<!') {
      if (!fixedWidth(lookbehindBody(p, i + 4))) return false;
    } else if (ext.startsWith('<')) return false; // (?<name> is JavaScript's, not Python's
  }
  return !inClass;
}

/** The text of the group starting at `start` up to its closing parenthesis. */
function lookbehindBody(p: string, start: number): string {
  let depth = 1;
  for (let i = start; i < p.length; i++) {
    if (p[i] === '\\') i += 1;
    else if (p[i] === '(') depth += 1;
    else if (p[i] === ')' && --depth === 0) return p.slice(start, i);
  }
  return p.slice(start);
}

/** No quantifier of varying width and no alternation (Python refuses some unequal ones). */
function fixedWidth(body: string): boolean {
  const plain = body.replace(/\\./g, 'x');
  if (/[*+?|]/.test(plain)) return false;
  for (const m of plain.matchAll(/\{(\d*)(,?)(\d*)\}/g)) {
    if (m[2] === ',' && m[1] !== m[3]) return false;
  }
  return true;
}
