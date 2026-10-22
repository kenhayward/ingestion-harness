/** The Jobs page's pager, above the list: which jobs are shown, newer and older pages. */
export function JobsPager({
  from,
  to,
  total,
  page,
  pages,
  onPage,
}: {
  /** The first job shown (0-based) and the one after the last. */
  from: number;
  to: number;
  total: number;
  /** 0-based. */
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  return (
    <nav className="jobs-pager" aria-label="Pages of jobs">
      {total > 0 && (
        <span className="jobs-pager-range">
          {from + 1}–{to} of {total}
        </span>
      )}
      <span className="jobs-pager-buttons">
        <button
          type="button"
          aria-label="Newer jobs"
          disabled={page <= 0}
          onClick={() => onPage(page - 1)}
        >
          ‹ Newer
        </button>
        <span className="jobs-pager-page" aria-live="polite">
          Page <strong>{page + 1}</strong> of {pages}
        </span>
        <button
          type="button"
          aria-label="Older jobs"
          disabled={page >= pages - 1}
          onClick={() => onPage(page + 1)}
        >
          Older ›
        </button>
      </span>
    </nav>
  );
}
