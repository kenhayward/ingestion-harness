/** Help topic `introduction`: what CT Studio is, how a document flows, and who does what. */
export function IntroductionHelp() {
  return (
    <>
      <h3>What CT Studio does</h3>
      <p>
        Content Transformation Studio (CT Studio) turns documents whose layout is known in advance
        (protocols, reports, certificates, invoices) into checked, structured data: CSV and JSON
        files, and linked data (RDF) where it is wanted. A model reads each document following a
        recipe, its answers are checked, and a person reviews them before anything is delivered.
      </p>

      <h3>How a document goes through</h3>
      <ol>
        <li>
          <strong>Upload</strong> a PDF or Word document on Home and pick its document type.
        </li>
        <li>
          <strong>Read</strong>: the text is taken from the file; scanned pages are read by OCR.
        </li>
        <li>
          <strong>Split</strong> into sections: the parts of the document each step reads.
        </li>
        <li>
          <strong>Extract</strong>: the recipe's steps ask the model for each value, in a fixed
          shape, retrying when the answer does not fit.
        </li>
        <li>
          <strong>Check</strong>: values are read as their type, and compared with each other where
          the recipe says so.
        </li>
        <li>
          <strong>Review</strong>: a person corrects anything wrong and approves, or rejects.
        </li>
        <li>
          <strong>Publish</strong>: the outputs are delivered and appear on the Results page.
        </li>
      </ol>

      <h3>Words used throughout</h3>
      <ul>
        <li>
          <strong>Document type</strong>: a kind of document CT Studio can read.
        </li>
        <li>
          <strong>Recipe</strong>: a document type's instructions: its sections, outputs, steps and
          settings, in numbered versions. Only published versions read real documents.
        </li>
        <li>
          <strong>Job</strong>: one document going through, with its status.
        </li>
        <li>
          <strong>Outputs</strong>: the fields and tables a recipe delivers.
        </li>
      </ul>

      <h3>Who does what</h3>
      <ul>
        <li>
          <strong>Operators</strong> upload documents, follow and review jobs, and use the results:
          Home, Jobs and Results.
        </li>
        <li>
          <strong>Recipe designers</strong> build and improve document types: the Workbench (from
          sample documents, with the model proposing each part), Document types, and the Ontologies
          library for linked data.
        </li>
        <li>
          <strong>Administrators</strong> manage models, linked data settings and users under
          Administration in the account menu.
        </li>
      </ul>

      <h3>Getting help</h3>
      <p>
        Every screen has a green <strong>?</strong> that explains it. This Help gathers the same
        explanations in one place: pick a screen on the left, or one of its parts below it. From a{' '}
        <strong>?</strong>, <strong>Open in Help</strong> brings you here at that topic.
      </p>
      <h3>What&apos;s new</h3>
      <p>
        <strong>About</strong> in the account menu, or the version at the bottom of the menu on the
        left, shows which version of CT Studio you are using and the release notes, latest first:
        what changed, written up from time to time.
      </p>
    </>
  );
}
