import { useCallback, useEffect, useState } from 'react';
import type { ProjectView } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';
import { PROJECT_TABS, type ProjectTab } from '../router.js';
import { TemplateEditor } from '../templates/TemplateEditor.js';
import { SamplesTab } from './SamplesTab.js';

const TAB_LABEL: Record<ProjectTab, string> = {
  samples: 'Samples',
  brief: 'Brief',
  template: 'Template',
  runs: 'Test runs',
};

/** One workbench project: samples, brief, the draft template and dev test runs. */
export function ProjectPage({
  api,
  projectId,
  tab,
  onNavigate,
  pollMs = 3000,
}: {
  api: Api;
  projectId: string;
  tab: ProjectTab;
  onNavigate: (hash: string) => void;
  /** Poll interval for the Samples and Test runs tabs. */
  pollMs?: number;
}) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getProject(projectId).then(
      (v) => {
        setView(v);
        setMissing(false);
      },
      (err: Error) => {
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(err.message);
      },
    );
  }, [api, projectId]);
  useEffect(load, [load]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (missing) {
    return (
      <section className="workbench">
        <h2>Workbench</h2>
        {error && <p role="alert">{error}</p>}
        <p>
          No workbench project for <code>{projectId}</code> yet.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() =>
            void act(async () => {
              setView(await api.createProject(projectId));
              setMissing(false);
            })
          }
        >
          Open in workbench
        </button>
      </section>
    );
  }
  if (!view) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;

  const { project, draft, published } = view;
  return (
    <section className="workbench">
      <h2>{project.name}</h2>
      <p className="muted">
        <code>{project.id}</code> · {draft !== null ? `developing v${draft}` : 'no open draft'}
        {published !== null && ` · v${published} published`}
      </p>
      {error && <p role="alert">{error}</p>}
      <nav aria-label="Project" className="workbench-tabs">
        {PROJECT_TABS.map((t) => (
          <a
            key={t}
            href={`#/workbench/${project.id}/${t}`}
            aria-current={t === tab ? 'page' : undefined}
          >
            {TAB_LABEL[t]}
          </a>
        ))}
      </nav>
      {tab === 'samples' && <SamplesTab api={api} projectId={project.id} pollMs={pollMs} />}
      {tab === 'template' &&
        (draft !== null ? (
          <TemplateEditor
            key={draft}
            api={api}
            templateId={project.id}
            version={draft}
            onNavigate={onNavigate}
          />
        ) : (
          <div className="card">
            <p>Every version is published; start the next one to keep developing.</p>
            <button
              type="button"
              className="primary"
              onClick={() =>
                void act(async () => {
                  await api.newDraft(project.id, published!);
                  load();
                })
              }
            >
              Start v{(published ?? 0) + 1}
            </button>
          </div>
        ))}
    </section>
  );
}
