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
          The links below download each output: the CSV files, the JSON document, and the graph when
          RDF is delivered.
        </li>
      </ul>

      <h3>Fields and tables</h3>
      <p>
        The published values, laid out with the recipe's names. A value marked{' '}
        <strong>edited</strong> was changed by the reviewer; the delivered value is the corrected
        one. Edited table cells are highlighted.
      </p>

      <h3>Checks</h3>
      <p>
        Each check compares one output's values with a reference (for example the batch numbers in
        each table against the batches table). Every value shows whether it matched, nearly matched
        (a small difference, often an OCR misread) or did not match.
      </p>

      <h3>Issues</h3>
      <p>
        Values that could not be read as their type (a date that is not a date, a number with text)
        and were kept as written. Worth a look before relying on those values.
      </p>
    </>
  );
}
