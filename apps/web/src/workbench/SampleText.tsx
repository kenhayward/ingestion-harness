import { useEffect, useState } from 'react';
import type { PreparedText } from '@ih/shared';
import type { Api } from '../api/client.js';

/** A sample's prepared text (after extraction and OCR), one region per page. */
export function SampleText({
  api,
  projectId,
  sampleId,
}: {
  api: Api;
  projectId: string;
  sampleId: string;
}) {
  const [text, setText] = useState<PreparedText | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSampleText(projectId, sampleId).then(setText, (err: Error) => setError(err.message));
  }, [api, projectId, sampleId]);

  if (error) return <p role="alert">{error}</p>;
  if (!text) return <p>Loading text…</p>;
  return (
    <div className="sample-text">
      {text.pages.map((p) => (
        <section key={p.number} aria-label={`Page ${p.number}`}>
          <h4>
            Page {p.number}
            {p.ocr && <small className="badge"> OCR</small>}
          </h4>
          <pre>{p.text}</pre>
        </section>
      ))}
    </div>
  );
}
