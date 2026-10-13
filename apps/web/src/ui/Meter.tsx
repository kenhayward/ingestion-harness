import { TONE_COLOR, type StageTone } from './stageStyle.js';

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** A 0..1 figure as a bar (handoff §0.7): role img, the numbers in its label, a threshold tick. */
export function Meter({
  label,
  value: rawValue,
  threshold,
  min = 0,
  max = 1,
  tone = 'accent',
  showTickWithoutValue = false,
}: {
  label: string;
  value: number | null;
  threshold?: number;
  min?: number;
  max?: number;
  tone?: StageTone;
  /** Draw the threshold tick on an empty track when there is no score. */
  showTickWithoutValue?: boolean;
}) {
  // A figure that is not a number (NaN, Infinity) is no score at all.
  const value = rawValue !== null && Number.isFinite(rawValue) ? rawValue : null;
  const at = (v: number) => {
    const raw = (v - min) / (max - min);
    const share = max > min && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    return `${Math.round(share * 10000) / 100}%`;
  };
  const text = `${label}: ${value === null ? 'no score yet' : percent(value)}${
    threshold === undefined || value === null ? '' : `, threshold ${percent(threshold)}`
  }`;
  return (
    <span className="meter" role="img" aria-label={text}>
      {value !== null && (
        <span className="meter-fill" style={{ width: at(value), background: TONE_COLOR[tone] }} />
      )}
      {(value !== null || showTickWithoutValue) && threshold !== undefined && (
        <span className="meter-tick" style={{ left: at(threshold) }} />
      )}
    </span>
  );
}
