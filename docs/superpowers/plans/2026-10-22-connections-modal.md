# Connections in a modal — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** *Manage connections* opens the bridge's connections page in a CT Studio modal (two
tabs, list on the left, details on the right) when the page has its own origin, and in a new tab
otherwise.

**Architecture:** The bridge page stays server-rendered and gains a frame permission for one
origin (`BRIDGE_APP_ORIGIN`), a re-laid-out master/detail UI in CT Studio's tokens, and a static
`page.js` that posts one message to the parent. The API's connections link says whether to
embed. The web app gets a `ConnectionsProvider` that opens a `ConnectionsDialog` (an iframe) or
a new tab, and bumps a version its connection lists re-fetch on. nginx gets a second listener
that serves only `/connections`.

**Tech Stack:** TypeScript, Fastify, Zod, React, vitest, Testing Library, nginx, Docker compose.

**Spec:** `docs/superpowers/specs/2026-10-22-connections-modal-design.md`

## Global Constraints

- CT Studio never sees a credential: no secret in any message, link, log or API body.
- Never frame from the same origin; `frame-ancestors` names exactly `BRIDGE_APP_ORIGIN` or `'none'`.
- Blank `BRIDGE_APP_ORIGIN`: behaviour is exactly today's (new tab, `frame-ancestors 'none'`).
- Message shape: `{ source: 'ct-bridge', type: 'connections-changed' | 'session-ended' }`.
- The bridge page has no inline script or style (CSP `default-src 'self'`).
- `@ih/bridge-contract` is not changed (3ds-sink depends on its published version).
- Docs updated in the same PR: README, `.env.example`, compose, ADR 0017, CLAUDE.md, help, today's
  release note.
- Before saying done: `npm run check`, `npm run format:check`, `npm run worker:test`,
  `npm run worker:lint`. Stage files by name, never `git add -A`. Ask before pushing.

## Review Focus

1. A message from another origin or another window (e.g. a second frame) — ignored; covered in
   Task 6's `ignores messages not from its frame` test.
2. CT Studio itself framed by a dashboard — new tab; Task 6 `opens a tab when the app is framed`.
3. A session that expires while the modal is open — *Your session ended* + *Reopen*, never a
   broken frame; Task 3 (`data-event="ended"`) and Task 6 (`reopens after session-ended`).
4. A `theme` query that isn't `light`/`dark` — ignored, never echoed; Task 3 test.
5. A non-admin reaching `?tab=shared` or a shared id — the Personal tab, and 404 for the id, as
   today; Task 4 test.

---

### Task 1: `BRIDGE_APP_ORIGIN` in both configs

**Files:**
- Modify: `apps/bridge/src/config.ts`, `apps/api/src/config.ts`
- Test: `apps/bridge/test/config.test.ts`, `apps/api/test/config.test.ts`

**Interfaces:**
- Produces: `BridgeConfig.BRIDGE_APP_ORIGIN: string | undefined` and the API config's
  `BRIDGE_APP_ORIGIN: string | undefined` (normalised to `new URL(v).origin`).

- [ ] **Step 1: Failing tests** in each config test:
  - blank → `undefined`;
  - `https://ctstudio.app` → `'https://ctstudio.app'`; `http://localhost:8081` kept with its port;
  - refused (start fails, message names `BRIDGE_APP_ORIGIN`): `https://ctstudio.app/x`,
    `https://ctstudio.app?q=1`, `ftp://x`, `not a url`;
  - refused when it equals `new URL(BRIDGE_PUBLIC_URL).origin`
    (`BRIDGE_PUBLIC_URL=https://ctstudio.app/bridge`, origin `https://ctstudio.app`), message
    `BRIDGE_APP_ORIGIN must differ from BRIDGE_PUBLIC_URL's origin: a page on the app's own origin is never framed`.
- [ ] **Step 2:** `npx vitest run apps/bridge/test/config.test.ts apps/api/test/config.test.ts` → FAIL.
- [ ] **Step 3:** Add `BRIDGE_APP_ORIGIN: optional(...)` with an http(s), bare-origin check (path
  `/` only, no search or hash) to both schemas, and the cross-field check in each schema's
  refine (or where the config is built). Keep the two copies small and identical in wording.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `feat(bridge,api): BRIDGE_APP_ORIGIN, the origin allowed to frame the connections page`.

### Task 2: The connections link says whether to embed

**Files:**
- Modify: `apps/api/src/routes/bridge.ts`, `apps/api/src/app.ts` (`bridgeAuth` gains
  `appOrigin?: string`), `apps/api/src/server.ts`
- Test: `apps/api/test/bridge-routes.test.ts`

**Interfaces:**
- Consumes: Task 1's API config.
- Produces: `POST /api/bridge/connections-link` → `{ url: string; embed: { appOrigin: string; pageOrigin: string } | null }`,
  `pageOrigin = new URL(publicUrl).origin`. The schema in the route's `response` and the OpenAPI
  description (*the web app opens it in a modal when `embed` is set, else a new tab*).
  Request body gains optional `{ theme?: 'light' | 'dark' }`, appended as `&theme=` to the link.

- [ ] **Step 1: Failing tests:** `embed` is `null` without `appOrigin`; with
  `appOrigin: 'https://ctstudio.app'`, `publicUrl: 'https://connections.ctstudio.app'` it is
  `{ appOrigin: 'https://ctstudio.app', pageOrigin: 'https://connections.ctstudio.app' }`;
  `{theme:'dark'}` puts `theme=dark` in the URL; `{theme:'blue'}` is a 400.
- [ ] **Step 2:** `npx vitest run apps/api/test/bridge-routes.test.ts` → FAIL.
- [ ] **Step 3:** Implement; wire `appOrigin: config.BRIDGE_APP_ORIGIN` in `server.ts`.
- [ ] **Step 4:** Re-run → PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `feat(api): connections link reports when the page may be framed`.

### Task 3: Bridge framing, theme and the parent message

**Files:**
- Modify: `apps/bridge/src/page/routes.ts`, `apps/bridge/src/page/session.ts`,
  `apps/bridge/src/page/html.ts`
- Create: `apps/bridge/src/page/script.ts` (exports `PAGE_JS: string`)
- Test: `apps/bridge/test/page.test.ts`

**Interfaces:**
- Consumes: `BridgeConfig.BRIDGE_APP_ORIGIN`.
- Produces: `PageSession.theme?: 'light' | 'dark'`; `Shell` gains `appOrigin: string | null`,
  `theme?: 'light' | 'dark'`, `event?: 'changed' | 'ended'`; `layout()` renders
  `<html lang="en" data-theme=…>` (attribute only when set), `<body data-app-origin=… data-event=…>`
  and `<script src="${base}/connections/page.js" defer></script>`.

- [ ] **Step 1: Failing tests:**
  - CSP is `default-src 'self'; form-action 'self'; frame-ancestors https://ctstudio.app` with
    `BRIDGE_APP_ORIGIN` set, and ends `frame-ancestors 'none'` without;
  - `GET /connections/page.js` is 200 `text/javascript` and contains `postMessage` and
    `ct-bridge`;
  - `/connections/start?code=…&theme=dark` → the list page has `data-theme="dark"`;
    `theme=blue` → no `data-theme`, and `blue` appears nowhere in the response;
  - after a successful personal add, a save, a test (passing or failing) and a delete, the page
    rendered or redirected to carries `data-event="changed"`; a refused add (422) does not;
  - *Session ended* (401) and *Link expired* pages carry `data-event="ended"`;
  - `data-app-origin="https://ctstudio.app"` when set, `""` when not.
- [ ] **Step 2:** `npx vitest run apps/bridge/test/page.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `SessionSchema` gets `theme: z.enum(['light','dark']).optional()`.
  Redirects after a change (`toList`) carry the event as `?changed=1`, which the GET turns into
  `event: 'changed'`. `PAGE_JS` body:

  ```js
  (() => {
    const b = document.body, origin = b.dataset.appOrigin, ev = b.dataset.event;
    if (!origin || !ev || window.parent === window) return;
    const type = ev === 'changed' ? 'connections-changed' : 'session-ended';
    window.parent.postMessage({ source: 'ct-bridge', type }, origin);
  })();
  ```
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `feat(bridge): connections page may be framed by CT Studio and tells it of changes`.

### Task 4: Tabs, list and details

**Files:**
- Modify: `apps/bridge/src/page/html.ts` (replace `listPage`/`editPage` with the views below),
  `apps/bridge/src/page/routes.ts`
- Test: `apps/bridge/test/page.test.ts` (rewrite the list and edit assertions that depended on
  the tables)

**Interfaces:**
- Produces (in `html.ts`): `connectionsPage(shell, view: PageView): string` where
  `PageView = { tab: 'mine' | 'shared'; tabs: ('mine' | 'shared')[]; list: ListItem[];
  selected: { kind: 'connection'; ... } | { kind: 'add'; sinks: …; sinkId?: string; draft?: … }
  | { kind: 'confirm-delete'; connection: Connection } ; notice?: …; csrf: string }` and
  `ListItem = { id: string; name: string; system: string; builtIn: boolean }`.
- Routes: `GET /connections?tab=`, `GET /connections/:id`, `GET /connections/new?tab=&sink=`,
  `GET /connections/:id/delete`; existing `POST`s unchanged in rules, rendering through
  `connectionsPage`.

- [ ] **Step 1: Failing tests:**
  - an admin sees both tabs, `aria-selected` on the current one; a designer sees only
    *Your connections*, and `?tab=shared` gives the personal tab;
  - each list row shows the name and the sink's name and nothing else (no status, no endpoint);
    the built-in shows *Built in*;
  - `GET /connections` selects the tab's first connection; an empty tab shows the add view;
  - `GET /connections/:id` marks that row selected and shows its status, instance or endpoint,
    last used, secret note, the edit form, *Test* and *Delete*; the built-in has no form;
  - `GET /connections/new?tab=mine&sink=acme` shows Acme's add form; unknown sink → the
    system list;
  - `GET /connections/:id/delete` asks `Delete <name>?` with a form posting to
    `/connections/:id/delete`; the POST still deletes;
  - a notice from a test shows in the right panel;
  - another user's personal id stays 404, as today.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Keep every existing refusal message.
- [ ] **Step 4:** Run the bridge suite: `npx vitest run apps/bridge` → PASS.
- [ ] **Step 5: Commit** `feat(bridge): connections page as tabs with a list and details`.

### Task 5: CT Studio's look

**Files:**
- Modify: `apps/bridge/src/page/html.ts` (`PAGE_CSS`; may move to `apps/bridge/src/page/css.ts`)
- Test: `apps/bridge/test/page-css.test.ts`

- [ ] **Step 1: Failing test** `PAGE_CSS keeps CT Studio's token values`: parse every
  `--ih-*: value;` in `PAGE_CSS` per block (`:root`, `[data-theme='light']`,
  `[data-theme='dark']`, the dark `prefers-color-scheme` block) and assert each equals the same
  token in the same block of `apps/web/src/styles/tokens.css`; and that `PAGE_CSS` has no
  `url(`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Rewrite `PAGE_CSS` with the copied tokens, the tab strip and list styled after
  `.profile-tabs`/`.profile-side`, buttons and inputs after the app's, the two-column grid
  (list `260px`, details `1fr`) stacking under `640px`, `body` background
  `var(--ih-surface)`.
- [ ] **Step 4:** Run → PASS; look at it (`npm run dev` stack or the test server) in both themes.
- [ ] **Step 5: Commit** `feat(bridge): connections page in CT Studio's tokens`.

### Task 6: The modal in CT Studio

**Files:**
- Create: `apps/web/src/access/ConnectionsDialog.tsx`, `apps/web/src/access/connections.tsx`
  (`ConnectionsProvider`, `useConnections`)
- Modify: `apps/web/src/api/client.ts` (`openConnections` → `connectionsLink(theme?)`),
  `apps/web/src/App.tsx` (provider at the root), `BrowseDialog.tsx`, `ProfileConnections.tsx`,
  `PublishedOutputsPage.tsx`, `ConnectionPicker.tsx` and any other `openConnections` caller
  (`grep -rn openConnections apps/web/src`), `apps/web/src/styles.css`,
  `apps/web/test/fake-api.ts`
- Test: `apps/web/test/ConnectionsDialog.test.tsx`; update the callers' tests

**Interfaces:**
- Consumes: Task 2's link shape.
- Produces: `Api.connectionsLink(theme?: 'light' | 'dark'): Promise<{ url: string; embed: { appOrigin: string; pageOrigin: string } | null }>`;
  `useConnections(): { open(): Promise<void>; version: number }`.

- [ ] **Step 1: Failing tests:**
  - `opens a modal when embedded`: link with `embed` whose `appOrigin` is `location.origin`,
    `window.top === window` → a dialog named *Connections* with an iframe whose `src` is the
    link, `sandbox="allow-forms allow-scripts allow-same-origin"`, `referrerpolicy="no-referrer"`;
    `window.open` not called;
  - `opens a tab without embed`, `opens a tab on another origin` (appOrigin ≠ location.origin),
    `opens a tab when the app is framed` → `window.open(url, '_blank', 'noopener')`, no dialog;
  - `refreshes on connections-changed`: a `message` event with `origin = pageOrigin`,
    `source = iframe.contentWindow`, data `{source:'ct-bridge', type:'connections-changed'}`
    bumps `version` (a consumer re-fetches: `listMyConnections` called again);
  - `ignores messages not from its frame`: wrong origin, other source, wrong shape → no bump;
  - `reopens after session-ended`: shows *Your session ended* and *Reopen*; *Reopen* calls
    `connectionsLink` again and shows the new frame;
  - Close closes it; a click on the backdrop does not; the theme passed is `themeAttr(loadTheme())`
    when not null.
- [ ] **Step 2:** `npx vitest run apps/web/test/ConnectionsDialog.test.tsx` → FAIL.
- [ ] **Step 3:** Implement with `useModalFocus` and the `dialog-backdrop`/`dialog dialog-rich`
  classes plus `.connections-dialog` (size from the spec, full screen under 640px, the frame
  `flex: 1; border: 0`). Callers use `useConnections().open()`; their error handling stays.
  `ProfileConnections`, `ConnectionPicker` and Published outputs add `version` to their fetch
  effects' dependencies.
- [ ] **Step 4:** `npx vitest run apps/web` → PASS.
- [ ] **Step 5: Commit** `feat(web): Manage connections opens in a modal when the page has its own origin`.

### Task 7: Deployment and docs

**Files:**
- Modify: `deploy/docker/nginx.conf` (second `server`), `deploy/docker-compose.yml` and
  `deploy/docker-compose.dev.yml` (app port, `BRIDGE_APP_ORIGIN` in `x-bridge-env` and the
  bridge's `environment`), `deploy/.env.example`, `deploy/README.md`,
  `docs/adr/0017-delivery-bridge.md`, `CLAUDE.md`, `apps/web/src/help/ConnectionsHelp.tsx`,
  `docs/release-notes/Release-Notes-20261022.html`, `.github/workflows/ci.yml` only if the stack
  check needs the new port

- [ ] **Step 1:** nginx: `server { listen 8082; server_name _; location /connections { proxy_pass http://bridge:3100/connections; …same proxy headers… } location / { return 404; } }`,
  without the `security-headers.conf` include. Compose app ports gain
  `"${BRIDGE_PAGE_BIND:-127.0.0.1}:${BRIDGE_PAGE_PORT:-8082}:8082"`.
- [ ] **Step 2:** Verify: `docker compose -f deploy/docker-compose.yml config -q` succeeds;
  build and run the app image locally, `curl -si localhost:8082/connections/page.css` → 200 from
  the bridge, `curl -si localhost:8082/` → 404, `curl -si localhost:8082/api/health` → 404.
- [ ] **Step 3:** Docs: README *The connections page* rewritten (modal with its own origin:
  subdomain of the app's domain → `app:8082`/host `BRIDGE_PAGE_PORT`, `BRIDGE_PUBLIC_URL`,
  `BRIDGE_APP_ORIGIN`; the old direct-to-bridge recipe still works; same-origin = new tab);
  `.env.example` entries; ADR 0017 framing note; CLAUDE.md wording; help text; release note
  entry with a *Watch out for* line.
- [ ] **Step 4:** `npm run check`, `npm run format:check`, `npm run worker:test`,
  `npm run worker:lint` → all pass; `test/release-notes.test.ts` passes.
- [ ] **Step 5: Commit** `feat(deploy): a listener for the connections page's own origin; docs`.

### Task 8: Live check (with the owner)

- [ ] Owner adds `connections.ctstudio.app` in NGINX Proxy Manager → `app:8082` (or the host's
  `BRIDGE_PAGE_PORT` with `BRIDGE_PAGE_BIND` set), sets `BRIDGE_PUBLIC_URL` and
  `BRIDGE_APP_ORIGIN`, deploys the branch's images.
- [ ] From outside: Profile → Connections → *Manage connections* opens the modal; add, test and
  delete a personal connection; Profile's list refreshes without a reload; dark theme follows.
