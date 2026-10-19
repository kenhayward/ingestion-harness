/**
 * A plugin's settings form from the JSON Schema its worker publishes (recipe plugins 3c): the
 * subset Pydantic writes for plugin settings (text, switches, numbers, choices, lists of text and
 * text maps, each optionally `anyOf [x, null]`). Anything else is edited as JSON.
 */

type Schema = Record<string, unknown>;

export type SettingKind =
  'text' | 'boolean' | 'integer' | 'number' | 'enum' | 'list' | 'map' | 'json';

export interface SettingField {
  key: string;
  title: string;
  description?: string;
  kind: SettingKind;
  /** `enum` only: the choices. */
  options?: string[];
  /** The schema's default, which the form leaves out of `with`. */
  fallback?: unknown;
}

const isObj = (v: unknown): v is Schema => !!v && typeof v === 'object' && !Array.isArray(v);

/** `anyOf [x, {type: null}]` is an optional x; other unions stay as they are. */
function unwrap(property: Schema): Schema {
  const anyOf = property.anyOf;
  if (!Array.isArray(anyOf)) return property;
  const branches = anyOf.filter(isObj).filter((b) => b.type !== 'null');
  if (branches.length !== 1 || anyOf.length !== 2) return property;
  const rest = { ...property };
  delete rest.anyOf;
  return { ...rest, ...branches[0] };
}

function kindOf(p: Schema): Pick<SettingField, 'kind' | 'options'> {
  if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === 'string')) {
    return { kind: 'enum', options: p.enum as string[] };
  }
  if (Array.isArray(p.anyOf)) return { kind: 'json' };
  switch (p.type) {
    case 'string':
      return { kind: 'text' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'integer':
      return { kind: 'integer' };
    case 'number':
      return { kind: 'number' };
    case 'array':
      return isObj(p.items) && p.items.type === 'string' ? { kind: 'list' } : { kind: 'json' };
    case 'object':
      return !isObj(p.properties) &&
        isObj(p.additionalProperties) &&
        p.additionalProperties.type === 'string'
        ? { kind: 'map' }
        : { kind: 'json' };
    default:
      return { kind: 'json' };
  }
}

/** The form's fields, in the schema's order. */
export function settingsFields(schema: Schema): SettingField[] {
  const properties = isObj(schema.properties) ? schema.properties : {};
  return Object.entries(properties).map(([key, raw]) => {
    const p = unwrap(isObj(raw) ? raw : {});
    return {
      key,
      title: typeof p.title === 'string' ? p.title : key,
      description: typeof p.description === 'string' ? p.description : undefined,
      ...kindOf(p),
      ...(p.default !== undefined && p.default !== null ? { fallback: p.default } : {}),
    };
  });
}

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (isObj(v) && Object.keys(v).length === 0);

/**
 * `with` after setting `key`: empty values and the default are left out, so a step stores only
 * what was set (`fallback` is the schema's default; a switch's is off unless it says otherwise).
 */
export function setSetting(
  value: Record<string, unknown>,
  key: string,
  v: unknown,
  fallback: unknown = typeof v === 'boolean' ? false : undefined,
): Record<string, unknown> {
  const next = { ...value };
  if (isEmpty(v) || (fallback !== undefined && JSON.stringify(v) === JSON.stringify(fallback))) {
    delete next[key];
  } else {
    next[key] = v;
  }
  return next;
}
