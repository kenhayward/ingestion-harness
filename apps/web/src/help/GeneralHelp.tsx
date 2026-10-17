/** Help topic `general`: the recipe-wide settings on the General tab. */
export function GeneralHelp() {
  return (
    <>
      <p>
        Settings that apply to the whole recipe: how documents are read, which model runs by
        default, when a person checks the result, and what publishing delivers.
      </p>

      <h3>Name and Description</h3>
      <p>
        How the document type is shown across CT Studio. Renaming here changes the open draft;
        published versions keep their name.
      </p>

      <h3>Default model</h3>
      <p>
        The model choice every extract step uses unless the step names its own. Left empty, it is
        the default choice set under Administration &gt; Models. A model picked when a job is
        uploaded or retried overrides both.
      </p>

      <h3>Publish to</h3>
      <p>
        Where this recipe&apos;s published outputs are delivered: one of the publishing targets an
        administrator set up under Administration &gt; Published outputs. Left on Default, they go
        to the default target. A target named here that this deployment does not have blocks
        publishing until you pick another. Outputs already delivered stay where they were delivered;
        a new version delivers to its own target from then on.
      </p>

      <h3>Preamble</h3>
      <p>
        Domain guidance placed at the top of every extraction prompt: what kind of document this is,
        the terms it uses, the traps to avoid. Keep it about the document type as a whole; put
        guidance for one output in that step's instructions instead. The Revise stage in the
        Workbench can propose a new preamble from your feedback.
      </p>

      <h3>Review</h3>
      <ul>
        <li>
          <strong>on_warnings</strong> (the default): a job stops for a person to check when
          something looks wrong: a value that could not be read as its type, a check with unmatched
          rows, or a problem with repeating sections' keys. Otherwise it is delivered.
        </li>
        <li>
          <strong>always</strong>: every job stops for review before delivery.
        </li>
        <li>
          <strong>never</strong>: results are delivered without review. Processing problems (a
          required section missing, a model refusing) still stop the job.
        </li>
      </ul>

      <h3>OCR</h3>
      <ul>
        <li>
          <strong>auto</strong>: pages with little or no text layer are read by the OCR model; the
          rest use their text layer.
        </li>
        <li>
          <strong>always</strong>: every page is read by OCR (for scans with a poor text layer).
        </li>
        <li>
          <strong>never</strong>: only the text layer; image-only pages come out empty.
        </li>
      </ul>

      <h3>Date order</h3>
      <p>
        How to read a numeric date like 02/03/2023: DMY is 2 March, MDY is 3 February. Dates with a
        month name are read either way.
      </p>

      <h3>Page markers</h3>
      <p>
        Puts a "[page N]" line before each page, numbered as in the original PDF, so steps can say
        which page a value came from. Leave it on unless an anchor needs the raw text.
      </p>

      <h3>Copy anchor</h3>
      <p>
        For PDFs holding several copies of the document (for example the blank protocol followed by
        the signed one): a regular expression that marks where each copy starts. One copy is kept,
        the last by default, and everything else on this page works on that copy only.
      </p>

      <h3>Delivered formats</h3>
      <p>
        What publishing writes for each document: CSV and JSON by default, and RDF (Turtle) once the
        outputs are mapped to an ontology on the Mapping tab. At least one format stays on.
      </p>
    </>
  );
}
