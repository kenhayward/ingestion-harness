/** Help topic `names`: name patterns, and the names a reviewer can change. */
export function NamesHelp() {
  return (
    <>
      <p>
        Some systems CT Studio delivers to name what they create, for example a document name. A
        target of such a system holds a <strong>name pattern</strong>, and a recipe can set its own
        pattern for that target on General, under <em>Publish to</em>.
      </p>

      <h3>Patterns</h3>
      <p>
        A pattern is text with placeholders in braces, filled in for each document:{' '}
        <code>{'{field:title}'}</code> (an extracted field), <code>{'{source.filename}'}</code>,{' '}
        <code>{'{source.stem}'}</code> (the file name without its extension),{' '}
        <code>{'{source.sha256}'}</code>, <code>{'{recipe.id}'}</code>,{' '}
        <code>{'{recipe.version}'}</code>, <code>{'{job.id}'}</code> and <code>{'{date}'}</code>{' '}
        (the publishing date, UTC). <code>{'{field:title|source.stem}'}</code> uses the title, or
        the file name when there is no title; <code>{"{field:title|'untitled'}"}</code> ends with a
        fixed text. Write <code>{'{{'}</code> and <code>{'}}'}</code> for braces.
      </p>

      <h3>On the review screen</h3>
      <p>
        <strong>Names</strong> shows what each such target will call this document. Type another
        name to use it instead; a name left as it is follows the pattern. A pattern that resolves to
        nothing (a field the document lacks) needs a name typed here, or the delivery goes back to
        review.
      </p>

      <h3>Names already in use</h3>
      <p>
        When a system already holds a <em>different</em> document under that name, the job comes
        back to review with the name marked. Choose another and approve again. The same document
        delivered again is never a conflict: the system replaces it.
      </p>
    </>
  );
}
