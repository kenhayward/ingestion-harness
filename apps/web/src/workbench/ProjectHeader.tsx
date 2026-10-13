import type { GateView, ProjectView } from '@ih/shared';
import { Icon } from '../ui/Icon.js';

/** Project page header (handoff §2): name, versions, data policy and the gated Publish button. */
export function ProjectHeader({
  view,
  gate,
  role,
  onTogglePolicy,
}: {
  view: ProjectView;
  /** Null while the overview is unknown: Publish is hidden until the gate is known. */
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
        {draft !== null && gate && (
          <a
            className={gate.passes ? 'button' : 'button locked'}
            href={`#/workbench/${project.id}/evaluate`}
            title={gate.reason}
          >
            {!gate.passes && <Icon name="lock" size={14} />}
            Publish v{draft}
            {!gate.passes && <span className="visually-hidden"> (locked: {gate.reason})</span>}
          </a>
        )}
      </div>
    </header>
  );
}
