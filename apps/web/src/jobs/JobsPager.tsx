/**
 * The Jobs page's pager, above the list: which jobs are shown, and newer and older pages. The
 * server pages from a job's place, so "Page n of m" is where the shown jobs fall in the list.
 */
export function JobsPager({
  from,
  to,
  total,
  size,
  hasNewer,
  hasOlder,
  onNewer,
  onOlder,
}: {
  /** The first job shown (0-based) and the one after the last. */
  from: number;
  to: number;
  total: number;
  /** Jobs a page holds. */
  size: number;
  hasNewer: boolean;
  hasOlder: boolean;
  onNewer: () => void;
  onOlder: () => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.floor(from / size), pages - 1);
  return (
    <nav className="jobs-pager" aria-label="Pages of jobs">
      {total > 0 && (
        <span className="jobs-pager-range">
          {from + 1}–{to} of {total}
        </span>
      )}
      <span className="jobs-pager-buttons">
        <button type="button" aria-label="Newer jobs" disabled={!hasNewer} onClick={onNewer}>
          ‹ Newer
        </button>
        <span className="jobs-pager-page" aria-live="polite">
          Page <strong>{page + 1}</strong> of {pages}
        </span>
        <button type="button" aria-label="Older jobs" disabled={!hasOlder} onClick={onOlder}>
          Older ›
        </button>
      </span>
    </nav>
  );
}
