import { useEffect, useRef, useState } from 'react';
import type { AnchorSuggestion, SampleView, SegmentDocument } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { sectionTone, TONE_COLOR } from '../ui/stageStyle.js';
import { SampleText, type TextMark } from './SampleText.js';
import { SegmentationGrid } from './SegmentationGrid.js';
import { plural } from './samples.js';
import {
  hitTone,
  initialSelection,
  landingText,
  move,
  sectionHits,
  suggestionFor,
  type Selection,
} from './segmentation.js';
import { useSegmentPreview } from './useSegmentPreview.js';

export const PREVIEW_DEBOUNCE_MS = 600;

type Row = { key: number; id: string; anchor: string; required: boolean; description?: string };
type Copies = { anchor: string; select: 'first' | 'last' } | null;

/** Every row has a filled anchor and a non-empty id, and ids are unique. */
function isComplete(rows: Row[]): boolean {
  return (
    rows.length > 0 &&
    rows.every((r) => r.id && r.anchor) &&
    new Set(rows.map((r) => r.id)).size === rows.length
  );
}

function candidate(rows: Row[], copies: Copies, pageMarkers: boolean): SegmentDocument {
  return {
    sections: rows.map((r) => ({
      id: r.id,
      anchor: r.anchor,
      required: r.required,
      ...(r.description !== undefined ? { description: r.description } : {}),
    })),
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
  onDirtyChange,
}: {
  api: Api;
  projectId: string;
  draft: number | null;
  pollMs: number;
  /** Reports whether there are unsaved anchor edits (false again on unmount). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [copies, setCopies] = useState<Copies>(null);
  const [pageMarkers, setPageMarkers] = useState(true);
  const [saved, setSaved] = useState('');
  const [samples, setSamples] = useState<SampleView[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { view, running, error: previewError, preview } = useSegmentPreview(api, projectId, pollMs);
  const [saving, setSaving] = useState(false);
  // An edit whose debounced preview has not started yet.
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextKey = useRef(0);

  useEffect(() => {
    if (draft === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [{ record }, list] = await Promise.all([
          api.getTemplate(projectId, draft),
          api.listSamples(projectId),
        ]);
        if (cancelled) return;
        const block = (record.definition.document ?? {}) as {
          sections?: { id: string; anchor: string; required?: boolean; description?: string }[];
          copies?: Copies;
          pageMarkers?: boolean;
        };
        const loaded = (block.sections ?? []).map((s) => ({
          key: nextKey.current++,
          id: s.id,
          anchor: s.anchor,
          required: s.required ?? true,
          ...(s.description !== undefined ? { description: s.description } : {}),
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
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, projectId, draft, preview]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const dirtyNow = rows !== null && JSON.stringify(candidate(rows, copies, pageMarkers)) !== saved;
  const reportDirty = useRef(onDirtyChange);
  reportDirty.current = onDirtyChange;
  useEffect(() => {
    reportDirty.current?.(dirtyNow);
  }, [dirtyNow]);
  useEffect(() => () => reportDirty.current?.(false), []);

  const result = view?.result ?? null;
  useEffect(() => {
    if (!result) return;
    setSelected((current) =>
      current && result.samples.some((s) => s.sampleId === current.sampleId)
        ? current
        : initialSelection(result),
    );
  }, [result]);

  if (draft === null) {
    return <p className="muted">Start the next version on the Template tab to edit anchors.</p>;
  }
  if (rows === null) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;

  const current = candidate(rows, copies, pageMarkers);
  const dirty = JSON.stringify(current) !== saved;
  const complete = isComplete(rows);
  // A preview that timed out means an anchor backtracks; production segmentation has no such cap.
  const slowAnchor = previewError?.includes('backtrack') ?? false;
  // The worker reports an anchor that is not a valid regular expression.
  const invalidAnchor = Object.keys(view?.result?.anchorErrors ?? {}).length > 0;
  const settling = pending || running;
  // Why Save is disabled, in the order the user can fix things.
  const saveBlocked = saving
    ? 'Saving…'
    : invalidAnchor
      ? 'Fix the invalid anchor to save'
      : slowAnchor
        ? 'Fix the slow anchor to save'
        : !complete
          ? 'Every section needs an id and an anchor; ids must differ'
          : settling
            ? 'Waiting for the preview'
            : !dirty
              ? 'No unsaved changes'
              : undefined;

  const edit = (nextRows: Row[], nextCopies: Copies = copies) => {
    setRows(nextRows);
    setCopies(nextCopies);
    setMessage(null);
    if (timer.current) clearTimeout(timer.current);
    if (isComplete(nextRows)) {
      setPending(true);
      timer.current = setTimeout(() => {
        setPending(false);
        preview(candidate(nextRows, nextCopies, pageMarkers));
      }, PREVIEW_DEBOUNCE_MS);
    } else {
      setPending(false);
    }
  };
  const setRow = (i: number, patch: Partial<Row>) => {
    if (selected && patch.id !== undefined && selected.sectionId === rows[i]?.id) {
      setSelected({ ...selected, sectionId: patch.id });
    }
    edit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
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
    } finally {
      setSaving(false);
    }
  };

  const addSection = () =>
    edit([...rows, { key: nextKey.current++, id: '', anchor: '', required: true }]);
  const selectedSample = selected ? samples.find((s) => s.id === selected.sampleId) : undefined;
  const selectedRow =
    selected && result ? result.samples.find((s) => s.sampleId === selected.sampleId) : undefined;
  const cellOf = (id: string) => selectedRow?.sections.find((c) => c.id === id);
  const indexOf = (id: string) => rows.findIndex((r) => r.id === id);
  const colour = (id: string) => {
    const i = indexOf(id);
    return i < 0 ? TONE_COLOR.neutral : TONE_COLOR[sectionTone(i)];
  };
  const marks: TextMark[] = (selectedRow?.sections ?? [])
    .filter((c) => c.found && c.page !== null && c.line !== null)
    .map((c) => ({ page: c.page!, line: c.line!, label: c.id, color: colour(c.id) }));
  const selectedSection = selected ? rows.find((r) => r.id === selected.sectionId) : undefined;
  const missingRequired =
    selectedSection?.required === true &&
    selectedRow?.error === null &&
    cellOf(selectedSection.id)?.found === false;
  const suggestion =
    result && selected ? suggestionFor(result, selected.sampleId, selected.sectionId) : null;
  const applySuggestion = (s: AnchorSuggestion) => {
    const i = indexOf(s.section);
    if (i >= 0) setRow(i, { anchor: s.anchor });
  };
  const prepared = result ? result.samples.filter((s) => s.error === null).length : 0;
  const hitsOf = (id: string) =>
    result && result.samples.some((s) => s.sections.some((c) => c.id === id))
      ? sectionHits(result, id)
      : null;

  return (
    <div className="sections-tab">
      <div className="sections-layout">
        <div className="sections-main">
          <section className="card anchors-card" aria-labelledby="anchors-title">
            <div className="anchors-head">
              <h3 id="anchors-title">Anchors</h3>
              <span className="muted" aria-live="polite">
                {running
                  ? 'Updating the preview…'
                  : result
                    ? `Live preview on ${plural(prepared, 'prepared sample')}`
                    : 'No preview yet'}
              </span>
              {dirty && <span className="tone-text-warn unsaved-note">Unsaved anchors</span>}
              <span className="anchors-actions">
                <button type="button" onClick={addSection}>
                  <Icon name="plus" /> Add section
                </button>
                <button
                  type="button"
                  className={dirty ? 'primary' : undefined}
                  onClick={() => void save()}
                  disabled={saveBlocked !== undefined}
                  title={saveBlocked}
                >
                  Save to draft v{draft}
                </button>
              </span>
            </div>
            {slowAnchor && <p className="muted">Fix the slow anchor to save.</p>}
            {invalidAnchor && !slowAnchor && (
              <p className="muted">Fix the invalid anchor to save.</p>
            )}
            {message && <p role="status">{message}</p>}
            {(error ?? previewError) && <p role="alert">{error ?? previewError}</p>}
            <ol className="anchor-list">
              {rows.map((r, i) => {
                const hits = hitsOf(r.id);
                const tone = hits ? hitTone(hits.hits, hits.of, r.required) : 'neutral';
                return (
                  <li
                    key={r.key}
                    className={`anchor-row${selected?.sectionId === r.id ? ' selected' : ''}`}
                  >
                    <span
                      className="anchor-order"
                      aria-hidden="true"
                      style={{ background: TONE_COLOR[sectionTone(i)] }}
                    >
                      {i + 1}
                    </span>
                    <input
                      className="mono anchor-id"
                      aria-label={`Id of section ${i + 1}`}
                      value={r.id}
                      onChange={(e) => setRow(i, { id: e.target.value })}
                    />
                    <input
                      className="mono anchor-regex"
                      aria-label={`Anchor of section ${i + 1}`}
                      aria-invalid={tone === 'danger'}
                      value={r.anchor}
                      onChange={(e) => setRow(i, { anchor: e.target.value })}
                    />
                    <span
                      className={`hits-badge tone-${tone}`}
                      role="img"
                      aria-label={
                        hits
                          ? `Matched in ${hits.hits} of ${hits.of} samples`
                          : 'Not in the preview yet'
                      }
                    >
                      {hits ? `${hits.hits}/${hits.of}` : '–'}
                    </span>
                    <label className="inline anchor-required">
                      <input
                        type="checkbox"
                        aria-label={`Section ${i + 1} required`}
                        checked={r.required}
                        onChange={(e) => setRow(i, { required: e.target.checked })}
                      />{' '}
                      Required
                    </label>
                    <span className="anchor-tools">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move section ${i + 1} up`}
                        disabled={i === 0}
                        onClick={() => edit(move(rows, i, i - 1))}
                      >
                        <Icon name="chevronUp" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move section ${i + 1} down`}
                        disabled={i === rows.length - 1}
                        onClick={() => edit(move(rows, i, i + 1))}
                      >
                        <Icon name="chevronDown" />
                      </button>
                      <button
                        type="button"
                        className="icon-button danger"
                        aria-label={`Remove section ${i + 1}`}
                        onClick={() => edit(rows.filter((_, j) => j !== i))}
                      >
                        <Icon name="trash" />
                      </button>
                    </span>
                    {selectedSample && selectedRow?.error === null && (
                      <p
                        className={`anchor-landing${tone === 'danger' && cellOf(r.id)?.found === false ? ' tone-text-danger' : ''}`}
                      >
                        {landingText(selectedSample.filename, cellOf(r.id), r.required)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
            <details className="document-options">
              <summary>
                Document options · page markers {pageMarkers ? 'on' : 'off'} ·{' '}
                {copies?.anchor ? `keeps the ${copies.select} copy` : 'no copy selection'}
              </summary>
              <fieldset className="copies">
                <legend>Several copies in one document</legend>
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
                      copies &&
                      edit(rows, { ...copies, select: e.target.value as 'first' | 'last' })
                    }
                  >
                    <option value="last">last copy</option>
                    <option value="first">first copy</option>
                  </select>
                </label>
              </fieldset>
            </details>
          </section>
          {result && (
            <section className="card grid-card" aria-labelledby="grid-title">
              <div className="grid-head">
                <h3 id="grid-title">Where each anchor lands</h3>
                <span className="muted">Click a cell to see it in the text</span>
              </div>
              <SegmentationGrid
                result={result}
                sections={rows.map((r) => ({ id: r.id, required: r.required }))}
                samples={samples}
                selected={selected}
                onOpen={(sampleId, sectionId) => setSelected({ sampleId, sectionId })}
              />
            </section>
          )}
        </div>
        {selected && selectedSample && (
          <aside className="card section-text" aria-label={`Text of ${selectedSample.filename}`}>
            <h3>{selectedSample.filename}</h3>
            <p className="muted">Section starts marked in their colours</p>
            {missingRequired && selectedSection && (
              <div
                className="anchor-hint"
                role="note"
                aria-label={`${selectedSection.id} not found`}
              >
                <p>
                  <strong>{selectedSection.id} not found.</strong>{' '}
                  {suggestion
                    ? suggestion.reason
                    : 'No other way of writing its label starts a line in this sample; edit the anchor by hand.'}
                </p>
                {suggestion && !settling && (
                  <button type="button" onClick={() => applySuggestion(suggestion)}>
                    Use <code>{suggestion.anchor}</code>
                  </button>
                )}
              </div>
            )}
            <SampleText
              key={selected.sampleId}
              api={api}
              projectId={projectId}
              sampleId={selected.sampleId}
              marks={marks}
              focus={selected.sectionId}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
