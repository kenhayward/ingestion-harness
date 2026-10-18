import { useId, useState } from 'react';
import { applyChanges, type DraftChange, type OutputMapping, type Semantics } from '@ih/shared';
import type { Api } from '../api/client.js';
import { draftingModelName, relativeTime } from '../jobs/derive.js';
import {
  compactIri,
  EMPTY_SEMANTICS,
  nameOf,
  outlineItems,
  STATUS_WORD,
  useTermLabels,
  type ItemKey,
  type OutlineItem,
} from '../templates/MappingEditor.js';
import { changeLabel } from './changes.js';
import { ModelLogButton } from './DraftLogDialog.js';
import type { ReviewState } from './StagePanel.js';

type Def = Record<string, unknown>;
type Verb = 'NEW' | 'CHANGED' | 'REMOVED';
type Filter = 'all' | 'proposed' | 'unmapped';
type Confidence = 'high' | 'medium' | 'low';

const VERB_TONE: Record<Verb, string> = { NEW: 'ok', CHANGED: 'info', REMOVED: 'danger' };
const CONFIDENCE: Confidence[] = ['high', 'medium', 'low'];

interface Meta {
  confidence?: Confidence;
  evidence?: string[];
  alternatives?: { iri: string; label: string; score: number }[];
  reason: string;
}
const meta = (c: DraftChange): Meta => c as unknown as Meta;

/** The recipe's semantics with every part present (a draft may leave parts out). */
function full(def: Def | null): Semantics {
  const s = (def?.semantics ?? null) as Partial<Semantics> | null;
  if (!s) return EMPTY_SEMANTICS;
  return {
    ...EMPTY_SEMANTICS,
    ...s,
    document: { ...EMPTY_SEMANTICS.document, ...s.document },
    fields: s.fields ?? {},
    tables: s.tables ?? {},
  } as Semantics;
}

const isOutput = (key: ItemKey) => key.startsWith('field:') || key.startsWith('column:');

/** The outline item a change belongs to: where its checkbox sits. */
function changeKey(c: DraftChange, s: Semantics, fieldIds: string[]): ItemKey | null {
  switch (c.op) {
    case 'setDocumentMapping':
      return 'document';
    case 'putFieldMapping':
      return `field:${c.field}`;
    case 'putTableMapping':
      return `table:${c.table}`;
    case 'removeMapping':
      if (c.id.includes('.')) return `column:${c.id}`;
      return fieldIds.includes(c.id) || s.fields[c.id] ? `field:${c.id}` : `table:${c.id}`;
    case 'putLocalTerm':
      return 'local';
    default:
      return null;
  }
}

/** The part of the semantics an outline item shows: compared to find what a proposal changes. */
function part(key: ItemKey, s: Semantics): unknown {
  if (key.startsWith('field:')) return s.fields[key.slice(6)];
  if (key.startsWith('table:')) {
    const t = s.tables[key.slice(6)];
    return t ? { link: t.link, class: t.class, iri: t.iri } : undefined;
  }
  if (key.startsWith('column:')) {
    const [table, column] = key.slice(7).split('.', 2) as [string, string];
    return s.tables[table]?.columns[column];
  }
  return (s as unknown as Record<string, unknown>)[key === 'local' ? 'local' : key];
}

/** One line of the now/proposed comparison: a label and a term (or plain text), or nothing. */
interface Fact {
  label: string;
  value?: string;
  /** A term: shown by its readable name, with the CURIE under it. */
  term?: boolean;
  /** Words, not an identifier: not in the mono face. */
  plain?: boolean;
  /** What an empty value means (else a dash). */
  empty?: string;
}

const VALUE_AS: Record<string, string> = {
  literal: 'Literal',
  entity: 'Entity',
  concept: 'Concept',
  node: 'Value node',
};

function outputFacts(m: OutputMapping | undefined, enumValues: string[] | null): Fact[] {
  if (!m) return [{ label: 'Property', empty: 'Default vocabulary' }];
  const as = m.node ? 'node' : m.object ? 'entity' : m.concepts ? 'concept' : 'literal';
  const facts: Fact[] = [{ label: 'Value as', value: VALUE_AS[as], plain: true }];
  facts.push(
    m.node
      ? { label: 'Link', value: m.property, term: true, empty: 'The value-node default' }
      : { label: 'Property', value: m.property, term: true },
  );
  if (m.object) {
    facts.push({ label: 'Entity class', value: m.object.class, term: true });
    facts.push({ label: 'IRI template', value: m.object.iri });
  }
  if (m.concepts) {
    if (enumValues) {
      for (const v of enumValues)
        facts.push({ label: v, value: m.concepts.values?.[v], term: true, empty: 'No concept' });
    } else {
      facts.push({ label: 'Concept scheme', value: m.concepts.scheme, term: true });
    }
  }
  if (m.node) {
    facts.push({ label: 'Node class', value: m.node.class, term: true });
    if (m.node.value) facts.push({ label: 'Value property', value: m.node.value, term: true });
    if (m.node.unit) facts.push({ label: 'Unit', value: m.node.unit, term: true });
  }
  return facts;
}

interface OutputDef {
  id: string;
  type?: string;
  enum?: string[];
}
const enumOf = (o: OutputDef | undefined) => (o?.type === 'enum' ? (o.enum ?? []) : null);

function facts(
  key: ItemKey,
  s: Semantics,
  fields: OutputDef[],
  tables: { id: string; columns?: OutputDef[] }[],
): Fact[] {
  if (key.startsWith('field:')) {
    const id = key.slice(6);
    return outputFacts(s.fields[id], enumOf(fields.find((f) => f.id === id)));
  }
  if (key.startsWith('column:')) {
    const [table, column] = key.slice(7).split('.', 2) as [string, string];
    const def = tables.find((t) => t.id === table)?.columns?.find((c) => c.id === column);
    return outputFacts(s.tables[table]?.columns[column], enumOf(def));
  }
  if (key.startsWith('table:')) {
    const t = s.tables[key.slice(6)];
    return [
      { label: 'Link from the document', value: t?.link || undefined, term: true },
      { label: 'Row class', value: t?.class || undefined, term: true },
      { label: 'Row IRI template', value: t?.iri },
    ];
  }
  switch (key) {
    case 'document':
      return [
        { label: 'Document class', value: s.document.class || undefined, term: true },
        { label: 'Document IRI template', value: s.document.iri },
      ];
    case 'ontologies':
    case 'shapes':
      return [
        {
          label: 'Pinned',
          value: s[key].map((p) => `${p.id} v${p.version}`).join(' · ') || undefined,
        },
      ];
    case 'prefixes':
      return Object.entries(s.prefixes).map(([p, iri]) => ({ label: p, value: iri }));
    case 'valueNodes':
      return [
        { label: 'Link', value: s.valueNodes?.link, term: true },
        { label: 'Value property', value: s.valueNodes?.value, term: true },
        { label: 'Unit property', value: s.valueNodes?.unitProperty, term: true },
      ];
    case 'local':
      return s.local.map((t) => ({ label: t.label, value: t.iri, term: true }));
    default:
      return [];
  }
}

/** Every label either side has: in the proposal's order, then what only the mapping now has. */
function rows(now: Fact[], proposed: Fact[]) {
  const labels = proposed.map((f) => f.label);
  for (const f of now) if (!labels.includes(f.label)) labels.push(f.label);
  return labels.map((label) => ({
    label,
    now: now.find((f) => f.label === label),
    proposed: proposed.find((f) => f.label === label),
  }));
}

/**
 * The Workbench Mapping stage as the Recipe tab's outline: with a ready proposal, each output it
 * touches carries its change (a checkbox, NEW / CHANGED) and the inspector puts the mapping now
 * beside the proposed one with the model's confidence, reason, the values seen and the terms it
 * was chosen over; without one, the mapping as it is, read-only. Edits happen on the Recipe tab.
 */
export function MappingReview({
  api,
  projectId,
  definition,
  review,
  now = Date.now(),
}: {
  api: Api;
  projectId: string;
  definition: Def | null;
  review: ReviewState | null;
  now?: number;
}) {
  const uid = useId();
  const changes = review?.body.changes ?? [];
  const selected = review?.selected ?? new Set<number>();
  const base = definition ?? {};
  const nowS = full(definition);
  const proposedS = changes.length ? full(applyChanges(base, changes)) : nowS;
  const afterS = changes.length
    ? full(
        applyChanges(
          base,
          changes.filter((_, i) => selected.has(i)),
        ),
      )
    : nowS;

  const nowLabels = useTermLabels(api, nowS);
  const proposedLabels = useTermLabels(api, proposedS);
  const name = (term: string) => {
    const n = nameOf(proposedLabels, term);
    return n !== term ? n : nameOf(nowLabels, term);
  };

  const outputs = (definition?.outputs ?? {}) as {
    fields?: OutputDef[];
    tables?: { id: string; columns?: OutputDef[] }[];
  };
  const fields = outputs.fields ?? [];
  const tables = outputs.tables ?? [];
  const items = outlineItems(name, nowS, fields, tables, false);
  const afterItems = outlineItems(name, afterS, fields, tables, false);
  const proposedItems = outlineItems(name, proposedS, fields, tables, false);
  const fieldIds = fields.map((f) => f.id);

  // Which changes sit on which item, and what the proposal does to each item.
  const byKey = new Map<ItemKey, number[]>();
  changes.forEach((c, i) => {
    const key = changeKey(c, nowS, fieldIds);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), i]);
  });
  const verbOf = (i: OutlineItem): Verb | null => {
    if (!changes.length) return null;
    const before = part(i.key, nowS);
    const after = part(i.key, proposedS);
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return null;
    if (before === undefined || i.status === 'none') return 'NEW';
    const p = proposedItems.find((x) => x.key === i.key);
    return after === undefined || p?.status === 'none' ? 'REMOVED' : 'CHANGED';
  };
  const proposedKeys = items.filter((i) => byKey.has(i.key) || verbOf(i)).map((i) => i.key);
  const unmappedKeys = items
    .filter((i) => isOutput(i.key) && i.status === 'none')
    .map((i) => i.key);

  const [filter, setFilter] = useState<Filter>('all');
  const [picked, setPicked] = useState<ItemKey | null>(null);
  const opening =
    proposedKeys[0] ??
    items.find((i) => isOutput(i.key) && i.status !== 'ok')?.key ??
    items.find((i) => isOutput(i.key))?.key ??
    'document';
  const key = picked && items.some((i) => i.key === picked) ? picked : opening;
  const shown = items.filter((i) =>
    filter === 'proposed'
      ? proposedKeys.includes(i.key)
      : filter === 'unmapped'
        ? unmappedKeys.includes(i.key)
        : true,
  );
  const item = items.find((i) => i.key === key)!;
  const at = shown.findIndex((i) => i.key === key);
  const prev = at >= 0 ? shown[at - 1] : undefined;
  const next = at >= 0 ? shown[at + 1] : shown[0];

  const outs = items.filter((i) => isOutput(i.key));
  const mappedNow = outs.filter((i) => i.status === 'ok').length;
  const mappedAfter = afterItems.filter((i) => isOutput(i.key) && i.status === 'ok').length;

  const count = (c: Confidence) => changes.filter((x) => meta(x).confidence === c).length;
  const chosen = changes.filter((_, i) => selected.has(i)).length;

  const groups = (['Setup', 'Fields', 'Tables', 'More'] as const)
    .map((g) => [g, shown.filter((i) => i.group === g)] as const)
    .filter(([, list]) => list.length > 0);

  const termCell = (f: Fact | undefined, fallback: string) => {
    if (!f?.value) return <span className="muted">{fallback}</span>;
    if (f.plain) return <span>{f.value}</span>;
    if (!f.term) return <code>{f.value}</code>;
    const n = name(f.value);
    return n !== f.value ? (
      <>
        <span className="mapping-term-name">{n}</span>
        <code>{f.value}</code>
      </>
    ) : (
      <code>{f.value}</code>
    );
  };

  const own = byKey.get(key) ?? [];
  const verb = verbOf(item);
  const owner =
    !own.length && verb && key.startsWith('column:')
      ? items.find((i) => i.key === `table:${key.slice(7).split('.', 1)[0]}`)
      : undefined;
  const compare = rows(
    facts(key, nowS, fields, tables),
    facts(key, proposedS, fields, tables),
  ).filter(
    (r) =>
      r.now?.value ||
      r.proposed?.value ||
      r.proposed?.empty ||
      (!r.proposed && r.now?.empty && !verb),
  );

  return (
    <div className="mapping-editor mapping-review">
      {review && (
        <section className="mapping-proposal-bar" aria-label="Proposal">
          <span className="kind-tag tone-info">Proposal</span>
          <span className="mapping-proposal-what">
            <strong>
              {changes.length} change{changes.length === 1 ? '' : 's'}
            </strong>{' '}
            · {draftingModelName(review.proposal.model, review.models)} ·{' '}
            {relativeTime(review.proposal.createdAt, now)}{' '}
            <ModelLogButton api={api} projectId={projectId} proposalId={review.proposal.id} />
          </span>
          <span className="mapping-confidence-counts">
            {CONFIDENCE.filter((c) => count(c) > 0).map((c) => (
              <span key={c} className={`confidence confidence-${c}`}>
                <ConfidenceBars level={c} /> {count(c)} {c}
              </span>
            ))}
          </span>
          <span className="mapping-proposal-actions">
            <span className="muted">
              {chosen} of {changes.length} selected
            </span>
            <button
              type="button"
              className="danger"
              disabled={review.busy}
              onClick={review.onReject}
            >
              Reject all
            </button>
            <button
              type="button"
              className="primary"
              disabled={review.busy || chosen === 0 || review.blockedReason !== null}
              title={review.blockedReason ?? undefined}
              onClick={review.onApply}
            >
              Apply {chosen} selected change{chosen === 1 ? '' : 's'}
            </button>
          </span>
          {review.body.notes && <p className="mapping-proposal-notes">{review.body.notes}</p>}
        </section>
      )}
      <div className="mapping-split">
        <nav className="mapping-outline" aria-label="Mapping outline">
          {review && (
            <div role="group" aria-label="Show" className="segmented mapping-filter">
              {(
                [
                  ['all', 'All'],
                  ['proposed', `Proposed · ${proposedKeys.length}`],
                  ['unmapped', `Unmapped · ${unmappedKeys.length}`],
                ] as const
              ).map(([f, text]) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {text}
                </button>
              ))}
            </div>
          )}
          {groups.map(([g, list]) => {
            const groupOuts = list.filter((i) => isOutput(i.key));
            const after = afterItems.filter(
              (i) => isOutput(i.key) && groupOuts.some((o) => o.key === i.key),
            );
            const okNow = groupOuts.filter((i) => i.status === 'ok').length;
            const okAfter = after.filter((i) => i.status === 'ok').length;
            return (
              <div key={g} className="mapping-outline-group">
                <p className="mapping-outline-head">
                  <span>{g}</span>
                  {groupOuts.length > 0 && (
                    <span>
                      {okNow} of {groupOuts.length}
                      {review && okAfter !== okNow && ` → ${okAfter} of ${groupOuts.length}`}
                    </span>
                  )}
                </p>
                <ul>
                  {list.map((i) => {
                    const idx = byKey.get(i.key) ?? [];
                    const v = verbOf(i);
                    const on = idx.length > 0 && idx.every((n) => selected.has(n));
                    return (
                      <li key={i.key} className={review ? 'with-check' : undefined}>
                        {review && (
                          <span className="mapping-check">
                            {idx.length > 0 && (
                              <input
                                type="checkbox"
                                aria-label={`Apply: ${idx.map((n) => changeLabel(changes[n]!)).join('; ')}`}
                                checked={on}
                                disabled={review.busy}
                                onChange={() => review.onSelect(idx, !on)}
                              />
                            )}
                          </span>
                        )}
                        <button
                          type="button"
                          className={i.indent ? 'indent' : undefined}
                          aria-label={i.label}
                          aria-current={i.key === key ? 'true' : undefined}
                          aria-describedby={`${uid}-${i.key}`}
                          onClick={() => setPicked(i.key)}
                        >
                          <span className={`map-dot map-${i.status}`} aria-hidden="true" />
                          <span className={i.output ? 'mapping-item mono' : 'mapping-item'}>
                            {i.text}
                          </span>
                          <span id={`${uid}-${i.key}`} className="mapping-summary">
                            {v ? (
                              <span className={`kind-tag tone-${VERB_TONE[v]}`}>{v}</span>
                            ) : i.status === 'none' && i.output ? (
                              <span className="kind-tag tone-neutral">unmapped</span>
                            ) : (
                              i.summary
                            )}
                            <span className="visually-hidden">{` (${STATUS_WORD[i.status]})`}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {groups.length === 0 && <p className="muted mapping-outline-empty">Nothing to show.</p>}
        </nav>
        <section className="mapping-inspector" aria-label={item.label}>
          <header className="mapping-inspector-head">
            <span className={`map-dot map-${item.status}`} aria-hidden="true" />
            <h3 className={item.output ? 'mono' : undefined}>{item.text}</h3>
            {item.kind && <span className="kind-tag tone-info">{item.kind}</span>}
            {verb && (
              <span className="kind-tag tone-neutral">
                {item.status === 'none' ? 'not mapped now' : `now ${STATUS_WORD[item.status]}`}
              </span>
            )}
            <span className="mapping-step">
              <button
                type="button"
                className="small ghost"
                disabled={!prev}
                aria-label={prev ? `Previous: ${prev.label}` : 'Previous'}
                onClick={() => prev && setPicked(prev.key)}
              >
                ‹ {prev?.text ?? ''}
              </button>
              <button
                type="button"
                className="small ghost"
                disabled={!next}
                aria-label={next ? `Next: ${next.label}` : 'Next'}
                onClick={() => next && setPicked(next.key)}
              >
                {next?.text ?? ''} ›
              </button>
            </span>
          </header>
          <div className="mapping-body">
            {compare.length > 0 && (
              <table
                className={verb ? 'mapping-compare' : 'mapping-compare single'}
                aria-label={verb ? 'Now and proposed' : 'Mapping'}
              >
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="visually-hidden">Part</span>
                    </th>
                    <th scope="col">{verb ? 'Now' : review ? 'Unchanged' : 'Now'}</th>
                    {verb && (
                      <>
                        <th scope="col" aria-hidden="true" />
                        <th scope="col">Proposed</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {compare.map((r) => {
                    const differs = (r.now?.value ?? '') !== (r.proposed?.value ?? '');
                    return (
                      <tr key={r.label}>
                        <th scope="row">{r.label}</th>
                        <td className="mapping-now">{termCell(r.now, r.now?.empty ?? '—')}</td>
                        {verb && (
                          <>
                            <td className="mapping-arrow" aria-hidden="true">
                              {differs ? '→' : ''}
                            </td>
                            <td
                              className={differs ? 'mapping-proposed differs' : 'mapping-proposed'}
                            >
                              {termCell(r.proposed, r.proposed?.empty ?? '—')}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {review && !own.length && !verb && (
              <p className="muted">The proposal leaves this as it is.</p>
            )}
            {owner && (
              <p className="muted">
                Changed with {owner.label}: apply it there.{' '}
                <button type="button" className="link" onClick={() => setPicked(owner.key)}>
                  Open {owner.label}
                </button>
              </p>
            )}
            {review &&
              own.map((n) => {
                const c = changes[n]!;
                const m = meta(c);
                return (
                  <div key={n} className="mapping-why">
                    <dl>
                      {m.confidence && (
                        <>
                          <dt>Confidence</dt>
                          <dd className={`confidence confidence-${m.confidence}`}>
                            <ConfidenceBars level={m.confidence} /> {m.confidence}
                          </dd>
                        </>
                      )}
                      {m.reason && (
                        <>
                          <dt>Why</dt>
                          <dd>{m.reason}</dd>
                        </>
                      )}
                      {m.evidence?.length ? (
                        <>
                          <dt>Seen in samples</dt>
                          <dd className="evidence-chips">
                            {m.evidence.map((e) => (
                              <span key={e} className="evidence-chip mono">
                                {e}
                              </span>
                            ))}
                          </dd>
                        </>
                      ) : null}
                      {m.alternatives?.length ? (
                        <>
                          <dt>Chosen over</dt>
                          <dd className="evidence-chips">
                            {m.alternatives.map((a) => (
                              <span key={a.iri} className="evidence-chip" title={a.iri}>
                                <span>{a.label}</span>{' '}
                                <code>{compactIri(a.iri, proposedS.prefixes)}</code>
                              </span>
                            ))}
                          </dd>
                        </>
                      ) : null}
                    </dl>
                    <label className="inline mapping-apply">
                      <input
                        type="checkbox"
                        aria-label={`Apply this change: ${changeLabel(c)}`}
                        checked={selected.has(n)}
                        disabled={review.busy}
                        onChange={() => review.onSelect([n], !selected.has(n))}
                      />
                      <strong>Apply this change</strong>
                      <span className="muted">
                        {' '}
                        · {chosen} of {changes.length} selected
                      </span>
                    </label>
                  </div>
                );
              })}
          </div>
        </section>
      </div>
      <div className="mapping-foot">
        <span
          className="mapping-meter"
          role="img"
          aria-label={`${mappedNow} of ${outs.length} outputs mapped`}
        >
          <span style={{ width: `${outs.length ? (100 * mappedNow) / outs.length : 0}%` }} />
          {review && mappedAfter > mappedNow && (
            <span
              className="mapping-meter-after"
              style={{
                width: `${outs.length ? (100 * (mappedAfter - mappedNow)) / outs.length : 0}%`,
              }}
            />
          )}
        </span>
        <span>
          {review
            ? `${mappedNow} of ${outs.length} mapped now · ${mappedAfter} after applying the selected changes`
            : `${mappedNow} of ${outs.length} outputs mapped`}
        </span>
        <a href={`#/workbench/${projectId}/template`}>Edit the mapping on the Recipe tab</a>
      </div>
    </div>
  );
}

function ConfidenceBars({ level }: { level: Confidence }) {
  const n = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
  return (
    <span className="confidence-bars" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className={i < n ? 'on' : undefined} />
      ))}
    </span>
  );
}
