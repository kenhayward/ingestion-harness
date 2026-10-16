/** Help topic `outputs`: fields and tables, what the recipe delivers. */
export function OutputsHelp() {
  return (
    <>
      <p>
        The outputs are what the recipe extracts from each document and delivers: the columns of the
        CSV files and the keys of the JSON. Decide them first; sections and steps exist to fill
        them.
      </p>

      <h3>Fields and tables</h3>
      <ul>
        <li>
          A <strong>field</strong> holds one value per document (the product name, the study
          number). All fields go into one row of the document's fields CSV.
        </li>
        <li>
          A <strong>table</strong> holds any number of rows with the same columns (one row per
          result, per batch). Each table is its own CSV.
        </li>
      </ul>

      <h3>Id and Name</h3>
      <p>
        The id is the column or key name in what is delivered: lowercase, letters, digits, "_" and
        "-", starting with a letter. The name is the readable label shown to reviewers.
      </p>

      <h3>Type</h3>
      <p>
        What the value is read as: text, integer, decimal, date, boolean, enum (one of a fixed list
        of values) or list (several text values). Extracted values are normalised to the type, so
        "1,234.5" becomes 1234.5 and dates come out as YYYY-MM-DD. A value that cannot be read as
        its type is kept as written and listed as an issue, which sends the job for review.
      </p>

      <h3>Enum values</h3>
      <p>The allowed values of an enum, one per line; the model must pick one of them.</p>

      <h3>Description</h3>
      <p>
        Tells the model exactly what to copy: where the value is, which of several similar values to
        take, how it is written. It is the most effective place to improve a field that comes out
        wrong.
      </p>

      <h3>Filling outputs</h3>
      <p>
        Every field and table must be filled by <strong>exactly one step</strong> on the Pipeline
        tab; the checks above the tabs say when one is not. Changing an output's type, values or
        columns makes saved references for it outdated, so they need verifying again before they
        count in evaluations.
      </p>
    </>
  );
}
