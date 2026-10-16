/** Help topic `ontology`: one ontology, its versions and where it came from. */
export function OntologyHelp() {
  return (
    <>
      <p>One ontology from the library: its versions, where it came from, and its terms.</p>

      <h3>Version</h3>
      <p>
        Each import adds a version. When there is more than one, the Version list at the top picks
        which one to look at. Recipes pin the version they map to, so a new version changes nothing
        until a recipe moves to it.
      </p>

      <h3>About this version</h3>
      <ul>
        <li>
          The ontology's own address (IRI) and version address, and its licence, as the file states
          them.
        </li>
        <li>
          <strong>Source</strong>: the URL it was fetched from, the files it was built from, or an
          uploaded file (downloadable from the top).
        </li>
        <li>
          <strong>Imports</strong>: other ontologies this one builds on, and whether each was found
          in the library, fetched from the web, or could not be found (its terms are then missing).
        </li>
      </ul>

      <h3>Terms</h3>
      <p>
        Below, the terms by kind: classes, properties, concepts and shapes, each with its own help
        on the bar. Search finds terms by name or synonym; pick one for its details, or switch to
        the graph to see its neighbours.
      </p>

      <h3>For administrators</h3>
      <ul>
        <li>
          <strong>Edit…</strong>: name, description, tags, Local only (never sent to external
          models) and Retired.
        </li>
        <li>
          <strong>Delete version…</strong>: removes the version shown. A version a recipe still pins
          should be replaced in the recipe first.
        </li>
      </ul>
    </>
  );
}
