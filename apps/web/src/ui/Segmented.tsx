import { Icon, type IconName } from './Icon.js';

export type SegmentedOption<T extends string> = { value: T; label: string; icon?: IconName };

/** One-of-n choice as a group of toggle buttons (aria-pressed): colour mode, token expiry, … */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  title,
}: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Every option off (e.g. a role you may not change), with `title` saying why. */
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div role="group" aria-label={label} className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          title={title}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
