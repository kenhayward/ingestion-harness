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
    <section className="page-viewer" aria-label="Document page">
      <div className="page-nav">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          ‹
        </button>
        <span>
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          ›
        </button>
      </div>
      <img src={src} alt={`Page ${page} of ${pageCount}`} />
    </section>
  );
}
