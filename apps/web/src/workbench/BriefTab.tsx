import { useState, type FormEvent } from 'react';
import { EMPTY_BRIEF, type Brief, type BriefBody } from '@ih/shared';
import type { Api } from '../api/client.js';

/** Brief fields edited as free text (`answers` is filled from the Survey stage). */
type TextField = Exclude<keyof BriefBody, 'answers'>;

const FIELDS: { key: TextField; label: string; hint: string }[] = [
  { key: 'purpose', label: 'Purpose', hint: 'What the outputs are for and who consumes them.' },
  {
    key: 'outputs',
    label: 'Outputs wanted',
    hint: 'Must-have and nice-to-have values, in plain words.',
  },
  { key: 'exampleOutput', label: 'Example output', hint: 'A mock CSV or a few example rows.' },
  { key: 'glossary', label: 'Glossary', hint: 'Domain terms and abbreviations.' },
  {
    key: 'variants',
    label: 'Variants',
    hint: 'Known issuers, layouts, languages, blank vs executed copies.',
  },
  {
    key: 'rules',
    label: 'Rules',
    hint: 'For example: placeholders are null; use the executed copy; dates are DMY.',
  },
];

/** The user's product knowledge for this document type; every save is a new version. */
export function BriefTab({
  api,
  projectId,
  brief,
  onSaved,
}: {
  api: Api;
  projectId: string;
  brief: Brief | null;
  onSaved: (brief: Brief) => void;
}) {
  const [body, setBody] = useState<BriefBody>(brief?.body ?? EMPTY_BRIEF);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(body) !== JSON.stringify(brief?.body ?? EMPTY_BRIEF);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const saved = await api.saveBrief(projectId, body);
      onSaved(saved);
      setMessage(`Saved as version ${saved.version}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form aria-label="Brief" className="brief-form" onSubmit={(e) => void save(e)}>
      {FIELDS.map((f) => (
        <div key={f.key}>
          <label htmlFor={`brief-${f.key}`}>{f.label}</label>
          <small id={`brief-${f.key}-hint`} className="muted">
            {f.hint}
          </small>
          <textarea
            id={`brief-${f.key}`}
            aria-describedby={`brief-${f.key}-hint`}
            rows={4}
            value={body[f.key]}
            onChange={(e) => setBody({ ...body, [f.key]: e.target.value })}
          />
        </div>
      ))}
      {brief && <p className="muted">Version {brief.version}</p>}
      <button type="submit" className="primary" disabled={!dirty}>
        Save brief
      </button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
