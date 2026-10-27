import type { Api } from '../api/client.js';

/**
 * A held PDF's review page (`#/conversion/items/<itemId>/review`): the pages beside the
 * decomposed document, to approve or reject. A placeholder until the review page itself.
 */
export function ConversionReviewPage({ itemId }: { api: Api; itemId: string }) {
  return (
    <div className="conversion-page">
      <a className="back-link" href="#/conversion">
        Conversion
      </a>
      <h1>Review</h1>
      <p className="muted">
        The review of <span className="mono">{itemId}</span> is not available yet.
      </p>
    </div>
  );
}
