import type { NextAction as Action, NextActionKind, OverviewState } from '@ih/shared';
import { StageStatusIcon } from './StageStatusIcon.js';
import { stageStyle } from './stageStyle.js';

/** The icon and tone each next-action kind shows (handoff §1). */
export const NEXT_ACTION_STATE: Record<NextActionKind, OverviewState> = {
  refresh: 'stale',
  decide: 'proposed',
  brief: 'warn',
  samples: 'warn',
  running: 'running',
  below_threshold: 'warn',
  publish: 'ready',
  start_version: 'pending',
  continue: 'pending',
};

/** Status icon + verb phrase in the state's tone; a link to the right tab when `href` is given. */
export function NextAction({ action, href }: { action: Action; href?: string }) {
  const state = NEXT_ACTION_STATE[action.kind];
  const content = (
    <>
      <StageStatusIcon state={state} size={16} decorative />
      <span>{action.label}</span>
    </>
  );
  const tone = stageStyle(state).tone;
  return href === undefined ? (
    <span className="next-action" data-tone={tone}>
      {content}
    </span>
  ) : (
    <a className="next-action" data-tone={tone} href={href}>
      {content}
    </a>
  );
}
