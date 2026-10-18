/** Help topic `mapping`: mapping outputs to ontology terms for RDF delivery. */
export function MappingHelp() {
  return (
    <>
      <p>
        A mapping says what each output means in terms of a shared vocabulary (an ontology), so
        publishing can also deliver the results as a linked-data graph (RDF). It is only needed when
        RDF is one of the delivered formats; CSV and JSON never use it.
      </p>

      <h3>Outline and editor</h3>
      <p>
        The list on the left holds everything to map: the setup, every field, every table with its
        columns, local terms and (in the Workbench) the preview. A green dot is mapped, an amber one
        started but unfinished, a grey one not mapped yet. Pick an item to edit it on the right; ‹
        and › step to the previous or next one. <strong>Find a …</strong> searches the pinned
        ontologies right under the field.
      </p>
      <p>
        Terms show by their readable name: the list says <em>has analyte</em> rather than an id like
        af-x:AFX_0000117 (point at it to see the term), and each term box says under it which
        pinned ontology or local term names it, and whether it is deprecated. When no pinned
        ontology or local term has the term, or its prefix is not declared, the box says so.
      </p>

      <h3>Ontologies</h3>
      <p>
        The ontologies whose terms the mapping may use, pinned to a version from the Ontologies
        library. The Workbench survey suggests which to pin.
      </p>

      <h3>Shapes</h3>
      <p>
        Optional rule sets (SHACL) the delivered graph must satisfy, such as "every batch has
        exactly one lot number". A violation sends the job for review instead of publishing a graph
        that breaks the rules.
      </p>

      <h3>Prefixes</h3>
      <p>
        Short names for long addresses (<code>acme:</code> for{' '}
        <code>https://acme.example/def/</code>), used to write terms compactly.
      </p>

      <h3>Document</h3>
      <p>
        The class of thing each document is (a stability report, an invoice) and, optionally, how
        its address is built from its values.
      </p>

      <h3>Fields</h3>
      <p>Each field maps to a property, and its value is one of:</p>
      <ul>
        <li>
          <strong>a literal</strong>: the value itself, such as a number, date or text.
        </li>
        <li>
          <strong>an entity</strong>: a thing in its own right (a product, a site), with a class and
          an address template built from the value.
        </li>
        <li>
          <strong>a concept</strong>: one entry of a controlled list, such as a dosage form, chosen
          from a concept scheme; an enum's values each map to a concept.
        </li>
      </ul>

      <h3>Tables</h3>
      <p>
        Each row becomes a thing of the row class, linked from the document by a property, with its
        columns mapped like fields. A row address template is optional.
      </p>

      <h3>Local terms</h3>
      <p>
        Terms you define for this recipe when the pinned ontologies have nothing suitable: an
        address and a label. Prefer an ontology term when one fits.
      </p>

      <h3>Preview</h3>
      <p>
        In the Workbench, the preview builds the graph from your samples, so you can see the triples
        and any rule violations before publishing.
      </p>
    </>
  );
}
