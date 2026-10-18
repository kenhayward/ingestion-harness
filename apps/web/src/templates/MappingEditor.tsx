import { useEffect, useId, useRef, useState } from 'react';
import type {
  GraphPreviewView,
  OntologyDetail,
  OntologySummary,
  OntologyTerm,
  OntologyTermKind,
  OutputMapping,
  Semantics,
  ShaclReport,
  TermGroup,
  TermLabel,
  TermLabelsBody,
} from '@ih/shared';
import { CURIE_PREFIXES } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Text } from './fields.js';

type Definition = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a recipe being edited
type TableMapping = Semantics['tables'][string];
type LocalTerm = Semantics['local'][number];

/** What a mapping position needs (the API's semanticsIssues checks the same). */
export type Want = 'property' | 'class' | 'concept' | 'scheme';

const WANT_LABEL: Record<Want, string> = {
  property: 'property',
  class: 'class',
  concept: 'concept',
  scheme: 'concept scheme',
};
const WANT_GROUP: Record<Want, TermGroup> = {
  property: 'properties',
  class: 'classes',
  concept: 'concepts',
  scheme: 'concepts',
};
const WANT_KINDS: Record<Want, OntologyTermKind[]> = {
  property: ['object_property', 'datatype_property', 'annotation_property'],
  class: ['class'],
  concept: ['concept'],
  scheme: ['scheme'],
};
const LOCAL_KINDS: LocalTerm['kind'][] = [
  'class',
  'object_property',
  'datatype_property',
  'annotation_property',
  'concept',
];

export const EMPTY_SEMANTICS: Semantics = {
  ontologies: [],
  shapes: [],
  prefixes: {},
  document: { class: '', iri: 'doc/{source}' },
  fields: {},
  tables: {},
  local: [],
};

/** An IRI as a CURIE when a declared (or built-in) prefix covers it; the longest namespace wins. */
export function compactIri(iri: string, prefixes: Record<string, string>): string {
  const all = Object.entries({ ...CURIE_PREFIXES, ...prefixes }).filter(([, ns]) => ns);
  const best = all
    .filter(([, ns]) => iri.startsWith(ns) && iri.length > ns.length)
    .sort((a, b) => b[1].length - a[1].length)[0];
  return best ? `${best[0]}:${iri.slice(best[1].length)}` : iri;
}

type ValueAs = 'literal' | 'entity' | 'concept';
const valueAs = (m: OutputMapping | undefined): ValueAs =>
  m?.object ? 'entity' : m?.concepts ? 'concept' : 'literal';

/** How far an outline item is: done, started, not started, or nothing to check (optional). */
export type MappingStatus = 'ok' | 'partial' | 'none' | 'info';

/** What a term search needs: where to look and how to write what it finds. */
interface TermContext {
  api: Api;
  pins: Semantics['ontologies'];
  prefixes: Record<string, string>;
  /** Each mapped term's name, keyed as written (absent until looked up). */
  labels: Record<string, TermLabel>;
}

/** A term's readable name when one is known, else the term as written. */
const nameOf = (labels: Record<string, TermLabel>, term: string): string => {
  const hit = labels[term];
  return hit && (hit.from === 'ontology' || hit.from === 'local') && hit.label ? hit.label : term;
};

/** Every term the mapping names (document, fields, tables, columns), sorted, once each. */
function mappedTerms(s: Semantics): string[] {
  const out = new Set<string>();
  const add = (t: string | undefined) => {
    if (t?.trim()) out.add(t.trim());
  };
  const output = (m: OutputMapping) => {
    add(m.property);
    add(m.object?.class);
    add(m.concepts?.scheme);
    Object.values(m.concepts?.values ?? {}).forEach(add);
  };
  add(s.document.class);
  Object.values(s.fields).forEach(output);
  for (const t of Object.values(s.tables)) {
    add(t.link);
    add(t.class);
    Object.values(t.columns).forEach(output);
  }
  return [...out].sort();
}

/** Wait this long after the last edit before asking for names again. */
const LABEL_DELAY_MS = 300;

/** The names of the mapping's terms, asked for once per change of terms, pins or prefixes. */
function useTermLabels(api: Api, s: Semantics): Record<string, TermLabel> {
  const terms = mappedTerms(s);
  const request = terms.length
    ? JSON.stringify({
        ontologies: s.ontologies,
        prefixes: s.prefixes,
        local: s.local.map(({ iri, label }) => ({ iri, label })),
        terms,
      } satisfies TermLabelsBody)
    : '';
  const [labels, setLabels] = useState<Record<string, TermLabel>>({});
  useEffect(() => {
    if (!request) return;
    let live = true;
    const timer = setTimeout(() => {
      api.termLabels(JSON.parse(request) as TermLabelsBody).then(
        (r) => {
          if (live) setLabels(r.terms);
        },
        // Names are a help: the mapping is edited and saved the same without them.
        () => undefined,
      );
    }, LABEL_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, request]);
  return labels;
}

/** What a term box says under it: the term's name and where it is from, or why it has none. */
function TermName({ info }: { info: TermLabel | undefined }) {
  if (!info || info.from === 'built-in') return null;
  if (info.from === 'unknown' || info.from === 'invalid') {
    return (
      <small className="term-name term-missing">
        {info.from === 'invalid'
          ? 'Unknown prefix: declare it under Prefixes.'
          : 'Not in the pinned ontologies or the local terms: find one, or add a local term.'}
      </small>
    );
  }
  return (
    <small className="term-name">
      <span className="term-label">{info.label || 'No label'}</span>
      <span className="term-from">
        {info.from === 'local' ? 'local term' : (info.ontology ?? '').replace('@', ' v')}
      </span>
      {info.deprecated && <span className="kind-tag tone-warn">deprecated</span>}
    </small>
  );
}

/** A field's or column's state and one-line summary, for the outline. */
export function outputStatus(
  m: OutputMapping | undefined,
  enumValues: string[] | null,
  /** A term's readable name (the term itself when it has none). */
  name: (term: string) => string = (term) => term,
): { status: MappingStatus; summary: string; term?: string } {
  if (!m) return { status: 'none', summary: 'unmapped' };
  if (!m.property) return { status: 'partial', summary: 'no property' };
  if (m.object) {
    return m.object.class
      ? { status: 'ok', summary: `entity · ${name(m.object.class)}`, term: m.object.class }
      : { status: 'partial', summary: 'entity · no class' };
  }
  if (m.concepts) {
    if (enumValues) {
      const done = enumValues.filter((v) => m.concepts?.values?.[v]).length;
      return {
        status: done === enumValues.length ? 'ok' : 'partial',
        summary: `concept · ${done} of ${enumValues.length}`,
      };
    }
    return m.concepts.scheme
      ? { status: 'ok', summary: `concept · ${name(m.concepts.scheme)}`, term: m.concepts.scheme }
      : { status: 'partial', summary: 'concept · no scheme' };
  }
  return { status: 'ok', summary: name(m.property), term: m.property };
}

/**
 * A term box: the CURIE or IRI typed in, and *Find a …* that opens a search of the pinned
 * ontologies right under it (no dialog), so the field and its results stay in view together.
 */
function TermField({
  label,
  value,
  want,
  ctx,
  bare,
  onChange,
}: {
  label: string;
  value: string;
  want: Want;
  ctx: TermContext;
  /** No visible label (a row that shows what it is beside it); `label` stays its name. */
  bare?: boolean;
  onChange: (term: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const findLabel = `Find a ${WANT_LABEL[want]}`;
  return (
    <div className="term-field">
      <div className="term-input">
        {bare ? (
          <span className="term-bare">
            <Text label={label} bare className="mono" value={value} onChange={onChange} />
          </span>
        ) : (
          <Text label={label} className="mono" value={value} onChange={onChange} />
        )}
        <button
          type="button"
          className="term-find"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {findLabel}
        </button>
      </div>
      <TermName info={ctx.labels[value.trim()]} />
      {open && (
        <TermSearch
          title={findLabel}
          want={want}
          ctx={ctx}
          onPick={(term) => {
            onChange(term);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** Search the pinned versions for a term of the kind wanted; Escape closes it. */
function TermSearch({
  title,
  want,
  ctx,
  onPick,
  onClose,
}: {
  title: string;
  want: Want;
  ctx: TermContext;
  onPick: (term: string) => void;
  onClose: () => void;
}) {
  const { api, pins, prefixes } = ctx;
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<OntologyTerm[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    if (!q.trim() || pins.length === 0) {
      setHits([]);
      return;
    }
    Promise.all(
      pins.map((p) =>
        api.listOntologyTerms(p.id, p.version, { q: q.trim(), group: WANT_GROUP[want], limit: 20 }),
      ),
    )
      .then((pages) => {
        if (n !== seq.current) return;
        const seen = new Set<string>();
        setHits(
          pages
            .flatMap((page) => page.items)
            .filter((t) => WANT_KINDS[want].includes(t.kind))
            .filter((t) => (seen.has(t.iri) ? false : (seen.add(t.iri), true))),
        );
        setError(null);
      })
      .catch((err: unknown) => n === seq.current && setError((err as Error).message));
  }, [api, pins, q, want]);
  return (
    <div
      role="group"
      aria-label={title}
      className="term-search"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {pins.length === 0 ? (
        <p className="muted">Pin an ontology first: terms are found in the pinned versions.</p>
      ) : (
        <>
          <label>
            Search
            <input
              value={q}
              placeholder={`A ${WANT_LABEL[want]} in ${pins.map((p) => p.id).join(', ')}`}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
          </label>
          {error && <p role="alert">{error}</p>}
          {hits.length > 0 && (
            <ul className="term-hits">
              {hits.map((t) => {
                const term = compactIri(t.iri, prefixes);
                return (
                  <li key={t.iri}>
                    <button type="button" onClick={() => onPick(term)}>
                      <strong>{t.label}</strong> <code>{term}</code>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {q.trim() && hits.length === 0 && !error && (
            <p className="muted">No matching term. Add a local term under Local terms.</p>
          )}
        </>
      )}
    </div>
  );
}

const VALUE_AS: [ValueAs, string][] = [
  ['literal', 'Literal'],
  ['entity', 'Entity'],
  ['concept', 'Concept'],
];
const VALUE_AS_HINT: Record<ValueAs, string> = {
  literal: 'The value itself, typed as the output is.',
  entity: 'The value names a thing of its own, with a class and a readable IRI.',
  concept: 'The value links to a SKOS concept.',
};

/** One field's or column's mapping: property, and the value as a literal, an entity or a concept. */
function OutputEditor({
  label,
  id,
  enumValues,
  mapping,
  ctx,
  onChange,
}: {
  label: string;
  /** The output's own id: the default entity IRI template names it. */
  id: string;
  enumValues: string[] | null;
  mapping: OutputMapping | undefined;
  ctx: TermContext;
  onChange: (next: OutputMapping | undefined) => void;
}) {
  const m: OutputMapping = mapping ?? { property: '' };
  const set = (next: OutputMapping) =>
    onChange(next.property === '' && !next.object && !next.concepts ? undefined : next);
  const as = valueAs(mapping);
  const setAs = (next: ValueAs) => {
    const { object: _o, concepts: _c, ...rest } = m; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
    if (next === 'entity') set({ ...rest, object: { class: '', iri: `${id}/{value|slug}` } });
    else if (next === 'concept') set({ ...rest, concepts: enumValues ? {} : { match: 'label' } });
    else set(rest);
  };
  const concepts = m.concepts;
  const setValue = (value: string, term: string) => {
    const values = { ...(concepts?.values ?? {}) };
    if (term) values[value] = term;
    else delete values[value];
    const { values: _v, ...others } = concepts ?? {}; // eslint-disable-line @typescript-eslint/no-unused-vars -- replaced below
    set({ ...m, concepts: Object.keys(values).length ? { ...others, values } : others });
  };
  return (
    <fieldset className="mapping-form">
      <legend className="visually-hidden">{label}</legend>
      <div className="mapping-line">
        <span className="mapping-key">Value as</span>
        <div className="mapping-value-as">
          <div role="group" aria-label="Value as" className="segmented">
            {VALUE_AS.map(([v, text]) => (
              <button key={v} type="button" aria-pressed={as === v} onClick={() => setAs(v)}>
                {text}
              </button>
            ))}
          </div>
          <small className="muted">{VALUE_AS_HINT[as]}</small>
        </div>
      </div>
      <TermField
        label="Property"
        value={m.property ?? ''}
        want="property"
        ctx={ctx}
        onChange={(v) => set({ ...m, property: v })}
      />
      {m.object && (
        <>
          <TermField
            label="Entity class"
            value={m.object.class}
            want="class"
            ctx={ctx}
            onChange={(v) => set({ ...m, object: { ...m.object!, class: v } })}
          />
          <div className="term-field">
            <Text
              label="IRI template"
              className="mono"
              value={m.object.iri}
              onChange={(v) => set({ ...m, object: { ...m.object!, iri: v } })}
            />
            <small className="muted">
              Under the base IRI, e.g. party/{'{value|slug}'}; filters: slug, upper.
            </small>
          </div>
        </>
      )}
      {concepts &&
        (enumValues ? (
          <div className="mapping-values">
            <p className="mapping-key">
              Concept for each value · {enumValues.filter((v) => concepts.values?.[v]).length} of{' '}
              {enumValues.length}
            </p>
            {enumValues.map((value) => (
              <div className="mapping-value-row" key={value}>
                <code className={concepts.values?.[value] ? undefined : 'missing'}>{value}</code>
                <TermField
                  label={`Concept for ${value}`}
                  bare
                  value={concepts.values?.[value] ?? ''}
                  want="concept"
                  ctx={ctx}
                  onChange={(v) => setValue(value, v)}
                />
              </div>
            ))}
          </div>
        ) : (
          <>
            <TermField
              label="Concept scheme"
              value={concepts.scheme ?? ''}
              want="scheme"
              ctx={ctx}
              onChange={(v) => set({ ...m, concepts: { ...concepts, scheme: v || undefined } })}
            />
            <p className="muted">Values are matched to the scheme&apos;s concepts by label.</p>
          </>
        ))}
    </fieldset>
  );
}

/** Pinned versions as chips with Unpin, and the form that pins another. */
function PinList({
  pins,
  what,
  onUnpin,
}: {
  pins: Semantics['ontologies'];
  /** "" for ontologies, "shapes " for shapes: the Unpin buttons' names. */
  what: string;
  onUnpin: (i: number) => void;
}) {
  if (pins.length === 0) return <p className="muted">Nothing pinned yet.</p>;
  return (
    <ul className="pins">
      {pins.map((p, i) => (
        <li key={`${p.id}@${p.version}`} className="pin-chip">
          <a href={`#/ontologies/${encodeURIComponent(p.id)}`}>{p.id}</a>{' '}
          <span className="muted">v{p.version}</span>
          <button
            type="button"
            className="icon-only"
            aria-label={`Unpin ${what}${p.id} v${p.version}`}
            title="Unpin"
            onClick={() => onUnpin(i)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Pin a ready version of a library ontology. */
function PinForm({ api, onPin }: { api: Api; onPin: (id: string, version: number) => void }) {
  const [ontologies, setOntologies] = useState<OntologySummary[]>([]);
  const [id, setId] = useState('');
  const [detail, setDetail] = useState<OntologyDetail | null>(null);
  const [version, setVersion] = useState('');
  useEffect(() => {
    api.listOntologies().then(setOntologies, () => setOntologies([]));
  }, [api]);
  useEffect(() => {
    setDetail(null);
    setVersion('');
    if (id) api.getOntology(id).then(setDetail, () => setDetail(null));
  }, [api, id]);
  const ready = (detail?.versions ?? []).filter((v) => v.status === 'ready');
  return (
    <div className="pin-form">
      <label>
        Ontology
        <select value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">— choose —</option>
          {ontologies.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Version
        <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={!detail}>
          <option value="">— choose —</option>
          {ready.map((v) => (
            <option key={v.version} value={String(v.version)}>
              v{v.version}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!id || !version}
        onClick={() => {
          onPin(id, Number(version));
          setId('');
        }}
      >
        Pin
      </button>
    </div>
  );
}

/**
 * Prefix rows, held here so a row never vanishes into another: the mapping only gets them while
 * every prefix is non-empty and unique (an object cannot hold two rows under one key).
 */
function PrefixRows({
  prefixes,
  onChange,
}: {
  prefixes: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(prefixes));
  /** What this editor last wrote: anything else (YAML applied, a reload) resets the rows. */
  const written = useRef(JSON.stringify(prefixes));
  useEffect(() => {
    const incoming = JSON.stringify(prefixes);
    if (incoming !== written.current) {
      written.current = incoming;
      setRows(Object.entries(prefixes));
    }
  }, [prefixes]);
  const keys = rows.map(([k]) => k.trim());
  const valid = keys.every((k) => k !== '') && new Set(keys).size === keys.length;
  const update = (next: [string, string][]) => {
    setRows(next);
    const nextKeys = next.map(([k]) => k.trim());
    if (nextKeys.every((k) => k !== '') && new Set(nextKeys).size === nextKeys.length) {
      const value = Object.fromEntries(next.map(([k, ns]) => [k.trim(), ns]));
      written.current = JSON.stringify(value);
      onChange(value);
    }
  };
  const freshName = () => {
    let n = 1;
    while (keys.includes(`p${n}`)) n += 1;
    return `p${n}`;
  };
  return (
    <>
      {rows.map(([prefix, ns], i) => (
        <div className="prefix-row" key={i}>
          <Text
            label="Prefix"
            value={prefix}
            onChange={(v) => update(rows.map((r, j) => (j === i ? [v, r[1]] : r)))}
          />
          <Text
            label="Namespace"
            value={ns}
            onChange={(v) => update(rows.map((r, j) => (j === i ? [r[0], v] : r)))}
          />
          <button type="button" onClick={() => update(rows.filter((_, j) => j !== i))}>
            Remove prefix
          </button>
        </div>
      ))}
      {!valid && (
        <p role="alert" className="field-error">
          Each prefix must be unique and not empty: the mapping keeps the last valid set until then.
        </p>
      )}
      <button type="button" onClick={() => update([...rows, [freshName(), '']])}>
        Add a prefix
      </button>
    </>
  );
}

const ACTIVE = new Set(['queued', 'running']);

/** A previewed sample's SHACL violations (ADR 0011 step 5). */
function ReportSummary({ report }: { report: ShaclReport }) {
  const violations = report.results.filter((r) => r.severity === 'Violation');
  if (violations.length === 0) return <p className="muted">Conforms to the shapes.</p>;
  return (
    <div className="shacl-summary">
      <p className="field-error">
        {violations.length} {violations.length === 1 ? 'violation' : 'violations'}: publishing would
        go back to review.
      </p>
      <ul>
        {violations.map((v, i) => (
          <li key={i}>
            {v.output}: {v.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Render the saved draft's mapping over the dev samples' newest finished runs. */
export function GraphPreview({
  api,
  projectId,
  dirty,
  heading = true,
}: {
  api: Api;
  projectId: string;
  dirty: boolean;
  /** Its own "Preview" heading; off where the caller already titles it (the mapping inspector). */
  heading?: boolean;
}) {
  const [view, setView] = useState<GraphPreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const poll = (jobId: string, delay: number) => {
    timer.current = setTimeout(() => {
      api.getGraphPreview(projectId, jobId).then(
        (next) => {
          setView(next);
          if (ACTIVE.has(next.status)) poll(jobId, 1000);
          else setBusy(false);
        },
        (err: unknown) => {
          setError((err as Error).message);
          setBusy(false);
        },
      );
    }, delay);
  };
  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const started = await api.startGraphPreview(projectId);
      setView(started);
      poll(started.jobId, 0);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const failed = view && !ACTIVE.has(view.status) && view.status !== 'succeeded';
  return (
    <section className="graph-preview">
      {heading && <h3>Preview</h3>}
      <p className="muted">
        Renders the saved draft&apos;s mapping over each dev sample&apos;s newest finished test run,
        as publishing would.
      </p>
      <button type="button" onClick={() => void start()} disabled={busy || dirty}>
        Preview on dev samples
      </button>
      {dirty && <p className="muted">Save the draft first: the preview uses the saved draft.</p>}
      {busy && <p className="muted">Rendering…</p>}
      {(error || failed || view?.error) && (
        <p role="alert">{error ?? view?.error ?? `The preview ${view?.status}.`}</p>
      )}
      {view?.result?.samples.map((s) => (
        <details key={s.sampleId} open>
          <summary>
            {s.fileName} · {s.triples} {s.triples === 1 ? 'triple' : 'triples'}
          </summary>
          {s.report && <ReportSummary report={s.report} />}
          <pre className="turtle">{s.turtle}</pre>
        </details>
      ))}
    </section>
  );
}

type ItemKey = string;
interface OutlineItem {
  key: ItemKey;
  group: 'Setup' | 'Fields' | 'Tables' | 'More';
  /** The item's name: its outline button's and its inspector's accessible name. */
  label: string;
  /** What the outline shows (a column without its table's prefix). */
  text: string;
  /** Under its table in the outline. */
  indent?: boolean;
  /** An output's id: shown in the mono face. */
  output?: boolean;
  /** A tag beside the inspector's title: the output's type or the item's kind. */
  kind?: string;
  status: MappingStatus;
  summary: string;
  /** The term the summary names (it shows the term's name when one is known). */
  term?: string;
}

const STATUS_WORD: Record<MappingStatus, string> = {
  ok: 'mapped',
  partial: 'needs attention',
  none: 'not mapped',
  info: 'optional',
};

const pinText = (pins: Semantics['ontologies']) =>
  pins.map((p) => `${p.id} v${p.version}`).join(' · ');

/** Fields, then each table with its columns: what the outline and the coverage count. */
function outlineItems(
  name: (term: string) => string,
  s: Semantics,
  fields: { id: string; type?: string; enum?: string[] }[],
  tables: { id: string; columns?: { id: string; type?: string; enum?: string[] }[] }[],
  withPreview: boolean,
): OutlineItem[] {
  const typeTag = (o: { type?: string; enum?: string[] }) =>
    o.type === 'enum' ? `enum · ${(o.enum ?? []).join(', ')}` : (o.type ?? 'text');
  const items: OutlineItem[] = [
    {
      key: 'ontologies',
      group: 'Setup',
      label: 'Ontologies',
      text: 'Ontologies',
      status: s.ontologies.length ? 'ok' : 'none',
      summary: s.ontologies.length ? pinText(s.ontologies) : 'none pinned',
    },
    {
      key: 'shapes',
      group: 'Setup',
      label: 'Shapes',
      text: 'Shapes',
      status: s.shapes.length ? 'ok' : 'info',
      summary: s.shapes.length ? pinText(s.shapes) : 'optional',
    },
    {
      key: 'prefixes',
      group: 'Setup',
      label: 'Prefixes',
      text: 'Prefixes',
      status: 'info',
      summary: Object.keys(s.prefixes).join(' · ') || 'built-in only',
    },
    {
      key: 'document',
      group: 'Setup',
      label: 'Document',
      text: 'Document',
      status: s.document.class ? 'ok' : 'none',
      summary: s.document.class ? name(s.document.class) : 'no class',
      term: s.document.class || undefined,
    },
  ];
  for (const f of fields) {
    const st = outputStatus(s.fields[f.id], f.type === 'enum' ? (f.enum ?? []) : null, name);
    items.push({
      key: `field:${f.id}`,
      group: 'Fields',
      label: f.id,
      text: f.id,
      output: true,
      kind: `field · ${typeTag(f)}`,
      ...st,
    });
  }
  for (const t of tables) {
    const tm = s.tables[t.id];
    items.push({
      key: `table:${t.id}`,
      group: 'Tables',
      label: `Table ${t.id}`,
      text: t.id,
      output: true,
      kind: 'table',
      status: !tm ? 'none' : tm.link && tm.class ? 'ok' : 'partial',
      summary: !tm ? 'unmapped' : tm.class ? name(tm.class) : 'no row class',
      term: tm?.class || undefined,
    });
    for (const c of t.columns ?? []) {
      const st = outputStatus(tm?.columns[c.id], c.type === 'enum' ? (c.enum ?? []) : null, name);
      items.push({
        key: `column:${t.id}.${c.id}`,
        group: 'Tables',
        label: `${t.id}.${c.id}`,
        text: c.id,
        indent: true,
        output: true,
        kind: `column of ${t.id} · ${typeTag(c)}`,
        ...st,
      });
    }
  }
  items.push({
    key: 'local',
    group: 'More',
    label: 'Local terms',
    text: 'Local terms',
    status: 'info',
    summary: String(s.local.length),
  });
  if (withPreview) {
    items.push({
      key: 'preview',
      group: 'More',
      label: 'Preview',
      text: 'Preview on dev samples',
      status: 'info',
      summary: '',
    });
  }
  return items;
}

/** Where the editor opens: the ontologies until one is pinned, then the first output to finish. */
function firstKey(items: OutlineItem[], s: Semantics): ItemKey {
  if (s.ontologies.length === 0) return 'ontologies';
  const todo = items.find(
    (i) => (i.key.startsWith('field:') || i.key.startsWith('column:')) && i.status !== 'ok',
  );
  return todo?.key ?? items.find((i) => i.key.startsWith('field:'))?.key ?? 'document';
}

/**
 * The recipe's ontology mapping (ADR 0011) as an outline and an inspector: the outline lists the
 * setup (pinned ontologies and shapes, prefixes, the document), every field, every table with its
 * columns, local terms and (Workbench) the preview, each with how far it is mapped; the inspector
 * edits the one picked. Outputs left unmapped publish under the recipe's default vocabulary.
 */
export function MappingEditor({
  api,
  definition,
  semantics,
  onChange,
  preview,
  readOnly,
}: {
  api: Api;
  definition: Definition;
  semantics: Semantics | undefined;
  onChange: (next: Semantics | undefined) => void;
  /** Workbench only: the project whose dev samples the preview uses. */
  preview?: { projectId: string; dirty?: boolean };
  /** A published version or a retired type: the outline still opens every item, nothing edits. */
  readOnly?: boolean;
}) {
  if (!semantics) {
    return (
      <div className="mapping-editor">
        <p>
          Map the outputs to ontology terms to publish the document as RDF. Pin the ontologies the
          brief names, then give each output a property.
        </p>
        <button type="button" disabled={readOnly} onClick={() => onChange(EMPTY_SEMANTICS)}>
          Map to ontologies
        </button>
      </div>
    );
  }
  return (
    <MappingOutline
      api={api}
      definition={definition}
      semantics={semantics}
      onChange={onChange}
      preview={preview}
      readOnly={readOnly ?? false}
    />
  );
}

function MappingOutline({
  api,
  definition,
  semantics,
  onChange,
  preview,
  readOnly,
}: {
  api: Api;
  definition: Definition;
  semantics: Semantics;
  onChange: (next: Semantics | undefined) => void;
  preview?: { projectId: string; dirty?: boolean };
  readOnly: boolean;
}) {
  const uid = useId();
  const s: Semantics = {
    ...EMPTY_SEMANTICS,
    ...semantics,
    document: { ...EMPTY_SEMANTICS.document, ...semantics.document },
  };
  const set = (patch: Partial<Semantics>) => onChange({ ...s, ...patch });
  const labels = useTermLabels(api, s);
  const name = (term: string) => nameOf(labels, term);
  const ctx: TermContext = { api, pins: s.ontologies, prefixes: s.prefixes, labels };
  const fields: { id: string; type?: string; enum?: string[] }[] = definition.outputs?.fields ?? [];
  const tables: { id: string; columns?: { id: string; type?: string; enum?: string[] }[] }[] =
    definition.outputs?.tables ?? [];
  const items = outlineItems(name, s, fields, tables, preview !== undefined);
  // The opening item is picked once and kept: finishing it (or pinning the first ontology) must
  // not move the editor away mid-typing. Only an item that disappears falls back to it again.
  const [selected, setSelected] = useState<ItemKey>(() => firstKey(items, s));
  const key = items.some((i) => i.key === selected) ? selected : firstKey(items, s);
  useEffect(() => {
    if (key !== selected) setSelected(key);
  }, [key, selected]);
  const index = items.findIndex((i) => i.key === key);
  const item = items[index]!;
  const prev = items[index - 1];
  const next = items[index + 1];
  const outputs = items.filter((i) => i.key.startsWith('field:') || i.key.startsWith('column:'));
  const mapped = outputs.filter((i) => i.status === 'ok').length;
  const started = outputs.filter((i) => i.status === 'partial').length;

  const setField = (id: string, m: OutputMapping | undefined) => {
    const nextFields = { ...s.fields };
    if (m) nextFields[id] = m;
    else delete nextFields[id];
    set({ fields: nextFields });
  };
  const setTable = (id: string, t: TableMapping) => {
    const nextTables = { ...s.tables };
    const empty = !t.link && !t.class && !t.iri && Object.keys(t.columns).length === 0;
    if (empty) delete nextTables[id];
    else nextTables[id] = t;
    set({ tables: nextTables });
  };
  const tableMapping = (id: string): TableMapping =>
    s.tables[id] ?? { link: '', class: '', columns: {} };
  const setLocal = (i: number, patch: Partial<LocalTerm>) =>
    set({ local: s.local.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const body = () => {
    if (key === 'ontologies') {
      return (
        <>
          <p className="muted">
            The vocabularies the outputs are mapped to; terms are found in these versions.
          </p>
          <PinList
            pins={s.ontologies}
            what=""
            onUnpin={(i) => set({ ontologies: s.ontologies.filter((_, j) => j !== i) })}
          />
          <PinForm
            api={api}
            onPin={(id, version) =>
              set({ ontologies: [...s.ontologies.filter((p) => p.id !== id), { id, version }] })
            }
          />
        </>
      );
    }
    if (key === 'shapes') {
      return (
        <>
          <p className="muted">
            SHACL shapes the document&apos;s graph is checked against: a violation sends the job to
            review, and publishing its graph waits until it is fixed.
          </p>
          <PinList
            pins={s.shapes}
            what="shapes "
            onUnpin={(i) => set({ shapes: s.shapes.filter((_, j) => j !== i) })}
          />
          <PinForm
            api={api}
            onPin={(id, version) =>
              set({ shapes: [...s.shapes.filter((p) => p.id !== id), { id, version }] })
            }
          />
        </>
      );
    }
    if (key === 'prefixes') {
      return (
        <>
          <p className="muted">
            Short names for namespaces, used in terms as <code>prefix:Name</code>. rdf, rdfs, owl,
            xsd, skos, dcterms and prov are built in.
          </p>
          <PrefixRows prefixes={s.prefixes} onChange={(prefixes) => set({ prefixes })} />
        </>
      );
    }
    if (key === 'document') {
      return (
        <>
          <TermField
            label="Document class"
            value={s.document.class}
            want="class"
            ctx={ctx}
            onChange={(v) => set({ document: { ...s.document, class: v } })}
          />
          <div className="term-field">
            <Text
              label="Document IRI template"
              className="mono"
              value={s.document.iri}
              onChange={(v) => set({ document: { ...s.document, iri: v } })}
            />
            <small className="muted">
              {'{source}'} is the file&apos;s sha256; {'{type}'} and {'{version}'} the
              recipe&apos;s.
            </small>
          </div>
        </>
      );
    }
    if (key === 'local') {
      return (
        <>
          <p className="muted">For outputs no pinned ontology has a term for.</p>
          {s.local.map((t, i) => (
            <div className="local-row" key={i}>
              <Text
                label="Term IRI"
                className="mono"
                value={t.iri}
                onChange={(v) => setLocal(i, { iri: v })}
              />
              <label>
                Kind
                <select
                  value={t.kind}
                  onChange={(e) => setLocal(i, { kind: e.target.value as LocalTerm['kind'] })}
                >
                  {LOCAL_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <Text label="Label" value={t.label} onChange={(v) => setLocal(i, { label: v })} />
              <button
                type="button"
                onClick={() => set({ local: s.local.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              onClick={() => set({ local: [...s.local, { iri: '', kind: 'class', label: '' }] })}
            >
              Add a local term
            </button>
          </div>
        </>
      );
    }
    if (key === 'preview' && preview) {
      return (
        <GraphPreview
          api={api}
          projectId={preview.projectId}
          dirty={preview.dirty ?? false}
          heading={false}
        />
      );
    }
    if (key.startsWith('field:')) {
      const f = fields.find((x) => `field:${x.id}` === key)!;
      return (
        <OutputEditor
          key={key}
          label={f.id}
          id={f.id}
          enumValues={f.type === 'enum' ? (f.enum ?? []) : null}
          mapping={s.fields[f.id]}
          ctx={ctx}
          onChange={(m) => setField(f.id, m)}
        />
      );
    }
    if (key.startsWith('table:')) {
      const t = tables.find((x) => `table:${x.id}` === key)!;
      const tm = tableMapping(t.id);
      return (
        <fieldset className="mapping-form" key={key}>
          <legend className="visually-hidden">Table {t.id}</legend>
          <TermField
            label="Link from the document"
            value={tm.link}
            want="property"
            ctx={ctx}
            onChange={(v) => setTable(t.id, { ...tm, link: v })}
          />
          <TermField
            label="Row class"
            value={tm.class}
            want="class"
            ctx={ctx}
            onChange={(v) => setTable(t.id, { ...tm, class: v })}
          />
          <div className="term-field">
            <Text
              label="Row IRI template (optional)"
              className="mono"
              value={tm.iri ?? ''}
              onChange={(v) => {
                const { iri: _i, ...rest } = tm; // eslint-disable-line @typescript-eslint/no-unused-vars -- replaced below
                setTable(t.id, v ? { ...rest, iri: v } : rest);
              }}
            />
            <small className="muted">
              e.g. batch/{'{batch|upper}'}; empty: named under the document.
            </small>
          </div>
          <p className="muted">Map its columns from the outline, under the table.</p>
        </fieldset>
      );
    }
    // A table column.
    const [tableId, columnId] = key.slice('column:'.length).split('.') as [string, string];
    const t = tables.find((x) => x.id === tableId)!;
    const c = (t.columns ?? []).find((x) => x.id === columnId)!;
    const tm = tableMapping(t.id);
    return (
      <OutputEditor
        key={key}
        label={`${t.id}.${c.id}`}
        id={c.id}
        enumValues={c.type === 'enum' ? (c.enum ?? []) : null}
        mapping={tm.columns[c.id]}
        ctx={ctx}
        onChange={(m) => {
          const columns = { ...tm.columns };
          if (m) columns[c.id] = m;
          else delete columns[c.id];
          setTable(t.id, { ...tm, columns });
        }}
      />
    );
  };

  /** The summary shows the term's name: the term itself goes in its tooltip and description. */
  const named = (i: OutlineItem) => i.term !== undefined && name(i.term) !== i.term;
  const groups = (['Setup', 'Fields', 'Tables', 'More'] as const)
    .map((g) => [g, items.filter((i) => i.group === g)] as const)
    .filter(([, list]) => list.length > 0);

  return (
    <div className="mapping-editor">
      <div className="mapping-split">
        <nav className="mapping-outline" aria-label="Mapping outline">
          {groups.map(([g, list]) => {
            const outs = list.filter(
              (i) => i.key.startsWith('field:') || i.key.startsWith('column:'),
            );
            return (
              <div key={g} className="mapping-outline-group">
                <p className="mapping-outline-head">
                  <span>{g}</span>
                  {outs.length > 0 && (
                    <span>
                      {outs.filter((i) => i.status === 'ok').length} of {outs.length}
                    </span>
                  )}
                </p>
                <ul>
                  {list.map((i) => (
                    <li key={i.key}>
                      <button
                        type="button"
                        className={i.indent ? 'indent' : undefined}
                        aria-label={i.label}
                        aria-current={i.key === key ? 'true' : undefined}
                        aria-describedby={`${uid}-${i.key}`}
                        onClick={() => setSelected(i.key)}
                      >
                        <span className={`map-dot map-${i.status}`} aria-hidden="true" />
                        <span className={i.output ? 'mapping-item mono' : 'mapping-item'}>
                          {i.text}
                        </span>
                        <span
                          id={`${uid}-${i.key}`}
                          className={named(i) ? 'mapping-summary named' : 'mapping-summary'}
                          title={named(i) ? i.term : undefined}
                        >
                          {i.status === 'none' && i.output ? (
                            <span className="kind-tag tone-neutral">unmapped</span>
                          ) : (
                            i.summary
                          )}
                          <span className="visually-hidden">
                            {named(i)
                              ? ` (${i.term}, ${STATUS_WORD[i.status]})`
                              : ` (${STATUS_WORD[i.status]})`}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        <section className="mapping-inspector" aria-label={item.label}>
          <header className="mapping-inspector-head">
            <span className={`map-dot map-${item.status}`} aria-hidden="true" />
            <h3 className={item.output ? 'mono' : undefined}>{item.text}</h3>
            {item.kind && <span className="kind-tag tone-info">{item.kind}</span>}
            <span className="mapping-step">
              <button
                type="button"
                className="small ghost"
                disabled={!prev}
                aria-label={prev ? `Previous: ${prev.label}` : 'Previous'}
                onClick={() => prev && setSelected(prev.key)}
              >
                ‹ {prev?.text ?? ''}
              </button>
              <button
                type="button"
                className="small ghost"
                disabled={!next}
                aria-label={next ? `Next: ${next.label}` : 'Next'}
                onClick={() => next && setSelected(next.key)}
              >
                {next?.text ?? ''} ›
              </button>
            </span>
          </header>
          {/* The outline and ‹ › stay outside: a read-only mapping can still be browsed. */}
          <fieldset className="mapping-body" disabled={readOnly}>
            {body()}
          </fieldset>
        </section>
      </div>
      <div className="mapping-foot">
        <span
          className="mapping-meter"
          role="img"
          aria-label={`${mapped} of ${outputs.length} outputs mapped`}
        >
          <span style={{ width: `${outputs.length ? (100 * mapped) / outputs.length : 0}%` }} />
        </span>
        <span>
          <strong>{mapped}</strong> of {outputs.length} outputs mapped
          {started > 0 && <span className="muted"> · {started} started</span>}
        </span>
        <button
          type="button"
          className="danger"
          disabled={readOnly}
          onClick={() => onChange(undefined)}
        >
          Remove the mapping
        </button>
      </div>
    </div>
  );
}
