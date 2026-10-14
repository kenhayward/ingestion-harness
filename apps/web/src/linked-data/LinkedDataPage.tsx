import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  baseIriProblem,
  baseIriWarnings,
  CUSTOMER_SLUG_RE,
  effectiveBaseIri,
  type LinkedDataBody,
  type LinkedDataView,
} from '@ih/shared';
import type { Api, Me } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';

/** A customer id from a name: lower case, ASCII, words joined by `-`. */
export function slugFrom(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * Linked data (ADR 0011): the deployment's customer and the base IRI its RDF is minted under.
 * IRIs are identities: once RDF was published, changing the base needs a confirmation and
 * applies to new publishes only. Admins only.
 */
export function LinkedDataPage({ api, me }: { api: Api; me: Me }) {
  const isAdmin = me.role === 'admin';
  const [view, setView] = useState<LinkedDataView | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  /** The id follows the name until someone edits it. */
  const [slugEdited, setSlugEdited] = useState(false);
  const [base, setBase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const show = useCallback((next: LinkedDataView) => {
    setView(next);
    setName(next.settings.customerName);
    setSlug(next.settings.customerSlug ?? '');
    setSlugEdited(next.settings.customerSlug !== null);
    setBase(next.settings.baseIri ?? '');
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    api.getLinkedData().then(show, (err: unknown) => setError((err as Error).message));
  }, [api, isAdmin, show]);

  if (!isAdmin) return <p>Admins only.</p>;

  const baseIri = base.trim() || null;
  const problem = baseIri ? baseIriProblem(baseIri) : null;
  const warnings = baseIri && !problem ? baseIriWarnings(baseIri) : [];
  const slugOk = CUSTOMER_SLUG_RE.test(slug);
  const effective = effectiveBaseIri({ customerSlug: slugOk ? slug : null, baseIri });
  const current = view?.effectiveBase ?? null;
  const needsConfirm = !!view && view.rdfPublished > 0 && current !== null && effective !== current;
  const canSave = !!view && name.trim() !== '' && slugOk && problem === null && !saving;

  const save = async (confirm?: string) => {
    setSaving(true);
    setError(null);
    setMessage(null);
    const body: LinkedDataBody = {
      customerName: name.trim(),
      customerSlug: slug,
      baseIri,
      ...(confirm ? { confirm } : {}),
    };
    try {
      show(await api.saveLinkedData(body));
      setMessage('Saved.');
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    if (needsConfirm) setConfirming(true);
    else void save();
  };

  return (
    <div className="linked-data-page">
      <div className="page-header">
        <div>
          <h1>Linked data</h1>
          <p className="muted">
            Published RDF belongs to the customer: its IRIs live under their base. One customer per
            deployment.
          </p>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {view && (
        <form className="form-rows" onSubmit={submit}>
          <label>
            Customer name
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) setSlug(slugFrom(e.target.value));
              }}
            />
          </label>
          <label>
            Customer id
            <input
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugEdited(true);
              }}
            />
          </label>
          {slug !== '' && !slugOk && (
            <p className="field-error">Lower case letters, digits and -, 2 to 63 characters.</p>
          )}
          <label>
            Base IRI (optional)
            <input
              value={base}
              placeholder="https://data.example.com/"
              onChange={(e) => setBase(e.target.value)}
            />
          </label>
          {problem && <p className="field-error">{problem}</p>}
          {warnings.length > 0 && (
            <p className="field-warning">
              Avoid {warnings.map((w) => `“${w}”`).join(', ')} in a base IRI: identifiers outlive
              environments, products and versions.
            </p>
          )}
          <div className="iri-examples">
            <h3>Example IRIs</h3>
            {effective ? (
              <ul>
                <li>
                  <code>{`${effective}doc/{sha256}`}</code>
                </li>
                <li>
                  <code>{`${effective}party/acme-ltd`}</code>
                </li>
              </ul>
            ) : (
              <p className="muted">Set the customer: RDF is not published until then.</p>
            )}
          </div>
          <div>
            <button type="submit" disabled={!canSave}>
              Save
            </button>
          </div>
        </form>
      )}
      {view && (
        <section>
          <h2>Published</h2>
          <p>
            {view.rdfPublished} RDF outputs published
            {view.effectiveBase ? ` under ${view.effectiveBase}` : ''}.
          </p>
          {view.effectiveBase && (
            <p>
              {view.graphs.published} {view.graphs.published === 1 ? 'graph' : 'graphs'} published
              under <code>{view.effectiveBase}</code>
              {view.graphs.lastPublishedAt
                ? `, the newest ${when(view.graphs.lastPublishedAt)}`
                : ''}
              .
            </p>
          )}
          {view.withdrawals.queued + view.withdrawals.running > 0 && (
            <p className="muted">
              {view.withdrawals.queued + view.withdrawals.running} withdrawals or republishes
              waiting.
            </p>
          )}
          {view.withdrawals.failed > 0 && (
            <p role="alert">
              {view.withdrawals.failed} failed: published outputs or graphs may not have been
              withdrawn (see the worker logs).
            </p>
          )}
          {view.endpoint && (
            <dl className="meta">
              <dt>SPARQL endpoint</dt>
              <dd>
                <code>{view.endpoint.sparql}</code>
              </dd>
              <dt>Graph Store (read)</dt>
              <dd>
                <code>{view.endpoint.get}</code>
              </dd>
              <dt>User</dt>
              <dd>
                <code>{view.endpoint.user}</code>
              </dd>
            </dl>
          )}
          {view.endpoint && (
            <p className="muted">
              IRIs are identifiers, not data: find entities by their values (their labels and
              properties), never by reading meaning out of an IRI.
            </p>
          )}
          {view.graphs.endpoint === true && (
            <p className="muted">Graphs go to the triple store (Fuseki) and to S3.</p>
          )}
          {view.graphs.endpoint === false && (
            <p className="muted">
              No triple store is configured (<code>RDF_ENDPOINT</code>): graphs go to S3 only.
            </p>
          )}
          {view.history.length > 0 && (
            <table aria-label="Base IRI history">
              <thead>
                <tr>
                  <th>When</th>
                  <th>From</th>
                  <th>To</th>
                  <th>By</th>
                  <th>RDF outputs before</th>
                </tr>
              </thead>
              <tbody>
                {view.history.map((h) => (
                  <tr key={`${h.changedAt}-${h.toBase}`}>
                    <td>{when(h.changedAt)}</td>
                    <td>{h.fromBase ?? '—'}</td>
                    <td>{h.toBase ?? '—'}</td>
                    <td>{h.changedBy ?? '—'}</td>
                    <td>{h.rdfPublished}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {confirming && view && (
        <Dialog
          title="Change the base IRI?"
          onClose={() => setConfirming(false)}
          actions={
            <button type="button" disabled={saving} onClick={() => void save(effective ?? '')}>
              Change the base
            </button>
          }
        >
          <p>
            {view.rdfPublished} RDF outputs were published under <code>{current}</code>. Their IRIs
            stay as they are; documents published from now on are named under{' '}
            <code>{effective}</code>, so the same document can end up with two names.
          </p>
        </Dialog>
      )}
    </div>
  );
}
