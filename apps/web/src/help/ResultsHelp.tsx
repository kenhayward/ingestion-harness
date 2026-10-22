/** Help topic `results`: the Results page, the published outputs. */
export function ResultsHelp() {
  return (
    <>
      <p>
        The Results page lists every document whose outputs have been published: the data that was
        delivered. Test runs and rejected documents never appear here.
      </p>

      <h3>Finding a result</h3>
      <ul>
        <li>
          <strong>Document type</strong> shows one type's results.
        </li>
        <li>
          <strong>Show</strong> narrows to results a person <strong>Reviewed</strong>, those{' '}
          <strong>Auto-approved</strong> (published without review), or those{' '}
          <strong>With issues</strong>.
        </li>
        <li>The search box filters by file name.</li>
      </ul>

      <h3>The list</h3>
      <p>
        Newest first, one line a result, grouped by the day they were published. The list fills the
        window and shows as many results as fit: <strong>‹ Newer</strong> and{' '}
        <strong>Older ›</strong> above it move between pages, and a page that starts partway through
        a day repeats its heading with <em>(continued)</em>. In a narrow window the document type
        and file count give way to the file name; the preview shows both.
      </p>
      <ul>
        <li>
          From the keyboard: <kbd>↑</kbd> and <kbd>↓</kbd> move to the next result (onto the next
          page when needed), <kbd>Page Up</kbd> and <kbd>Page Down</kbd> change page, and{' '}
          <kbd>Enter</kbd> opens the full result.
        </li>
        <li>
          <strong>Published</strong>: the time the outputs were delivered.
        </li>
        <li>
          <strong>Reviewed by</strong>: who approved the values, or that they were published without
          review.
        </li>
        <li>
          <strong>Issues</strong>: how many values could not be read as their type and were kept as
          written. Worth a look before relying on those values.
        </li>
      </ul>

      <h3>Looking at a result</h3>
      <ul>
        <li>
          Click a row for its preview on the right: the first fields, the first rows of the first
          table, and the files that were published.
        </li>
        <li>
          <strong>Open full result</strong> shows everything: every field, table and check, when and
          where it was published, and each output to download.
        </li>
        <li>
          <strong>Open in viewer</strong> shows the document beside its values, as on the Review
          page but read-only: page thumbnails, the tables, and page numbers that turn to their page.
          It shows the reviewed values, which are what was published. Documents of older (legacy)
          types don't have it.
        </li>
        <li>
          The preview also opens the original document (<strong>PDF</strong>, or{' '}
          <strong>Original</strong> for a Word document) and downloads every output at once as a{' '}
          <strong>ZIP</strong>.
        </li>
      </ul>
    </>
  );
}
