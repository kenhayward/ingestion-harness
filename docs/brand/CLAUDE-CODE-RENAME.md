# Task for Claude Code — rebrand the web app to "CT Studio"

Product name: **Content Transformation Studio**; in-app short name: **CT Studio**. Only the
user-facing brand changes — package names, routes, storage keys, env vars and images stay.

1. **Static assets** — copy `web/favicon.ico`, `web/favicon.svg`, `web/apple-touch-icon.png`,
   `web/icon-192.png`, `web/icon-512.png`, `web/icon-maskable-512.png`, `web/site.webmanifest`
   into `apps/web/public/`. Replace the `<title>`/icon links in `apps/web/index.html` with
   `web/head-snippet.html`.
2. **Brand component** — add `apps/web/src/ui/BrandMark.tsx`: inline SVG (viewBox 0 0 64 64),
   props `size` (number) and picks geometry by size (≥ 64 full, 24–63 small, < 24 tiny — paths in
   `BRAND.md` / the SVG files), tile `var(--ih-accent)`, glyph `var(--ih-accent-text)` so it follows
   light/dark automatically, `aria-hidden` by default.
3. **App shell** (`shell/AppShell.tsx`) — replace the three-bar mark and "Ingestion Harness" with
   `<BrandMark size={30} />` + "CT Studio"; the home link gets
   `aria-label="CT Studio — Content Transformation Studio, home"` and
   `title="Content Transformation Studio"`.
4. **Sign in** (`access/SignIn.tsx`) — `<BrandMark size={52} />` + H1 "CT Studio".
5. **Document title** — `"<Page> · CT Studio"` on route change (Jobs, Review, Results, Document
   types, Workbench, Access, Sign in).
6. **Docs** — README / docs titles become "Content Transformation Studio", first mention
   "Content Transformation Studio (CT Studio)"; add `docs/brand/` with `BRAND.md` + the SVGs.
7. **Tests first** — update tests that query "Ingestion Harness" by text/role; add a test that
   the home link's accessible name contains "Content Transformation Studio", that `BrandMark`
   picks the right geometry per size, and that `document.title` ends with "· CT Studio".
   `npm run check` green.
