# Connections in a modal — design

Date: 2026-10-22. Status: draft for the owner's review.

## Intent

*Manage connections* opens the delivery bridge's connections page in a new browser tab. People
reach CT Studio as `https://ctstudio.app`, and a new tab pulls them out of the app for what is a
short, frequent task (add a login, rotate a key, test one). The owner wants it to feel native: a
CT Studio modal, CT Studio's look, two tabs (*Your connections*, *Shared connections*), each with
the connections listed on the left (name and system only) and the selected one's details on the
right.

The reason the page lives on the bridge at all stays untouched: **CT Studio never sees a
credential.** Whatever is typed into the page must stay out of reach of CT Studio's scripts, so a
bug in the app (an XSS) cannot read a password while it is typed.

## Goals

- The page opens in a modal over CT Studio, from every place that has *Manage connections*
  (Profile → Connections, Administration → Published outputs, the target browse dialog).
- The modal and the page inside it look like CT Studio, in its current light or dark theme.
- Two tabs; each a list (name, system) on the left and the details on the right.
- When a connection is added, changed, tested or deleted, CT Studio's own lists of connections
  (Profile, the target pickers, Published outputs) refresh without a reload.
- The credential boundary holds: the framed page is on a **different origin** from CT Studio.

## Non-goals

- Moving credential entry into CT Studio's React code, or any CT Studio API carrying a secret.
- A rich client on the bridge page: it stays server-rendered; the only script is a tiny static
  file that sends one message to the parent.
- Changing who may do what (admins manage shared connections, everyone their own personal ones,
  as today) or any connections API.
- Changes to the 3ds-sink repository: nothing there is involved.

## Anti-goals

- Framing the page from the same origin (`https://ctstudio.app/bridge`). That puts the frame's
  DOM in reach of the app's scripts and defeats the point of the bridge page. When the page is
  only reachable on the app's own origin, *Manage connections* keeps opening a new tab.
- Any framing permission broader than the one exact CT Studio origin.
- The modal closing by itself after a save (the person may have more to do) or losing typed
  input to a stray click outside.

## Decisions

### Where the page lives (owner: a subdomain)

The page gets its own origin, a subdomain of the app's domain, e.g.
`https://connections.ctstudio.app`. A subdomain is a different **origin** (the boundary) but the
same **site**, so the page's `SameSite=Lax` session cookie is still set and sent inside the
frame; a wholly different domain would be a third-party frame whose cookie browsers block. The
deploy README says so: the page's host must be a subdomain of the app's.

*My call:* the app's nginx gets a **second listener**, `BRIDGE_PAGE_PORT` (default `8082`),
whose only routes are `/connections` and below, proxied to `bridge:3100`; everything else is 404.
The operator points the subdomain at that port in their TLS proxy (NGINX Proxy Manager today), as
they point `ctstudio.app` at `APP_PORT`. A separate port rather than matching on `Host` means the
whole app can never be served on the connections origin by accident, and no `server_name` has to
be templated. The listener does not include the app's `security-headers.conf` (its
`X-Frame-Options: DENY` and `frame-ancestors` would forbid the framing); the bridge sets the
page's own headers. The `/bridge/connections` location on the app's port stays, for deployments
without a subdomain (new tab, as now).

The listener is published on `${BRIDGE_PAGE_BIND:-127.0.0.1}:${BRIDGE_PAGE_PORT:-8082}`, so a
deployment that doesn't use it exposes nothing beyond the host. A TLS proxy on the stack's Docker
network reaches it as `app:8082` without any host port; one elsewhere sets
`BRIDGE_PAGE_BIND=0.0.0.0` (as `S3_PUBLIC_BIND` works). This replaces the README's current
own-origin recipe (the proxy forwarding straight to `bridge:3100` with a hand-written
`/connections`-only location) as the recommended one, because nginx enforces the path instead of
the proxy's config. A deployment already set up the old way keeps working, modal included: the
bridge sets the page's headers either way.

Then `BRIDGE_PUBLIC_URL=https://connections.ctstudio.app` (no path).

### Who may frame it

New setting **`BRIDGE_APP_ORIGIN`**, read by the API (through `x-bridge-env`) and by the bridge
(an explicit line in its own `environment`, as `BRIDGE_PUBLIC_URL` is):
the origin people reach CT Studio at (`https://ctstudio.app`). Blank (the default): no framing,
everything as today.

- The bridge's page CSP becomes `frame-ancestors <BRIDGE_APP_ORIGIN>` when set, else `'none'`.
- Both services refuse to start when it is not a bare origin (`http(s)://host[:port]`, no path,
  query or fragment) or when it equals the origin of `BRIDGE_PUBLIC_URL` (same-origin framing).
- `POST /api/bridge/connections-link` answers `{ url, embed }`, where `embed` is
  `{ appOrigin, pageOrigin }` when `BRIDGE_APP_ORIGIN` is set, else `null`. The web app opens the
  modal only when `embed` is set **and** `window.location.origin === embed.appOrigin` (someone
  on a LAN address such as `http://host:8081` would be refused by the frame's CSP, so they get
  the new tab) **and** CT Studio is not itself framed (`window.top === window`): when another
  site frames CT Studio (`FRAME_ANCESTORS`, ADR 0012), the browser checks `frame-ancestors`
  against every ancestor and treats the page's cookie as third-party, so the modal could not
  work. Otherwise it opens the new tab exactly as now.

### The modal (CT Studio)

*My call:* a `ConnectionsDialog` in `apps/web/src/access/`, in the `dialog-rich` style: a header
(*Connections*, the plug icon, a close button) and a body that is the frame. Size
`min(1080px, 100%)` wide and `min(720px, 100vh - 32px)` tall; full screen under 640px. It closes
only by its Close button or Escape while focus is in CT Studio's part (Escape inside the frame
does not reach the app), never by a click outside, as Profile does. It may open over another
dialog (the browse dialog), above it.

The frame: `src` = the one-time link, `title="Connections"`, `referrerpolicy="no-referrer"`,
`sandbox="allow-forms allow-scripts allow-same-origin"` (the page keeps its own origin, cannot
navigate CT Studio or open pop-ups).

One place owns opening it: a `ConnectionsProvider` at the app's root exposes `open()` and a
`version` number. The three *Manage connections* buttons call `open()`; `ProfileConnections`,
`ConnectionPicker` and Published outputs' connection data re-fetch when `version` changes.

### Messages (page → CT Studio)

The page serves `/connections/page.js` (static; allowed by its `default-src 'self'`). Every page
carries `data-app-origin` (blank when unset) and, when there is news, `data-event`:

- `changed` — after a successful add, save, test (either result: the status changed) or delete;
- `ended` — on the *Session ended* and *Link expired* pages.

The script, only when `window.parent !== window` and the app origin is set, posts
`{ source: 'ct-bridge', type: 'connections-changed' | 'session-ended' }` to `window.parent` with
`targetOrigin` = the app origin. Nothing secret is ever in a message.

CT Studio accepts a message only when `event.origin === embed.pageOrigin`, `event.source` is its
frame's window, and the shape matches. `connections-changed` bumps `version`;
`session-ended` replaces the frame with a short *Your session ended* note and a *Reopen* button
that mints a new link. Nothing flows from CT Studio into the page.

### The page (bridge)

Server-rendered as now, re-laid out; the same page works framed and in a tab.

- **Tabs** (rendered by the bridge, inside the frame — *my call*, so the tab fallback gets them
  too): *Your connections* and, for admins only, *Shared connections* (non-admins see no Shared
  tab: today they see no shared section). Links: `/connections?tab=mine|shared`.
- **Left: the list.** Each row is the connection's name and its system (the sink's name; for a
  shared connection the sink's name too, e.g. *S3*). The built-in connection is listed in Shared,
  marked *Built in*. At the top, *Add connection*. The selected row is highlighted.
- **Right: the details.** For the selected connection: name, system, instance (personal) or
  endpoint (shared), status and its reason, last used, the secret note; then the edit form
  (name, credential fields, *Save even if the test fails*, *Test and save*), *Test*, *Delete*.
  The built-in one shows its details with no form or actions.
- **Delete asks first** (*my call*: in a modal a stray click is easy): *Delete* shows *Delete
  <name>? Targets using it stop delivering.* with *Delete* and *Cancel* in the right panel
  (`GET /connections/:id/delete` renders the question; the existing `POST` does it).
- **Add:** the right panel lists the systems one can add to (personal: each personal sink;
  shared: each shared sink); choosing one (`/connections/new?tab=…&sink=…`) shows that sink's
  form (instance, name, credentials), as today's add forms.
- **Routes:** `GET /connections` (the tab's first connection selected, or *Add* when it has
  none), `GET /connections/:id` (its tab inferred from its kind), `GET /connections/new`,
  `GET /connections/:id/delete`; the `POST` routes and their rules are unchanged, except that
  they render the selected connection (or the list) with the notice instead of today's list.
- **Notices** (*Connected as …*, *The test failed …*) show at the top of the right panel.
- **Narrow widths** (under 640px, inside the frame): the list above the details.

### Look

*My call:* the bridge's `PAGE_CSS` is rebuilt from CT Studio's tokens: the subset of
`apps/web/src/styles/tokens.css` it uses (fonts, sizes, radii, spacing, surface, border, text,
muted, accent, selected row, status colours), both themes, with the same structure
(`:root[data-theme='light'|'dark']`, no attribute = the OS). A bridge test reads `tokens.css` and
fails when a copied value drifts. Tabs, list rows, buttons and inputs follow Profile's and the
dialogs' styles. CT Studio bundles no web font, so the same font stack is the same font.

**Theme:** the web app adds `theme=light|dark` to the link when the person chose one (*System*:
nothing); `/connections/start` keeps it in the page session (an optional field), and every page
renders `<html data-theme>` from it.

## Documentation

`deploy/README.md` (the subdomain, `BRIDGE_PAGE_PORT`, `BRIDGE_APP_ORIGIN`, the same-site rule),
`deploy/.env.example`, the compose files, ADR 0017 (a note on framing), `CLAUDE.md`'s bridge and
publishing-targets paragraphs (*opens the bridge's page in a modal or a new tab*), the in-app
help (`ConnectionsHelp.tsx`) and today's release note (with a *Watch out for* line: set
`BRIDGE_APP_ORIGIN`, `BRIDGE_PUBLIC_URL` and the subdomain to get the modal).

## Left to the builder

Class names, the exact markup, component splits, how `version` reaches the consumers (context
or prop), test layout.
