# API docs: an OpenAPI reference for the API

**Status:** design · 2026-10-13 · approved in conversation

The API has about 95 routes in 13 route plugins (`apps/api/src/app.ts`), more than half of them in
the Workbench. The only description of them today is the code and `CLAUDE.md`. This design adds
an OpenAPI 3.1 document generated from the routes themselves, and a public docs browser at
`/api/docs` that groups the calls by area and describes each one in full. The app links to it.

## Goals and non-goals

**Goals**
- Every route has a summary, a full description, typed parameters and body, every response it
  can send (success, errors, binary downloads), and whether it needs a session or the admin
  token.
- Calls are grouped by area (pipeline, configuration, Workbench, administration) so a reader can
  find a call without knowing the code.
- The docs cannot drift: a route without docs, or a response that does not match its documented
  schema, fails CI.
- The docs are public and linked from the app (the nav and the sign-in page).

**Non-goals**
- Changing request validation or error bodies. Handlers keep their `safeParse` calls and their
  exact error messages (see "No runtime behaviour change").
- A generated TypeScript client. The web keeps its hand-written `Api` port.
- Documenting the worker or the S3 key layout beyond what the API serves.

## Current state

- Validation is inside handlers: `const body = X.safeParse(req.body); if (!body.success) return
  reply.code(400).send({ error: ... })`. No route declares a Fastify `schema`.
- Request schemas are mostly local to route files (`ListQuery`, `RetryBody`, `CleanupBody`, …);
  some live in `@ih/shared` (`PublishBodySchema`, `ChangeBodySchema`, `FeedbackBodySchema`,
  `SurveyBodySchema`, …).
- Most response DTOs are TypeScript interfaces only (`JobSummary`, `ProjectSummary`, `SampleView`,
  `IterationView`, `ExportView`, `GateView`, …).
- Errors are always `{ error: string | ZodIssue[] }`.
- Auth (ADR 0006): a session cookie (`ih_session`) on every `/api/*` route except
  `/api/auth/login|logout`, decided on the matched route pattern; about 10 routes add an
  `adminOnly` pre-handler, and some Workbench routes need the admin token only for local-only
  projects.
- Non-JSON routes: multipart uploads (documents, samples, template import, bundle import with
  `id`/`name` fields before the file), binary downloads (PDF, page PNG, results archive, bundle
  zip) and YAML export.
- Zod is 3.25.76.

## Approach

Route docs sit next to each handler as a Fastify route `schema`. `@fastify/swagger` collects them
into an OpenAPI 3.1 document, converting Zod with `fastify-type-provider-zod`'s
`jsonSchemaTransform` (on the major version that supports Zod 3). `@scalar/fastify-api-reference`
serves the browser.

Rejected:
- **A separate `zod-to-openapi` registry**: no change to route files, but docs live away from the
  handlers and drift.
- **A hand-written YAML spec**: drifts fastest; 95 routes is too many to maintain by hand.
- **Fastify validation from the same schemas now**: worthwhile later, but it changes every 400
  body. Kept out of this work.

### No runtime behaviour change

Declaring `schema.body` or `schema.response` normally makes Fastify validate requests and
serialise responses with `fast-json-stringify`, which drops fields the schema does not list. To
keep behaviour identical, `buildApp` installs:

- a pass-through validator compiler (`() => (data) => ({ value: data })`): the handlers'
  `safeParse` stays the source of truth for validation and error messages;
- a serializer compiler that is plain `JSON.stringify`: a response schema can never drop a field.

The docs therefore describe behaviour but cannot enforce it at runtime. Tests do that (see
"Keeping the docs true").

### Route docs

Each route gets:

```ts
app.post<{ Params: { id: string } }>('/jobs/:id/retry', {
  schema: {
    tags: ['Jobs'],
    operationId: 'retryJob',
    summary: 'Retry a job',
    description: md`
      Re-queues a failed, cancelled or needs-review job. ...
      **Model:** a model ref sets the job's override, \`null\` clears it, absent keeps it.`,
    params: JobIdParams,
    body: RetryBody,
    response: { 200: JobSummarySchema, 400: ErrorBody, 404: NotFound, 409: Conflict('...') },
  },
}, async (req, reply) => { /* unchanged */ });
```

- `summary`: under 60 characters, imperative ("Retry a job").
- `description`: Markdown. What the call does, when to use it, side effects (jobs queued, objects
  written, events logged), and every rule that gives a non-2xx status, with the exact error
  message. The rules now spread across `CLAUDE.md` (data policy, publish gate, reference pinning,
  export staleness) move here, and `CLAUDE.md` links to the docs where it repeats them.
- `operationId`: unique camelCase, matching the web `Api` port's method name where one exists.
- A small `md` tag strips common indentation so long descriptions stay readable in the source.

Request schemas that are local to a route file stay there and are passed to `schema`; they are
not moved unless the web needs them.

### Response schemas

Response DTOs get Zod schemas in `@ih/shared` next to their interfaces (`JobSummarySchema` next to
`JobSummary`, …). The interfaces stay, so no consumer changes. A type test pins each pair:

```ts
expectTypeOf<z.infer<typeof JobSummarySchema>>().toEqualTypeOf<JobSummary>();
```

Shared components, in `apps/api/src/openapi/components.ts`:

| Component | Shape |
| --- | --- |
| `ErrorBody` | `{ error: string \| ZodIssue[] }` |
| `NotFound` | 404 `ErrorBody`, "not found" |
| `SignInRequired` | 401 `{ error: 'sign in required' }`, added to every guarded route automatically |
| `AdminOnly` | 403 `{ error: 'admins only' }` |
| `Conflict(message)` | 409 `ErrorBody` with the exact message in the description |
| `PdfFile`, `PngImage`, `ZipFile`, `YamlFile` | binary or text bodies with their content type |
| `MultipartUpload(fields)` | `multipart/form-data` with field order noted when it matters |

### Groups

Tags, gathered with `x-tagGroups` (Scalar shows these as sidebar sections):

| Group | Tags |
| --- | --- |
| **Pipeline** | Documents · Jobs · Review & steps · Results |
| **Configuration** | Specs · Templates · References & regression · Models |
| **Workbench** | Projects & data policy · Samples & brief · Drafting stages & proposals · Test runs · Evaluation, iterations & comparisons · Feedback & revise · Holdout & publish gate · Bundles |
| **Administration** | Auth & sessions · Access tokens · Data-lake S3 keys · Health |

Each tag has a description of a paragraph or two: the concepts behind the area (for example, what
a Workbench project, a dev or holdout sample and an iteration are), with a link to the relevant
ADR or design doc on GitHub.

The document's top-level `info.description` covers sign-in, the error body, IDs (UUIDs; an
invalid one is a 404), pagination, and how jobs move through their statuses.

### Security in the document

- `components.securitySchemes.session`: `apiKey` in cookie `ih_session`. Applied globally;
  `/api/auth/login`, `/api/auth/logout` and the docs routes set `security: []`.
- Admin-only routes carry `x-admin: true` and start their description with **Admin token
  required.** A sweep test checks the flag against behaviour (see "Keeping the docs true").
- Routes where the admin requirement depends on the project's data policy (bundle export and
  download) say so in the description, with the 403.
- The document has no deployment details: `servers: [{ url: '/' }]`, no bucket names, hosts or
  env values.

## The docs browser

- `GET /api/openapi.json`: the generated document, built once on first request and cached.
- `GET /api/docs` (and its asset routes): Scalar, with assets bundled in the package (no CDN).
  Configured with the `x-tagGroups`, light/dark following the OS, colours taken from
  `apps/web/src/styles/tokens.css`, and "Try it" sending requests to the same origin, so the
  session cookie applies when the reader is signed in. Signed out, a guarded call gets a 401,
  which the docs explain.
- Both sit under `/api/`, so nginx's `location /api/` and Vite's dev proxy already route them.
  The security headers (`frame-ancestors 'none'`, no framing) do not get in Scalar's way.

### Public routes

The docs are public. The access hook changes from a path list to a route flag:

- a route is public when its `config.public` is `true`;
- login and logout set it on their routes;
- the docs plugin is registered in its own encapsulated context with an `onRoute` hook that sets
  `config.public = true` on every route it registers (Scalar's asset routes included), so we do
  not depend on Scalar's internal route names.

The hook still decides on the matched route, never the raw URL, so the path-handling tests in
`access.test.ts` keep passing unchanged. The sweep test changes from "every `/api` route except
login and logout" to: the public routes are exactly login, logout, `/api/openapi.json` and the
routes under `/api/docs`; every other `/api` route returns 401 without a session. ADR 0006 gets an
addendum recording the public docs.

The document describes the API that is already in a public repository, so making it public
exposes nothing new. It never includes tokens, examples taken from real data, or deployment
details.

## App link

- Side nav (`apps/web/src/shell/AppShell.tsx`): an **API docs** link at the bottom of the nav,
  visible to everyone signed in, `href="/api/docs"`, opening in a new tab
  (`target="_blank" rel="noopener"`) with an external-link icon from `apps/web/src/ui/`.
- Sign-in page: a small "API docs" link under the form, since the docs need no session.
- Tests (Testing Library, by role and name): both links exist with `href="/api/docs"`.

## Keeping the docs true

1. **Docs sweep** (`apps/api/test/openapi.test.ts`): every route Fastify registers (collected with
   an `onRoute` hook in `buildApp`) has `tags` from the known list, a `summary`, a `description`
   of at least 80 characters, an `operationId`, and a 2xx response. During rollout, an explicit
   allow-list names the undocumented routes; it only shrinks, and the last PR deletes it.
2. **Response conformance**: a helper in `apps/api/test/helpers.ts`,
   `expectDocumented(app, res)`, looks up the route's documented schema for the status code and
   validates the body with Ajv. `app.inject()` calls in the existing route tests go through it,
   so every response the suite already exercises is checked against the docs, error bodies
   included. A status code the route does not document fails.
3. **Valid document**: the generated document passes `@apidevtools/swagger-parser` validation,
   `operationId`s are unique, and every tag belongs to a group.
4. **Committed snapshot**: `docs/openapi.json` is generated by `npm run openapi` and checked in
   `npm run check` (regenerate and compare), so API changes appear in PR diffs.
5. **Admin flag sweep**: signed in with a user (non-admin) token, every route returns 403
   `admins only` exactly when its `x-admin` is true. This tests behaviour rather than how the check
   is wired (the `adminOnly` pre-handler in `access/routes.ts`, the plugin hook in
   `routes/s3-keys.ts`).

## Rollout

Each PR is red-tests-first and leaves `npm run check` green.

1. **Infrastructure**: dependencies, pass-through compilers, components, `/api/openapi.json`,
   Scalar at `/api/docs`, public route flag + sweep change + ADR 0006 addendum, docs sweep with a
   full allow-list, conformance helper, snapshot, app links. Documents Health and Auth.
2. **Pipeline**: Documents, Jobs, Review & steps, Results, Models.
3. **Configuration**: Specs, Templates, References & regression.
4. **Workbench** (two or three PRs): projects, samples, brief and data policy; drafting stages,
   proposals, feedback and revise; test runs, evaluation, holdout, publish and bundles.
5. **Finish**: delete the allow-list, move the route rules from `CLAUDE.md` into a link to the
   docs, and add the docs to `CLAUDE.md`'s definition of done ("new routes documented").

## Risks

- **Pass-through compilers hide wrong schemas at runtime.** The conformance helper catches them
  only for responses the tests exercise; routes with thin tests get thin checking. Each rollout
  PR adds a test for any documented status code no test reaches.
- **Library compatibility.** `fastify-type-provider-zod` versions are tied to Zod majors; pin the
  Zod 3 line. A later Zod 4 migration moves to the newer line or to Zod's own `toJSONSchema`.
- **Description size.** Long Markdown in route files makes them longer. Accepted: keeping the
  docs beside the code is the point.
