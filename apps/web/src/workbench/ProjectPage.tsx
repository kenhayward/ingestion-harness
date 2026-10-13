import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectOverview, ProjectView } from '@ih/shared';
import { ApiError, type Api } from '../api/client.js';
import type { ProjectTab } from '../router.js';
import { TemplateEditor } from '../templates/TemplateEditor.js';
import { BriefTab } from './BriefTab.js';
import { ExportPanel } from './ExportPanel.js';
import { forgetProject, rememberProject } from './listDerive.js';
import { EvaluateTab } from './EvaluateTab.js';
import { OverviewTab } from './OverviewTab.js';
import { ProjectHeader } from './ProjectHeader.js';
import { ProjectRail } from './ProjectRail.js';
import { ReferencesTab } from './ReferencesTab.js';
import { ReviseTab } from './ReviseTab.js';
import { RunsTab } from './RunsTab.js';
import { SamplesTab } from './SamplesTab.js';
import { SectionsTab } from './SectionsTab.js';
import { StagePanel } from './StagePanel.js';
import { SurveyTab } from './SurveyTab.js';
import { TabHeader } from './TabHeader.js';

const TAB_TITLE: Record<Exclude<ProjectTab, 'overview'>, string> = {
  samples: 'Samples',
  brief: 'Brief',
  survey: 'Survey',
  outputs: 'Outputs',
  sections: 'Section anchors',
  steps: 'Extraction steps',
  references: 'References',
  evaluate: 'Evaluate',
  revise: 'Revise',
  template: 'Template',
  runs: 'Test runs',
};

/** Deletes a never-published project after its id is typed; the caller shows a refusal. */
function DeleteProject({
  projectId,
  onDelete,
}: {
  projectId: string;
  onDelete: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  if (!open) {
    return (
      <p>
        <button type="button" className="danger" onClick={() => setOpen(true)}>
          Delete project
        </button>
      </p>
    );
  }
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        if (typed === projectId) void onDelete();
      }}
    >
      <p>
        Deletes the project, its samples, drafts, runs, references and files. This cannot be undone.
      </p>
      <label>
        Type {projectId} to confirm
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </label>
      <button type="submit" className="danger-fill" disabled={typed !== projectId}>
        Delete project
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

/** One workbench project on the project shell: header, step rail and the current tab. */
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
  /** Poll interval for the tabs, and for the overview while anything runs. */
  pollMs?: number;
  role: 'admin' | 'user';
}) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  /** Bumped when a stage changes the draft, to remount editors showing it. */
  const [revision, setRevision] = useState(0);

  // The Workbench list's "Pinned and recent" cards show the projects opened last.
  useEffect(() => rememberProject(projectId), [projectId]);

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

  const [overviewError, setOverviewError] = useState<string | null>(null);
  /** Numbers each overview request, so an older response never replaces a newer one. */
  const overviewRequest = useRef(0);
  const overviewInFlight = useRef(false);
  const loadOverview = useCallback(() => {
    const request = ++overviewRequest.current;
    overviewInFlight.current = true;
    api.getProjectOverview(projectId).then(
      (o) => {
        if (request !== overviewRequest.current) return;
        overviewInFlight.current = false;
        setOverview(o);
        setOverviewError(null);
      },
      (err: Error) => {
        if (request !== overviewRequest.current) return;
        overviewInFlight.current = false;
        setOverviewError(err.message);
      },
    );
  }, [api, projectId]);
  // Also on every tab change: the tabs' own actions change the stages.
  useEffect(loadOverview, [loadOverview, tab]);
  useEffect(() => {
    window.addEventListener('focus', loadOverview);
    return () => window.removeEventListener('focus', loadOverview);
  }, [loadOverview]);
  const running = overview?.stages.some((s) => s.state === 'running') ?? false;
  useEffect(() => {
    if (!running || pollMs <= 0) return;
    const timer = setInterval(() => {
      if (!overviewInFlight.current) loadOverview();
    }, pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, loadOverview]);

  const changed = () => {
    loadOverview();
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
    loadOverview();
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
              loadOverview();
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
  const itemOf = (t: ProjectTab) => overview?.stages.find((s) => s.stage === t) ?? null;
  const header = (t: Exclude<ProjectTab, 'overview'>) => (
    <TabHeader title={TAB_TITLE[t]} item={itemOf(t)} />
  );
  return (
    <section className="workbench project-page">
      <ProjectHeader
        view={view}
        gate={overview?.gate ?? null}
        role={role}
        onTogglePolicy={() => void togglePolicy()}
      />
      {error && <p role="alert">{error}</p>}
      {overviewError && (
        <p role="alert">
          Could not load the project status: {overviewError}{' '}
          <button type="button" onClick={loadOverview}>
            Retry
          </button>
        </p>
      )}
      <div className="project-layout">
        <ProjectRail
          projectId={project.id}
          tab={tab}
          items={overview?.stages ?? null}
          onNavigate={onNavigate}
        />
        <div className="project-tab">
          {tab === 'overview' &&
            (overview ? (
              <OverviewTab projectId={project.id} overview={overview} />
            ) : (
              !overviewError && <p>Loading…</p>
            ))}
          {tab === 'samples' && (
            <>
              {header('samples')}
              <SamplesTab
                api={api}
                projectId={project.id}
                pollMs={pollMs}
                onChanged={loadOverview}
              />
            </>
          )}
          {tab === 'brief' && (
            <>
              {header('brief')}
              <BriefTab
                api={api}
                projectId={project.id}
                brief={view.brief}
                onSaved={(brief) => {
                  setView({ ...view, brief });
                  loadOverview();
                }}
              />
              <ExportPanel
                api={api}
                role={role}
                projectId={project.id}
                dataPolicy={project.dataPolicy}
                pollMs={pollMs}
              />
            </>
          )}
          {tab === 'survey' && header('survey')}
          {tab === 'survey' && (
            <SurveyTab
              api={api}
              projectId={project.id}
              dataPolicy={project.dataPolicy}
              brief={view.brief}
              onBriefSaved={(brief) => {
                setView({ ...view, brief });
                loadOverview();
              }}
              pollMs={pollMs}
              onChanged={changed}
            />
          )}
          {(tab === 'outputs' || tab === 'steps') && (
            <StagePanel
              key={tab}
              api={api}
              projectId={project.id}
              stage={tab}
              title={TAB_TITLE[tab]}
              item={itemOf(tab)}
              dataPolicy={project.dataPolicy}
              hasDraft={draft !== null}
              draft={draft}
              published={published}
              briefVersion={view.brief?.version ?? null}
              pollMs={pollMs}
              onApplied={changed}
              onSkipped={changed}
            />
          )}
          {tab === 'sections' && (
            <>
              <StagePanel
                key={`sections-${revision}`}
                api={api}
                projectId={project.id}
                stage="sections"
                title={TAB_TITLE.sections}
                item={itemOf('sections')}
                dataPolicy={project.dataPolicy}
                hasDraft={draft !== null}
                briefVersion={view.brief?.version ?? null}
                pollMs={pollMs}
                onApplied={changed}
                onSkipped={changed}
              />
              <SectionsTab
                key={revision}
                api={api}
                projectId={project.id}
                draft={draft}
                pollMs={300}
              />
            </>
          )}
          {tab === 'references' && header('references')}
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
          {tab === 'evaluate' && header('evaluate')}
          {tab === 'evaluate' && (
            <EvaluateTab
              api={api}
              projectId={project.id}
              dataPolicy={project.dataPolicy}
              hasDraft={draft !== null}
              draft={draft}
              pollMs={pollMs}
              onRestored={changed}
              onStarted={loadOverview}
            />
          )}
          {tab === 'revise' && header('revise')}
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
          {tab === 'runs' && header('runs')}
          {tab === 'runs' && (
            <RunsTab api={api} projectId={project.id} draft={draft} pollMs={pollMs} />
          )}
          {tab === 'template' && header('template')}
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
                      loadOverview();
                    })
                  }
                >
                  Start v{(published ?? 0) + 1}
                </button>
              </div>
            ))}
        </div>
      </div>
      {published === null && (
        <DeleteProject
          projectId={project.id}
          onDelete={() =>
            act(async () => {
              try {
                await api.deleteProject(project.id);
              } catch (err) {
                loadOverview();
                throw err;
              }
              forgetProject(project.id);
              onNavigate('#/workbench');
            })
          }
        />
      )}
    </section>
  );
}
