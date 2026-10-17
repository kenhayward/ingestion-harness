/** Help topic `workbench`: the Workbench project list. */
export function WorkbenchHelp() {
  return (
    <>
      <p>
        The Workbench is where a document type is built from sample documents, with a model
        proposing each part and you deciding. Each project is one document type.
      </p>

      <h3>How a project goes</h3>
      <p>
        Add samples, write a brief (what you need from the documents), then work through the stages:
        Survey, Outputs, Sections, Steps and, for linked data, Mapping. Each stage proposes changes
        you accept or reject. Then verify references, evaluate the recipe on the samples, revise
        from feedback, and publish. A project's Overview tab shows where it stands and what to do
        next.
      </p>

      <h3>Starting a project</h3>
      <ul>
        <li>
          <strong>New project</strong> asks for an id (lowercase, it becomes the document type's id
          and cannot change) and a name.
        </li>
        <li>
          <strong>Import bundle</strong> brings in a project exported from another CT Studio, with
          its samples, brief and recipe.
        </li>
      </ul>

      <h3>Finding a project</h3>
      <ul>
        <li>
          <strong>Pinned and recent</strong>: cards for up to three projects you pinned and up to
          three you opened lately. Pin a project from its row to keep it here.
        </li>
        <li>
          The chips filter the list: <strong>Needs you</strong> (a proposal to decide, a stage out
          of date, or a warning), <strong>Running</strong>, <strong>Ready to publish</strong>,{' '}
          <strong>In progress</strong>, and <strong>Published, no draft</strong>.
        </li>
        <li>
          Search by name or id, and narrow by phase or data policy; sort by recent activity, name,
          score or number of samples.
        </li>
      </ul>

      <h3>Data policy</h3>
      <p>
        A project is <strong>local</strong> by default: its documents only go to models running on
        your own servers. Only an administrator can let a project use external models.
      </p>
    </>
  );
}
