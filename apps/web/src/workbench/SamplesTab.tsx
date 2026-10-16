import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { MAX_SAMPLES, type SampleRole, type SampleView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { isSourceFile, SOURCE_ACCEPT } from '../documents.js';
import { Icon } from '../ui/Icon.js';
import { Meter } from '../ui/Meter.js';
import { Segmented } from '../ui/Segmented.js';
import { SampleText } from './SampleText.js';
import {
  batchProgress,
  DEV_TARGET,
  HOLDOUT_MIN,
  holdoutLine,
  plural,
  prepareFraction,
  prepareNote,
  sampleMeta,
  samplePages,
  sampleSummary,
  uploadFraction,
  uploadNote,
  type UploadProgress,
} from './samples.js';
import { SampleTag } from './tags.js';

const ROLES = [
  { value: 'dev', label: 'Dev' },
  { value: 'holdout', label: 'Holdout' },
] as const;
/** Failures that retrying cannot fix: the file itself has to be replaced. */
const PERMANENT: ReadonlySet<string> = new Set(['password', 'corrupt', 'too_large']);

const PILL = {
  ready: { label: 'Ready', tone: 'ok' },
  preparing: { label: 'Preparing', tone: 'info' },
  failed: { label: 'Failed', tone: 'danger' },
} as const;
const GROUP = {
  dev: { title: 'Development', note: 'the model reads these while drafting' },
  holdout: { title: 'Holdout', note: 'only used to score the draft for publishing' },
} as const;

function SummaryCard({
  title,
  figure,
  unit,
  meter,
  foot,
  footTone,
}: {
  title: string;
  figure: number;
  unit: string;
  meter: { label: string; value: number; tone: 'ok' | 'accent' | 'warn' | 'skip' };
  foot: string;
  footTone?: 'warn';
}) {
  return (
    <section className="card summary-card" aria-label={title}>
      <h3>{title}</h3>
      <p className="summary-figure">
        <strong>{figure}</strong>
        <span className="muted">{unit}</span>
      </p>
      <Meter label={meter.label} value={meter.value} tone={meter.tone} />
      <p className={footTone ? 'summary-foot tone-text-warn' : 'summary-foot muted'}>{foot}</p>
    </section>
  );
}

/** Upload, triage and roles of a project's samples (PDF or Word). Polls while any is preparing. */
export function SamplesTab({
  api,
  projectId,
  pollMs,
  retired = null,
  onChanged,
}: {
  api: Api;
  projectId: string;
  pollMs: number;
  /** Why job-creating actions are off (a retired document type); null when they are not. */
  retired?: string | null;
  /** Called after a successful upload, retry, role change or removal. */
  onChanged?: () => void;
}) {
  const [samples, setSamples] = useState<SampleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [addAs, setAddAs] = useState<SampleRole>('dev');
  const [over, setOver] = useState(false);
  /** The files of the current upload not yet in (#142), in upload order. */
  const [uploads, setUploads] = useState<(UploadProgress & { key: number; name: string })[]>([]);

  const [listError, setListError] = useState<string | null>(null);
  const alive = useRef(true);
  const inflight = useRef(false);
  const latest = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const next = await api.listSamples(projectId);
      if (!alive.current || seq !== latest.current) return;
      setSamples(next);
      setListError(null);
    } catch (err) {
      if (alive.current && seq === latest.current) setListError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const preparing = samples?.some((s) => s.state === 'preparing') ?? false;
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => {
      if (inflight.current) return;
      inflight.current = true;
      void refresh().finally(() => {
        inflight.current = false;
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [preparing, pollMs, refresh]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    }
    await refresh();
  };

  const upload = async (files: File[]) => {
    const failures = files
      .filter((f) => !isSourceFile(f))
      .map((f) => `${f.name}: not a PDF or Word document`);
    const slots = Math.max(0, MAX_SAMPLES - (samples?.length ?? 0));
    const accepted = files.filter(isSourceFile);
    for (const f of accepted.slice(slots)) failures.push(`${f.name}: no sample slots left`);
    const batch = accepted.slice(0, slots);
    setUploading(true);
    setUploads(
      batch.map((f, key) => ({ key, name: f.name, sent: 0, total: f.size, started: false })),
    );
    const update = (key: number, next: Partial<UploadProgress>) =>
      setUploads((rows) => rows.map((r) => (r.key === key ? { ...r, ...next } : r)));
    let uploaded = 0;
    for (const [key, file] of batch.entries()) {
      update(key, { started: true });
      try {
        await api.uploadSample(projectId, file, addAs, (sent, total) =>
          update(key, { sent, total }),
        );
        uploaded += 1;
        // Show it (preparing) while the rest upload.
        await refresh();
      } catch (err) {
        failures.push(`${file.name}: ${(err as Error).message}`);
      }
      setUploads((rows) => rows.filter((r) => r.key !== key));
    }
    setUploading(false);
    setError(failures.length ? failures.join('; ') : null);
    if (uploaded > 0) onChanged?.();
    await refresh();
  };

  const slotsLeft = Math.max(0, MAX_SAMPLES - (samples?.length ?? 0));
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!uploading && slotsLeft > 0 && retired === null) void upload([...e.dataTransfer.files]);
  };

  if (samples === null) {
    return (error ?? listError) ? <p role="alert">{error ?? listError}</p> : <p>Loading…</p>;
  }
  const summary = sampleSummary(samples);
  const ready = samples.filter((s) => s.state === 'ready');
  const shown =
    ready.find((s) => s.id === selected) ?? ready.find((s) => s.role === 'dev') ?? ready[0] ?? null;
  const batch = batchProgress(samples, uploads.length);
  const devOk = summary.dev.total >= DEV_TARGET.min && summary.dev.total <= DEV_TARGET.max;
  const gateOk = summary.holdout.ready >= HOLDOUT_MIN;

  return (
    <div className="samples-tab">
      <div className="summary-cards">
        <SummaryCard
          title="Dev samples"
          figure={summary.dev.ready}
          unit={`ready of ${summary.dev.total}`}
          meter={{
            label: 'Dev samples ready',
            value: summary.dev.total ? summary.dev.ready / summary.dev.total : 0,
            tone: 'ok',
          }}
          foot={`${DEV_TARGET.min}–${DEV_TARGET.max} recommended`}
          footTone={devOk ? undefined : 'warn'}
        />
        <SummaryCard
          title="Holdout samples"
          figure={summary.holdout.ready}
          unit="ready"
          meter={{
            label: 'Holdout samples for the gate',
            value: Math.min(1, summary.holdout.ready / HOLDOUT_MIN),
            tone: 'skip',
          }}
          foot={
            gateOk
              ? `Enough for the publish gate (≥ ${HOLDOUT_MIN})`
              : `Add ${HOLDOUT_MIN - summary.holdout.ready} more for the publish gate (≥ ${HOLDOUT_MIN})`
          }
          footTone={gateOk ? undefined : 'warn'}
        />
        <SummaryCard
          title="Capacity"
          figure={summary.used}
          unit={`of ${MAX_SAMPLES}`}
          meter={{ label: 'Capacity used', value: summary.used / MAX_SAMPLES, tone: 'accent' }}
          foot={`${plural(summary.slots, 'slot')} left`}
        />
        <SummaryCard
          title="OCR"
          figure={summary.ocrPages}
          unit={`of ${summary.pages} pages`}
          meter={{
            label: 'Pages read by OCR',
            value: summary.pages ? summary.ocrPages / summary.pages : 0,
            tone: 'accent',
          }}
          foot="Pages without a text layer"
        />
      </div>

      <div
        className={`drop-zone sample-drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className="drop-icon" aria-hidden="true">
          <Icon name="upload" size={20} />
        </span>
        <div className="drop-text">
          <strong>
            Drop sample files here or{' '}
            <label className="browse-link">
              browse
              <input
                type="file"
                className="visually-hidden"
                aria-label="Add sample documents"
                accept={SOURCE_ACCEPT}
                multiple
                disabled={uploading || summary.slots === 0 || retired !== null}
                title={retired ?? undefined}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length) void upload(files);
                }}
              />
            </label>
          </strong>
          <small>
            PDF or Word. Each is prepared in the background: text extraction, then OCR for pages
            without a text layer · {summary.slots} of {MAX_SAMPLES} slots left
          </small>
        </div>
        <div className="drop-role">
          <span className="muted">Add as</span>
          <Segmented label="Add as" options={ROLES} value={addAs} onChange={setAddAs} />
        </div>
      </div>
      {(error ?? listError) && <p role="alert">{error ?? listError}</p>}
      {batch && (
        <section className="card batch-progress" aria-label="Preparing samples">
          <div className="batch-progress-head">
            <h3>Preparing samples</h3>
            <span className="muted">{batch.text}</span>
          </div>
          <Meter label="All samples" value={batch.value} tone="accent" />
          {uploads.length > 0 && (
            <ul aria-label="Uploads" className="upload-rows">
              {uploads.map((u) => (
                <li key={u.key} aria-label={u.name} className="upload-row">
                  <span className="upload-name">{u.name}</span>
                  <span className="muted">{uploadNote(u)}</span>
                  <Meter label={`Uploading ${u.name}`} value={uploadFraction(u)} tone="accent" />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="samples-layout">
        <div className="sample-groups">
          {(['dev', 'holdout'] as const).map((role) => {
            const rows = samples.filter((s) => s.role === role);
            return (
              <section key={role} className="card sample-group" aria-labelledby={`samples-${role}`}>
                <div className={`sample-group-head tone-${role === 'dev' ? 'info' : 'skip'}`}>
                  <SampleTag role={role} />
                  <h3 id={`samples-${role}`}>{GROUP[role].title}</h3>
                  <span className="muted">
                    {plural(rows.length, 'sample')} · {GROUP[role].note}
                  </span>
                </div>
                {rows.length === 0 ? (
                  <p className="muted sample-empty">
                    No {role} samples yet. Add some with “Add as{' '}
                    {role === 'dev' ? 'Dev' : 'Holdout'}”.
                  </p>
                ) : (
                  <ul aria-label={role === 'dev' ? 'Dev samples' : 'Holdout samples'}>
                    {rows.map((s) => {
                      const note = prepareNote(s);
                      const pages = samplePages(s);
                      const fraction = s.state === 'preparing' ? prepareFraction(s) : null;
                      const pill = PILL[s.state];
                      const isShown = shown?.id === s.id;
                      return (
                        <li
                          key={s.id}
                          aria-label={s.filename}
                          className={`sample-row${isShown ? ' selected' : ''}`}
                        >
                          <span
                            className="page-badge"
                            role="img"
                            aria-label={pages === null ? 'Pages unknown' : plural(pages, 'page')}
                          >
                            {pages ?? '?'}
                          </span>
                          <div className="sample-main">
                            <div className="sample-title">
                              <button
                                type="button"
                                className="sample-name"
                                aria-label={`Show text of ${s.filename}`}
                                aria-pressed={isShown}
                                disabled={s.state !== 'ready'}
                                title={
                                  s.state === 'ready'
                                    ? undefined
                                    : 'Text is shown once the sample is prepared'
                                }
                                onClick={() => setSelected(s.id)}
                              >
                                {s.filename}
                              </button>
                              <span className={`pill tone-${pill.tone}`}>{pill.label}</span>
                            </div>
                            <p className="muted sample-meta">{sampleMeta(s)}</p>
                            {note && (
                              <p className={`sample-note tone-text-${note.tone}`}>{note.text}</p>
                            )}
                            {fraction !== null && (
                              <div className="sample-progress">
                                <Meter
                                  label={`Preparing ${s.filename}`}
                                  value={fraction}
                                  tone="accent"
                                />
                                <span className="muted">{Math.round(fraction * 100)}%</span>
                              </div>
                            )}
                            {s.role === 'holdout' && (
                              <p className="sample-note holdout-note">
                                {holdoutLine(s.holdoutRuns)}
                              </p>
                            )}
                          </div>
                          <div className="sample-actions">
                            <Segmented
                              label={`Role of ${s.filename}`}
                              options={ROLES}
                              value={s.role}
                              onChange={(next) => {
                                if (next !== s.role) {
                                  void act(() => api.setSampleRole(projectId, s.id, next));
                                }
                              }}
                            />
                            {s.state === 'failed' &&
                              s.prepareJobId &&
                              !PERMANENT.has(s.prepareError?.code ?? '') && (
                                <button
                                  type="button"
                                  className="icon-button"
                                  aria-label={`Retry ${s.filename}`}
                                  onClick={() => void act(() => api.retryJob(s.prepareJobId!))}
                                >
                                  Retry
                                </button>
                              )}
                            <button
                              type="button"
                              className="icon-button danger"
                              aria-label={`Remove ${s.filename}`}
                              onClick={() => void act(() => api.removeSample(projectId, s.id))}
                            >
                              <Icon name="trash" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>

        <section className="card sample-preview" aria-label="Text preview">
          {shown ? (
            <>
              <div className="sample-preview-head">
                <h3>{shown.filename}</h3>
                <span className="muted">
                  {(shown.triage?.chars ?? 0).toLocaleString('en-GB')} characters
                </span>
              </div>
              <SampleText
                key={shown.id}
                api={api}
                projectId={projectId}
                sampleId={shown.id}
                paged
              />
              <p className="muted sample-preview-foot">
                {shown.triage?.ocrPages.length ? 'Read by OCR' : 'Text layer'} · cached per PDF
                hash, so re-runs see identical text
              </p>
            </>
          ) : (
            <p className="muted">The prepared text of a ready sample shows here.</p>
          )}
        </section>
      </div>
    </div>
  );
}
