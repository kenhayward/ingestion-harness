import type { Retirement } from '@ih/shared';
import { retiredLine, unretireHint } from './retired.js';

/**
 * A retired document type: who retired it, what that means, and the API route an admin
 * unretires it with (there is no Unretire button, D14). Reuses the stale banner's look in its
 * grey `skip` tone.
 */
export function RetiredBanner({ retirement, typeId }: { retirement: Retirement; typeId: string }) {
  return (
    <div className="stale-banner" role="note" data-tone="skip">
      <p className="stale-banner-text">
        <strong>{retiredLine(retirement)}.</strong> Nothing new runs for it: uploads, test runs,
        drafting and publishing are off. Its jobs, results and references stay readable.{' '}
        {unretireHint(typeId)}
      </p>
    </div>
  );
}
