import type { ReactNode } from 'react';
import { Icon } from '../ui/Icon.js';

/**
 * Source PDF pane (UI handoff §2): page toolbar over the rendered page on a recessed well, with
 * a strip of page thumbnails beside it (a dot marks pages holding flagged values).
 */
export function PageViewer({
  src,
  thumbSrc,
  page,
  pageCount,
  flaggedPages = new Set<number>(),
  onPage,
  actions,
}: {
  src: string;
  /** A page's image for its thumbnail; absent: no thumbnails. */
  thumbSrc?: (page: number) => string;
  page: number;
  pageCount: number;
  /** Pages a flagged value was found on. */
  flaggedPages?: ReadonlySet<number>;
  onPage: (page: number) => void;
  /** Buttons at the right of the toolbar (swap sides, hide). */
  actions?: ReactNode;
}) {
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
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
        {actions && <span className="pane-actions">{actions}</span>}
      </div>
      <div className="page-body">
        {thumbSrc && pageCount > 1 && (
          <nav className="page-thumbs" aria-label="Pages">
            {pages.map((n) => {
              const flagged = flaggedPages.has(n);
              return (
                <button
                  key={n}
                  type="button"
                  aria-label={flagged ? `Page ${n} (flagged values)` : `Page ${n}`}
                  aria-current={n === page ? 'page' : undefined}
                  onClick={() => onPage(n)}
                >
                  <span className="page-thumb">
                    <img src={thumbSrc(n)} alt="" loading="lazy" decoding="async" />
                    {flagged && <i className="page-thumb-flag" aria-hidden="true" />}
                  </span>
                  <small aria-hidden="true">{n}</small>
                </button>
              );
            })}
          </nav>
        )}
        <div className="page-well">
          <img src={src} alt={`Page ${page} of ${pageCount}`} />
        </div>
      </div>
    </section>
  );
}
