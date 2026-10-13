import { useId, type ReactNode } from 'react';
import type { ChangeBody, DraftChange, ProposalStatus, ProposalView } from '@ih/shared';
import { relativeTime } from '../jobs/derive.js';
import { StageStatusIcon } from '../ui/StageStatusIcon.js';
import { stageStyle, TONE_COLOR, type DisplayState } from '../ui/stageStyle.js';
import { changeDiff, changeLabel, changeParts, changeVerb, type ChangeVerb } from './changes.js';

/** A proposal's status as a stage state: the card's border tone. */
export const PROPOSAL_STATE: Record<ProposalStatus, DisplayState> = {
  running: 'running',
  ready: 'proposed',
  accepted: 'accepted',
  partially_accepted: 'accepted',
  rejected: 'pending',
  failed: 'warn',
};

const VERB_TONE: Record<ChangeVerb, string> = { NEW: 'ok', CHANGED: 'info', REMOVED: 'danger' };

export interface NextStep {
  href: string;
  label: string;
  text: string;
}

function ChangeText({ c }: { c: DraftChange }) {
  const parts = changeParts(c);
  return (
    <>
      <span className={`kind-tag tone-${parts.tone}`}>{parts.kind}</span>
      {parts.id && <code>{parts.id}</code>} {parts.text}
    </>
  );
}

/** Handoff §0.2: the drafting proposal; after a decision, the applied card. */
export function ProposalCard({
  projectId,
  proposal,
  body,
  definition,
  draftVersion,
  selected,
  onToggle,
  onApply,
  onReject,
  busy,
  applyBlockedReason,
  now,
  note,
  next,
  badge,
  footerNote,
}: {
  projectId: string;
  proposal: ProposalView;
  body: ChangeBody;
  /** The open draft: NEW/CHANGED tags and diff chips while the proposal is ready; null hides them. */
  definition: Record<string, unknown> | null;
  draftVersion: number | null;
  selected: ReadonlySet<number>;
  onToggle: (index: number) => void;
  onApply: () => void;
  onReject: () => void;
  busy: boolean;
  /** Apply is disabled and this says why (e.g. unsaved edits elsewhere). */
  applyBlockedReason?: string | null;
  now: number;
  /** A muted line under a change (sections: where the anchor was found). */
  note?: (c: DraftChange) => string | null;
  /** The next action on the applied card. */
  next?: NextStep;
  /** Beside each change while ready (revise: the "Answers 1" badge); null draws nothing. */
  badge?: (c: DraftChange, index: number) => ReactNode;
  /** A muted line in the footer, next to Apply and Reject. */
  footerNote?: string;
}) {
  const idBase = useId();
  const border = TONE_COLOR[stageStyle(PROPOSAL_STATE[proposal.status]).tone];
  const meta = (
    <p>
      <code>{proposal.model ?? '—'}</code> · brief v{proposal.briefVersion ?? '–'} ·{' '}
      {proposal.status.replace('_', ' ')} · {relativeTime(proposal.createdAt, now)}
    </p>
  );

  if (proposal.status !== 'ready') {
    const applied = proposal.acceptedChanges ?? [];
    const accepted = proposal.status === 'accepted' || proposal.status === 'partially_accepted';
    return (
      <section
        aria-label="Proposal"
        className="proposal-card proposal-decided"
        style={{ borderColor: border }}
      >
        <div className={accepted ? 'proposal-meta proposal-applied' : 'proposal-meta'}>
          {accepted && (
            <div role="status">
              <h3>
                {`${applied.length} of ${body.changes.length} changes applied${draftVersion === null ? '' : ` to draft v${draftVersion}`}`}
              </h3>
            </div>
          )}
          {proposal.status === 'rejected' && <h3>Proposal rejected</h3>}
          {accepted && next && (
            <>
              <p>{next.text}</p>
              <a className="button primary" href={next.href}>
                {next.label}
              </a>
            </>
          )}
        </div>
        <details className="proposal-history">
          <summary>Latest proposal</summary>
          <div className="proposal-meta">
            {meta}
            {body.notes && <p>{body.notes}</p>}
          </div>
          <ul className="proposal-changes proposal-decided-list">
            {body.changes.map((c, i) => {
              const done = applied.includes(i);
              return (
                <li key={`${i}-${c.op}`}>
                  <StageStatusIcon state={done ? 'accepted' : 'pending'} size={18} decorative />
                  <span className="proposal-change">
                    <span className="proposal-line">
                      <ChangeText c={c} />{' '}
                      <strong className={done ? 'applied-yes' : 'muted'}>
                        {done ? 'Applied' : 'Not applied'}
                      </strong>
                    </span>
                    <span className="proposal-line muted">{c.reason}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      </section>
    );
  }

  return (
    <section aria-label="Proposal" className="proposal-card" style={{ borderColor: border }}>
      <div className="proposal-meta proposal-ready">
        <h3>
          Proposal · {selected.size} of {body.changes.length} changes selected
        </h3>
        {meta}
        {body.notes && <p>{body.notes}</p>}
      </div>
      <ul className="proposal-changes">
        {body.changes.map((c, i) => {
          const verb = definition ? changeVerb(c, definition) : null;
          const diff = definition ? changeDiff(c, definition) : null;
          const line = note?.(c) ?? null;
          const badgeNode = badge?.(c, i);
          return (
            <li key={`${i}-${c.op}`}>
              <input
                id={`${idBase}-${i}`}
                type="checkbox"
                aria-label={`Apply: ${changeLabel(c)}`}
                checked={selected.has(i)}
                onChange={() => onToggle(i)}
              />
              <label className="proposal-change" htmlFor={`${idBase}-${i}`}>
                <span className="proposal-line">
                  {verb && <span className={`kind-tag tone-${VERB_TONE[verb]}`}>{verb}</span>}
                  <ChangeText c={c} />
                </span>
                {diff && <code className="diff-chip">{diff}</code>}
                <span className="proposal-line muted">{c.reason}</span>
                {line && <span className="proposal-line muted">{line}</span>}
              </label>
              {badgeNode != null && <span className="proposal-badge">{badgeNode}</span>}
              <details>
                <summary>Details</summary>
                <pre>{JSON.stringify(c, null, 2)}</pre>
              </details>
            </li>
          );
        })}
      </ul>
      <footer className="proposal-footer">
        <button
          type="button"
          className="primary"
          disabled={busy || selected.size === 0 || !!applyBlockedReason}
          title={
            applyBlockedReason ?? (selected.size === 0 ? 'Select a change to apply' : undefined)
          }
          onClick={onApply}
        >
          Apply {selected.size} selected {selected.size === 1 ? 'change' : 'changes'}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={onReject}>
          Reject all
        </button>
        {footerNote && <span className="muted proposal-footer-note">{footerNote}</span>}
        <a className="proposal-edit" href={`#/workbench/${projectId}/template`}>
          Edit by hand on the Template tab
        </a>
      </footer>
    </section>
  );
}
