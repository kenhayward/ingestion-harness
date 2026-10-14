import { useEffect, useId, useState } from 'react';
import type { DataPolicy } from '@ih/shared';
import type { Api } from '../api/client.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { ReprocessDialog } from '../ui/ReprocessDialog.js';
import { runSamples, type SampleChoice } from '../workbench/runs.js';
import { tryOnBlockedReason } from './editor-derive.js';

/**
 * *Try on [dev sample] → Test run* (handoff §10, TR1): runs the saved draft on one prepared dev
 * sample as a test run; it shows on the Test runs tab. Never holdout.
 */
export function TryOn({
  api,
  projectId,
  version,
  dirty,
  dataPolicy,
  issues,
  retired = null,
  onQueued,
}: {
  api: Api;
  projectId: string;
  version: number;
  dirty: boolean;
  dataPolicy: DataPolicy;
  /** Validation issues in the draft: the API refuses a test run of an invalid draft. */
  issues: number;
  /** Why nothing may run (a retired document type); null otherwise. */
  retired?: string | null;
  onQueued: () => void;
}) {
  const [samples, setSamples] = useState<SampleChoice[] | null>(null);
  const [picked, setPicked] = useState('');
  const [asking, setAsking] = useState(false);
  const [queued, setQueued] = useState<string | null>(null);
  const choices = useModelChoices(api);
  const selectId = useId();

  useEffect(() => {
    let live = true;
    api.listSamples(projectId).then(
      (all) => {
        if (live) setSamples(runSamples(all).filter((c) => c.selectable));
      },
      () => {
        if (live) setSamples([]);
      },
    );
    return () => {
      live = false;
    };
  }, [api, projectId]);

  const ready = samples ?? [];
  const current = ready.find((c) => c.sample.id === picked) ?? ready[0] ?? null;
  const blocked =
    retired ?? tryOnBlockedReason(dirty, samples === null ? null : ready.length, issues);
  return (
    <div className="try-on">
      {/* A separate label: a select inside its label would add the picked file to its name. */}
      <label htmlFor={selectId}>Try on</label>
      <select
        id={selectId}
        className="mono"
        value={current?.sample.id ?? ''}
        disabled={ready.length === 0}
        onChange={(e) => setPicked(e.target.value)}
      >
        {ready.map((c) => (
          <option key={c.sample.id} value={c.sample.id}>
            {c.sample.filename}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={blocked !== null}
        title={blocked ?? undefined}
        onClick={() => setAsking(true)}
      >
        Test run
      </button>
      {asking && current && (
        <ReprocessDialog
          title={`Test v${version} on ${current.sample.filename}`}
          confirmLabel="Run test"
          choices={choices}
          emptyLabel="Document type's model"
          dataPolicy={dataPolicy}
          summary={
            <p>
              Runs the saved draft on {current.sample.filename}: reviewable, never published or
              scored. It shows on the Test runs tab.
            </p>
          }
          onConfirm={async (model) => {
            await api.runDevTests(projectId, { model, sampleIds: [current.sample.id] });
            setQueued(current.sample.filename);
            onQueued();
          }}
          onClose={() => setAsking(false)}
        />
      )}
      {queued && (
        <p role="status" className="muted">
          Test run queued on {queued}. <a href={`#/workbench/${projectId}/runs`}>See Test runs</a>
        </p>
      )}
    </div>
  );
}
