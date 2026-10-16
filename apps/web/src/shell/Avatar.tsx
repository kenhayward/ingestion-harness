import { initials } from './derive.js';

/**
 * A person's picture: their linked GitHub account's (docs/design/profile.md), else their
 * initials. Decorative: the name is always written beside it.
 */
export function Avatar({
  name,
  url,
  size = 'small',
}: {
  name: string;
  url?: string | null;
  size?: 'small' | 'large';
}) {
  const className = size === 'large' ? 'avatar avatar-large' : 'avatar';
  return url ? (
    <img className={className} src={url} alt="" aria-hidden="true" referrerPolicy="no-referrer" />
  ) : (
    <span className={className} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
