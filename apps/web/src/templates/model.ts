/* eslint-disable @typescript-eslint/no-explicit-any --
   These helpers edit template definitions as schemaless JSON (drafts may be incomplete or
   invalid while being authored); validation happens separately via TemplateSchema. */
import { TemplateSchema } from '@ih/shared';

/** A template definition as edited: plain JSON, possibly incomplete while being authored. */
export type Definition = Record<string, any>;

type Key = string | number;

/** Immutable update at `path`; untouched branches keep their identity. */
export function setIn<T>(obj: T, path: Key[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path as [Key, ...Key[]];
  const container: any = Array.isArray(obj) ? [...obj] : { ...(obj ?? {}) };
  container[head] = setIn(container[head], rest, value);
  return container as T;
}

export function getIn(obj: unknown, path: Key[]): any {
  return path.reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function removeAt<T>(list: T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/** Paths a check step can compare: `<field>` and `<table>.<column>`. */
export function checkPathOptions(def: Definition): string[] {
  const fields = (def.outputs?.fields ?? []).map((f: { id: string }) => f.id);
  const columns = (def.outputs?.tables ?? []).flatMap(
    (t: { id: string; columns?: { id: string }[] }) =>
      (t.columns ?? []).map((c) => `${t.id}.${c.id}`),
  );
  return [...fields, ...columns];
}

/** Same rules as the API (apps/api/src/templates/definitions.ts): schema + no custom prompts. */
export function validateDefinition(def: unknown): string[] {
  const result = TemplateSchema.safeParse(def);
  if (!result.success) {
    return result.error.issues.map((i) =>
      i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
    );
  }
  return result.data.pipeline.flatMap((step) =>
    step.type === 'extract' && step.prompt && !step.prompt.startsWith('builtin/')
      ? [
          `step "${step.id}": custom prompt files are not supported for database templates; use instructions`,
        ]
      : [],
  );
}
