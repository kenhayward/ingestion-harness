export type FilterChip<T extends string> = {
  value: T;
  label: string;
  count: number;
  /** warn: the count is always amber (e.g. "Needs attention"). */
  tone?: 'warn';
};

/** One-of-n list filter as pill buttons with counts (aria-pressed). */
export function FilterChips<T extends string>({
  label,
  chips,
  value,
  onChange,
}: {
  label: string;
  chips: readonly FilterChip<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="chips">
      {chips.map((c) => (
        <button
          key={c.value}
          type="button"
          className="chip"
          aria-pressed={c.value === value}
          onClick={() => onChange(c.value)}
        >
          {c.label}
          <span className={c.tone ? `chip-count tone-${c.tone}` : 'chip-count'}>{c.count}</span>
        </button>
      ))}
    </div>
  );
}
