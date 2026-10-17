import { versionLink, type VersionInfo } from '@ih/shared';
import { Icon } from '../ui/Icon.js';

/**
 * The build's version at the bottom of the nav (ADR 0014), linking to its tag's page on GitHub (the
 * merged PR), or an untagged build's changes since the previous tag. A dev build has no link.
 */
export function NavVersion({ info, compact }: { info: VersionInfo; compact: boolean }) {
  const text = /^\d/.test(info.version) ? `v${info.version}` : info.version;
  const name = `Version ${info.version}`;
  const href = versionLink(info);
  if (!href) {
    return (
      <span className="nav-version" title={compact ? name : undefined}>
        <Icon name="history" size={18} />
        <span className="nav-label">{text}</span>
      </span>
    );
  }
  return (
    <a
      className="nav-version"
      href={href}
      target="_blank"
      rel="noopener"
      aria-label={compact ? `${name} (opens in a new tab)` : undefined}
      title={compact ? name : undefined}
    >
      <Icon name="history" size={18} />
      <span className="nav-label">{text}</span>
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}
