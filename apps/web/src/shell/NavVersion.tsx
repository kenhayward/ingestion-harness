import type { VersionInfo } from '@ih/shared';
import { Icon } from '../ui/Icon.js';

/** `v2026.10.17.3` for a calendar version (ADR 0014); a dev build's name as it is. */
export const versionText = (info: VersionInfo) =>
  /^\d/.test(info.version) ? `v${info.version}` : info.version;

/**
 * The build's version at the bottom of the nav (ADR 0014). It opens About, where the release notes
 * are and the build's link to GitHub.
 */
export function NavVersion({
  info,
  compact,
  onOpen,
}: {
  info: VersionInfo;
  compact: boolean;
  /** Opens About. */
  onOpen: () => void;
}) {
  const text = versionText(info);
  const name = `Version ${info.version}`;
  return (
    <button
      type="button"
      className="nav-version"
      aria-label={`${compact ? name : text}: about CT Studio and release notes`}
      title={compact ? name : undefined}
      onClick={onOpen}
    >
      <Icon name="history" size={18} />
      <span className="nav-label">{text}</span>
    </button>
  );
}
