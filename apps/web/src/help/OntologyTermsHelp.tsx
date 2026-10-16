/** Help topics for the ontology detail page's term kinds: classes, properties, concepts, shapes. */

function Browsing() {
  return (
    <>
      <h3>Browsing</h3>
      <p>
        The tree shows the hierarchy from the top; search replaces it with matches by name or
        synonym. Pick a term for its details (label, definition, synonyms and how it connects to
        other terms), or switch to <strong>Graph</strong> to see its neighbours and follow them.
      </p>
    </>
  );
}

export function OntologyClassesHelp() {
  return (
    <>
      <p>
        A <strong>class</strong> is a kind of thing: a document, a batch, a test, a site. A table
        row or a document is mapped to a class, so the graph says what each thing is.
      </p>
      <h3>Hierarchy</h3>
      <p>
        <strong>Parents</strong> are broader classes and <strong>Children</strong> narrower ones: a
        "Stability report" may be a child of "Report". Pick the most specific class that fits every
        document of the type.
      </p>
      <h3>Connections</h3>
      <p>
        A class's details list the properties whose domain or range is that class (what can be said
        about it, and what points to it), and any shapes that check it.
      </p>
      <Browsing />
    </>
  );
}

export function OntologyPropertiesHelp() {
  return (
    <>
      <p>
        A <strong>property</strong> is a relationship or an attribute: "has batch number", "was
        tested at", "has result". Each field and column is mapped to a property.
      </p>
      <h3>Kinds</h3>
      <ul>
        <li>
          <strong>Datatype properties</strong> hold a plain value: a number, a date, some text. Map
          fields whose value is used as it is.
        </li>
        <li>
          <strong>Object properties</strong> point to another thing: an entity (a product, a site)
          or a concept from a controlled list.
        </li>
        <li>
          <strong>Annotation properties</strong> carry labels and notes about terms.
        </li>
      </ul>
      <h3>Domain and Range</h3>
      <p>
        The <strong>Domain</strong> is the class of thing the property describes; the{' '}
        <strong>Range</strong> is what its value is (a class, or a data type). Choose properties
        whose domain matches what the document or row is mapped to.
      </p>
      <Browsing />
    </>
  );
}

export function OntologyConceptsHelp() {
  return (
    <>
      <p>
        A <strong>concept</strong> is one entry in a controlled list (a dosage form, a test type, a
        storage condition), and a <strong>scheme</strong> is the list it belongs to.
      </p>
      <h3>Using concepts</h3>
      <p>
        A field or column whose value comes from a fixed list (an enum in the recipe) maps to a
        concept scheme, and each of its values to one concept, so "Tablet" in a document becomes the
        shared term for tablets rather than the word.
      </p>
      <h3>Hierarchy</h3>
      <p>
        Concepts can be broader or narrower than each other; the tree shows the scheme's top
        concepts first.
      </p>
      <Browsing />
    </>
  );
}

export function OntologyShapesHelp() {
  return (
    <>
      <p>
        A <strong>shape</strong> is a rule the data must follow, written in SHACL: "every batch has
        exactly one lot number", "a result's value is a number".
      </p>
      <h3>Using shapes</h3>
      <p>
        A recipe can pin shapes on its Mapping tab. Before a graph is published it is checked
        against them; a violation sends the job for review instead of publishing data that breaks
        the rules. The Workbench preview shows violations on your samples.
      </p>
      <h3>Targets</h3>
      <p>
        Each shape targets a class (or certain properties). A class's details list the shapes that
        target it.
      </p>
      <Browsing />
    </>
  );
}
