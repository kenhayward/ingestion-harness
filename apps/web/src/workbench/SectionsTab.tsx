import { useEffect, useRef, useState } from 'react';
import type { SampleView, SegmentDocument } from '@ih/shared';
import type { Api } from '../api/client.js';
import { SampleText } from './SampleText.js';
import { SegmentationGrid } from './SegmentationGrid.js';
import { useSegmentPreview } from './useSegmentPreview.js';

export const PREVIEW_DEBOUNCE_MS = 600;

type Row = { id: string; anchor: string; required: boolean };
type Copies = { anchor: string; select: 'first' | 'last' } | null;

function candidate(rows: Row[], copies: Copies, pageMarkers: boolean): SegmentDocument {
  return {
    sections: rows.map((r) => ({ id: r.id, anchor: r.anchor, required: r.required })),
    ...(copies && copies.anchor ? { copies } : {}),
    pageMarkers,
  };
}

/** Edit section anchors and see, live, where they land in every prepared sample. */
export function SectionsTab({
  api,
  projectId,
  draft,
  pollMs,
}: {
  api: Api;
  projectId: string;
  draft: number | null;
  pollMs: number;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [copies, setCopies] = useState<Copies>(null);
  const [pageMarkers, setPageMarkers] = useState(true);
  const [saved, setSaved] = useState('');
  const [samples, setSamples] = useState<SampleView[]>([]);
  const [open, setOpen] = useState<{ sampleId: string; sectionId: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { view, running, error: previewError, preview } = useSegmentPreview(api, projectId, pollMs);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (draft === null) return;
    void (async () => {
      try {
        const [{ record }, list] = await Promise.all([
          api.getTemplate(projectId, draft),
          api.listSamples(projectId),
        ]);
        const block = (record.definition.document ?? {}) as {
          sections?: { id: string; anchor: string; required?: boolean }[];
          copies?: Copies;
          pageMarkers?: boolean;
        };
        const loaded = (block.sections ?? []).map((s) => ({
          id: s.id,
          anchor: s.anchor,
          required: s.required ?? true,
        }));
        const loadedCopies = block.copies ?? null;
        const loadedMarkers = block.pageMarkers ?? true;
        setRows(loaded);
        setCopies(loadedCopies);
        setPageMarkers(loadedMarkers);
        setSaved(JSON.stringify(candidate(loaded, loadedCopies, loadedMarkers)));
        setSamples(list);
        if (loaded.length) preview(candidate(loaded, loadedCopies, loadedMarkers));
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [api, projectId, draft, preview]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (draft === null) {
    return <p className="muted">Start the next version on the Template tab to edit anchors.</p>;
  }
  if (rows === null) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;

  const current = candidate(rows, copies, pageMarkers);
  const dirty = JSON.stringify(current) !== saved;
  const complete = rows.length > 0 && rows.every((r) => r.id && r.anchor);

  const edit = (nextRows: Row[], nextCopies: Copies = copies) => {
    setRows(nextRows);
    setCopies(nextCopies);
    setMessage(null);
    if (timer.current) clearTimeout(timer.current);
    if (nextRows.length && nextRows.every((r) => r.id && r.anchor)) {
      timer.current = setTimeout(
        () => preview(candidate(nextRows, nextCopies, pageMarkers)),
        PREVIEW_DEBOUNCE_MS,
      );
    }
  };
  const setRow = (i: number, patch: Partial<Row>) =>
    edit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setError(null);
    try {
      const { record } = await api.getTemplate(projectId, draft);
      const definition = record.definition;
      const document = { ...((definition.document ?? {}) as Record<string, unknown>) };
      delete document.copies;
      await api.saveTemplate(projectId, draft, {
        ...definition,
        document: {
          ...document,
          sections: current.sections,
          ...(current.copies ? { copies: current.copies } : {}),
        },
      });
      setSaved(JSON.stringify(current));
      setMessage(`Saved to v${draft}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openSample = open ? samples.find((s) => s.id === open.sampleId) : undefined;
  const marks =
    open && view?.result
      ? (view.result.samples
          .find((s) => s.sampleId === open.sampleId)
          ?.sections.filter((c) => c.found && c.page !== null && c.line !== null)
          .map((c) => ({ page: c.page!, line: c.line!, label: c.id })) ?? [])
      : [];

  return (
    <div className="sections-tab">
      <p className="muted">
        Each section starts at the first match of its anchor (a Python regular expression,
        multiline) and runs to the next one. The grid shows where every anchor lands in each
        prepared sample.
      </p>
      <table aria-label="Sections">
        <thead>
          <tr>
            <th>Id</th>
            <th>Anchor</th>
            <th>Required</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  aria-label={`Id of section ${i + 1}`}
                  value={r.id}
                  onChange={(e) => setRow(i, { id: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="mono"
                  aria-label={`Anchor of section ${i + 1}`}
                  value={r.anchor}
                  onChange={(e) => setRow(i, { anchor: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Section ${i + 1} required`}
                  checked={r.required}
                  onChange={(e) => setRow(i, { required: e.target.checked })}
                />
              </td>
              <td>
                <button
                  type="button"
                  aria-label={`Remove section ${i + 1}`}
                  onClick={() => edit(rows.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => edit([...rows, { id: '', anchor: '', required: true }])}>
        Add section
      </button>
      <fieldset className="copies">
        <legend>Several copies in one PDF</legend>
        <label>
          Copy anchor
          <input
            className="mono"
            value={copies?.anchor ?? ''}
            onChange={(e) =>
              edit(
                rows,
                e.target.value
                  ? { anchor: e.target.value, select: copies?.select ?? 'last' }
                  : null,
              )
            }
          />
        </label>
        <label>
          Keep
          <select
            value={copies?.select ?? 'last'}
            disabled={!copies}
            onChange={(e) =>
              copies && edit(rows, { ...copies, select: e.target.value as 'first' | 'last' })
            }
          >
            <option value="last">last copy</option>
            <option value="first">first copy</option>
          </select>
        </label>
      </fieldset>
      <div className="actions">
        <button type="button" onClick={() => preview(current)} disabled={!complete}>
          Preview
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void save()}
          disabled={!dirty || !complete}
        >
          Save to draft
        </button>
        {running && <span className="muted">Previewing…</span>}
        {message && <span role="status">{message}</span>}
      </div>
      {(error ?? previewError) && <p role="alert">{error ?? previewError}</p>}
      {view?.result && (
        <SegmentationGrid
          result={view.result}
          sections={rows.map((r) => ({ id: r.id, required: r.required }))}
          samples={samples}
          onOpen={(sampleId, sectionId) => setOpen({ sampleId, sectionId })}
        />
      )}
      {open && openSample && (
        <section aria-label={`Text of ${openSample.filename}`}>
          <h3>{openSample.filename}</h3>
          <SampleText
            key={open.sampleId}
            api={api}
            projectId={projectId}
            sampleId={open.sampleId}
            marks={marks}
          />
        </section>
      )}
    </div>
  );
}
