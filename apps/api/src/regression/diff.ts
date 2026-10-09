/**
 * Structural diff of two template definitions. Lists of objects with an `id` (sections, fields,
 * tables, columns, steps) are matched by id rather than position, so moving or inserting an
 * item reads as one change instead of a cascade.
 */

export interface Change {
  kind: 'added' | 'removed' | 'changed';
  /** e.g. "outputs.fields[a].type", "pipeline[s1].instructions", "pipeline order". */
  path: string;
  before?: unknown;
  after?: unknown;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isKeyedList = (v: unknown): v is Obj[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && typeof x.id === 'string');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

function diff(a: unknown, b: unknown, path: string, out: Change[]): void {
  if (same(a, b)) return;
  if ((isKeyedList(a) || isKeyedList(b)) && Array.isArray(a) && Array.isArray(b)) {
    const before = new Map((a as Obj[]).map((x) => [x.id as string, x]));
    const after = new Map((b as Obj[]).map((x) => [x.id as string, x]));
    for (const [id, item] of before) {
      if (!after.has(id)) out.push({ kind: 'removed', path: `${path}[${id}]`, before: item });
    }
    for (const [id, item] of after) {
      const old = before.get(id);
      if (old === undefined) out.push({ kind: 'added', path: `${path}[${id}]`, after: item });
      else diff(old, item, `${path}[${id}]`, out);
    }
    const order = (m: Map<string, Obj>, other: Map<string, Obj>) =>
      [...m.keys()].filter((id) => other.has(id));
    if (!same(order(before, after), order(after, before))) {
      out.push({
        kind: 'changed',
        path: `${path} order`,
        before: [...before.keys()],
        after: [...after.keys()],
      });
    }
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in b)) out.push({ kind: 'removed', path: join(path, key), before: a[key] });
      else if (!(key in a)) out.push({ kind: 'added', path: join(path, key), after: b[key] });
      else diff(a[key], b[key], join(path, key), out);
    }
    return;
  }
  out.push({ kind: 'changed', path, before: a, after: b });
}

export function diffDefinitions(from: Obj, to: Obj): Change[] {
  const strip = ({ version: _version, ...rest }: Obj) => rest;
  const out: Change[] = [];
  diff(strip(from), strip(to), '', out);
  return out;
}
