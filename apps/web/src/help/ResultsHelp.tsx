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
        <li>The chips filter by document type.</li>
        <li>The search box filters by file name.</li>
      </ul>

      <h3>The list</h3>
      <ul>
        <li>
          <strong>Published</strong>: when the outputs were delivered.
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
        <li>Click a file name for a quick preview of its fields and tables.</li>
        <li>
          The open icon at the end of the row shows the full result: every field and table, when and
          where it was published, and each output to download (CSV, JSON, and the graph when RDF is
          delivered).
        </li>
        <li>
          The row also links to the original document, and downloads every output at once as a{' '}
          <strong>ZIP</strong>.
        </li>
      </ul>
    </>
  );
}
