import { useId, type ReactNode } from 'react';
import { maintenanceMessage, type MaintenanceNotice } from '@ih/shared';
import { Icon } from '../ui/Icon.js';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The maintenance banner (migration 0046): a warning triangle, the admin's message (else the
 * default one) and since when. On the sign-in page, the maintenance page and the admin's preview.
 */
export function MaintenanceBanner({
  notice,
  children,
  live = true,
}: {
  notice: MaintenanceNotice;
  /** A line under the message: who can still get in, what to do. */
  children?: ReactNode;
  /** false for the admin's preview: not announced as an alert. */
  live?: boolean;
}) {
  const titleId = useId();
  return (
    <div
      role={live ? 'alert' : undefined}
      aria-labelledby={titleId}
      className="callout tone-warn maintenance-banner"
    >
      <Icon name="warning" size={22} />
      <span>
        <strong id={titleId}>Under maintenance</strong>
        <span className="maintenance-message">{maintenanceMessage(notice)}</span>
        {notice.since && <small>Since {when(notice.since)}.</small>}
        {children && <small>{children}</small>}
      </span>
    </div>
  );
}
