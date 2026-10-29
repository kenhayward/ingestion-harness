import { useMemo, useState } from 'react';
import {
  WATCH_ADMIT,
  WATCH_SLEEP,
  type WatchPatchRequest,
  type WatchSource,
  type WatchTestResult,
  type WatchView,
} from '@ih/shared';
import { BrowseDialog } from '../access/BrowseDialog.js';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { STOP_TO_CHANGE, testedText } from './derive.js';

type Source = Record<string, string>;

/** The folder a form describes: only the target's declared fields, trimmed, empty ones left out. */
function sourceOf(fields: readonly { id: string }[], values: Source): Source {
  const out: Source = {};
  for (const f of fields) {
    const v = (values[f.id] ?? '').trim();
    if (v) out[f.id] = v;
  }
  return out;
}

const sameSource = (a: Source, b: Source) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? '') === (b[k] ?? ''));
};

const inRange = (n: number, min: number, max: number) =>
  Number.isInteger(n) && n >= min && n <= max;

/**
 * A new watch, or the reconfiguration of one. The folder is tested (its root listed as you)
 * before it can be saved. While a watch is not stopped its target, folder and run-as user are
 * locked; the other settings apply to the next pickups at any time. A change to the target or
 * folder makes the watch run as the admin who saves it.
 */
export function WatchDialog({
  api,
  sources,
  watch,
  onClose,
  onSaved,
}: {
  api: Api;
  sources: readonly WatchSource[];
  /** Absent: a new watch. */
  watch?: WatchView;
  onClose: () => void;
  onSaved: (watch: WatchView) => void;
}) {
  const [name, setName] = useState(watch?.name ?? '');
  const [targetId, setTargetId] = useState(watch?.targetId ?? '');
  const [values, setValues] = useState<Source>(watch?.source ?? {});
  const [labels, setLabels] = useState<Source>({});
  const [force, setForce] = useState(watch?.force ?? false);
  const [autoApprove, setAutoApprove] = useState(watch?.autoApprove ?? true);
  const [reasonFiles, setReasonFiles] = useState(watch?.reasonFiles ?? true);
  const [sleep, setSleep] = useState(String(watch?.sleepSeconds ?? WATCH_SLEEP.default));
  const [admit, setAdmit] = useState(String(watch?.admit ?? WATCH_ADMIT.default));
  const [runAsMe, setRunAsMe] = useState(false);
  const [testing, setTesting] = useState(false);
  /** The folder last tested and what the test found. */
  const [tested, setTested] = useState<{ key: string; result: WatchTestResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<{ id: string; label: string } | null>(null);

  const locked = watch !== undefined && watch.state !== 'stopped';
  const target = sources.find((s) => s.targetId === targetId);
  const fields = target?.sourceFields ?? [];
  const source = sourceOf(fields, values);
  const folderKey = JSON.stringify([targetId, source]);
  const folderChanged =
    watch === undefined || targetId !== watch.targetId || !sameSource(source, watch.source);
  const missing = fields.some((f) => f.required && !source[f.id]);
  const sleepN = Number(sleep);
  const admitN = Number(admit);
  const numbersOk =
    inRange(sleepN, WATCH_SLEEP.min, WATCH_SLEEP.max) &&
    inRange(admitN, WATCH_ADMIT.min, WATCH_ADMIT.max);
  const canTest = target !== undefined && !missing && !testing;
  const passed = tested?.key === folderKey && tested.result.ok;

  /** What differs from the saved watch: the only keys a patch sends. */
  const patch = useMemo<WatchPatchRequest>(() => {
    if (!watch) return {};
    const p: WatchPatchRequest = {};
    if (name.trim() !== watch.name) p.name = name.trim();
    if (targetId !== watch.targetId) p.targetId = targetId;
    if (!sameSource(source, watch.source)) p.source = source;
    if (force !== watch.force) p.force = force;
    if (autoApprove !== watch.autoApprove) p.autoApprove = autoApprove;
    if (reasonFiles !== watch.reasonFiles) p.reasonFiles = reasonFiles;
    if (sleepN !== watch.sleepSeconds) p.sleepSeconds = sleepN;
    if (admitN !== watch.admit) p.admit = admitN;
    if (runAsMe) p.runAsMe = true;
    return p;
    // `source` is derived from `fields` and `values`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch, name, targetId, folderKey, force, autoApprove, reasonFiles, sleepN, admitN, runAsMe]);

  const changed = watch === undefined || Object.keys(patch).length > 0;
  const canSave =
    !busy &&
    name.trim() !== '' &&
    target !== undefined &&
    !missing &&
    numbersOk &&
    changed &&
    (!folderChanged || passed);

  const setValue = (id: string, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
    setLabels((l) => ({ ...l, [id]: '' }));
  };

  const test = async () => {
    setTesting(true);
    setError(null);
    try {
      setTested({ key: folderKey, result: await api.testWatch({ targetId, source }) });
    } catch (err) {
      setTested({ key: folderKey, result: { ok: false, problem: (err as Error).message } });
    }
    setTesting(false);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        watch
          ? await api.updateWatch(watch.id, patch)
          : await api.createWatch({
              name: name.trim(),
              targetId,
              source,
              force,
              autoApprove,
              reasonFiles,
              sleepSeconds: sleepN,
              admit: admitN,
            }),
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  /** The browse dialog reads a sink's tree through the watch route, as the signed-in admin. */
  const browseApi = (fieldId: string): Api => ({
    ...api,
    browseSink: (req) =>
      api.browseWatchSource({
        targetId,
        field: fieldId,
        parentId: req.parentId,
        cursor: req.cursor,
      }),
  });

  return (
    <Dialog
      title={watch ? `Reconfigure ${watch.name}` : 'New watch'}
      className="watch-dialog"
      onClose={onClose}
      actions={
        <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
          Save
        </button>
      }
    >
      <div className="dialog-form watch-form">
        <label className="field">
          <span className="field-label">Name</span>
          <input
            type="text"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Target</span>
          <select
            value={targetId}
            disabled={locked}
            onChange={(e) => {
              setTargetId(e.target.value);
              setValues({});
              setLabels({});
            }}
          >
            <option value="">Choose a target</option>
            {sources.map((s) => (
              <option key={s.targetId} value={s.targetId}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        {fields.map((f) => (
          <div className="field" key={f.id}>
            <label className="field-label" htmlFor={`watch-field-${f.id}`}>
              {f.label}
            </label>
            <div className="watch-field-row">
              <input
                id={`watch-field-${f.id}`}
                type="text"
                value={values[f.id] ?? ''}
                disabled={locked}
                onChange={(e) => setValue(f.id, e.target.value)}
              />
              {f.browse && (
                <button
                  type="button"
                  disabled={locked || !target}
                  aria-label={`Browse ${f.label.toLowerCase()}`}
                  onClick={() => setBrowsing({ id: f.id, label: f.label })}
                >
                  Browse…
                </button>
              )}
            </div>
            {labels[f.id] && <small className="muted">{labels[f.id]}</small>}
          </div>
        ))}

        {locked && <p className="muted watch-note">{STOP_TO_CHANGE}</p>}
        {watch && !locked && folderChanged && (
          <p className="muted watch-note">
            Saving a new target or folder lists the folder first, and the watch then runs as you.
          </p>
        )}

        {folderChanged && (
          <div className="watch-test">
            <button type="button" disabled={!canTest} onClick={() => void test()}>
              Test folder
            </button>
            {tested?.key === folderKey &&
              (tested.result.ok ? (
                <span className="watch-test-ok">{testedText(tested.result.files)}</span>
              ) : (
                <p role="alert">{tested.result.problem}</p>
              ))}
          </div>
        )}

        {watch && (
          <div className="conv-check">
            <label>
              <input
                type="checkbox"
                checked={runAsMe}
                disabled={locked}
                onChange={(e) => setRunAsMe(e.target.checked)}
              />
              Run as me
            </label>
            <small className="muted">
              {' '}
              · now runs as {watch.runAs.name ?? 'nobody'}
              {locked ? `. ${STOP_TO_CHANGE}` : ''}
            </small>
          </div>
        )}

        <label className="conv-switch">
          <input
            type="checkbox"
            role="switch"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
          />
          <span className="conv-switch-track" aria-hidden="true" />
          Force-load
          <span className="muted"> · update documents already loaded, and load copies</span>
        </label>
        <label className="conv-switch">
          <input
            type="checkbox"
            role="switch"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
          />
          <span className="conv-switch-track" aria-hidden="true" />
          Auto Approve
          <span className="muted"> · deliver converted PDFs without holding them for review</span>
        </label>
        <label className="conv-switch">
          <input
            type="checkbox"
            role="switch"
            checked={reasonFiles}
            onChange={(e) => setReasonFiles(e.target.checked)}
          />
          <span className="conv-switch-track" aria-hidden="true" />
          Reason files
          <span className="muted"> · write a note beside each file moved to failed</span>
        </label>

        <label className="field">
          <span className="field-label">Sleep when idle (seconds)</span>
          <input
            type="number"
            min={WATCH_SLEEP.min}
            max={WATCH_SLEEP.max}
            value={sleep}
            onChange={(e) => setSleep(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Admit at a time</span>
          <input
            type="number"
            min={WATCH_ADMIT.min}
            max={WATCH_ADMIT.max}
            value={admit}
            onChange={(e) => setAdmit(e.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
      </div>
      {browsing && target && (
        <BrowseDialog
          api={browseApi(browsing.id)}
          sinkId={target.sinkId}
          instanceId={target.instanceId}
          connectionId={null}
          field={browsing.id}
          label={browsing.label}
          onPick={(id, label) => {
            setValues((v) => ({ ...v, [browsing.id]: id }));
            setLabels((l) => ({ ...l, [browsing.id]: label }));
          }}
          onClose={() => setBrowsing(null)}
        />
      )}
    </Dialog>
  );
}
