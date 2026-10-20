/** Help topic `pipeline`: extract, plugin and check steps, in order. */
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
          the outputs; each retry tells the model what was wrong. When a step needs retries on many
          runs, its warning has <em>See the model log</em>: the recent runs that needed a retry,
          each attempt's prompt and reply, and the errors that sent it back, so you can see what the
          model got wrong and change the step.
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
      <p>
        A check can compare with a plugin instead of a reference: pick <strong>A plugin</strong>{' '}
        under <em>Compares with</em>, choose the check plugin and fill in its settings. For example{' '}
        <code>list.lookup@1</code> checks each value against a list of accepted values you type in,
        with aliases and a tolerance for misreads. A check plugin judges every value as matched, an
        alias, near or unmatched, and may add a short note saying why; the note shows beside the
        value on the Review page and in the check on the Results page. A check never changes an
        output.
      </p>

      <h3>Plugin steps</h3>
      <p>
        A plugin step runs a capability installed with CT Studio instead of asking a model, such as{' '}
        <code>text.pattern@1</code>, which fills fields or a table by matching patterns in the
        step's sections, or one your administrator added as a package. It fills outputs like an
        extract step and can read earlier values; most call no model and cost nothing to run. A
        plugin table step reading a repeating section runs once per occurrence, as an extract step
        does, and its <strong>Key column</strong> is filled with each occurrence's key.
      </p>
      <p>
        A table step (extract or plugin) can also <strong>enrich</strong> a table an earlier step
        created: tick the columns it fills under <em>Enriches only these columns</em>. It receives
        the rows found so far and fills only those columns on each, for example an expiry date
        printed elsewhere in the document. Every column is filled by exactly one step: the step
        creating the rows fills the rest. Re-running the step that creates the rows re-runs the
        enriching steps too.
      </p>
      <p>
        Add one with <em>Add plugin step</em>, which lists the plugins this deployment's workers can
        run. Its form sets what it fills and reads, and its settings, laid out from what the plugin
        asks for. A plugin no worker has any more keeps its settings as JSON, and the recipe cannot
        be published until a worker has the plugin again or the step is changed.
      </p>
      <p>
        Some plugins ask a model, for example to find a value the text does not label. Their step
        has a <strong>Model</strong> picker like an extract step's (empty uses the document type's
        model), and the project's data policy applies as for any model call. A reviewer can re-run a
        plugin step from the Review page's Steps tab, with guidance for the plugin and, for one that
        asks a model, another model.
      </p>
      <p>
        In the Workbench, <em>Preview on dev samples</em> runs the saved step on each prepared dev
        sample, cut into sections as a run would, and shows what it found, what could not be read as
        its type, and why a sample failed. It runs only this step (no earlier values) and stops
        after 20 seconds, so a pattern that never finishes cannot stall anything.
      </p>

      <h3>Order</h3>
      <p>
        A step can only use context from steps above it, and a check runs on what the steps above it
        filled. Use the arrows to reorder.
      </p>
    </>
  );
}
