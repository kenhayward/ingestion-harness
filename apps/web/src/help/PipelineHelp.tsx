/** Help topic `pipeline`: extract and check steps, in order. */
export function PipelineHelp() {
  return (
    <>
      <p>
        The pipeline is the list of steps that fill the outputs. Steps run in order, top to bottom;
        each extract step is one model call (or one per chunk or occurrence), answered in a fixed
        shape and checked before it is accepted.
      </p>

      <h3>Extract steps</h3>
      <ul>
        <li>
          <strong>Fills</strong>: either some fields, or one table. Every output is filled by
          exactly one step.
        </li>
        <li>
          <strong>Reads sections</strong>: the parts of the document the model sees. Fewer, tighter
          sections give shorter prompts and fewer mix-ups.
        </li>
        <li>
          <strong>Instructions</strong>: guidance for this step only, added to the prompt: where the
          values are, what to ignore, how rows are laid out.
        </li>
        <li>
          <strong>Model</strong>: empty uses the document type's model (General tab).
        </li>
        <li>
          <strong>Page images</strong>: pages also sent as pictures, for when the text loses
          something (ticks, stamps, a layout the text flattens). Needs a vision-capable model.
        </li>
        <li>
          <strong>Pages per call</strong>: for a long table in one section, run the step once per N
          pages and join the rows, so no single reply gets too long.
        </li>
        <li>
          <strong>Max attempts</strong>: how often the step is retried when the reply does not fit
          the outputs; each retry tells the model what was wrong.
        </li>
        <li>
          <strong>Context</strong>: values filled by earlier steps, shown in this step's prompt (a
          field, or a table's column such as <code>batches.batch</code>), for example so a table
          step knows the batch numbers to expect.
        </li>
        <li>
          <strong>Key column</strong>: on a table step reading a repeating section, the column the
          worker fills with each occurrence's key (see the Sections help).
        </li>
      </ul>
      <p>
        Every prompt also states the document's file name and starts each page with "[page N]", so a
        step can fill a file name or page number from them.
      </p>

      <h3>Check steps</h3>
      <p>
        A check compares the values of one output with a reference, for example each table's batch
        numbers against the batches table. Values found in the reference match; near matches (a
        letter or two different, often OCR) are flagged; anything else is unmatched and sends the
        job for review. Aliases list other accepted spellings. One check compares one path: to check
        several tables, add one check per table.
      </p>

      <h3>Order</h3>
      <p>
        A step can only use context from steps above it, and a check runs on what the steps above it
        filled. Use the arrows to reorder.
      </p>
    </>
  );
}
