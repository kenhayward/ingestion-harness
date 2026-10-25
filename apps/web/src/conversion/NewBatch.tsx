import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { DOCX_MIME, sourceKeyProblem, type ConversionTarget } from '@ih/shared';
import type { Api } from '../api/client.js';
import { readDrop, type Dropped } from '../jobs/folder-drop.js';
import { navigate } from '../router.js';
import { Icon } from '../ui/Icon.js';
import { Meter } from '../ui/Meter.js';

/** Only Word documents are converted for now (phase 3). */
const WORD_ACCEPT = ['.docx', DOCX_MIME].join(',');

/** A .docx by type or name (browsers often send no type for .docx). */
const isWordFile = (f: File) => f.type === DOCX_MIME || /\.docx$/i.test(f.name);

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
 * The Conversion tab's new batch (decomposition phase 3): a target, Word files or a folder, and
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
  const [rows, setRows] = useState<Row[]>([]);
  /** Files left out of what was picked: not Word documents, hidden or lock files. */
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
    const taken = picked.filter((p) => isWordFile(p.file) && !hiddenOrLock(p.path));
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
    // A file picked again (the same source key) replaces the one listed.
    setRows((prev) => [
      ...(fresh ? [] : prev).filter((r) => !added.some((a) => a.sourceKey === r.sourceKey)),
      ...added,
    ]);
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
    if (!todo.length || !target) return;
    setBusy(true);
    setError(null);
    cancelled.current = false;
    const done = () => {
      setBusy(false);
      setProgress(null);
    };
    let batchId: string;
    try {
      batchId = (await api.createConversionBatch({ targetId: target, force })).id;
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
    if (gone.current) return;
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
  const noTargets = targets !== null && targets.length === 0;

  return (
    <section className="card new-batch" aria-labelledby={`${filesId}-heading`}>
      <h2 className="section-heading" id={`${filesId}-heading`}>
        New batch
      </h2>
      <label className="field">
        Target
        <select
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
      </label>
      {noTargets && (
        <p className="muted">
          No target takes Word documents yet. An administrator sets one up under Administration &gt;
          Publishing targets.
        </p>
      )}
      {targetsError && <p role="alert">The targets could not be read: {targetsError}</p>}

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
          <strong>Drop Word files or a folder here</strong>
          <small>Each Word document (.docx) is delivered as a document of its own</small>
        </span>
        <span className="conversion-choose">
          <label htmlFor={filesId} className="button">
            Choose files
          </label>
          <label htmlFor={folderId} className="button">
            Choose folder
          </label>
        </span>
        <input
          id={filesId}
          className="visually-hidden"
          type="file"
          accept={WORD_ACCEPT}
          multiple
          disabled={busy}
          onChange={(e) => {
            add([...(e.target.files ?? [])].map((file) => ({ file, path: file.name })));
            e.target.value = ''; // the same file can be picked again
          }}
        />
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
      </div>

      {leftOut > 0 && (
        <p className="muted" role="status">
          {plural(leftOut, 'file')} left out: only Word documents (.docx) are converted, and hidden
          and lock files are skipped.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="upload-list" aria-label="Files to convert">
          {rows.map((r) => (
            <li key={r.key} className={ROW_CLASS[r.status]}>
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

      <label className="inline">
        <input
          type="checkbox"
          checked={force}
          disabled={busy}
          onChange={(e) => setForce(e.target.checked)}
        />
        Force-load
      </label>
      <p className="muted conversion-hint">
        Delivers every file as an explicit update, even one already loaded or a copy of another
        file. Changes made in the target are still never overwritten.
      </p>

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
          The batch started without the files refused above.{' '}
          <a href={`#/conversion/${encodeURIComponent(started)}`}>Open the batch</a>
        </p>
      )}

      <div className="card-actions">
        {busy ? (
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
          Start
        </button>
      </div>
    </section>
  );
}
