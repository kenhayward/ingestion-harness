import { useCallback, useEffect, useState } from 'react';
import type { ProjectView, StageView } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';
import { PROJECT_TABS, type ProjectTab } from '../router.js';
import { TemplateEditor } from '../templates/TemplateEditor.js';
import { BriefTab } from './BriefTab.js';
import { ExportPanel } from './ExportPanel.js';
import { EvaluateTab } from './EvaluateTab.js';
import { ReferencesTab } from './ReferencesTab.js';
import { ReviseTab } from './ReviseTab.js';
import { RunsTab } from './RunsTab.js';
import { SamplesTab } from './SamplesTab.js';
import { SectionsTab } from './SectionsTab.js';
import { StagePanel } from './StagePanel.js';
import { SurveyTab } from './SurveyTab.js';

const TAB_LABEL: Record<ProjectTab, string> = {
  samples: 'Samples',
  brief: 'Brief',
  survey: 'Survey',
  outputs: 'Outputs',
  sections: 'Sections',
  steps: 'Steps',
  references: 'References',
  evaluate: 'Evaluate',
  revise: 'Revise',
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
  role,
}: {
  api: Api;
  projectId: string;
  tab: ProjectTab;
  onNavigate: (hash: string) => void;
  /** Poll interval for the Samples and Test runs tabs. */
  pollMs?: number;
  role: 'admin' | 'user';
}) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stages, setStages] = useState<StageView[]>([]);
  /** Bumped when a stage changes the draft, to remount editors showing it. */
  const [revision, setRevision] = useState(0);

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

  const loadStages = useCallback(() => {
    api.listStages(projectId).then(setStages, () => setStages([]));
  }, [api, projectId]);
  useEffect(loadStages, [loadStages]);

  const changed = () => {
    loadStages();
    load();
    setRevision((r) => r + 1);
  };

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const togglePolicy = async () => {
    if (!view) return;
    const next = view.project.dataPolicy === 'external' ? 'local' : 'external';
    if (
      next === 'external' &&
      !window.confirm(
        'Sample text from dev samples may be sent to external model providers. Allow?',
      )
    ) {
      return;
    }
    await act(async () => setView(await api.setDataPolicy(view.project.id, next)));
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
      <p className="policy">
        <span className={`pill ${project.dataPolicy === 'external' ? 'tone-warn' : 'tone-ok'}`}>
          {project.dataPolicy === 'external' ? 'External models allowed' : 'Local models only'}
        </span>
        {role === 'admin' && (
          <button type="button" onClick={() => void togglePolicy()}>
            {project.dataPolicy === 'external'
              ? 'Restrict to local models'
              : 'Allow external models'}
          </button>
        )}
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
            {(() => {
              const s = stages.find((x) => x.stage === t);
              return s && s.state !== 'pending' ? ` \u00b7 ${s.state}` : '';
            })()}
          </a>
        ))}
      </nav>
      {tab === 'samples' && <SamplesTab api={api} projectId={project.id} pollMs={pollMs} />}
      {tab === 'brief' && (
        <>
          <BriefTab
            api={api}
            projectId={project.id}
            brief={view.brief}
            onSaved={(brief) => setView({ ...view, brief })}
          />
          <ExportPanel
            api={api}
            projectId={project.id}
            dataPolicy={project.dataPolicy}
            pollMs={pollMs}
          />
        </>
      )}
      {tab === 'survey' && (
        <SurveyTab
          api={api}
          projectId={project.id}
          dataPolicy={project.dataPolicy}
          brief={view.brief}
          onBriefSaved={(brief) => setView({ ...view, brief })}
          pollMs={pollMs}
          onChanged={changed}
        />
      )}
      {(tab === 'outputs' || tab === 'steps') && (
        <>
          <StagePanel
            key={`${tab}-${revision}`}
            api={api}
            projectId={project.id}
            stage={tab}
            dataPolicy={project.dataPolicy}
            hasDraft={draft !== null}
            pollMs={pollMs}
            onApplied={changed}
            onSkipped={changed}
          />
          <p className="muted">
            Edit by hand on the <a href={`#/workbench/${project.id}/template`}>Template</a> tab.
          </p>
        </>
      )}
      {tab === 'sections' && (
        <>
          <StagePanel
            key={`sections-${revision}`}
            api={api}
            projectId={project.id}
            stage="sections"
            dataPolicy={project.dataPolicy}
            hasDraft={draft !== null}
            pollMs={pollMs}
            onApplied={changed}
            onSkipped={changed}
          />
          <SectionsTab key={revision} api={api} projectId={project.id} draft={draft} pollMs={300} />
        </>
      )}
      {tab === 'references' && (
        <ReferencesTab
          key={`references-${revision}`}
          api={api}
          projectId={project.id}
          dataPolicy={project.dataPolicy}
          hasDraft={draft !== null}
          pollMs={pollMs}
          onChanged={changed}
        />
      )}
      {tab === 'evaluate' && (
        <EvaluateTab
          api={api}
          projectId={project.id}
          dataPolicy={project.dataPolicy}
          hasDraft={draft !== null}
          draft={draft}
          pollMs={pollMs}
          onRestored={changed}
        />
      )}
      {tab === 'revise' && (
        <ReviseTab
          api={api}
          projectId={project.id}
          dataPolicy={project.dataPolicy}
          hasDraft={draft !== null}
          pollMs={pollMs}
          onApplied={changed}
        />
      )}
      {tab === 'runs' && <RunsTab api={api} projectId={project.id} draft={draft} pollMs={pollMs} />}
      {tab === 'template' &&
        (draft !== null ? (
          <TemplateEditor
            key={draft}
            api={api}
            templateId={project.id}
            version={draft}
            onNavigate={onNavigate}
            embedded={{ onChanged: load }}
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
