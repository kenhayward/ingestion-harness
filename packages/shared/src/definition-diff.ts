import { z } from 'zod';
import { CHANGE_STAGES } from './drafting.js';

/**
 * Structural diff of two template definitions (moved from apps/api/src/regression/diff.ts so the
 * API's draft change log and the web's unsaved bar word a change the same way). Lists of objects
 * with an `id` (sections, fields, tables, columns, steps) are matched by id rather than position,
 * so moving or inserting an item reads as one change instead of a cascade.
 */
export const DefinitionChangeSchema = z.object({
  kind: z.enum(['added', 'removed', 'changed']),
  path: z
    .string()
    .describe('e.g. `outputs.fields[a].type`, `pipeline[s1].instructions`, `pipeline order`.'),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type DefinitionChange = z.infer<typeof DefinitionChangeSchema>;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isKeyedList = (v: unknown): v is Obj[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && typeof x.id === 'string');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

function diff(a: unknown, b: unknown, path: string, out: DefinitionChange[]): void {
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

export function diffDefinitions(from: Obj, to: Obj): DefinitionChange[] {
  const strip = ({ version: _version, ...rest }: Obj) => rest;
  const out: DefinitionChange[] = [];
  diff(strip(from), strip(to), '', out);
  return out;
}

/** At most this many diff chips per change (the summary counts the subjects). */
export const MAX_CHANGE_CHIPS = 4;
const MINUS = '−';

/** What a diff path is about, in words: `field due_date`, `step totals`, `the preamble`. */
export function changeSubject(path: string): string {
  const item = (prefix: string) => new RegExp(`^${prefix}\\[([^\\]]+)\\]`).exec(path)?.[1];
  const column = /^outputs\.tables\[([^\]]+)\]\.columns\[([^\]]+)\]/.exec(path);
  if (column) return `column ${column[1]}.${column[2]}`;
  const table = item('outputs\\.tables');
  if (table !== undefined) return `table ${table}`;
  const field = item('outputs\\.fields');
  if (field !== undefined) return `field ${field}`;
  if (path.startsWith('outputs')) return 'the outputs';
  const section = item('document\\.sections');
  if (section !== undefined) return `section ${section}`;
  if (path.startsWith('document.sections')) return 'the sections';
  if (path.startsWith('document.copies')) return 'the copy selection';
  if (path.startsWith('document')) return 'the document settings';
  const step = item('pipeline');
  if (step !== undefined) return `step ${step}`;
  if (path.startsWith('pipeline')) return 'the pipeline';
  if (path.startsWith('review')) return 'the review setting';
  if (path === 'model') return "the document type's model";
  return `the ${path.split(/[.[ ]/)[0]}`;
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

/** The mono chips for one change: `+ due_date`, `− payment`, `^A → ^B`, `instructions edited`. */
function chips(c: DefinitionChange): string[] {
  const { before, after } = c;
  if (c.path.endsWith(' order')) return ['reordered'];
  const item = /\[([^\]]+)\]$/.exec(c.path);
  if (item && c.kind === 'added') return [`+ ${item[1]}`];
  if (item && c.kind === 'removed') return [`${MINUS} ${item[1]}`];
  if (c.kind === 'changed' && isStrings(before) && isStrings(after)) {
    const added = after.filter((x) => !before.includes(x)).map((x) => `+ ${x}`);
    const removed = before.filter((x) => !after.includes(x)).map((x) => `${MINUS} ${x}`);
    return added.length + removed.length > 0 ? [...added, ...removed] : ['reordered'];
  }
  if (c.kind === 'changed' && isScalar(before) && isScalar(after)) {
    return [`${clip(String(before))} → ${clip(String(after))}`];
  }
  const key = c.path.slice(c.path.lastIndexOf('.') + 1);
  return [`${key} ${c.kind === 'changed' ? 'edited' : c.kind}`];
}

export interface DefinitionChangeText {
  /** What changed, in order of first appearance: `field due_date`, `step totals`. */
  subjects: string[];
  /** One line: `Added field due_date`, `Changed step totals and 2 more`; `No changes`. */
  summary: string;
  /** Up to MAX_CHANGE_CHIPS chips: `+ due_date`, `^A → ^B`, `− payment`. */
  diff: string[];
  /** How many structural changes (0: nothing to record). */
  count: number;
}

/** A draft change in words, for the change log (TP1) and the unsaved bar. */
export function describeDefinitionChange(before: unknown, after: unknown): DefinitionChangeText {
  const obj = (v: unknown): Obj => (isObj(v) ? v : {});
  const changes = diffDefinitions(obj(before), obj(after));
  const subjects = [...new Set(changes.map((c) => changeSubject(c.path)))];
  const verb = (subject: string) => {
    const of = changes.filter((c) => changeSubject(c.path) === subject);
    const whole = of.length === 1 && of[0]!.path.endsWith(']');
    if (whole && of[0]!.kind === 'added') return 'Added';
    if (whole && of[0]!.kind === 'removed') return 'Removed';
    return 'Changed';
  };
  const [first] = subjects;
  const more = subjects.length > 1 ? ` and ${subjects.length - 1} more` : '';
  return {
    subjects,
    summary: first === undefined ? 'No changes' : `${verb(first)} ${first}${more}`,
    diff: changes.flatMap(chips).slice(0, MAX_CHANGE_CHIPS),
    count: changes.length,
  };
}

/** Where a draft change came from (Workbench tabs TP1, migration 0029). */
export const TEMPLATE_CHANGE_SOURCES = [
  'hand',
  'proposal',
  'restore',
  'started',
  'import',
] as const;
export type TemplateChangeSource = (typeof TEMPLATE_CHANGE_SOURCES)[number];

/** One entry of a draft's change log, newest first in `GET …/draft/changes`. */
export const TemplateChangeSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  at: z.string(),
  source: z.enum(TEMPLATE_CHANGE_SOURCES),
  stage: z
    .enum(CHANGE_STAGES)
    .nullable()
    .describe('The drafting stage of an applied proposal; null for every other source.'),
  proposalId: z.string().nullable(),
  summary: z.string().describe('One line, e.g. `Added field due_date`.'),
  diff: z.array(z.string()).describe('Up to 4 short chips, e.g. `+ due_date`, `^A → ^B`.'),
  by: z.string().nullable().describe('The signed-in token label; null without access control.'),
});
export type TemplateChange = z.infer<typeof TemplateChangeSchema>;
export type TemplateChangeInput = Omit<TemplateChange, 'id' | 'version' | 'at'>;
