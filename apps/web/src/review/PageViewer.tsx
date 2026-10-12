import { Icon } from '../ui/Icon.js';

/** Source PDF pane (UI handoff §2): page toolbar over the rendered page on a recessed well. */
export function PageViewer({
  src,
  page,
  pageCount,
  onPage,
}: {
  src: string;
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  return (
    <section className="page-viewer" aria-label="Source PDF">
      <div className="page-nav">
        <button
          type="button"
          className="icon bordered"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <Icon name="chevronLeft" />
        </button>
        <span>
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className="icon bordered"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          <Icon name="chevronRight" />
        </button>
        <span className="page-hint muted">Click a value to find it on the page</span>
      </div>
      <div className="page-well">
        <img src={src} alt={`Page ${page} of ${pageCount}`} />
      </div>
    </section>
  );
}
