import { useId, useState } from 'react';
import type { Api, TemplateListItem } from '../api/client.js';
import { isSourceFile, SOURCE_ACCEPT } from '../documents.js';
import { Icon } from '../ui/Icon.js';
import { qualityLine, shapeLine } from './quality.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { ReprocessDialog } from '../ui/ReprocessDialog.js';

/**
 * One document type (UI handoff §4): versions, shape, quality, and the quick actions (edit or
 * start a draft, test-run a PDF or Word document, export YAML).
 */
export function TemplateCard({
  api,
  item,
  onNavigate,
}: {
  api: Api;
  item: TemplateListItem;
  onNavigate: (hash: string) => void;
}) {
  const titleId = useId();
  const fileId = useId();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The version the card describes and acts on: the draft when there is one. */
  const shown = item.draft ?? item.published;
  const quality = qualityLine(item.summary, item.draft);

  const newDraft = async (from: number) => {
    setBusy(true);
    try {
      const { record } = await api.newDraft(item.id, from);
      onNavigate(`#/templates/${record.id}/${record.version}`);
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** The sample picked for a test run, asking for the model in the re-process dialog. */
  const [testFile, setTestFile] = useState<File | null>(null);
  const choices = useModelChoices(api);
  const pickTestFile = (file: File | undefined) => {
    if (!file || shown === null) return; // picker cancelled
    if (!isSourceFile(file)) {
      setStatus('Choose a PDF or Word document');
      return;
    }
    setStatus(null);
    setTestFile(file);
  };

  return (
    <article className="type-card" aria-labelledby={titleId}>
      <div className="type-card-head">
        <span className="type-icon" aria-hidden="true">
          <Icon name="types" size={20} />
        </span>
        <div>
          <h2 id={titleId}>{item.name}</h2>
          <span className="mono muted">{item.id}</span>
        </div>
      </div>
      <div className="pills">
        {item.published !== null ? (
          <a className="pill tone-ok" href={`#/templates/${item.id}/${item.published}`}>
            Published v{item.published}
          </a>
        ) : (
          <span className="pill tone-neutral">Not published</span>
        )}
        {item.draft !== null && <span className="pill tone-info">Draft v{item.draft}</span>}
      </div>
      <p className="shape-line muted">{shapeLine(item.summary)}</p>
      <p className={`quality quality-${quality.tone}`}>{quality.text}</p>
      <div className="card-actions">
        {item.draft !== null ? (
          <a className="button primary" href={`#/templates/${item.id}/${item.draft}`}>
            Edit draft v{item.draft}
          </a>
        ) : item.published !== null ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void newDraft(item.published!)}
          >
            New draft from v{item.published}
          </button>
        ) : null}
        <a className="button" href={`#/workbench/${item.id}`}>
          Open in workbench
        </a>
        {shown !== null && (
          <>
            <label className="button" htmlFor={fileId}>
              Test run
            </label>
            <input
              id={fileId}
              className="visually-hidden"
              type="file"
              accept={SOURCE_ACCEPT}
              aria-label={`Test run ${item.name} with a PDF or Word document`}
              onChange={(e) => {
                pickTestFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <a
              className="button icon bordered"
              href={api.exportUrl(item.id, shown)}
              aria-label={`Export ${item.name} YAML`}
              title="Export YAML"
            >
              <Icon name="download" />
            </a>
          </>
        )}
      </div>
      {status && (
        <p role="status" className="muted">
          {status}
        </p>
      )}
      {testFile && shown !== null && (
        <ReprocessDialog
          title={`Test run ${item.name} v${shown}`}
          confirmLabel="Run test"
          choices={choices}
          emptyLabel="Template's models"
          summary={
            <p>
              Runs {testFile.name} through v{shown}: reviewable, never published.
            </p>
          }
          onConfirm={async (model) => {
            await api.testRun(testFile, item.id, shown, model);
            setStatus('Test run queued — see Jobs');
          }}
          onClose={() => setTestFile(null)}
        />
      )}
    </article>
  );
}
