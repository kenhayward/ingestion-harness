# Publishing targets: design

Status: agreed in conversation 2026-10-16, ready for review, not yet planned. Replaces the single `.env` publish
target (`TARGET_S3_*`, read by `apps/api/src/config.ts` `targetConfig` and
`worker/src/ingest_worker/config.py`) with a list of targets that admins manage and recipes name.

## Intent

Today every published output of every document type goes to one bucket, fixed in `.env` and
read once when the API and worker start. Changing it means editing `.env` and redeploying. Over
time, different recipient systems want their own buckets: an internal one per recipient, reached
with that recipient's read-only S3 keys, or an external Amazon S3 bucket the recipient owns.

So:

- admins keep a list of **publishing targets** in the database, edited in the app;
- each **document type's recipe names its target**, so where a type delivers is part of the
  versioned recipe and changes only with a new published version (an audit trail, and the same
  "published versions never change" rule as everything else in a recipe);
- outputs already delivered stay findable where they went, whatever changes later.

## Goals

- Administration gets a **Published outputs** tab listing the targets: add, edit, test, remove.
  RDF publishing settings will join this tab later (not in this cut).
- Two kinds of target:
  - **Internal**: a bucket on this deployment's SeaweedFS. Bucket name and optional prefix only;
    no endpoint or credentials (the deployment's own `S3_*` are used); the bucket is created if
    missing.
  - **External**: an Amazon S3 bucket or any S3-compatible store, with every setting such a
    bucket needs (below).
- A recipe names its target in YAML and on the General tab; one target per document type.
- Publishing (the worker), Results, withdrawal and republish all use the target an output was
  delivered to.
- The data lake's read-only S3 keys (ADR 0008) are granted per internal target, so each
  recipient system sees only its own buckets.
- Nothing changes on upgrade: today's `.env` target becomes the `default` target, and every
  recipe that names none keeps delivering there.

## Non-goals

- Several targets for one document type (different outputs or formats to different buckets).
  Revisit with RDF publishing if asked for.
- RDF / triple store settings on the new tab (later).
- Moving or copying already delivered outputs between targets.
- Read-only S3 keys for external targets (they are issued by our SeaweedFS).

## Anti-goals

- A published version's deliveries changing destination without a new version. Hence the
  `default` target is a fixed id, not "whichever target is marked default" (see Decisions).
- Losing track of delivered outputs: Results, withdrawal or republish looking in the wrong place
  after a target is edited.
- Secrets readable back through the API, in logs, or in the recipe.
- Publishing blocked or broken for existing deployments by the upgrade.

## Decisions

### The target list

- Table `publish_targets` (forward-only migration, next free number): `id` (the same id rule as
  model choices, made from the label when not given; `default` reserved for the seeded one),
  `label`, `kind` `internal|external`, `bucket`, `prefix` (default `''`), and for external ones:
  - `endpoint` (blank = AWS's regional endpoint for the region);
  - `region` (required for external);
  - `access_key_id` and the secret access key, the secret encrypted under `LLM_SECRETS_KEY` like
    LLM endpoint keys (`apps/api/src/llm/secrets.ts` encrypts, `llm/secrets.py` decrypts; 409
    `LLM_SECRETS_KEY is not set: the API cannot store keys` without it), never returned (`keySet`);
    an optional session token is out of scope;
  - `force_path_style` (on for most non-AWS stores, off for AWS);
  - server-side encryption: none, `AES256` (S3-managed) or `aws:kms` with an optional KMS key id;
  - storage class (optional; e.g. `STANDARD`, `STANDARD_IA`, `INTELLIGENT_TIERING`);
  - `source` `env|ui`, `edited_at`, `updated_by`, `created_at`.
- **Default target.** On start the `.env` target is seeded as id `default` (label "Default"):
  internal when `TARGET_S3_ENDPOINT` is blank or equals `S3_ENDPOINT`, else external with the
  `TARGET_S3_*` values, its keys read from `.env` (shown as "Keys from .env", not stored). As with
  LLM endpoints, an admin's edit wins and `.env` stops changing it. `default` cannot be removed or
  renamed (its label may change).
- **Locking.** While any published recipe version names a target, or any delivered output
  (`job_outputs`, graph versions) records it, its kind, endpoint, region and bucket cannot
  change (409 naming what uses it). It can still be removed (2026-10-28: a target whose
  repository or bucket was deleted only ever fails, and published versions stay published): a
  version naming a removed target sends its documents to review, and a withdrawal skips what was
  delivered to it. Only an S3 key consumer's grant or a queued or running withdrawal blocks
  removal. Prefix also locks (keys
  are recorded with the prefix applied, so changing it would only affect new deliveries; locking
  is simpler and clearer). Label, credentials, path style, encryption and storage class stay
  editable, so rotating a key never needs a new version. To move a type: add a target, publish a
  new version naming it.
- **Test connection** (admins): writes a small object under the target's prefix, reads it back
  and deletes it; the answer says which step failed in plain words (unreachable,
  access denied, no such bucket, wrong region). Also offered before saving a new target.

### On the recipe

- New optional field on the template definition's `delivery` block naming the target id
  (`packages/shared/src/template.ts` `DeliverySchema` and the worker's `Delivery`, both sides in
  the same PR). Absent = `default`. The existing `DELIVERY_TARGETS` (S3 / RDF switches) keep
  their meaning; the builder picks a field name that does not clash with them.
- General tab: a *Publish to* picker (label, kind, bucket) for any user who can edit the recipe.
  The list comes from a non-admin route giving id, label, kind and bucket only.
- `templateIssues` adds an issue at that path when the named target does not exist on this
  deployment; it blocks publishing (Templates publish, import with `publish: true`, Workbench
  publish), like an unknown model choice. This matters for recipes imported from another
  deployment through GitHub sync or bundles.
- Legacy `spec.yaml` types always deliver to `default`.
- **Target ids name recipients, not buckets** (agreed). A recipe's target id travels with it
  through GitHub sync, YAML export and bundles unchanged. Each deployment defines its own target
  under that id: dev's `finance-lake` points at a dev bucket, production's at the real one, so a
  recipe moved from dev to production delivers to production's bucket with no edit. An import
  never drops or rewrites the id; when this deployment has no target with it, the imported draft
  carries the publishing issue until an admin adds the target or someone picks another on the
  General tab. The Published outputs help says so, and the target form's id hint says to use the
  same id on every deployment for the same recipient. (A recipe naming no target hashes as
  before, so `definitionSha256` of existing recipes does not move.)

### Delivery records

- `job_outputs` gets the target id (migration backfills `default` for every existing published
  row). Graph version copies (`storage.graph_version_key`) go to the recipe's target too and
  record it the same way (the builder finds where: `published_graph_versions` or the event).
- The worker resolves the recipe version's target at publish time, from the database, and
  records it. Results (`storeFor`), job output downloads, withdrawal (`run_withdraw`) and
  republish read each output from its recorded target. Republish delivers to the target recorded
  for the job's recipe version (the version's own target, which never changed).
- The worker builds target stores from the database (like `LiveModels` for LLM endpoints): read
  on start and refreshed when the table's version moves, so a key rotation needs no restart. The
  API does the same for reads. Both cache clients per target.

### Internal buckets and S3 keys

- Saving an internal target creates its bucket on SeaweedFS if missing (the API, with the
  deployment's `S3_*` credentials).
- A data lake consumer (`s3_consumers`) is granted one or more internal targets; its SeaweedFS
  policy reads exactly those buckets (and prefixes). The migration grants every existing
  consumer the `default` target when it is internal, so their keys keep working. The reconciler
  rewrites policies when grants change. The S3 keys section shows each consumer's targets and
  stays where it is today (Administration > Integration).
- `s3KeysConfig`'s "only when the target is the local SeaweedFS" becomes "offered when at least
  one internal target exists".

### The tab

Administration > **Published outputs** (`AdminDialog` tab, admins), main button *Add target* in
the header (`InSlot`). Targets are rows like the Models tab's endpoints: label, id, kind tag
(Internal / External), bucket and prefix, "used by n document types", where the settings came from
(from .env / edited by / added here by). Opened: the settings form (external fields shown only
for External), *Test connection*, *Remove* (confirm; disabled with the reason while in use). A
help topic (`HELP_TOPICS`, `<HelpButton>`) explains targets, the default, why a type's target
only changes with a new version, locking, and S3 keys per target.

## Constraints

- Forward-only migrations; routes documented (OpenAPI, `x-admin`); Zod at the boundary; shared
  schemas in `packages/shared`.
- Cross-language contract: the target schema, the recipe field and the delivery record are read
  by both API and worker; add a row to CLAUDE.md's contracts table and a shared fixture for the
  recipe field and the secret format (the existing `llm-secret.json` pattern).
- Tests stay offline: S3 through the existing `ObjectStore` ports and `MemoryObjectStore`; the
  S3 key issuer through `MemoryS3KeyIssuer`; *Test connection* through a port with a fake.
- Operators cannot reach any of the new routes (`operatorMayCall` stays closed).
- `TARGET_S3_*` keep working as the seed for `default`; `.env.example` and the deploy docs say so.

## Calls made after the builder check (mine, for review)

- **Seeding `default`:** `.env` seeds it once, when the row does not exist (first start after the
  upgrade). From then on the database wins; if `.env`'s `TARGET_S3_*` later differ from the stored
  `default`, the API and worker log a warning on start and change nothing (following `.env` would
  silently move deliveries of locked versions). This differs from LLM endpoints on purpose.
- **Internal vs external `default`:** seeded internal only when `TARGET_S3_ENDPOINT` is blank or
  equal to `S3_ENDPOINT` *and* its keys are blank or equal to `S3_*`; otherwise external (endpoint,
  region and keys from `.env`), so the identity that writes never changes on upgrade. Internal
  targets always write with the deployment's `S3_*`.
- **Prefix:** applied at write time and part of the recorded `object_key`, as today
  (`pipeline.py` prepends `target.prefix`). Readers use the recorded bucket and key as they are,
  through the client of the recorded target; the backfill only adds the target id. Graph version
  copies, whose key is computed from the prefix today, record their target so withdrawal and
  rebuilds use that target's prefix.
- **Recorded wins:** for anything already delivered, the recorded target id, bucket and key are
  authoritative; the target row gives only the client (endpoint, credentials, encryption).
- **Which version decides:** the job's recipe version (`specVersion`), at publish time. A publish
  queued under v3 delivers to v3's target even after v4 is published. Draft test runs deliver
  nothing and never touch a target. Remint, backfill and republish write to the target of the
  job's version.
- **"In use":** a published version's definition naming the target (absent = `default`, so
  `default` is always in use), a delivered output or graph copy recording it, or an S3 key
  consumer granted it. Drafts do not count: a draft naming a removed target gets the publishing
  issue.
- **S3 key grants:** edited on the consumer in the S3 keys section (a list of internal target ids,
  at least one); whole targets (their bucket and prefix), no finer subsets. The migration grants
  existing consumers `default` (they can only exist while the target is local, which is when
  `default` seeds as internal); the reconciler rewrites their policies on its first run.
- **Test connection** runs in the API (it serves the form; the worker and API share a host and
  network in our deployments). A secret sent for testing is never logged or echoed; leaving the
  secret blank on an existing target tests with the stored one.

## Left to the builder

- Exact table and column names, the recipe field name, and the target id rule.
- How the worker and API notice target changes (version counter + NOTIFY like
  `llm_config_state`, or a poll).
- Where graph versions record their target.
- The SeaweedFS policy shape for several buckets.
- Help wording.
