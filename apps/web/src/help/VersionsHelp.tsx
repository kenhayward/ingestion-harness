/** Help topic `versions`: published versions, the open draft, labels and going back. */
export function VersionsHelp() {
  return (
    <>
      <p>
        Every change to a recipe happens in a <strong>draft</strong>. Publishing turns the draft
        into a numbered version that can no longer change, and new documents use the newest
        published version. Jobs remember the version they ran with.
      </p>

      <h3>Label and note</h3>
      <p>
        A short label (up to 80 characters) and a note say what a version is for, such as "Batch
        tables split per batch" or why it was published. They describe the version without changing
        it, so published versions can be labelled too, and the draft's label carries over when it is
        published.
      </p>

      <h3>Replace draft</h3>
      <p>
        <strong>Replace draft vN with vM</strong> copies an older version into the open draft, for
        example to undo changes that made results worse. The draft's change log records it, and
        nothing is published until you publish. Save or discard unsaved edits first.
      </p>

      <h3>Start a draft from a version</h3>
      <p>
        When no draft is open, <strong>Start vN from vM</strong> opens the next draft as a copy of
        the version you choose.
      </p>
    </>
  );
}
