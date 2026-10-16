/** Help topic `templates`: the Document types page. */
export function TemplatesHelp() {
  return (
    <>
      <p>
        Every kind of document CT Studio can read has a <strong>document type</strong>, and each
        type has a recipe: what the document looks like and what to extract from it. This page lists
        them all.
      </p>

      <h3>Starting a document type</h3>
      <ul>
        <li>
          <strong>New document type</strong> asks for an id (lowercase, it cannot change later and
          names the outputs) and a name, and opens an empty draft recipe. For a type built from
          sample documents with the model's help, start a project in the Workbench instead.
        </li>
        <li>
          <strong>Import YAML</strong> creates a draft from a recipe pasted as YAML; tick{' '}
          <em>Publish if valid</em> to publish it straight away.
        </li>
        <li>
          <strong>Import from GitHub</strong> picks a recipe YAML file from one of your GitHub
          repositories, by branch and folder (link your GitHub account in Profile first).
        </li>
      </ul>

      <h3>On each card</h3>
      <ul>
        <li>
          Which version is published and whether a draft is open. New documents always use the
          newest published version; a draft never runs on real uploads.
        </li>
        <li>
          <strong>Edit draft</strong> opens the open draft; <strong>New draft from vN</strong>{' '}
          starts the next one from the published version. Each tab of the recipe editor has its own
          help.
        </li>
        <li>
          <strong>Open in workbench</strong>: the type's Workbench project, where it is tested on
          samples and evaluated.
        </li>
        <li>
          <strong>Test run</strong>: run one PDF or Word document through the draft. Test runs go
          through review like real jobs but are never delivered.
        </li>
        <li>
          <strong>Export YAML</strong>, <strong>Rename…</strong> and, for administrators,{' '}
          <strong>Retire…</strong>.
        </li>
      </ul>

      <h3>Retiring</h3>
      <p>
        A retired type disappears from the upload list and takes no new work; what it delivered is
        withdrawn. Its jobs and results stay readable. Bringing a type back is done by an
        administrator through the API.
      </p>

      <h3>Legacy spec types</h3>
      <p>
        Types defined by an older file format show as read-only cards marked <em>Legacy spec</em>.
        They keep working, but can only be retired here.
      </p>
    </>
  );
}
