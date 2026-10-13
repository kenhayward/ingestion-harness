import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  EMPTY_BRIEF,
  OVERVIEW_LABEL,
  SurveyBodySchema,
  briefDiff,
  type Brief,
  type BriefBody,
  type BriefSection,
  type BriefVersionView,
  type OverviewItem,
  type SurveyBody,
} from '@ih/shared';
import type { Api } from '../api/client.js';
import { relativeTime } from '../jobs/derive.js';
import { Icon } from '../ui/Icon.js';
import {
  BRIEF_HINT,
  BRIEF_LABEL,
  TEXT_SECTIONS,
  briefStatus,
  compareOf,
  csvPreview,
  openQuestions,
  versionChangeText,
  type TextSection,
} from './brief.js';
import { plural } from './samples.js';
import { TabHeader } from './TabHeader.js';

function SectionCard({
  section,
  value,
  edited,
  onChange,
  children,
}: {
  section: TextSection;
  value: string;
  edited: boolean;
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  const id = `brief-${section}`;
  return (
    <section id={`${id}-card`} className={`card brief-card${edited ? ' edited' : ''}`}>
      <div className="brief-card-head">
        <h3>
          <label htmlFor={id}>{BRIEF_LABEL[section]}</label>
        </h3>
        {edited && <span className="edited-tag">edited</span>}
        <span className="muted brief-chars">{value.length} chars</span>
      </div>
      <small id={`${id}-hint`} className="muted">
        {BRIEF_HINT[section]}
      </small>
      <textarea
        id={id}
        aria-describedby={`${id}-hint`}
        className={section === 'exampleOutput' ? 'mono' : undefined}
        rows={5}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {children}
    </section>
  );
}

function ExamplePreview({ text }: { text: string }) {
  const preview = csvPreview(text);
  if (!preview) return null;
  return (
    <div className="brief-preview">
      <p className="muted">
        Preview · {plural(preview.rows.length, 'row')} × {plural(preview.header.length, 'column')}
      </p>
      <div className="table-scroll">
        <table aria-label="Example output preview">
          <thead>
            <tr>
              {preview.header.map((h, i) => (
                <th key={i} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r, i) => (
              <tr key={i}>
                {preview.header.map((_h, j) => (
                  <td key={j}>{r[j] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComparePanel({ from, to, onClose }: { from: Brief; to: Brief; onClose: () => void }) {
  const diff = briefDiff(from.body, to.body);
  return (
    <section
      className="card brief-compare"
      aria-label={`Compare v${from.version} with v${to.version}`}
    >
      <div className="brief-card-head">
        <h3>
          v{from.version} → v{to.version}
        </h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {diff.length === 0 ? (
        <p className="muted">No differences.</p>
      ) : (
        <div className="table-scroll">
          <table aria-label="Changes">
            <thead>
              <tr>
                <th scope="col">Section</th>
                <th scope="col">v{from.version}</th>
                <th scope="col">v{to.version}</th>
              </tr>
            </thead>
            <tbody>
              {diff.map((d) => (
                <tr key={d.section}>
                  <th scope="row">{BRIEF_LABEL[d.section]}</th>
                  <td className="brief-diff-text">{d.before || '—'}</td>
                  <td className="brief-diff-text">{d.after || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The user's product knowledge for this document type; every save is a new version. */
export function BriefTab({
  api,
  projectId,
  brief,
  item,
  onSaved,
  onNavigate,
  aside,
}: {
  api: Api;
  projectId: string;
  brief: Brief | null;
  /** The Brief entry of the project overview (status line); null until it loads. */
  item: OverviewItem | null;
  onSaved: (brief: Brief) => void;
  onNavigate: (hash: string) => void;
  /** The drafting bundle panel, under Versions. */
  aside?: ReactNode;
}) {
  const saved = brief?.body ?? EMPTY_BRIEF;
  const [body, setBody] = useState<BriefBody>(saved);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<BriefVersionView[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [survey, setSurvey] = useState<SurveyBody | null>(null);
  const [compare, setCompare] = useState<{ from: Brief; to: Brief } | null>(null);
  const [now] = useState(() => Date.now());
  const changed = briefDiff(saved, body).map((d) => d.section);

  const loadVersions = useCallback(() => {
    api.listBriefVersions(projectId).then(
      (list) => {
        setVersions(list);
        setVersionsError(null);
      },
      (err: Error) => setVersionsError(err.message),
    );
  }, [api, projectId]);
  useEffect(loadVersions, [loadVersions]);

  useEffect(() => {
    api.listProposals(projectId).then(
      (proposals) => {
        for (const p of proposals) {
          if (p.stage !== 'survey' || (p.status !== 'ready' && p.status !== 'accepted')) continue;
          const parsed = SurveyBodySchema.safeParse(p.body);
          if (parsed.success) {
            setSurvey(parsed.data);
            return;
          }
        }
      },
      () => setSurvey(null), // the empty card still links to Survey
    );
  }, [api, projectId]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveBrief(projectId, body);
      onSaved(next);
      setMessage(`Saved as v${next.version}`);
      loadVersions();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const jump = (section: BriefSection) => {
    const card = document.getElementById(
      section === 'answers' ? 'brief-answers-card' : `brief-${section}-card`,
    );
    card?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    document
      .getElementById(section === 'answers' ? 'brief-answers-card' : `brief-${section}`)
      ?.focus();
  };

  const openCompare = async ([from, to]: [number, number]) => {
    setError(null);
    try {
      const [a, b] = await Promise.all([
        api.getBriefVersion(projectId, from),
        api.getBriefVersion(projectId, to),
      ]);
      setCompare({ from: a, to: b });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const headerItem =
    item && brief
      ? { ...item, status: briefStatus(brief.version, brief.createdAt, changed.length, now) }
      : item;
  const open = survey ? openQuestions(survey, body.answers) : null;
  const card = (section: TextSection, children?: ReactNode) => (
    <SectionCard
      section={section}
      value={body[section]}
      edited={changed.includes(section)}
      onChange={(value) => {
        setMessage(null);
        setBody({ ...body, [section]: value });
      }}
    >
      {children}
    </SectionCard>
  );

  return (
    <div className="brief-tab">
      <TabHeader
        title="Brief"
        item={headerItem}
        description="Everything you know about this document type, in plain words. The model reads it at every drafting stage; each save is a new version."
        actions={
          changed.length > 0 ? (
            <>
              <span className="unsaved-note">
                <span className="unsaved-dot" aria-hidden="true" />
                Unsaved changes
              </span>
              <button type="button" disabled={saving} onClick={() => setBody(saved)}>
                Discard
              </button>
              <button
                type="button"
                className="primary"
                disabled={saving}
                onClick={() => void save()}
              >
                Save as v{(brief?.version ?? 0) + 1}
              </button>
            </>
          ) : undefined
        }
      />
      <nav aria-label="Brief sections" className="brief-nav">
        {TEXT_SECTIONS.map((s) => {
          const filled = body[s].trim() !== '';
          return (
            <button key={s} type="button" className="brief-nav-chip" onClick={() => jump(s)}>
              <span className={`brief-nav-mark${filled ? ' filled' : ''}`} aria-hidden="true">
                {filled ? '✓' : '○'}
              </span>
              {BRIEF_LABEL[s]}
              {!filled && <span className="visually-hidden"> (empty)</span>}
            </button>
          );
        })}
        <button type="button" className="brief-nav-chip" onClick={() => jump('answers')}>
          <span
            className={`brief-nav-mark${body.answers.length ? ' filled' : ' open'}`}
            aria-hidden="true"
          >
            {body.answers.length ? '✓' : '!'}
          </span>
          Survey answers · {body.answers.length}
        </button>
      </nav>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}

      <div className="brief-layout">
        <form aria-label="Brief" className="brief-main" onSubmit={(e) => void save(e)}>
          {compare && (
            <ComparePanel from={compare.from} to={compare.to} onClose={() => setCompare(null)} />
          )}
          {card('purpose')}
          <div className="brief-pair">
            {card('outputs')}
            {card('glossary')}
          </div>
          {card('exampleOutput', <ExamplePreview text={body.exampleOutput} />)}
          <div className="brief-pair">
            {card('variants')}
            {card('rules')}
          </div>
          <section
            id="brief-answers-card"
            tabIndex={-1}
            className={`card brief-answers${body.answers.length ? '' : ' empty'}`}
            aria-labelledby="brief-answers-title"
          >
            <span className="drop-icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <div className="brief-answers-body">
              <h3 id="brief-answers-title">Survey answers</h3>
              {body.answers.length ? (
                <dl>
                  {body.answers.map((a, i) => (
                    <div key={i}>
                      <dt>{a.question}</dt>
                      <dd>{a.answer}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="muted">
                  {open !== null && open > 0
                    ? `None saved yet — the Survey has ${plural(open, 'open question')} about things the brief leaves open.`
                    : 'None saved yet — the Survey stage asks about what the brief leaves open.'}{' '}
                  Answers you save there are stored here, where every later stage reads them.
                </p>
              )}
            </div>
            <button type="button" onClick={() => onNavigate(`#/workbench/${projectId}/survey`)}>
              Open Survey
            </button>
          </section>
        </form>

        <div className="brief-side">
          <section className="card brief-versions" aria-labelledby="brief-versions-title">
            <h3 id="brief-versions-title">Versions</h3>
            {versionsError !== null ? (
              <p role="alert">Could not load the versions: {versionsError}</p>
            ) : versions === null ? (
              <p className="muted">Loading…</p>
            ) : versions.length === 0 ? (
              <p className="muted">No version saved yet.</p>
            ) : (
              <ul aria-label="Versions">
                {versions.map((v, i) => {
                  const pair = compareOf(v.version, versions);
                  return (
                    <li key={v.version} aria-label={`v${v.version}`}>
                      <div className="brief-version-head">
                        <strong>v{v.version}</strong>
                        <span className="muted">{relativeTime(v.createdAt, now)}</span>
                        {i === 0 && <span className="version-tag current">CURRENT</span>}
                        {v.usedBy.map((s) => (
                          <span key={s} className="version-tag">
                            used by {OVERVIEW_LABEL[s]}
                          </span>
                        ))}
                      </div>
                      <p className="muted">{versionChangeText(v)}</p>
                      <button
                        type="button"
                        aria-label={`Compare v${v.version}`}
                        disabled={!pair}
                        title={
                          pair ? `Compare v${pair[0]} with v${pair[1]}` : 'Nothing to compare yet'
                        }
                        onClick={() => pair && void openCompare(pair)}
                      >
                        Compare
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {aside}
        </div>
      </div>
    </div>
  );
}
