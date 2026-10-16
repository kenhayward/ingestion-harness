import { createRequire } from 'node:module';
import { md } from './zod.js';

const REPO = 'https://github.com/kenhayward/ingestion-harness/blob/main';
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

/** Every tag a route may use, with the concepts behind its area. */
export const TAGS = {
  Documents: md`
    Upload a PDF to process it with a document type. The API stores the file in the inbox
    bucket, records a document and queues a job; the worker does the rest.
  `,
  Jobs: md`
    A job processes one document with one version of a document type. Jobs move through
    \`queued\`, \`running\` and then \`succeeded\`, \`awaiting_review\`, \`needs_review\`
    (a processing problem for an operator), \`failed\` (after retries), \`rejected\` or
    \`cancelled\`. See the [job lifecycle](${REPO}/docs/architecture.md#job-lifecycle).`,
  'Review & steps': md`
    Jobs of document types with a review policy stop in \`awaiting_review\`. Reviewers read the
    draft outputs, record edits, then approve (the edited outputs are published) or reject
    (final). Each extraction step's run can be inspected and re-run.
  `,
  Results: md`
    Published outputs, read from the publishing target each was delivered to: the documents a job delivered, their
    values and their files.
  `,
  Specs: md`
    Document types as uploads see them: database recipes and the definitions loaded from the
    repository's \`specs/\` folder (legacy \`spec.yaml\` and \`template.yaml\`). Versions are
    immutable once published. An admin can retire a document type (hidden from new work, still
    readable; also on the Document types page) and unretire it (here only).
  `,
  Recipes: md`
    Transformation recipes: each document type's definition (outputs, sections, pipeline steps,
    review policy, default model), kept in the database. Drafts are editable, published versions
    are immutable. Recipes import and export as YAML. See
    [ADR 0003](${REPO}/docs/adr/0003-versioned-document-specs.md).`,
  'References & regression': md`
    References are verified output values for a sample PDF. Regression runs process the
    references' PDFs with a recipe version and score the outputs against them; metrics
    summarise a document type's runs.
  `,
  Models: md`
    Language models the worker discovered from the configured providers. Model refs are
    \`provider/model-id\` or an alias such as \`default\` or \`fast\`.
  `,
  'Projects & data policy': md`
    The Workbench builds a document type from sample PDFs, one project per type (the project id
    is the recipe id). A project's data policy decides whether its documents may be sent to
    external model providers (\`external\`) or only to local ones (\`local\`). See
    [ADR 0007](${REPO}/docs/adr/0007-workbench.md) and the
    [Workbench design](${REPO}/docs/design/workbench.md).`,
  'Samples & brief': md`
    Samples are the project's PDFs, each in the **dev** set (seen by drafting) or the
    **holdout** set (used only to score). Uploading a sample prepares its text (with OCR where
    needed). The brief describes what the document type must extract.
  `,
  'Drafting stages & proposals': md`
    A drafting model proposes the recipe in stages (survey, outputs, sections, steps), each a
    set of typed changes the user accepts in full or in part. Anchor previews check section
    anchors against the dev samples.
  `,
  'Test runs': md`
    Test runs process samples with the open draft. They are never delivered to the target.
  `,
  'Evaluation, iterations & comparisons': md`
    An evaluation runs the draft over a sample set and scores the outputs against the
    references; each evaluation is recorded as an iteration with a snapshot of the definition.
    Comparisons run several models over the same samples.
  `,
  'Feedback & revise': md`
    Feedback notes on dev samples and iterations, and the **revise** stage, which proposes
    changes from the open feedback and the latest evaluation failures.
  `,
  'Holdout & publish gate': md`
    Holdout reference runs and the publish gate: a version is published only when its newest
    holdout evaluation covers every ready holdout sample and scores at or above the project's
    threshold, unless an override reason is given.
  `,
  Bundles: md`
    Export a project as a zip bundle (samples, prepared text, brief, draft and drafting
    context) and import one as a new project.
  `,
  'Auth & sessions': md`
    Sign in with an email address and a password to get a session cookie (\`ih_session\`).
    Every \`/api\` route needs the session except sign-in, sign-out and these docs. See
    [ADR 0013](${REPO}/docs/adr/0013-email-password-users.md).`,
  Profile: md`
    Your own profile: name, job title, company and LinkedIn name, and a linked GitHub account
    (its picture is your picture in the app) with the repository recipe YAML will be stored in.
    The email address is changed by an admin.
  `,
  Users: md`
    Admins add people with a name, an email address and a one-time password, and can edit,
    disable, unlock or reissue them, and read recent sign-ins. The admin from the API log signs
    in as \`admin\` with the token the API prints on every start.
  `,
  'Data-lake S3 keys': md`
    Read-only S3 credentials for data-lake consumers of the publish bucket. Secrets are shown
    once. See [ADR 0008](${REPO}/docs/adr/0008-s3-read-keys.md).`,
  Ontologies: md`
    The ontology library: customer and industry ontologies (OWL/RDFS, SKOS, SHACL) that
    document types map their outputs to. Admins import a file as a new immutable version;
    the worker parses it and indexes its terms, which anyone signed in can browse. See
    [ADR 0011](${REPO}/docs/adr/0011-rdf-publishing-and-ontologies.md).`,
  'Linked data': md`
    The deployment's customer and the base IRI its RDF is minted under (ADR 0011). One
    customer per deployment; without their own base, IRIs live under
    \`https://id.stocks-hayward.com/<customer>/\`.
  `,
  'Published outputs': md`
    Publishing targets: the S3 buckets published outputs are delivered to. Each recipe names one
    (\`delivery.publishTo\`, absent = \`default\`, seeded from \`.env\`); every delivered output
    records its target, so it is read and withdrawn there whatever changes later. A target in
    use keeps its bucket, prefix, endpoint and region.
  `,
  GitHub: md`
    Syncing transformation recipes with a GitHub repository: this deployment's instance name
    and default folder, a document type's repository link, and pushing a published version
    as a YAML file with the signed-in user's own linked GitHub account. Admins set the
    settings and links; anyone with a linked account can push.
  `,
  Health: md`
    Liveness and readiness checks for load balancers and orchestrators. They need no session.
  `,
} as const;

export type Tag = keyof typeof TAGS;

export const TAG_GROUPS: { name: string; tags: Tag[] }[] = [
  { name: 'Pipeline', tags: ['Documents', 'Jobs', 'Review & steps', 'Results'] },
  {
    name: 'Configuration',
    tags: ['Specs', 'Recipes', 'References & regression', 'Models', 'Ontologies'],
  },
  {
    name: 'Workbench',
    tags: [
      'Projects & data policy',
      'Samples & brief',
      'Drafting stages & proposals',
      'Test runs',
      'Evaluation, iterations & comparisons',
      'Feedback & revise',
      'Holdout & publish gate',
      'Bundles',
    ],
  },
  {
    name: 'Administration',
    tags: [
      'Auth & sessions',
      'Profile',
      'Users',
      'Data-lake S3 keys',
      'Published outputs',
      'Linked data',
      'GitHub',
      'Health',
    ],
  },
];

const DESCRIPTION = md`
  Content Transformation Studio (CT Studio) extracts the contents of PDFs whose structure is known
  in advance and publishes them as validated CSV and JSON. This API is what the web app uses.

  ## Signing in

  Every \`/api\` route needs a session except \`POST /api/auth/login\`, \`POST /api/auth/logout\`
  and these docs. Sign in with your email address and password; the response sets the
  \`ih_session\` cookie, which the browser sends with every request. Signed out, a guarded route
  answers \`401\` \`{ "error": "sign in required" }\`. A session opened with a one-time password
  can only read \`GET /api/auth/me\` and change the password (\`PUT /api/auth/password\`); every
  other guarded route answers \`403\` \`{ "error": "change your one-time password first" }\`.
  "Try it" in these docs uses your session when you are signed in to the app in the same
  browser.

  A request that changes something (\`POST\`, \`PUT\`, \`PATCH\`, \`DELETE\`) and that the
  browser marks as sent from another site's page (\`Sec-Fetch-Site: cross-site\`) is refused
  with \`403\` \`{ "error": "cross-site request refused" }\`, signing in included. Scripts and
  other clients that send no \`Sec-Fetch-Site\` are unaffected.

  ## Errors

  Errors are JSON: \`{ "error": "message" }\`, or \`{ "error": [ ...Zod issues ] }\` for some
  validation failures. IDs are UUIDs; a malformed ID is a \`404\`, the same as an unknown one.

  ## Admin routes

  Routes marked **Admins only** (\`x-admin: true\`) answer \`403\`
  \`{ "error": "admins only" }\` to a user who is not an admin.
`;

export const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'Content Transformation Studio API', version, description: DESCRIPTION },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      session: {
        type: 'apiKey',
        in: 'cookie',
        name: 'ih_session',
        description: 'Session cookie set by `POST /api/auth/login`.',
      },
    },
  },
  security: [{ session: [] }],
  tags: Object.entries(TAGS).map(([name, description]) => ({ name, description })),
  'x-tagGroups': TAG_GROUPS,
} as const;
