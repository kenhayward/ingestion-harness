import {
  bridgeError,
  parsePattern,
  resolvePattern,
  type DestinationField,
} from '@ih/bridge-contract';
import { SinkError } from '../sinks/port.js';

const refuse = (message: string) => new SinkError(bridgeError('content_rejected', message));

/**
 * Where one delivery goes: the target's destination with its sink's pattern fields resolved for
 * this document. A pattern field's value is the first of:
 *
 * 1. the reviewer's override (a literal, used as it is; only for an `overridable` field);
 * 2. the recipe's pattern for the target;
 * 3. the target's own pattern.
 *
 * Fixed fields are the target's. Every problem throws a SinkError before anything is written:
 * an override or pattern for a field that can't take one is `content_rejected`, and a required
 * pattern that resolves to nothing is `pattern_unresolved` (an optional one is left out).
 */
export function resolveDestination(input: {
  targetId: string;
  target: { label: string; destination: Record<string, string> };
  fields: readonly DestinationField[];
  patterns: Record<string, string>;
  overrides: Record<string, string>;
  naming: Record<string, string>;
}): Record<string, string> {
  const { targetId, target, fields, patterns, overrides, naming } = input;
  const declared = new Map(fields.map((f) => [f.id, f]));
  for (const id of Object.keys(overrides)) {
    const f = declared.get(id);
    if (!f) throw refuse(`${target.label}: ${id} is not a destination field`);
    if (f.kind !== 'pattern' || !f.overridable) {
      throw refuse(`${target.label}: ${f.label} can't be changed for one document`);
    }
  }
  for (const id of Object.keys(patterns)) {
    const f = declared.get(id);
    if (!f) throw refuse(`${target.label}: ${id} is not a destination field`);
    if (f.kind !== 'pattern') throw refuse(`${target.label}: ${f.label} is not a name pattern`);
  }
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(target.destination)) {
    if (declared.get(id)?.kind !== 'pattern') out[id] = value;
  }
  for (const f of fields) {
    if (f.kind !== 'pattern') continue;
    const override = overrides[f.id];
    if (override !== undefined && override !== '') {
      out[f.id] = override;
      continue;
    }
    const pattern = patterns[f.id] || target.destination[f.id] || '';
    let variables: string[] = [];
    let value = '';
    if (pattern) {
      const parsed = parsePattern(pattern);
      if ('error' in parsed) throw refuse(`${target.label}: ${f.label}: ${parsed.error}`);
      const resolved = resolvePattern(pattern, naming);
      if ('value' in resolved) value = resolved.value;
      else variables = resolved.unresolved;
    }
    if (value !== '') {
      out[f.id] = value;
      continue;
    }
    if (!f.required) continue;
    throw new SinkError(
      bridgeError(
        'pattern_unresolved',
        variables.length
          ? `${target.label}: ${f.label} resolves to nothing: the document has no ${variables.join(', ')}`
          : `${target.label}: ${f.label} has no name pattern`,
        { targetId, field: f.id, variables },
      ),
    );
  }
  return out;
}
