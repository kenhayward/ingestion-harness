/** Help topic `yaml`: the whole recipe as YAML. */
export function YamlHelp() {
  return (
    <>
      <p>
        The YAML tab shows the whole recipe as text: every setting from the other tabs, in one
        place. It is handy for edits across many outputs or steps at once, for copying settings
        between recipes, and for keeping a recipe in version control.
      </p>

      <h3>Apply YAML</h3>
      <p>
        Edits here change nothing until you press <strong>Apply YAML</strong>: the text is checked
        and, if it is valid, replaces what the other tabs show. Then save the draft as usual. Text
        that does not parse, or a recipe that breaks a rule (an unknown section, an output no step
        fills), is reported and nothing is replaced.
      </p>

      <h3>Ids and keys</h3>
      <p>
        Ids are lowercase. Keys left out take their defaults (for example <code>required</code> is
        true and <code>repeat</code> is false), so a short recipe stays short.
      </p>

      <h3>Import and export</h3>
      <p>
        The export button above the tabs downloads the recipe as a file. On the Document types page
        a YAML file can be imported as a new draft.
      </p>
    </>
  );
}
