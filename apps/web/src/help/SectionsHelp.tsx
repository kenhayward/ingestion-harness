/** Help topic `sections`: how a recipe splits a document, and how its settings interact. */
export function SectionsHelp() {
  return (
    <>
      <p>
        Before any model call, the document's text is split into <strong>sections</strong>. Each
        extract step reads only the sections it names, so a good split keeps prompts short and stops
        values from one part of the document leaking into another.
      </p>

      <h3>Anchor</h3>
      <p>
        A regular expression (multiline: <code>^</code> is the start of any line) that finds the
        first line of the section. A section starts where its anchor matches and{' '}
        <strong>runs to the next section's start</strong>, whichever section that is: the order is
        the order in the document, not in this list. Use the Workbench Sections tab to see where
        each anchor lands in your samples.
      </p>

      <h3>Required</h3>
      <p>
        A required section that no line matches stops the document: the job needs review with
        "required sections not found". An optional section that is missing is simply empty.
      </p>

      <h3>Repeats</h3>
      <p>
        Without Repeats, only the anchor's <em>first</em> match counts. When the same block appears
        once per batch, item or site, the later blocks then end up inside whichever section comes
        before them. With Repeats, <strong>every match starts an occurrence</strong>, and each
        occurrence runs to the next section's start.
      </p>
      <ul>
        <li>
          A table step (extract or plugin) reading a repeating section runs once per occurrence,
          told which one.
        </li>
        <li>
          A field step cannot read a repeating section (a field holds one value per document).
        </li>
        <li>A step reads at most one repeating section.</li>
        <li>A required repeating section needs at least one occurrence.</li>
      </ul>

      <h3>Key</h3>
      <p>
        A regular expression that names each occurrence, read from the occurrence's own text: the
        group named <code>key</code>, else group 1, else the whole match. For a caption like "Table
        6: Study-202432 - Batch 4586784 - Dissolution Results", <code>Batch\s+(\w+)</code> gives{' '}
        <code>4586784</code>.
      </p>

      <h3>Key from</h3>
      <p>
        Another repeating section that has a Key of its own, usually a heading that starts each
        block (the batch heading). It does two things:
      </p>
      <ul>
        <li>
          When this section's own Key finds nothing, an occurrence takes the key of the{' '}
          <strong>nearest heading above it</strong>. Its own Key wins when it finds one.
        </li>
        <li>
          It checks the blocks against the headings: a heading with no occurrence of this section, a
          key no heading has, a caption whose key differs from the heading above it, or an
          occurrence with no key at all. Any of these is a key issue, and the job{' '}
          <strong>needs review</strong> instead of delivering rows under the wrong batch.
        </li>
      </ul>
      <p>The list only offers repeating sections with their own Key and no Key from (no chains).</p>

      <h3>Key column</h3>
      <p>
        Set on a table step (Pipeline), it names the column the worker fills with each occurrence's
        key, so the batch number comes from the document rather than from the model's reading. It
        needs the step's repeating section to have a Key or Key from; without either, the model has
        to find the identifier itself, so say where in the step's instructions.
      </p>

      <h3>Putting it together</h3>
      <p>A stability report with the same five tables for each of three batches:</p>
      <ul>
        <li>
          <code>batch</code>: anchor on the batch heading, Repeats, Key <code>BATCH\s+(\w+)</code>.
        </li>
        <li>
          One section per table: anchor on its caption, Repeats, Key <code>Batch\s+(\w+)</code>, Key
          from <code>batch</code>.
        </li>
        <li>
          One table step per table reading its section, with Key column <code>batch</code>.
        </li>
      </ul>
      <p>
        Each table step then runs three times and every row carries the right batch. If a table is
        missed for one batch, the job stops for review rather than delivering two batches.
      </p>

      <h3>Missed headings</h3>
      <p>
        Under a sample, <strong>Missed headings</strong> lists keys (batch numbers, say) that appear
        in a heading line of the document but that no anchor caught, with the first such line. Most
        often the anchor is too strict, or the document varies the wording. If a heading sits just
        before the section it names, widen the anchor, or start the section earlier with a
        look-ahead such as <code>(?=...)</code>, so the section begins at the heading.
      </p>

      <h3>Before sections: copies</h3>
      <p>
        When a PDF holds several copies of the document (Document options), one copy is kept first,
        and sections are found in that copy only.
      </p>
    </>
  );
}
