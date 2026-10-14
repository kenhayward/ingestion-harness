# 0012: Embedding the app in a frame on named sites

**Status:** accepted · 2026-10-14

## Context
[ADR 0006](0006-token-access.md) exposed the app beyond the LAN with framing forbidden everywhere
(`X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`) and a
`SameSite=Strict` session cookie. People now want to use CT Studio inside a 3DEXPERIENCE
dashboard, which shows it in an iframe on `*.3dexperience.3ds.com`: a different site from the
app's own hostname. The browser refused to draw the app there. Even with framing allowed, a
`SameSite=Strict` cookie is never sent inside a cross-site frame, so sign-in would not stick.

## Decision
- **One setting, `FRAME_ANCESTORS`** (`deploy/.env`): space-separated https origins, `*.` for
  every subdomain, e.g. `https://*.3dexperience.3ds.com`. Blank (the default) keeps ADR 0006's
  behaviour exactly.
- **Framing (the app's nginx):** set, every response sends `frame-ancestors 'self' <the list>`
  and no `X-Frame-Options` (it cannot name a site, and `DENY` would override the allowance).
  The value is rendered from the environment at container start
  (`deploy/docker/frame-ancestors.conf.template`). Every site in the frame chain must be listed:
  a browser checks all ancestors, not only the direct parent.
- **Validation (the API):** the API reads the same variable and refuses to start unless every
  entry is an https origin (no `*` alone, no `http:`, no keywords, paths or `;`), so a typo
  cannot open framing more widely than meant.
- **Session cookie (the API):** set, and over HTTPS, the cookie is `SameSite=None; Secure;
  Partitioned; HttpOnly`. `Partitioned` (CHIPS) keeps the cookie working in browsers that block
  third-party cookies: each embedding site gets its own session, so people sign in once inside
  3DEXPERIENCE and separately when they open the app directly. Over plain HTTP (the LAN) the
  cookie stays `SameSite=Strict`.
- **Cross-site guard, always on:** `SameSite=Strict` also stopped other sites from making a
  signed-in browser change things (forged form posts). The access hook now refuses any `POST`,
  `PUT`, `PATCH` or `DELETE` under `/api` that the browser marks `Sec-Fetch-Site: cross-site`
  (403 `cross-site request refused`), sign-in included. The app's own requests are same-origin,
  framed or not; scripts send no `Sec-Fetch-Site` and are unaffected.

- **A widget page, `/widget.html`:** some dashboards (3DEXPERIENCE's "Run your app" widget)
  do not frame the URL they are given: their servers fetch the page once and serve the copy from
  their own site. The app's own page then runs on the dashboard's origin, its relative `/api`
  calls go to the dashboard, and it names hashed assets that the next deploy removes (seen as a
  blank widget and 404s for the old `/assets/index-….js`). `widget.html` is a page that never
  changes between builds and holds only a full-size iframe of the app; nginx rewrites its
  `src="/"` to `$forwarded_proto://$http_host/`, so the copy frames the app by absolute URL and the
  app runs on its own origin. It is served `no-cache` with the same headers as every page.

## Consequences
- Only the listed sites can frame the app; clickjacking from anywhere else stays blocked.
- The outer proxy (NGINX Proxy Manager) must not add its own `X-Frame-Options` or
  `frame-ancestors`.
- Browsers too old to send `Sec-Fetch-Site` (before Chrome 76, Firefox 90, Safari 16.4) get no
  cross-site protection when framing is on; they are not supported.
- A browser that blocks third-party cookies even when partitioned would need the Storage Access
  API; not done until someone hits it.
