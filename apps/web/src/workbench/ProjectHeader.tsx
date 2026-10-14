import type { GateView, ProjectView } from '@ih/shared';
import { Icon } from '../ui/Icon.js';
import { RETIRED_REASON, retiredNote } from '../ui/retired.js';

/**
 * Project page header (handoff §2): name, versions, data policy and Publish, which opens the
 * Template tab. References and evaluation are optional, so the gate never locks it.
 */
export function ProjectHeader({
  view,
  gate,
  role,
  onTogglePolicy,
}: {
  view: ProjectView;
  /** Null while the overview is unknown: Publish is hidden until then; its reason is the tooltip. */
  gate: GateView | null;
  role: 'admin' | 'user';
  onTogglePolicy: () => void;
}) {
  const { project, draft, published } = view;
  const external = project.dataPolicy === 'external';
  return (
    <header className="project-header">
      <a className="back-link" href="#/workbench">
        <Icon name="back" size={16} />
        Workbench
      </a>
      <div className="project-title">
        <h1>{project.name}</h1>
        <span className="pill tone-info">
          {draft !== null ? `Developing v${draft}` : 'No open draft'}
        </span>
        {view.retired && (
          <span className="pill tone-neutral" title={retiredNote(view.retired, project.id)}>
            Retired
          </span>
        )}
        <span className="muted">
          {published !== null && `v${published} published · `}
          <code>{project.id}</code>
        </span>
      </div>
      <div className="project-actions">
        <span className={`pill ${external ? 'tone-warn' : 'tone-ok'}`}>
          {!external && <Icon name="lock" size={14} />}
          {external ? 'External models allowed' : 'Local models only'}
        </span>
        {role === 'admin' && (
          <button type="button" onClick={onTogglePolicy}>
            {external ? 'Restrict to local models' : 'Allow external models…'}
          </button>
        )}
        {draft !== null &&
          gate &&
          (view.retired ? (
            <button type="button" disabled title={RETIRED_REASON}>
              Publish v{draft}
            </button>
          ) : (
            <a className="button" href={`#/workbench/${project.id}/template`} title={gate.reason}>
              Publish v{draft}
            </a>
          ))}
      </div>
    </header>
  );
}
