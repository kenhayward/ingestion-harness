/**
 * The Results page's pager, above the list, in the Jobs page's design. The API pages from the
 * last result shown and does not count the results, so it gives the page number, not how many
 * there are; the footer says which results are shown (the toolbar stays one line).
 */
export function ResultsPager({
  page,
  hasNewer,
  hasOlder,
  onNewer,
  onOlder,
}: {
  /** 0-based. */
  page: number;
  hasNewer: boolean;
  hasOlder: boolean;
  onNewer: () => void;
  onOlder: () => void;
}) {
  return (
    <nav className="jobs-pager results-pager" aria-label="Pages of results">
      <span className="jobs-pager-buttons">
        <button type="button" aria-label="Newer results" disabled={!hasNewer} onClick={onNewer}>
          ‹ Newer
        </button>
        <span className="jobs-pager-page" aria-live="polite">
          Page <strong>{page + 1}</strong>
        </span>
        <button type="button" aria-label="Older results" disabled={!hasOlder} onClick={onOlder}>
          Older ›
        </button>
      </span>
    </nav>
  );
}
