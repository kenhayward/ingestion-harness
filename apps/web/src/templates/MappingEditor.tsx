import { useEffect, useRef, useState } from 'react';
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
} from '@ih/shared';
import { CURIE_PREFIXES } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
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

/** One field's or column's mapping: property, and the value as a literal, an entity or a concept. */
function OutputRow({
  label,
  id,
  enumValues,
  mapping,
  onChange,
  find,
}: {
  label: string;
  /** The output's own id: the default entity IRI template names it. */
  id: string;
  enumValues: string[] | null;
  mapping: OutputMapping | undefined;
  onChange: (next: OutputMapping | undefined) => void;
  find: (want: Want, use: (term: string) => void) => void;
}) {
  const m: OutputMapping = mapping ?? { property: '' };
  const set = (next: OutputMapping) =>
    onChange(next.property === '' && !next.object && !next.concepts ? undefined : next);
  const setAs = (as: ValueAs) => {
    const { object: _o, concepts: _c, ...rest } = m; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
    if (as === 'entity') set({ ...rest, object: { class: '', iri: `${id}/{value|slug}` } });
    else if (as === 'concept') set({ ...rest, concepts: enumValues ? {} : { match: 'label' } });
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
    <fieldset className="mapping-row">
      <legend>{label}</legend>
      <div className="term-input">
        <Text
          label="Property"
          value={m.property ?? ''}
          onChange={(v) => set({ ...m, property: v })}
        />
        <button type="button" onClick={() => find('property', (t) => set({ ...m, property: t }))}>
          Find a property
        </button>
      </div>
      <label>
        Value as
        <select value={valueAs(mapping)} onChange={(e) => setAs(e.target.value as ValueAs)}>
          <option value="literal">a literal</option>
          <option value="entity">an entity</option>
          <option value="concept">a concept</option>
        </select>
      </label>
      {m.object && (
        <>
          <div className="term-input">
            <Text
              label="Entity class"
              value={m.object.class}
              onChange={(v) => set({ ...m, object: { ...m.object!, class: v } })}
            />
            <button
              type="button"
              onClick={() =>
                find('class', (t) => set({ ...m, object: { ...m.object!, class: t } }))
              }
            >
              Find a class
            </button>
          </div>
          <Text
            label="IRI template"
            hint="Under the base IRI, e.g. party/{value|slug}; filters: slug, upper."
            value={m.object.iri}
            onChange={(v) => set({ ...m, object: { ...m.object!, iri: v } })}
          />
        </>
      )}
      {concepts &&
        (enumValues ? (
          enumValues.map((value) => (
            <div className="term-input" key={value}>
              <Text
                label={`Concept for ${value}`}
                value={concepts.values?.[value] ?? ''}
                onChange={(v) => setValue(value, v)}
              />
              <button type="button" onClick={() => find('concept', (t) => setValue(value, t))}>
                Find a concept
              </button>
            </div>
          ))
        ) : (
          <>
            <div className="term-input">
              <Text
                label="Concept scheme"
                value={concepts.scheme ?? ''}
                onChange={(v) => set({ ...m, concepts: { ...concepts, scheme: v || undefined } })}
              />
              <button
                type="button"
                onClick={() =>
                  find('scheme', (t) => set({ ...m, concepts: { ...concepts, scheme: t } }))
                }
              >
                Find a scheme
              </button>
            </div>
            <p className="muted">Values are matched to the scheme&apos;s concepts by label.</p>
          </>
        ))}
    </fieldset>
  );
}

/** Search the pinned versions for a term of the kind wanted. */
function TermPickerDialog({
  api,
  want,
  pins,
  prefixes,
  onPick,
  onClose,
}: {
  api: Api;
  want: Want;
  pins: Semantics['ontologies'];
  prefixes: Record<string, string>;
  onPick: (term: string) => void;
  onClose: () => void;
}) {
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
  const title = `Find a ${WANT_LABEL[want]}`;
  return (
    <Dialog title={title} onClose={onClose}>
      {pins.length === 0 ? (
        <p>Pin an ontology first: terms are found in the pinned versions.</p>
      ) : (
        <>
          <label>
            Search
            <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </label>
          {error && <p role="alert">{error}</p>}
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
          {q.trim() && hits.length === 0 && !error && <p className="muted">No matching term.</p>}
        </>
      )}
    </Dialog>
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
}: {
  api: Api;
  projectId: string;
  dirty: boolean;
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
      <h3>Preview</h3>
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

/**
 * The recipe's ontology mapping (ADR 0011): pinned ontologies, prefixes, the document's class and
 * IRI, each output's property and value, and recipe-local terms. Outputs left unmapped publish
 * under the recipe's default vocabulary.
 */
export function MappingEditor({
  api,
  definition,
  semantics,
  onChange,
  preview,
}: {
  api: Api;
  definition: Definition;
  semantics: Semantics | undefined;
  onChange: (next: Semantics | undefined) => void;
  /** Workbench only: the project whose dev samples the preview uses. */
  preview?: { projectId: string; dirty?: boolean };
}) {
  const [picking, setPicking] = useState<{ want: Want; use: (term: string) => void } | null>(null);
  if (!semantics) {
    return (
      <div className="mapping-editor">
        <p>
          Map the outputs to ontology terms to publish the document as RDF. Pin the ontologies the
          brief names, then give each output a property.
        </p>
        <button type="button" onClick={() => onChange(EMPTY_SEMANTICS)}>
          Map to ontologies
        </button>
      </div>
    );
  }
  const s: Semantics = {
    ...EMPTY_SEMANTICS,
    ...semantics,
    document: { ...EMPTY_SEMANTICS.document, ...semantics.document },
  };
  const set = (patch: Partial<Semantics>) => onChange({ ...s, ...patch });
  const find = (want: Want, use: (term: string) => void) => setPicking({ want, use });
  const fields: { id: string; type?: string; enum?: string[] }[] = definition.outputs?.fields ?? [];
  const tables: { id: string; columns?: { id: string; type?: string; enum?: string[] }[] }[] =
    definition.outputs?.tables ?? [];
  const setField = (id: string, m: OutputMapping | undefined) => {
    const next = { ...s.fields };
    if (m) next[id] = m;
    else delete next[id];
    set({ fields: next });
  };
  const setTable = (id: string, t: TableMapping) => {
    const next = { ...s.tables };
    const empty = !t.link && !t.class && !t.iri && Object.keys(t.columns).length === 0;
    if (empty) delete next[id];
    else next[id] = t;
    set({ tables: next });
  };
  const setLocal = (i: number, patch: Partial<LocalTerm>) =>
    set({ local: s.local.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  return (
    <div className="mapping-editor">
      <section aria-labelledby="mapping-ontologies">
        <h3 id="mapping-ontologies">Ontologies</h3>
        <ul className="pins">
          {s.ontologies.map((p, i) => (
            <li key={`${p.id}@${p.version}`}>
              <a href={`#/ontologies/${encodeURIComponent(p.id)}`}>
                {p.id} v{p.version}
              </a>{' '}
              <button
                type="button"
                aria-label={`Unpin ${p.id} v${p.version}`}
                onClick={() => set({ ontologies: s.ontologies.filter((_, j) => j !== i) })}
              >
                Unpin
              </button>
            </li>
          ))}
        </ul>
        <PinForm
          api={api}
          onPin={(id, version) =>
            set({
              ontologies: [...s.ontologies.filter((p) => p.id !== id), { id, version }],
            })
          }
        />
      </section>

      <section aria-labelledby="mapping-shapes">
        <h3 id="mapping-shapes">Shapes</h3>
        <p className="muted">
          SHACL shapes the document&apos;s graph is checked against: a violation sends the job to
          review, and publishing its graph waits until it is fixed.
        </p>
        <ul className="pins">
          {s.shapes.map((p, i) => (
            <li key={`${p.id}@${p.version}`}>
              <a href={`#/ontologies/${encodeURIComponent(p.id)}`}>
                {p.id} v{p.version}
              </a>{' '}
              <button
                type="button"
                aria-label={`Unpin shapes ${p.id} v${p.version}`}
                onClick={() => set({ shapes: s.shapes.filter((_, j) => j !== i) })}
              >
                Unpin
              </button>
            </li>
          ))}
        </ul>
        <PinForm
          api={api}
          onPin={(id, version) =>
            set({ shapes: [...s.shapes.filter((p) => p.id !== id), { id, version }] })
          }
        />
      </section>

      <section>
        <h3>Prefixes</h3>
        <PrefixRows prefixes={s.prefixes} onChange={(prefixes) => set({ prefixes })} />
      </section>

      <section>
        <h3>Document</h3>
        <div className="term-input">
          <Text
            label="Document class"
            value={s.document.class}
            onChange={(v) => set({ document: { ...s.document, class: v } })}
          />
          <button
            type="button"
            onClick={() => find('class', (t) => set({ document: { ...s.document, class: t } }))}
          >
            Find a class
          </button>
        </div>
        <Text
          label="Document IRI template"
          hint="{source} is the file's sha256; {type} and {version} the recipe's."
          value={s.document.iri}
          onChange={(v) => set({ document: { ...s.document, iri: v } })}
        />
      </section>

      <section>
        <h3>Fields</h3>
        {fields.length === 0 && <p className="muted">No fields.</p>}
        {fields.map((f) => (
          <OutputRow
            key={f.id}
            label={f.id}
            id={f.id}
            enumValues={f.type === 'enum' ? (f.enum ?? []) : null}
            mapping={s.fields[f.id]}
            onChange={(m) => setField(f.id, m)}
            find={find}
          />
        ))}
      </section>

      {tables.length > 0 && (
        <section>
          <h3>Tables</h3>
          {tables.map((t) => {
            const tm: TableMapping = s.tables[t.id] ?? { link: '', class: '', columns: {} };
            return (
              <fieldset key={t.id} className="mapping-table">
                <legend>Table {t.id}</legend>
                <div className="term-input">
                  <Text
                    label="Link from the document"
                    value={tm.link}
                    onChange={(v) => setTable(t.id, { ...tm, link: v })}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      find('property', (term) => setTable(t.id, { ...tm, link: term }))
                    }
                  >
                    Find a property
                  </button>
                </div>
                <div className="term-input">
                  <Text
                    label="Row class"
                    value={tm.class}
                    onChange={(v) => setTable(t.id, { ...tm, class: v })}
                  />
                  <button
                    type="button"
                    onClick={() => find('class', (term) => setTable(t.id, { ...tm, class: term }))}
                  >
                    Find a class
                  </button>
                </div>
                <Text
                  label="Row IRI template (optional)"
                  hint="e.g. batch/{batch|upper}; empty: named under the document."
                  value={tm.iri ?? ''}
                  onChange={(v) => {
                    const { iri: _i, ...rest } = tm; // eslint-disable-line @typescript-eslint/no-unused-vars -- replaced below
                    setTable(t.id, v ? { ...rest, iri: v } : rest);
                  }}
                />
                {(t.columns ?? []).map((c) => (
                  <OutputRow
                    key={c.id}
                    label={`${t.id}.${c.id}`}
                    id={c.id}
                    enumValues={c.type === 'enum' ? (c.enum ?? []) : null}
                    mapping={tm.columns[c.id]}
                    onChange={(m) => {
                      const columns = { ...tm.columns };
                      if (m) columns[c.id] = m;
                      else delete columns[c.id];
                      setTable(t.id, { ...tm, columns });
                    }}
                    find={find}
                  />
                ))}
              </fieldset>
            );
          })}
        </section>
      )}

      <section>
        <h3>Local terms</h3>
        <p className="muted">For outputs no pinned ontology has a term for.</p>
        {s.local.map((t, i) => (
          <div className="local-row" key={i}>
            <Text label="Term IRI" value={t.iri} onChange={(v) => setLocal(i, { iri: v })} />
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
            <button type="button" onClick={() => set({ local: s.local.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => set({ local: [...s.local, { iri: '', kind: 'class', label: '' }] })}
        >
          Add a local term
        </button>
      </section>

      {preview && (
        <GraphPreview api={api} projectId={preview.projectId} dirty={preview.dirty ?? false} />
      )}

      <p>
        <button type="button" className="danger" onClick={() => onChange(undefined)}>
          Remove the mapping
        </button>
      </p>

      {picking && (
        <TermPickerDialog
          api={api}
          want={picking.want}
          pins={s.ontologies}
          prefixes={s.prefixes}
          onClose={() => setPicking(null)}
          onPick={(term) => {
            picking.use(term);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
