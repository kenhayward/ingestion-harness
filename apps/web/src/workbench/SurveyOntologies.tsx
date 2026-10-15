import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  EMPTY_BRIEF,
  type Brief,
  type BriefBody,
  type DataPolicy,
  type OntologySuggestion,
  type OntologySuggestionsView,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { keepDraft, loadKept } from '../ui/keptDraft.js';
import { BriefOntologies } from './BriefOntologies.js';
import { pinState, staleText, uncoveredHints, withPin } from './suggestions.js';

/**
 * The Survey tab's Ontologies section: the survey's suggestions (pin a vocabulary with one click,
 * evidence on demand, Refresh when stale) and the manual picker moved from the Brief. Both save
 * straight into the brief (`brief.ontologies`), as survey answers do.
 */
export function SurveyOntologies({
  api,
  projectId,
  dataPolicy,
  brief,
  onBriefSaved,
  saveBrief,
  briefBusy = false,
  surveyKey = '',
  pollMs,
  retired,
  hasSurvey,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  brief: Brief | null;
  onBriefSaved: (brief: Brief) => void;
  /** The tab's one-at-a-time brief save (null: another save is in flight); default: save here. */
  saveBrief?: (next: BriefBody) => Promise<Brief | null>;
  /** Another brief save on the tab is in flight. */
  briefBusy?: boolean;
  /** The survey proposal's id and status: the suggestions are read again when it changes. */
  surveyKey?: string;
  pollMs: number;
  retired: string | null;
  hasSurvey: boolean;
}) {
  const titleId = useId();
  const [view, setView] = useState<OntologySuggestionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const body = brief?.body ?? null;
  const savedGuidance = body?.ontologyGuidance ?? '';
  const keptKey = `ih.ontologyGuidance.${projectId}`;
  // Unsaved guidance survives leaving the tab (ui/keptDraft.ts), as the Brief's did.
  const [restored] = useState(() => {
    const kept = loadKept(keptKey, (v) => (typeof v === 'string' ? v : null));
    return kept && kept.value !== savedGuidance ? kept.value : null;
  });
  const [guidance, setGuidance] = useState(restored ?? savedGuidance);
  useEffect(() => {
    keepDraft(
      keptKey,
      guidance !== savedGuidance ? { base: brief?.version ?? null, value: guidance } : null,
    );
  }, [keptKey, guidance, savedGuidance, brief?.version]);

  const load = useCallback(
    () => api.getOntologySuggestions(projectId).then(setView, (e: Error) => setError(e.message)),
    // surveyKey: a survey that finishes, or is decided, on the open tab brings new suggestions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, projectId, surveyKey],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!view?.running) return;
    const t = setTimeout(() => void load(), pollMs);
    return () => clearTimeout(t);
  }, [view, load, pollMs]);

  const busy = saving || briefBusy;
  const save = async (next: BriefBody): Promise<boolean> => {
    if (lock.current || briefBusy) return false;
    lock.current = true;
    setSaving(true);
    setError(null);
    try {
      if (saveBrief) return (await saveBrief(next)) !== null;
      onBriefSaved(await api.saveBrief(projectId, next));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  const refresh = async () => {
    setError(null);
    try {
      setView(await api.refreshOntologySuggestions(projectId));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const record = view?.record ?? null;
  const base = body ?? EMPTY_BRIEF;
  return (
    <section id="survey-ontologies" className="card survey-ontologies" aria-labelledby={titleId}>
      <h3 id={titleId}>Ontologies</h3>
      <p className="muted">
        Vocabularies the Mapping stage draws its terms from. Suggestions come from the survey&apos;s
        candidate data and the ontology library; nothing is pinned until you pin it.
      </p>
      {error && <p role="alert">{error}</p>}
      {view?.failed && <p role="alert">The refresh failed: {view.failed}</p>}
      {view?.running && <p className="muted">Refreshing the suggestions…</p>}
      {view?.stale && !view.running && (
        <div className="banner tone-warn">
          <span>{staleText(view.stale)}</span>
        </div>
      )}
      {!hasSurvey && !record ? (
        <p className="muted">Run the survey to get suggestions.</p>
      ) : (
        hasSurvey && (
          <button
            type="button"
            disabled={retired !== null || view?.running === true}
            title={retired ?? undefined}
            onClick={() => void refresh()}
          >
            Refresh suggestions
          </button>
        )
      )}
      {record && (
        <>
          {record.suggestions.length === 0 && (
            <p className="muted">No library ontology covers enough of the candidates.</p>
          )}
          <div className="suggestion-grid">
            {record.suggestions.map((s) => (
              <SuggestionCard
                key={`${s.ontologyId}@${s.version}`}
                s={s}
                of={record.candidates}
                state={pinState(s, base)}
                disabled={busy || retired !== null}
                reason={retired}
                onPin={() => void save(withPin(base, s.ontologyId, s.version))}
              />
            ))}
          </div>
          {record.alsoMatched.length > 0 && (
            <details open className="also-matched">
              <summary>Also matched ({record.alsoMatched.length})</summary>
              <ul>
                {record.alsoMatched.map((m) => {
                  const name = `${m.label} v${m.version}`;
                  const state = pinState(m, base);
                  return (
                    <li key={`${m.ontologyId}@${m.version}`} aria-label={name}>
                      <span>
                        <strong>{name}</strong> ·{' '}
                        {m.adds.length
                          ? `adds ${m.adds.length}: ${m.adds.join(', ')}`
                          : `covers ${m.covers.length}: ${m.covers.join(', ')}`}
                        {m.evidence.length > 0 && (
                          <span className="muted">
                            {' '}
                            ({m.evidence.map((e) => `${e.candidate} → ${e.label}`).join('; ')})
                          </span>
                        )}
                      </span>
                      {state.kind === 'pinned' ? (
                        <span className="tone-ok">
                          <Icon name="check" /> Pinned
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || retired !== null}
                          title={retired ?? undefined}
                          aria-label={
                            state.kind === 'older'
                              ? `Use v${m.version} of ${m.label}`
                              : `Pin ${name}`
                          }
                          onClick={() => void save(withPin(base, m.ontologyId, m.version))}
                        >
                          {state.kind === 'older'
                            ? `v${state.pinned} pinned · use v${m.version}`
                            : 'Pin'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          {record.uncovered.length > 0 && (
            <div className="muted">
              <p>Not covered by the suggestions: {record.uncovered.join(', ')}</p>
              {uncoveredHints(record).map((hint) => (
                <p key={hint}>{hint}</p>
              ))}
            </div>
          )}
          {record.notes.map((n) => (
            <p key={n} className="muted">
              {n}
            </p>
          ))}
        </>
      )}
      <BriefOntologies
        title="Pinned ontologies"
        api={api}
        ontologies={base.ontologies ?? []}
        guidance={guidance}
        dataPolicy={dataPolicy}
        onChange={(next) => {
          if (JSON.stringify(next.ontologies) !== JSON.stringify(base.ontologies ?? [])) {
            void save({ ...base, ontologies: next.ontologies });
          }
          setGuidance(next.ontologyGuidance);
        }}
      />
      {busy && <p className="muted">Saving to the brief…</p>}
      {restored !== null && guidance === restored && guidance !== savedGuidance && (
        <p className="kept-note">Restored your unsaved guidance from your last visit.</p>
      )}
      {guidance !== savedGuidance && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void save({ ...base, ontologyGuidance: guidance })}
        >
          Save guidance
        </button>
      )}
    </section>
  );
}

function SuggestionCard({
  s,
  of,
  state,
  disabled,
  reason,
  onPin,
}: {
  s: OntologySuggestion;
  of: number;
  state: ReturnType<typeof pinState>;
  disabled: boolean;
  reason: string | null;
  onPin: () => void;
}) {
  const [open, setOpen] = useState(false);
  const name = `${s.label} v${s.version}`;
  return (
    <article className="suggestion-card" aria-label={name}>
      <h4>
        <a href={`#/ontologies/${encodeURIComponent(s.ontologyId)}`}>{s.label}</a>{' '}
        <span className="version-tag">v{s.version}</span>
      </h4>
      <p>{`covers ${s.covers.length} of ${of} candidates`}</p>
      <ul className="suggestion-chips" aria-label={`Candidates ${name} covers`}>
        {s.covers.map((c) => (
          <li key={c} className="suggestion-chip">
            {c}
          </li>
        ))}
      </ul>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Evidence
      </button>
      {open && (
        <ul className="suggestion-evidence">
          {s.evidence.map((e) => (
            <li key={`${e.candidate}:${e.iri}`}>
              {e.candidate} → {e.label}{' '}
              <span className="muted">
                ({e.kind}, {e.via})
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        {state.kind === 'pinned' ? (
          <span className="tone-ok">
            <Icon name="check" /> Pinned
          </span>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={disabled}
            title={reason ?? undefined}
            aria-label={state.kind === 'older' ? `Use v${s.version} of ${s.label}` : `Pin ${name}`}
            onClick={onPin}
          >
            {state.kind === 'older' ? `v${state.pinned} pinned · use v${s.version}` : 'Pin'}
          </button>
        )}
      </div>
    </article>
  );
}
