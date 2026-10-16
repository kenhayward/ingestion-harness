/** Help topic `ontologies`: the ontology library. */
export function OntologiesHelp() {
  return (
    <>
      <p>
        An ontology is a shared vocabulary for a field (process validation, units of measure, a
        customer's data model): the kinds of thing it talks about, how they relate, and controlled
        lists of values. Recipes map their outputs to ontology terms to deliver linked data (RDF),
        and the Workbench uses the library to suggest which vocabularies a document type needs.
      </p>

      <h3>Finding an ontology</h3>
      <p>
        Search by name, id, description or tag, and switch between cards and a list. Each shows the
        kinds of term the ontology holds, its tags, and how far its terms are prepared for
        meaning-based search (embeddings), which the mapping suggestions use.
      </p>

      <h3>Import ontology</h3>
      <p>Administrators add ontologies from:</p>
      <ul>
        <li>
          <strong>A file</strong>: Turtle (.ttl), RDF/XML (.owl, .rdf), JSON-LD, N-Triples or N3.
        </li>
        <li>
          <strong>A folder or .zip</strong>: either <strong>One ontology</strong> (all the files
          become one version) or <strong>One ontology per file</strong> (each file its own ontology,
          imports between them linking up).
        </li>
        <li>
          <strong>A URL</strong>, from the web hosts your administrator allows.
        </li>
      </ul>
      <p>
        Importing the same ontology again adds a new version. Ontologies it imports are taken from
        the library, or fetched and added to it when allowed.
      </p>

      <h3>Marks</h3>
      <ul>
        <li>
          <strong>Local only</strong>: the ontology's terms are never sent to external models, for
          vocabularies that must stay in-house.
        </li>
        <li>
          <strong>Retired</strong>: kept for recipes that already use it, but no longer suggested.
        </li>
      </ul>
    </>
  );
}
