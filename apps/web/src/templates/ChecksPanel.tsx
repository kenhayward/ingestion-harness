import { useId } from 'react';
import type { SubTab, TemplateCheck } from './checks.js';

const TONE_WORD: Record<TemplateCheck['tone'], string> = {
  ok: 'OK',
  warn: 'Needs you',
  alert: 'Stale',
  danger: 'Error',
};

/** The Template tab's Checks (handoff §10): each item says what is wrong and links to the fix. */
export function ChecksPanel({
  checks,
  onOpenSubTab,
}: {
  checks: readonly TemplateCheck[];
  onOpenSubTab: (tab: SubTab) => void;
}) {
  const heading = useId();
  const ok = checks.every((c) => c.tone === 'ok');
  return (
    <section className="card checks-panel" aria-labelledby={heading} data-tone={ok ? 'ok' : 'warn'}>
      <h3 id={heading}>Checks</h3>
      <ul className="checks-list">
        {checks.map((c, i) => (
          <li key={i} data-tone={c.tone}>
            <span className="check-dot" aria-hidden="true" />
            <span>
              <span className="visually-hidden">{TONE_WORD[c.tone]}: </span>
              {c.text}{' '}
              {c.link &&
                ('hash' in c.link ? (
                  <a href={c.link.hash}>{c.link.label}</a>
                ) : (
                  <button
                    type="button"
                    className="link"
                    onClick={() => onOpenSubTab((c.link as { subTab: SubTab }).subTab)}
                  >
                    {c.link.label}
                  </button>
                ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
