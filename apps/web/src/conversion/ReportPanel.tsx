import { useEffect, useState } from 'react';
import { DecompositionReportSchema, type Item, type ReportFlag } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { StatusPill } from '../ui/StatusPill.js';

type State =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; flags: ReportFlag[] };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * An item's decomposition report (spec §5.9): what decomposing its file noticed, each flag with
 * its severity, where it applies and its message. The report is written once the document is
 * decomposed, so before then (or for a file that never decomposed) there is none.
 */
export function ReportPanel({ api, item, onClose }: { api: Api; item: Item; onClose: () => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    api.getConversionReport(item.id).then(
      (body) => {
        if (!live) return;
        const report = DecompositionReportSchema.safeParse(body);
        setState(
          report.success
            ? { kind: 'ready', flags: report.data.flags }
            : { kind: 'error', message: 'the report could not be read' },
        );
      },
      (err: Error) => {
        if (!live) return;
        setState(
          err instanceof ApiError && err.status === 404
            ? { kind: 'none' }
            : { kind: 'error', message: err.message },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [api, item.id]);

  return (
    <Dialog title={`Report: ${item.sourceKey}`} onClose={onClose} closeLabel="Close">
      {state.kind === 'loading' && <p className="muted">Reading the report…</p>}
      {state.kind === 'none' && (
        <p className="muted">
          No report yet: it is written once the document has been decomposed. A file that could not
          be decomposed has none.
        </p>
      )}
      {state.kind === 'error' && <p role="alert">The report could not be shown: {state.message}</p>}
      {state.kind === 'ready' && state.flags.length === 0 && (
        <p>Nothing to flag: the document decomposed without anything to check.</p>
      )}
      {state.kind === 'ready' && state.flags.length > 0 && (
        <>
          <p className="muted">
            {plural(state.flags.filter((f) => f.severity === 'warning').length, 'warning')} and{' '}
            {plural(state.flags.filter((f) => f.severity === 'info').length, 'note')}: what to check
            in the target.
          </p>
          <ul className="conversion-report" aria-label="Flags">
            {state.flags.map((f, i) => (
              <li key={i}>
                <StatusPill
                  label={f.severity === 'warning' ? 'Warning' : 'Info'}
                  tone={f.severity === 'warning' ? 'warn' : 'neutral'}
                />
                <span>{f.message}</span>
                <span className="muted mono">
                  {f.code}
                  {f.at ? ` · ${f.at}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
