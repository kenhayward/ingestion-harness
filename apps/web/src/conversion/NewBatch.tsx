import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { sourceKeyProblem, type ConversionTarget } from '@ih/shared';
import type { Api } from '../api/client.js';
import { SOURCE_ACCEPT, isSourceFile } from '../documents.js';
import { readDrop, type Dropped } from '../jobs/folder-drop.js';
import { navigate } from '../router.js';
import { Icon } from '../ui/Icon.js';
import { Meter } from '../ui/Meter.js';

/** Hidden files and folders, and Office lock files (`~$report.docx` while report.docx is open). */
const hiddenOrLock = (path: string) =>
  path.split('/').some((part) => part.startsWith('.') || part.startsWith('~$'));

/** A file picked for the batch, and the source key that names its document. */
interface Picked {
  file: File;
  path: string;
}

interface Row {
  key: string;
  file: File;
  sourceKey: string;
  /** `invalid`: its source key breaks the rule, so it is never sent. */
  status: 'ready' | 'invalid' | 'uploading' | 'uploaded' | 'refused';
  message: string;
}

const ROW_CLASS: Record<Row['status'], string | undefined> = {
  ready: undefined,
  uploading: undefined,
  uploaded: 'upload-queued',
  refused: 'upload-error',
  invalid: 'upload-error',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const byPath = (a: Picked, b: Picked) => a.path.localeCompare(b.path, undefined, { numeric: true });

/**
 * The Conversion tab's new batch (decomposition phase 3): a target, Word or PDF files or a folder, and
 * Start. Start opens a batch, sends the files one per request (ruling R8), starts the batch and
 * opens its view. A file refused on upload says why on its row while the others carry on; then
 * the started batch is a link away, so the reasons stay in view.
 */
export function NewBatch({ api }: { api: Api }) {
  const filesId = useId();
  const folderId = useId();
  const [targets, setTargets] = useState<ConversionTarget[] | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [force, setForce] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  /** Files left out of what was picked: not Word or PDF, hidden or lock files. */
  const [leftOut, setLeftOut] = useState(0);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  /** While uploading: the file being sent (0-based), of how many, and how much of it is sent. */
  const [progress, setProgress] = useState<{ at: number; of: number; part: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A batch started with some files refused: the link to it, beside the reasons. */
  const [started, setStarted] = useState<string | null>(null);
  const nextKey = useRef(0);
  const cancelled = useRef(false);
  /** Set from the first Start until it settles, before any render can disable the button. */
  const starting = useRef(false);
  const gone = useRef(false);

  useEffect(() => {
    gone.current = false;
    return () => {
      // Left mid-upload: the loop stops, and the open batch stays unstarted (it can be discarded).
      gone.current = true;
    };
  }, []);

  useEffect(() => {
    api.listConversionTargets().then(
      (list) => {
        setTargets(list);
        setTarget((t) => t || (list[0]?.id ?? ''));
      },
      (err: Error) => setTargetsError(err.message),
    );
  }, [api]);

  function add(picked: Picked[], skipped = 0) {
    if (busy) return;
    const fresh = started !== null;
    setStarted(null);
    setError(null);
    const taken = picked.filter((p) => isSourceFile(p.file) && !hiddenOrLock(p.path));
    setLeftOut((n) => (fresh ? 0 : n) + skipped + picked.length - taken.length);
    const added = taken.map<Row>(({ file, path }) => {
      const problem = sourceKeyProblem(path);
      return {
        key: String(nextKey.current++),
        file,
        sourceKey: path.normalize('NFC'),
        status: problem ? 'invalid' : 'ready',
        message: problem ?? 'Ready',
      };
    });
    // A source key names one document, and the API takes it once a batch: a key already listed
    // (from an earlier pick, or earlier in this one) is flagged, and the first row is the one sent.
    setRows((prev) => {
      const kept = fresh ? [] : prev;
      const seen = new Set(kept.map((r) => r.sourceKey));
      const flagged = added.map<Row>((row) => {
        const repeated = seen.has(row.sourceKey);
        seen.add(row.sourceKey);
        return repeated && row.status === 'ready'
          ? { ...row, status: 'invalid', message: 'Already in the list' }
          : row;
      });
      return [...kept, ...flagged];
    });
  }

  const update = (key: string, status: Row['status'], message: string) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, status, message } : r)));

  /** Back to the list as picked: the open batch is gone, so nothing in it counts. */
  const unsend = () =>
    setRows((prev) =>
      prev.map((r) =>
        r.status === 'uploaded' || r.status === 'uploading'
          ? { ...r, status: 'ready', message: 'Ready' }
          : r,
      ),
    );

  async function discard(batchId: string) {
    try {
      await api.discardConversionBatch(batchId);
    } catch {
      // Left open: an unstarted batch has no jobs, and can be discarded later.
    }
  }

  async function start() {
    const todo = rows.filter((r) => r.status === 'ready');
    if (!todo.length || !target || starting.current) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    cancelled.current = false;
    const done = () => {
      starting.current = false;
      setBusy(false);
      setProgress(null);
    };
    let batchId: string;
    try {
      batchId = (await api.createConversionBatch({ targetId: target, force, autoApprove })).id;
    } catch (err) {
      setError(`The batch could not be opened: ${(err as Error).message}`);
      done();
      return;
    }
    let taken = 0;
    let refused = 0;
    for (const [at, row] of todo.entries()) {
      if (cancelled.current || gone.current) break;
      setProgress({ at, of: todo.length, part: 0 });
      update(row.key, 'uploading', 'Uploading…');
      try {
        await api.uploadConversionItem(batchId, row.file, row.sourceKey, (sent, total) =>
          setProgress({ at, of: todo.length, part: total ? sent / total : 0 }),
        );
        update(row.key, 'uploaded', 'Uploaded');
        taken++;
      } catch (err) {
        update(row.key, 'refused', (err as Error).message);
        refused++;
      }
    }
    setProgress(null); // the uploads are over: Cancel no longer applies
    if (gone.current) {
      // Left mid-upload: a batch with files stays open (unstarted); an empty one goes.
      if (!taken) await discard(batchId);
      return;
    }
    if (cancelled.current) {
      await discard(batchId);
      unsend();
      done();
      return;
    }
    if (!taken) {
      await discard(batchId);
      setError('No file was taken, so no batch was started.');
      done();
      return;
    }
    try {
      await api.startConversionBatch(batchId);
    } catch (err) {
      await discard(batchId);
      unsend();
      setError(`The batch did not start: ${(err as Error).message}. Try again.`);
      done();
      return;
    }
    done();
    if (gone.current) return;
    if (refused) setStarted(batchId);
    else navigate(`#/conversion/${encodeURIComponent(batchId)}`);
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const plain = [...e.dataTransfer.files].map((file) => ({ file, path: file.name }));
    // Folders are read after the event (readDrop takes what it needs now).
    const take = ({ files: loose, folders }: Dropped) =>
      add(
        [
          ...loose.map((file) => ({ file, path: file.name })),
          ...folders.flatMap((f) =>
            f.files.map((file, i) => ({ file, path: f.paths[i] ?? file.name })).sort(byPath),
          ),
        ],
        folders.reduce((n, f) => n + f.skipped, 0),
      );
    const dropped = readDrop(e.dataTransfer);
    if (dropped instanceof Promise) dropped.then(take, () => add(plain));
    else take(dropped);
  };

  const ready = rows.filter((r) => r.status === 'ready').length;
  const skipped = rows.filter((r) => r.status === 'invalid').length;
  const noTargets = targets !== null && targets.length === 0;
  const chosen = targets?.find((t) => t.id === target);
  const convert = ready ? `Convert ${plural(ready, 'document')}` : 'Convert documents';

  return (
    <section className="card new-batch" aria-label="New batch">
      <div className="new-batch-side">
        <div className="new-batch-step">
          <h2 className="new-batch-step-title">
            <span className="step-no">1</span> Target
          </h2>
          <select
            aria-label="Target"
            value={target}
            disabled={!targets?.length || busy}
            onChange={(e) => setTarget(e.target.value)}
          >
            {(targets ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} · {t.sinkName}
              </option>
            ))}
          </select>
          {chosen && (
            <p className="muted new-batch-note">
              <span className="sink-tag">{chosen.sinkName}</span> takes Word or PDF documents
            </p>
          )}
          {noTargets && (
            <p className="muted new-batch-note">
              No target takes Word or PDF documents yet. An administrator sets one up under
              Administration &gt; Publishing targets.
            </p>
          )}
          {targetsError && <p role="alert">The targets could not be read: {targetsError}</p>}
        </div>

        <div className="new-batch-step">
          <h2 className="new-batch-step-title">
            <span className="step-no">3</span> Options
          </h2>
          <label className="conv-switch">
            <input
              type="checkbox"
              role="switch"
              checked={force}
              disabled={busy}
              onChange={(e) => setForce(e.target.checked)}
            />
            <span className="conv-switch-track" aria-hidden="true" />
            Force-load
          </label>
          <p className="muted new-batch-note">
            Delivers every file as an explicit update, even one already loaded or a copy of another
            file. Changes made in the target are still never overwritten.
          </p>
          <label className="conv-switch">
            <input
              type="checkbox"
              role="switch"
              checked={autoApprove}
              disabled={busy}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            <span className="conv-switch-track" aria-hidden="true" />
            Auto Approve
          </label>
          <p className="muted new-batch-note">
            Delivers each PDF without holding it for review, as if it were approved. Its report is
            still written. Leave it off to check each PDF before it reaches the target.
          </p>
        </div>

        <div className="new-batch-go">
          {progress && (
            <div className="conversion-progress" role="status">
              <Meter label="Upload progress" value={(progress.at + progress.part) / progress.of} />
              <span>
                Uploading {progress.at + 1} of {progress.of}
              </span>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          {started && (
            <p role="status">
              The batch started without the files refused.{' '}
              <a href={`#/conversion/${encodeURIComponent(started)}`}>Open the batch</a>
            </p>
          )}
          <div className="new-batch-buttons">
            {progress ? (
              <button
                type="button"
                onClick={() => {
                  cancelled.current = true;
                }}
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              className="primary"
              disabled={!ready || !target || busy}
              onClick={() => void start()}
            >
              {busy ? 'Converting…' : convert}
            </button>
          </div>
          {chosen && (
            <p className="muted new-batch-to">
              to {chosen.label} · {chosen.sinkName}
            </p>
          )}
        </div>
      </div>

      <div className="new-batch-files">
        <h2 className="new-batch-step-title" id={`${filesId}-heading`}>
          <span className="step-no">2</span> Word or PDF files
        </h2>
        <div
          className={over ? 'drop-zone conversion-drop over' : 'drop-zone conversion-drop'}
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
          <span className="drop-text">
            <strong>Drop Word or PDF files or a folder here</strong>
            <small>
              Each .docx or .pdf becomes a document of its own · folders keep their paths
            </small>
          </span>
          <span className="conversion-choose">
            <input
              id={filesId}
              className="visually-hidden"
              type="file"
              accept={SOURCE_ACCEPT}
              multiple
              disabled={busy}
              onChange={(e) => {
                add([...(e.target.files ?? [])].map((file) => ({ file, path: file.name })));
                e.target.value = ''; // the same file can be picked again
              }}
            />
            <label htmlFor={filesId} className="button">
              Choose files
            </label>
            <input
              id={folderId}
              className="visually-hidden"
              type="file"
              multiple
              disabled={busy}
              {...{ webkitdirectory: '', directory: '' }}
              onChange={(e) => {
                add(
                  [...(e.target.files ?? [])]
                    .map((file) => ({ file, path: file.webkitRelativePath || file.name }))
                    .sort(byPath),
                );
                e.target.value = '';
              }}
            />
            <label htmlFor={folderId} className="button">
              Choose folder
            </label>
          </span>
        </div>

        {(rows.length > 0 || leftOut > 0) && (
          <div className="file-list">
            <div className="file-list-head">
              <strong>{plural(rows.length, 'file')}</strong>
              <span className="muted">
                {' '}
                · {ready} ready
                {skipped > 0 && ` · ${skipped} skipped`}
              </span>
              {leftOut > 0 && (
                <span
                  className="muted"
                  title="Only Word (.docx) and PDF files are converted, and hidden and lock files are skipped."
                >
                  {' '}
                  · {plural(leftOut, 'file')} left out (not Word or PDF, hidden or lock files)
                </span>
              )}
              {!busy && (
                <button
                  type="button"
                  className="link file-list-clear"
                  onClick={() => {
                    setRows([]);
                    setLeftOut(0);
                    setStarted(null);
                  }}
                >
                  Clear all
                </button>
              )}
            </div>
            {rows.length > 0 && (
              <ul className="file-list-rows" aria-label="Files to convert">
                {rows.map((r) => (
                  <li key={r.key} className={ROW_CLASS[r.status]}>
                    <span className="file-tag" aria-hidden="true">
                      {/\.pdf$/i.test(r.sourceKey) ? 'PDF' : 'DOCX'}
                    </span>
                    <span className="mono">{r.sourceKey}</span>
                    <span className="conversion-row-end">
                      <span>{r.message}</span>
                      {!busy && r.status !== 'uploaded' && (
                        <button
                          type="button"
                          className="icon"
                          aria-label={`Remove ${r.sourceKey}`}
                          title="Remove"
                          onClick={() => setRows((prev) => prev.filter((p) => p.key !== r.key))}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
