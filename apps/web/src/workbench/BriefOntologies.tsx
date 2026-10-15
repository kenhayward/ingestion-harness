import { useEffect, useId, useState } from 'react';
import type { BriefOntology, DataPolicy, OntologyDetail, OntologySummary } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';

/**
 * The brief's ontologies (ADR 0011): library versions the mapping stage draws its terms from
 * (vocabulary) or that check the document's graph (shapes), and guidance for the mapping.
 */
export function BriefOntologies({
  title = 'Ontologies',
  api,
  ontologies,
  guidance,
  dataPolicy,
  onChange,
}: {
  /** The card's heading (the Survey tab's section has its own "Ontologies"). */
  title?: string;
  api: Api;
  ontologies: BriefOntology[];
  guidance: string;
  dataPolicy: DataPolicy | null;
  onChange: (next: { ontologies: BriefOntology[]; ontologyGuidance: string }) => void;
}) {
  const titleId = useId();
  const [library, setLibrary] = useState<OntologySummary[]>([]);
  const [pickId, setPickId] = useState('');
  const [detail, setDetail] = useState<OntologyDetail | null>(null);
  const [version, setVersion] = useState('');
  const [role, setRole] = useState<BriefOntology['role']>('vocabulary');
  useEffect(() => {
    api.listOntologies().then(setLibrary, () => setLibrary([]));
  }, [api]);
  useEffect(() => {
    setDetail(null);
    setVersion('');
    if (pickId) api.getOntology(pickId).then(setDetail, () => setDetail(null));
  }, [api, pickId]);

  const set = (next: BriefOntology[]) => onChange({ ontologies: next, ontologyGuidance: guidance });
  const summaryOf = (id: string) => library.find((o) => o.id === id);
  const ready = (detail?.versions ?? []).filter((v) => v.status === 'ready');
  const localOnly = ontologies.some(
    (o) => o.role === 'vocabulary' && summaryOf(o.ontologyId)?.localOnly,
  );

  return (
    <section id="brief-ontologies-card" className="card brief-ontologies" aria-labelledby={titleId}>
      <span className="drop-icon" aria-hidden="true">
        <Icon name="graph" />
      </span>
      <div className="brief-ontologies-body">
        <h3 id={titleId}>{title}</h3>
        <p className="muted">
          The vocabularies the Mapping stage draws its terms from, and shapes the document&apos;s
          graph is checked against.
        </p>
        {ontologies.length > 0 && (
          <ul aria-label="Chosen ontologies">
            {ontologies.map((o, i) => {
              const latest = summaryOf(o.ontologyId)?.latest;
              const newer =
                latest && latest.status === 'ready' && latest.version > o.version
                  ? latest.version
                  : null;
              return (
                <li
                  key={`${o.ontologyId}@${o.version}`}
                  aria-label={`${o.ontologyId} v${o.version}`}
                >
                  <a href={`#/ontologies/${encodeURIComponent(o.ontologyId)}`}>
                    {summaryOf(o.ontologyId)?.label ?? o.ontologyId}
                  </a>{' '}
                  v{o.version} · {o.role}
                  {newer !== null && (
                    <>
                      {' '}
                      <span className="version-tag">Update available: v{newer}</span>{' '}
                      <button
                        type="button"
                        onClick={() =>
                          set(ontologies.map((x, j) => (j === i ? { ...x, version: newer } : x)))
                        }
                      >
                        Use v{newer}
                      </button>
                    </>
                  )}{' '}
                  <button
                    type="button"
                    aria-label={`Remove ${o.ontologyId} v${o.version}`}
                    onClick={() => set(ontologies.filter((_, j) => j !== i))}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {localOnly && dataPolicy === 'external' && (
          <p className="muted">
            A chosen ontology is local only: mapping will use local models for this project.
          </p>
        )}
        <div className="pin-form">
          <label>
            Ontology
            <select value={pickId} onChange={(e) => setPickId(e.target.value)}>
              <option value="">— choose —</option>
              {library.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Version
            <select value={version} disabled={!detail} onChange={(e) => setVersion(e.target.value)}>
              <option value="">— choose —</option>
              {ready.map((v) => (
                <option key={v.version} value={String(v.version)}>
                  v{v.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as BriefOntology['role'])}>
              <option value="vocabulary">vocabulary</option>
              <option value="shapes">shapes</option>
            </select>
          </label>
          <button
            type="button"
            disabled={!pickId || !version}
            onClick={() => {
              set([
                ...ontologies.filter((o) => !(o.ontologyId === pickId && o.role === role)),
                { ontologyId: pickId, version: Number(version), role },
              ]);
              setPickId('');
            }}
          >
            Add ontology
          </button>
        </div>
        <label>
          Guidance for the mapping
          <textarea
            rows={3}
            value={guidance}
            onChange={(e) => onChange({ ontologies, ontologyGuidance: e.target.value })}
          />
        </label>
      </div>
    </section>
  );
}
