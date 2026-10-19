/** Help topic `result`: one published result. */
export function ResultHelp() {
  return (
    <>
      <p>One document's published result: exactly what was delivered, and how it got there.</p>

      <h3>At the top</h3>
      <ul>
        <li>The file name, with the document type and recipe version that read it.</li>
        <li>
          <strong>Published</strong>: when the outputs were delivered.
        </li>
        <li>
          <strong>Review</strong>: who approved the values and their note, or that the result was
          published without review.
        </li>
        <li>
          <strong>Target</strong>: where in the data store the files were written, for anyone
          reading them directly.
        </li>
        <li>
          <strong>Original</strong> (or <strong>PDF</strong>) opens the uploaded document;{' '}
          <strong>Download all · ZIP</strong> downloads every output at once.
        </li>
        <li>
          The tiles count the fields, tables, checks and issues, and say what was edited in review
          or needs a look.
        </li>
      </ul>

      <h3>The contents</h3>
      <p>
        The list on the left holds everything the result contains: the fields, each table with its
        rows, each check, the graph (when RDF is delivered), the issues and the published files.
        Pick one to open it on the right. A count in amber is something to look at: values edited in
        review, near matches, issues.
      </p>
      <p>
        A table can be filtered (<strong>Filter rows</strong> keeps the rows with a matching value)
        and downloaded as <strong>CSV</strong>; ‹ › step to the table before or after.{' '}
        <strong>Published files</strong> downloads each output: the CSV files, the JSON document,
        and the graph when RDF is delivered. <strong>Graph</strong> shows that graph as cards, a
        diagram or Turtle (see <em>Reading a graph</em>).
      </p>

      <h3>Fields and tables</h3>
      <p>
        The published values, laid out with the recipe's names. A value marked{' '}
        <strong>edited</strong> was changed by the reviewer; the delivered value is the corrected
        one. Edited table cells are highlighted.
      </p>

      <h3>Checks</h3>
      <p>
        Each check compares one output's values with a reference (for example the batch numbers in
        each table against the batches table). Every value found shows whether it matched exactly,
        nearly matched (a small difference, often an OCR misread, with its edit distance) or was not
        found; a reference no value matched is listed as not used.
      </p>

      <h3>Issues</h3>
      <p>
        Values that could not be read as their type (a date that is not a date, a number with text)
        and were kept as written. Worth a look before relying on those values.
      </p>
    </>
  );
}
