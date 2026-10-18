import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  MappingMemoryEntry,
  MemoryCreateBody,
  MemoryListQuery,
  MemoryTermLabels,
  RememberedAnswer,
  TermLabel,
} from '@ih/shared';
import { answerTerms } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { HelpButton } from '../ui/Help.js';
import { Icon } from '../ui/Icon.js';
import { Segmented } from '../ui/Segmented.js';
import { TermInfo } from '../ui/TermInfo.js';
import { TermField, type TermContext } from '../templates/MappingEditor.js';
import { ANSWER_FIELDS, KIND_WORD, STATUS_LABEL, answerFrom, answerInWords } from './memory.js';

type StatusFilter = NonNullable<MemoryListQuery['status']>;

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'review', label: 'Needs review' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];

/**
 * Remembered mappings (docs/design/mapping-memory.md, section 6): the mappings designers
 * accepted in recipes, which the Workbench mapping stage offers again for outputs worded the
 * same. Designers confirm, correct, reject or delete them here.
 */
export function RememberedMappings({ api }: { api: Api }) {
  const [status, setStatus] = useState<StatusFilter>('review');
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<MappingMemoryEntry[] | null>(null);
  const [labels, setLabels] = useState<MemoryTermLabels>({});
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MappingMemoryEntry | null>(null);
  const [deleting, setDeleting] = useState<MappingMemoryEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [pins, setPins] = useState<TermContext['pins']>([]);

  const load = useCallback(
    () =>
      api.listMappingMemory({ status, q: q.trim() || undefined }).then(
        (page) => {
          setEntries(page.entries);
          setLabels(page.labels);
          setError(null);
        },
        (err: Error) => setError(err.message),
      ),
    [api, status, q],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // The term searches look in the library's newest ready versions.
  useEffect(() => {
    api.listOntologies().then(
      (list) =>
        setPins(
          list.flatMap((o) =>
            o.latest?.status === 'ready' ? [{ id: o.id, version: o.latest.version }] : [],
          ),
        ),
      () => setPins([]),
    );
  }, [api]);

  const review = async (
    entry: MappingMemoryEntry,
    patch: Parameters<Api['reviewMappingMemoryEntry']>[1],
  ) => {
    try {
      const { entry: next } = await api.reviewMappingMemoryEntry(entry.id, patch);
      setEntries((list) => list?.map((e) => (e.id === next.id ? next : e)) ?? list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="memory-view" aria-label="Remembered mappings">
      <div className="memory-head">
        <p className="muted">
          What designers accepted in recipes. The mapping stage offers these again for outputs
          worded the same, pre-selected; refusing one in a mapping counts against it.
        </p>
        <div className="memory-tools">
          <Segmented label="Status" options={FILTERS} value={status} onChange={setStatus} />
          <label className="search">
            <Icon name="search" />
            <input
              type="search"
              aria-label="Search remembered mappings"
              placeholder="Search wording"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            Add a mapping
          </button>
          <HelpButton topic="ontologyMemory" />
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {entries === null && !error && <p>Loading…</p>}
      {entries?.length === 0 && (
        <p className="muted">
          {status === 'review'
            ? 'Nothing waiting for review. Mappings designers accept in recipes appear here.'
            : 'No remembered mapping matches.'}
        </p>
      )}
      {entries && entries.length > 0 && (
        <table className="memory-table">
          <thead>
            <tr>
              <th scope="col">Output</th>
              <th scope="col">Accepted answer</th>
              <th scope="col">Used</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>
                  <strong>{e.name}</strong>
                  <div className="muted">
                    {KIND_WORD[e.kind]}
                    {e.type ? ` · ${e.type}` : ''}
                    {e.unit ? ` · ${e.unit}` : ''}
                  </div>
                </td>
                <td>
                  {answerInWords(e.answer, labels)}
                  <div className="muted">{e.ontologies.join(', ')}</div>
                  {e.stale && <p className="memory-stale">{e.stale}</p>}
                  {answerTerms(e.answer).some((iri) => labels[iri]) && (
                    <details className="memory-terms">
                      <summary>What the terms mean</summary>
                      {answerTerms(e.answer).map((iri) => {
                        const l = labels[iri];
                        return l ? (
                          <TermInfo
                            key={iri}
                            info={{
                              from: 'ontology',
                              iri,
                              label: l.label,
                              kind: l.kind as TermLabel['kind'],
                              ontology: l.ontology,
                              deprecated: l.deprecated,
                              altLabels: l.altLabels,
                              definition: l.definition,
                            }}
                          />
                        ) : null;
                      })}
                    </details>
                  )}
                </td>
                <td>
                  <details>
                    <summary>
                      Used by {e.votes} recipe{e.votes === 1 ? '' : 's'}
                    </summary>
                    <ul>
                      {e.recipes.map((r) => (
                        <li key={`${r.id}/${r.path}`}>
                          <a href={`#/templates/${encodeURIComponent(r.id)}/${r.version}`}>
                            {r.id}
                          </a>{' '}
                          <code>{r.path || 'document'}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                  {e.refusals > 0 && (
                    <div className="muted">
                      Refused in {e.refusals} recipe{e.refusals === 1 ? '' : 's'}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`memory-status status-${e.status}`}>
                    {STATUS_LABEL[e.status]}
                  </span>
                  {e.reviewedBy && <div className="muted">by {e.reviewedBy}</div>}
                </td>
                <td className="memory-actions">
                  {e.status !== 'confirmed' && (
                    <button type="button" onClick={() => void review(e, { status: 'confirmed' })}>
                      Confirm
                    </button>
                  )}
                  {e.status !== 'rejected' && (
                    <button type="button" onClick={() => void review(e, { status: 'rejected' })}>
                      Reject
                    </button>
                  )}
                  <button type="button" onClick={() => setEditing(e)}>
                    Edit
                  </button>
                  <button type="button" className="danger" onClick={() => setDeleting(e)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <AnswerDialog
          title="Edit remembered mapping"
          submit="Save and confirm"
          api={api}
          pins={pins}
          form={editing.answer.form}
          answer={editing.answer}
          onClose={() => setEditing(null)}
          onSubmit={async (answer) => {
            await review(editing, { answer });
            setEditing(null);
          }}
        />
      )}
      {adding && (
        <AddDialog
          api={api}
          pins={pins}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      {deleting && (
        <Dialog
          title="Delete this remembered mapping?"
          onClose={() => setDeleting(null)}
          actions={
            <button
              type="button"
              className="danger"
              onClick={async () => {
                try {
                  await api.deleteMappingMemoryEntry(deleting.id);
                  setDeleting(null);
                  void load();
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Delete
            </button>
          }
        >
          <p>
            Recipes that still map an output this way bring it back on their next save. To stop it
            being offered, reject it instead.
          </p>
        </Dialog>
      )}
    </section>
  );
}

/** The answer's fields: term boxes with *Find a …* searches of the library. */
function AnswerFields({
  api,
  pins,
  form,
  values,
  onChange,
}: {
  api: Api;
  pins: TermContext['pins'];
  form: RememberedAnswer['form'];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  const ctx: TermContext = useMemo(() => ({ api, pins, prefixes: {}, labels: {} }), [api, pins]);
  return (
    <>
      {ANSWER_FIELDS[form].map((f) =>
        f.want ? (
          <TermField
            key={f.key}
            label={f.label}
            value={values[f.key] ?? ''}
            want={f.want}
            ctx={ctx}
            onChange={(v) => onChange(f.key, v)}
          />
        ) : (
          <label key={f.key}>
            {f.label}
            <input
              className="mono"
              value={values[f.key] ?? ''}
              onChange={(e) => onChange(f.key, e.target.value)}
            />
          </label>
        ),
      )}
    </>
  );
}

function valuesOf(answer: RememberedAnswer | null): Record<string, string> {
  if (!answer) return {};
  return Object.fromEntries(
    Object.entries(answer).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
}

function AnswerDialog({
  title,
  submit,
  api,
  pins,
  form,
  answer,
  onClose,
  onSubmit,
}: {
  title: string;
  submit: string;
  api: Api;
  pins: TermContext['pins'];
  form: RememberedAnswer['form'];
  answer: RememberedAnswer;
  onClose: () => void;
  onSubmit: (answer: RememberedAnswer) => Promise<void>;
}) {
  const [values, setValues] = useState(() => valuesOf(answer));
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <button
          type="button"
          className="primary"
          onClick={() => void onSubmit(answerFrom(form, values, answer))}
        >
          {submit}
        </button>
      }
    >
      <AnswerFields
        api={api}
        pins={pins}
        form={form}
        values={values}
        onChange={(k, v) => setValues((was) => ({ ...was, [k]: v }))}
      />
    </Dialog>
  );
}

const KIND_FORMS: Record<MemoryCreateBody['kind'], RememberedAnswer['form'][]> = {
  column: ['literal', 'node', 'entity', 'concept'],
  field: ['literal', 'node', 'entity', 'concept'],
  table: ['table'],
  document: ['document'],
};

const FORM_WORD: Partial<Record<RememberedAnswer['form'], string>> = {
  literal: 'A value of a property',
  node: 'A value node of a class',
  entity: 'An entity of a class',
  concept: 'A concept',
  table: 'Rows of a class',
  document: 'The document class',
};

function AddDialog({
  api,
  pins,
  onClose,
  onAdded,
}: {
  api: Api;
  pins: TermContext['pins'];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<MemoryCreateBody['kind']>('column');
  const [name, setName] = useState('');
  const [type, setType] = useState('text');
  const [form, setForm] = useState<RememberedAnswer['form']>('literal');
  const [values, setValues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const valueKind = kind === 'column' || kind === 'field';
  const add = async () => {
    const body: MemoryCreateBody = {
      kind,
      name: name.trim(),
      ...(valueKind ? { type } : {}),
      answer: answerFrom(form, values),
    };
    try {
      await api.addMappingMemoryEntry(body);
      onAdded();
    } catch (err) {
      setProblem((err as Error).message);
    }
  };
  return (
    <Dialog
      title="Add a remembered mapping"
      onClose={onClose}
      actions={
        <button
          type="button"
          className="primary"
          disabled={!name.trim()}
          onClick={() => void add()}
        >
          Add
        </button>
      }
    >
      <label>
        Output kind
        <select
          value={kind}
          onChange={(e) => {
            const next = e.target.value as MemoryCreateBody['kind'];
            setKind(next);
            setForm(KIND_FORMS[next][0]!);
          }}
        >
          <option value="column">Column</option>
          <option value="field">Field</option>
          <option value="table">Table</option>
          <option value="document">Document</option>
        </select>
      </label>
      <label>
        Output name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {valueKind && (
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="boolean">Yes or no</option>
          </select>
        </label>
      )}
      {KIND_FORMS[kind].length > 1 && (
        <label>
          Published as
          <select
            value={form}
            onChange={(e) => setForm(e.target.value as RememberedAnswer['form'])}
          >
            {KIND_FORMS[kind].map((f) => (
              <option key={f} value={f}>
                {FORM_WORD[f]}
              </option>
            ))}
          </select>
        </label>
      )}
      <AnswerFields
        api={api}
        pins={pins}
        form={form}
        values={values}
        onChange={(k, v) => setValues((was) => ({ ...was, [k]: v }))}
      />
      {problem && <p role="alert">{problem}</p>}
    </Dialog>
  );
}
