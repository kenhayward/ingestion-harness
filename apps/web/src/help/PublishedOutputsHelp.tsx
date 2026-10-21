/** Help topic `published-outputs`: publishing targets, what they are and how they change. */
export function PublishedOutputsHelp() {
  return (
    <>
      <p>
        A <strong>publishing target</strong> is a place published outputs are delivered to: a bucket
        and a folder (prefix) in it. A recipe delivers to one target or to several.
      </p>

      <h3>Files or an archive</h3>
      <p>
        A target&apos;s <strong>Layout</strong> says how it writes what it is given. With{' '}
        <strong>Files</strong> each output lands at its own key, as before. With{' '}
        <strong>Archive (whole package)</strong> the target keeps each publication whole, under{' '}
        <code>packages/&lt;key&gt;/</code>: every file, the fields and tables as{' '}
        <code>data.json</code>, the graph as <code>graph.ttl</code>, and <code>package.json</code>{' '}
        describing them, written last. Publishing the same file under the same recipe version again
        replaces it. Results and downloads read from a Files target, so a recipe that delivers to an
        archive also names one.
      </p>

      <h3>Internal and external</h3>
      <p>
        An <strong>Internal</strong> target is a bucket on this deployment&apos;s own S3 storage;
        the bucket is created when you add it, and no keys are needed. An <strong>External</strong>{' '}
        target is an S3 bucket elsewhere, reached with a <strong>connection</strong>: its endpoint,
        region and keys. Connections live on the delivery bridge, not in CT Studio: open{' '}
        <em>Manage connections</em> to add one, rotate its keys or see why it needs attention, then
        pick it here. CT Studio never sees a secret. Use <em>Test connection</em> to write, read and
        delete a small file before relying on a target.
      </p>

      <h3>Where credentials went</h3>
      <p>
        After the upgrade that added the delivery bridge, the keys each external target held were
        moved to a connection named after the target, and keys read from <code>.env</code> became a
        connection that reads the same variables on the bridge. Nothing to do: deliveries carry on
        to the same buckets and keys.
      </p>

      <h3>The default target</h3>
      <p>
        <code>default</code> is created once from the deployment&apos;s <code>.env</code> on first
        start. Recipes that name no target deliver there. After that, what you change here wins over{' '}
        <code>.env</code>, and <code>default</code> can be edited but never removed.
      </p>

      <h3>The triple store</h3>
      <p>
        When the deployment has a triple store (<code>RDF_ENDPOINT</code> in its <code>.env</code>),
        it is listed here as <strong>Triple store</strong> (<code>rdf-default</code>). Recipes that
        deliver RDF load their graphs into it as well as delivering to their own target; no recipe
        names it. Only its label can change here; its credentials are a connection under{' '}
        <em>Manage connections</em>.
      </p>

      <h3>Choosing a target for a recipe</h3>
      <p>
        A recipe names its targets on its General tab. The choice is part of the recipe, so it
        changes only with a new version: published versions keep delivering where they did. Each job
        shows how its delivery to every target went; a job is published once every target has it.
      </p>

      <h3>Ids name recipients</h3>
      <p>
        The id is what recipes carry, for example <code>finance-lake</code>. Use the same id on
        every deployment for the same recipient, so a recipe copied between deployments delivers to
        the right place there.
      </p>

      <h3>Locked once in use</h3>
      <p>
        While a published recipe version, a delivered output or an S3 key consumer uses a target,
        its bucket, prefix and layout are locked: add a new target and publish a new version of the
        recipe instead. The label, connection and encryption settings can always change, so rotated
        keys need no new version. A target that is in use cannot be removed.
      </p>

      <h3>S3 keys for the data lake</h3>
      <p>
        Read-only S3 keys for data lake consumers (Administration, Integration) are granted per
        internal target, so a consumer sees only the outputs of the targets it was given.
      </p>
    </>
  );
}
