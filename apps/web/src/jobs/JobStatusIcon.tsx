import type { ReactNode } from 'react';
import type { JobStatus } from '@ih/shared';
import { statusIcon, statusLabel, statusTone, type StatusIcon, type Tone } from './derive.js';

/** The glyphs, drawn on an 18 px grid in the status's tone (`currentColor`). */
const GLYPHS: Record<StatusIcon, ReactNode> = {
  spinner: (
    <>
      <circle cx="9" cy="9" r="6.5" className="status-icon-track" />
      <path d="M9 2.5a6.5 6.5 0 0 1 6.5 6.5" className="status-icon-arc" />
    </>
  ),
  queued: (
    <>
      <circle cx="9" cy="9" r="6.5" strokeDasharray="2.6 2.2" />
      <path d="M9 5.5V9l2.2 1.5" />
    </>
  ),
  review: (
    <>
      <circle cx="9" cy="9" r="8" className="status-icon-soft" />
      <path d="M3.8 9s1.9-3.4 5.2-3.4S14.2 9 14.2 9s-1.9 3.4-5.2 3.4S3.8 9 3.8 9Z" />
      <circle cx="9" cy="9" r="1.6" className="status-icon-fill" />
    </>
  ),
  warning: (
    <>
      <path d="M9 2 16.5 15h-15Z" className="status-icon-soft" />
      <path d="M9 7v3.6" />
      <circle cx="9" cy="12.6" r=".95" className="status-icon-fill" />
    </>
  ),
  failed: (
    <>
      <circle cx="9" cy="9" r="8" className="status-icon-solid" />
      <path d="m6.2 6.2 5.6 5.6m0-5.6-5.6 5.6" className="status-icon-mark" />
    </>
  ),
  done: (
    <>
      <circle cx="9" cy="9" r="8" className="status-icon-solid" />
      <path d="m5.6 9.2 2.3 2.3 4.6-4.8" className="status-icon-mark" />
    </>
  ),
  rejected: (
    <>
      <circle cx="9" cy="9" r="7" />
      <path d="m4.3 13.7 9.4-9.4" />
    </>
  ),
  cancelled: (
    <>
      <circle cx="9" cy="9" r="7" />
      <path d="M5.8 9h6.4" />
    </>
  ),
};

/**
 * A job's status as an icon: named for screen readers and on hover, coloured by its tone, its
 * shape distinct for each status (never colour alone). Everything under way is one spinner.
 */
export function JobStatusIcon({ status }: { status: JobStatus }) {
  return (
    <StatusGlyph icon={statusIcon(status)} tone={statusTone(status)} label={statusLabel(status)} />
  );
}

/** One of the status glyphs, named for screen readers and on hover (Conversion uses them too). */
export function StatusGlyph({
  icon,
  tone,
  label,
}: {
  icon: StatusIcon;
  tone: Tone;
  label: string;
}) {
  return (
    <span
      className={`status-icon tone-${tone} status-icon-${icon}`}
      role="img"
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">
        {GLYPHS[icon]}
      </svg>
    </span>
  );
}
