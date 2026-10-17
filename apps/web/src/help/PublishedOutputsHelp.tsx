/** Help topic `published-outputs`: publishing targets, what they are and how they change. */
export function PublishedOutputsHelp() {
  return (
    <>
      <p>
        A <strong>publishing target</strong> is a place published outputs are delivered to: a bucket
        and a folder (prefix) in it. Each recipe delivers to exactly one target.
      </p>

      <h3>Internal and external</h3>
      <p>
        An <strong>Internal</strong> target is a bucket on this deployment&apos;s own S3 storage;
        the bucket is created when you add it, and no keys are needed. An <strong>External</strong>{' '}
        target is an S3 bucket elsewhere, reached with its own access key and secret, which are
        stored encrypted and never shown again. Use <em>Test connection</em> to write, read and
        delete a small file before relying on it.
      </p>

      <h3>The default target</h3>
      <p>
        <code>default</code> is created once from the deployment&apos;s <code>.env</code> on first
        start. Recipes that name no target deliver there. After that, what you change here wins over{' '}
        <code>.env</code>, and <code>default</code> can be edited but never removed.
      </p>

      <h3>Choosing a target for a recipe</h3>
      <p>
        A recipe names its target on its General tab. The choice is part of the recipe, so it
        changes only with a new version: published versions keep delivering where they did.
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
        its bucket, prefix, endpoint and region are locked: add a new target and publish a new
        version of the recipe instead. The label, keys and encryption settings can always change, so
        a rotated key needs no new version. A target that is in use cannot be removed.
      </p>

      <h3>S3 keys for the data lake</h3>
      <p>
        Read-only S3 keys for data lake consumers (Administration, Integration) are granted per
        internal target, so a consumer sees only the outputs of the targets it was given.
      </p>
    </>
  );
}
