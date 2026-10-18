/** Help for the Ontologies page's Remembered mappings (docs/design/mapping-memory.md). */
export function OntologyMemoryHelp() {
  return (
    <>
      <p>
        Every time a designer accepts a mapping in a recipe (applying a mapping proposal, saving the
        Mapping tab, or publishing), CT Studio remembers the answer for that kind of output: what it
        was called, its type and unit, and how it was mapped. The next recipe with an output worded
        the same gets that answer offered first.
      </p>
      <h3>How the mapping stage uses it</h3>
      <p>
        An output whose wording matches a remembered answer exactly is mapped before the model is
        asked, and the proposal card says so (<em>Remembered · N recipes</em>). It is pre-selected
        at high confidence when a designer confirmed it here or two recipes agree, at medium when
        one recipe accepted it. Similar wording only gives the model a hint and puts the remembered
        term among its candidates.
      </p>
      <h3>Refusing</h3>
      <p>
        You refuse a remembered answer in the mapping itself: leave its change unselected when you
        apply a proposal, or link the output to something else (or remove the mapping) later. An
        answer refused in more recipes than accepted it is no longer pre-selected.
      </p>
      <h3>Reviewing here</h3>
      <p>
        <strong>Needs review</strong> lists what recipes taught it that nobody has vouched for.
        <strong> Confirm</strong> an answer to make it the one pre-selected; <strong>Edit</strong>{' '}
        corrects it (and confirms it); <strong>Reject</strong> stops it being offered for such
        outputs. <strong>Delete</strong> only forgets it until a recipe that still maps an output
        this way is saved again, so rejecting is usually what you want. An entry is marked when one
        of its terms is missing or deprecated in the newest version of its ontology.
      </p>
      <h3>What it keeps</h3>
      <p>
        Only recipe structure: output names, descriptions, types and the terms chosen, never
        anything from a document. Wording from a local-only project is never sent to an external
        model.
      </p>
    </>
  );
}
