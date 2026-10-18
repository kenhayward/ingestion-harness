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
      <p>Newest first, grouped by the day they were published.</p>
      <ul>
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
          The preview also opens the original document (<strong>PDF</strong>, or{' '}
          <strong>Original</strong> for a Word document) and downloads every output at once as a{' '}
          <strong>ZIP</strong>.
        </li>
      </ul>
    </>
  );
}
