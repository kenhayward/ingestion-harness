/** Empty text means "not set": the key is dropped rather than stored as "". */
export const opt = (value: string): string | undefined => (value.trim() === '' ? undefined : value);
export const intList = (text: string): number[] =>
  text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
export const optInt = (text: string): number | undefined =>
  text.trim() === '' ? undefined : Math.trunc(Number(text));

export function Checklist({
  label,
  options,
  selected,
  onToggle,
  disabled = {},
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
  /** Options that cannot be ticked: id -> why (shown as the option's title). */
  disabled?: Record<string, string>;
}) {
  return (
    <fieldset className="choice">
      <legend>{label}</legend>
      {options.length === 0 && <small>None defined yet.</small>}
      {options.map((id) => (
        <label key={id} className="inline" title={disabled[id]}>
          <input
            type="checkbox"
            checked={selected.includes(id)}
            disabled={disabled[id] !== undefined && !selected.includes(id)}
            onChange={(e) => onToggle(id, e.target.checked)}
          />
          {id}
        </label>
      ))}
    </fieldset>
  );
}

/** `bare` drops the visible label (table cells under a heading); it stays the accessible name. */
export function Text({
  label,
  value,
  hint,
  bare,
  className,
  placeholder,
  onChange,
}: {
  label: string;
  value: unknown;
  hint?: string;
  bare?: boolean;
  className?: string;
  /** Shown while empty, e.g. "all" for Pages per call. */
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const input = (
    <input
      aria-label={bare ? label : undefined}
      title={bare ? hint : undefined}
      className={className}
      placeholder={placeholder}
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  if (bare) return input;
  return (
    <label title={hint}>
      {label}
      {input}
    </label>
  );
}

export function Area({
  label,
  value,
  hint,
  rows = 4,
  onChange,
}: {
  label: string;
  value: unknown;
  hint?: string;
  rows?: number;
  onChange: (value: string) => void;
}) {
  return (
    <label title={hint}>
      {label}
      <textarea
        rows={rows}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function Select({
  label,
  value,
  options,
  bare,
  onChange,
}: {
  label: string;
  value: unknown;
  options: string[];
  bare?: boolean;
  onChange: (value: string) => void;
}) {
  const current = value === undefined || value === null ? '' : String(value);
  const select = (
    <select
      aria-label={bare ? label : undefined}
      value={current}
      onChange={(e) => onChange(e.target.value)}
    >
      {!options.includes(current) && <option value={current}>{current || '— choose —'}</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o || '—'}
        </option>
      ))}
    </select>
  );
  if (bare) return select;
  return (
    <label>
      {label}
      {select}
    </label>
  );
}
