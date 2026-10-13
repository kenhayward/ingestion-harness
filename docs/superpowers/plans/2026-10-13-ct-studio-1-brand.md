# CT Studio rebrand (PR 1 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the web app on screen to "CT Studio" (Content Transformation Studio) with the new mark, icons and tab titles, without renaming anything technical.

**Architecture:** The brand kit is vendored into `docs/brand/` (and the Workbench redesign handoff into `docs/design/workbench-redesign/` for PRs 2–7). Static icons go to `apps/web/public/` (Vite copies them into `dist`, which nginx serves). A `BrandMark` component draws the mark inline from the `--ih-accent` / `--ih-accent-text` tokens so it follows light/dark; the app shell and sign-in use it. A pure `routeTitle(route)` plus a `useDocumentTitle` hook set `document.title`. Docs and the OpenAPI title adopt the long name.

**Tech Stack:** React 19 + Vite, Vitest + Testing Library (jsdom), Fastify OpenAPI document, Prettier.

**Spec:** `docs/brand/BRAND.md` and `docs/brand/CLAUDE-CODE-RENAME.md` (vendored by Task 1 from the handoff zip `ct-studio-brand-kit.zip`; until then they are at `$KIT/BRAND.md` and `$KIT/CLAUDE-CODE-RENAME.md`).

Source folders (extracted handoff zips, read-only):

```
KIT=C:/Users/kenha/AppData/Local/Temp/claude/D--Repositories-ingestion-harness--claude-worktrees-yaml-draft-document-ingestion-3c4d51/234b9329-4a59-4c1f-b3f0-9ff0b3e06767/scratchpad/brand/ct-studio-brand-kit
WB=C:/Users/kenha/AppData/Local/Temp/claude/D--Repositories-ingestion-harness--claude-worktrees-yaml-draft-document-ingestion-3c4d51/234b9329-4a59-4c1f-b3f0-9ff0b3e06767/scratchpad/wb/ingestion-harness-workbench-handoff
```

## Global Constraints

- Only the user-facing brand changes. Package names (`@ih/*`), the repo name, routes, `ih.*` storage keys, `--ih-*` CSS token names, env vars, Docker images and the `ih_session` cookie stay exactly as they are.
- In the app (header, sign-in, browser tab title, PWA `short_name`): **CT Studio**.
- In documentation (README, docs titles, OpenAPI title): **Content Transformation Studio**; the first mention in running text is "Content Transformation Studio (CT Studio)".
- Browser tab titles: `<Page> · CT Studio` — a space, U+00B7 MIDDLE DOT, a space. With no page: `CT Studio`.
- Home link: `aria-label="CT Studio — Content Transformation Studio, home"` (U+2014 EM DASH) and `title="Content Transformation Studio"`.
- Mark geometry by rendered size: ≥ 64 px full, 24–63 px small, < 24 px tiny. Tile colour `var(--ih-accent)`, glyph colour `var(--ih-accent-text)`. Never hard-code `#0A5BB0`/`#5EA3EE` in components.
- Header mark 30 px, sign-in mark 52 px.
- `npm run check` and `npm run format:check` green. Tests first (red, then green). Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit `config/llm-providers.yaml` (it has unrelated local changes). Stage files by name, never `git add -A` / `git add .`.

## Review Focus

1. **CSS variables in SVG attributes** — `fill="var(--ih-accent)"` as a presentation attribute does not resolve; the colours must be set through `style` (Task 2 test asserts `style.fill`).
2. **Dark mode** — the mark must flip with the theme because it reads tokens; no literal colour in `BrandMark` (Task 2 test asserts the style values are the `var(--ih-…)` strings).
3. **Accessible name duplication** — the mark is `aria-hidden`, so the home link's name is exactly its `aria-label`, not "CT Studio CT Studio" (Task 2 test asserts the exact name).
4. **Titles on every screen, including signed-out and loading** — sign-in shows `Sign in · CT Studio`, loading/unreachable show `CT Studio`, child routes take their parent page name (Task 3 tests).
5. **Prettier over vendored files** — the handoff's `prototype.html` and CSS must not be reformatted or fail `format:check` (Task 1 adds them to `.prettierignore` and runs `npm run format:check`).

---

### Task 1: Vendor the brand kit and handoff; web icons and `<head>`

**Files:**
- Create: `docs/brand/BRAND.md`, `docs/brand/CLAUDE-CODE-RENAME.md`, `docs/brand/svg/*.svg` (10 files), `docs/brand/png/*.png` (10 files) — copied from `$KIT`
- Create: `docs/design/workbench-redesign/` — copy of all of `$WB` (`WORKBENCH-HANDOFF.md`, `design-tokens/`, `prototype/`, `screenshots/`)
- Create: `apps/web/public/{favicon.ico,favicon.svg,apple-touch-icon.png,icon-192.png,icon-512.png,icon-maskable-512.png,site.webmanifest}` — copied from `$KIT/web/`
- Modify: `apps/web/index.html`
- Modify: `.prettierignore`
- Test: `apps/web/test/brand-assets.test.ts` (create)

**Interfaces:**
- Produces: `docs/brand/BRAND.md` (spec for later tasks); `docs/design/workbench-redesign/WORKBENCH-HANDOFF.md` (spec for PRs 2–7).

- [ ] **Step 1: Write the failing test** — `apps/web/test/brand-assets.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const web = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

describe('brand assets', () => {
  it.each([
    'favicon.ico',
    'favicon.svg',
    'apple-touch-icon.png',
    'icon-192.png',
    'icon-512.png',
    'icon-maskable-512.png',
    'site.webmanifest',
  ])('ships public/%s', (file) => {
    expect(existsSync(web(`public/${file}`))).toBe(true);
  });

  it('names the app in the web manifest', () => {
    const manifest = JSON.parse(readFileSync(web('public/site.webmanifest'), 'utf8')) as {
      name: string;
      short_name: string;
      icons: { src: string }[];
    };
    expect(manifest.name).toBe('Content Transformation Studio');
    expect(manifest.short_name).toBe('CT Studio');
    for (const icon of manifest.icons) expect(existsSync(web(`public${icon.src}`))).toBe(true);
  });

  it('links the icons and manifest from index.html', () => {
    const html = readFileSync(web('index.html'), 'utf8');
    expect(html).toContain('<title>CT Studio</title>');
    expect(html).not.toContain('Ingestion Harness');
    for (const href of ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/site.webmanifest']) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/test/brand-assets.test.ts`
Expected: FAIL — `public/favicon.ico` missing, title is "Ingestion Harness".

- [ ] **Step 3: Copy the files** (bash, from the repo root; `$KIT` and `$WB` as in the header)

```bash
mkdir -p docs/brand apps/web/public docs/design/workbench-redesign
cp "$KIT/BRAND.md" "$KIT/CLAUDE-CODE-RENAME.md" docs/brand/
cp -r "$KIT/svg" "$KIT/png" docs/brand/
cp "$KIT"/web/favicon.ico "$KIT"/web/favicon.svg "$KIT"/web/apple-touch-icon.png "$KIT"/web/icon-192.png "$KIT"/web/icon-512.png "$KIT"/web/icon-maskable-512.png "$KIT"/web/site.webmanifest apps/web/public/
cp -r "$WB"/. docs/design/workbench-redesign/
```

- [ ] **Step 4: Replace the `<head>` of `apps/web/index.html`** (content of `$KIT/web/head-snippet.html`):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CT Studio</title>
    <meta name="application-name" content="CT Studio" />
    <meta
      name="description"
      content="Content Transformation Studio — turn known PDFs into validated, structured data."
    />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <meta name="theme-color" content="#0A5BB0" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#121A25" media="(prefers-color-scheme: dark)" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Keep Prettier off the vendored files** — append to `.prettierignore`:

```
# Vendored design handoffs (kept byte-for-byte as delivered)
docs/brand/
docs/design/workbench-redesign/
```

- [ ] **Step 6: Run the test and the format check**

Run: `npx vitest run apps/web/test/brand-assets.test.ts` → PASS
Run: `npx prettier --check apps/web/index.html .prettierignore` and `npm run format:check` → clean (if `index.html` is reported, run `npx prettier --write apps/web/index.html`).
Run: `npm run build -w @ih/web` and confirm `apps/web/dist/favicon.svg` and `apps/web/dist/site.webmanifest` exist (`ls apps/web/dist`).

- [ ] **Step 7: Commit**

```bash
git add docs/brand docs/design/workbench-redesign apps/web/public apps/web/index.html .prettierignore apps/web/test/brand-assets.test.ts
git commit -m "Brand: vendor the CT Studio kit and Workbench handoff; web icons and head"
```

---

### Task 2: `BrandMark` in the app shell and sign-in

**Files:**
- Create: `apps/web/src/ui/BrandMark.tsx`
- Modify: `apps/web/src/shell/AppShell.tsx` (brand link, lines ~72-77)
- Modify: `apps/web/src/access/SignIn.tsx` (`AuthLayout`, lines ~22-28)
- Modify: `apps/web/src/ui/Icon.tsx` (remove the now-unused `brand` entry from `PATHS`)
- Modify: `apps/web/src/styles.css` (`.brand-mark` at ~336-350)
- Test: `apps/web/test/BrandMark.test.tsx` (create), `apps/web/test/AppShell.test.tsx`, `apps/web/test/SignIn.test.tsx`

**Interfaces:**
- Produces: `brandGeometry(size: number): 'full' | 'small' | 'tiny'`; `BrandMark({ size, label?, className? })`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/BrandMark.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandMark, brandGeometry } from '../src/ui/BrandMark.js';

describe('brandGeometry', () => {
  it.each([
    [16, 'tiny'],
    [23, 'tiny'],
    [24, 'small'],
    [30, 'small'],
    [52, 'small'],
    [63, 'small'],
    [64, 'full'],
    [256, 'full'],
  ] as const)('uses the %i px geometry: %s', (size, geometry) => {
    expect(brandGeometry(size)).toBe(geometry);
  });
});

describe('BrandMark', () => {
  it('is decorative by default and sized in pixels', () => {
    const { container } = render(<BrandMark size={30} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '30');
    expect(svg).toHaveAttribute('height', '30');
    expect(svg).toHaveAttribute('viewBox', '0 0 64 64');
    expect(svg).toHaveAttribute('data-geometry', 'small');
  });

  it('colours the tile and glyph from the theme tokens', () => {
    const { container } = render(<BrandMark size={30} />);
    expect(container.querySelector('rect')!.style.fill).toBe('var(--ih-accent)');
    expect(container.querySelector('g')!.style.stroke).toBe('var(--ih-accent-text)');
  });

  it.each([
    [64, 'full', 15, 2],
    [30, 'small', 14, 2],
    [52, 'small', 15, 2],
    [16, 'tiny', 12, 2],
  ] as const)('draws the %i px mark with the %s geometry', (size, geometry, rx, paths) => {
    const { container } = render(<BrandMark size={size} />);
    expect(container.querySelector('svg')).toHaveAttribute('data-geometry', geometry);
    expect(container.querySelector('rect')).toHaveAttribute('rx', String(rx));
    expect(container.querySelectorAll('path')).toHaveLength(paths);
  });

  it('draws three data cells only in the full geometry', () => {
    const cells = (size: number) =>
      render(<BrandMark size={size} />).container.querySelectorAll('path')[1]!.getAttribute('d');
    expect(cells(64)).toBe('M26 26h5v5h-5zM34 26h5v5h-5zM26 34h5v5h-5z');
    expect(cells(30)).toBe('M28 28h8v8h-8z');
  });

  it('becomes an image with a name when given a label', () => {
    const { getByRole } = render(<BrandMark size={64} label="CT Studio" />);
    expect(getByRole('img', { name: 'CT Studio' })).toBeInTheDocument();
  });
});
```

In `apps/web/test/AppShell.test.tsx`, replace the `'Ingestion Harness'` link assertion in the first test with:

```tsx
    const home = within(banner).getByRole('link', {
      name: 'CT Studio — Content Transformation Studio, home',
    });
    expect(home).toHaveAttribute('href', '#/');
    expect(home).toHaveAttribute('title', 'Content Transformation Studio');
    expect(home).toHaveTextContent('CT Studio');
    expect(home.querySelector('svg')).toHaveAttribute('data-geometry', 'small');
```

In `apps/web/test/SignIn.test.tsx`, add:

```tsx
  it('shows the CT Studio mark and name', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'CT Studio' })).toBeInTheDocument();
    expect(document.querySelector('.auth-brand svg')).toHaveAttribute('width', '52');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/web/test/BrandMark.test.tsx apps/web/test/AppShell.test.tsx apps/web/test/SignIn.test.tsx`
Expected: FAIL — `BrandMark.js` cannot be resolved; no link named "CT Studio — …"; no heading "CT Studio".

- [ ] **Step 3: Implement `apps/web/src/ui/BrandMark.tsx`**

```tsx
/** The CT Studio mark (docs/brand/BRAND.md): an open C holding data cells, on the accent tile. */
export type BrandGeometry = 'full' | 'small' | 'tiny';

/** Each size has its own drawing; the large one is never scaled down. */
export function brandGeometry(size: number): BrandGeometry {
  if (size >= 64) return 'full';
  if (size >= 24) return 'small';
  return 'tiny';
}

const SMALL_ARC = 'M46 17A21 21 0 1 0 46 47';
const ONE_CELL = 'M28 28h8v8h-8z';

const SHAPES: Record<BrandGeometry, { arc: string; arcWidth: number; cells: string; cellWidth: number }> = {
  full: {
    arc: 'M45.4 18.6A19 19 0 1 0 45.4 45.4',
    arcWidth: 5.5,
    cells: 'M26 26h5v5h-5zM34 26h5v5h-5zM26 34h5v5h-5z',
    cellWidth: 2.6,
  },
  small: { arc: SMALL_ARC, arcWidth: 7, cells: ONE_CELL, cellWidth: 4 },
  // BRAND.md gives the tiny mark only inside favicon.ico: the small drawing, heavier strokes.
  tiny: { arc: SMALL_ARC, arcWidth: 8, cells: ONE_CELL, cellWidth: 5 },
};

/** Corner radius in viewBox units: 15, 14 at 32 px and below, 12 at 16 px. */
function radius(geometry: BrandGeometry, size: number): number {
  if (geometry === 'tiny') return 12;
  if (geometry === 'small' && size <= 32) return 14;
  return 15;
}

export function BrandMark({
  size,
  label,
  className,
}: {
  size: number;
  /** Omit for a decorative mark next to the name (the default). */
  label?: string;
  className?: string;
}) {
  const geometry = brandGeometry(size);
  const shape = SHAPES[geometry];
  const a11y = label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  return (
    <svg
      className={className === undefined ? 'brand-mark' : `brand-mark ${className}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      focusable="false"
      data-geometry={geometry}
      {...a11y}
    >
      {/* Tokens via style: CSS variables do not resolve in SVG presentation attributes. */}
      <rect width="64" height="64" rx={radius(geometry, size)} style={{ fill: 'var(--ih-accent)' }} />
      <g
        style={{ stroke: 'var(--ih-accent-text)' }}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={shape.arc} strokeWidth={shape.arcWidth} />
        <path d={shape.cells} strokeWidth={shape.cellWidth} />
      </g>
    </svg>
  );
}
```

- [ ] **Step 4: Use it in the shell and sign-in**

`apps/web/src/shell/AppShell.tsx` — import `BrandMark` from `'../ui/BrandMark.js'` and replace the brand link:

```tsx
        <a
          className="brand"
          href="#/"
          aria-label="CT Studio — Content Transformation Studio, home"
          title="Content Transformation Studio"
        >
          <BrandMark size={30} />
          CT Studio
        </a>
```

`apps/web/src/access/SignIn.tsx` — import `BrandMark` and replace the `auth-brand` block:

```tsx
          <div className="auth-brand">
            <BrandMark size={52} />
            <h1>CT Studio</h1>
          </div>
```

Remove the `brand:` entry (three `<path>`s) from `PATHS` in `apps/web/src/ui/Icon.tsx` (no other user: `grep -rn "\"brand\"\|'brand'" apps/web/src` must print nothing afterwards; fix any `IconName` union/type error the removal surfaces).

`apps/web/src/styles.css` — replace the `.brand-mark` and `.brand-mark.large` rules with:

```css
.brand-mark {
  display: block;
  flex: none;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run apps/web/test/BrandMark.test.tsx apps/web/test/AppShell.test.tsx apps/web/test/SignIn.test.tsx` → PASS
Run: `npx vitest run --project web` → PASS (fix any other test that queried "Ingestion Harness": `grep -rn "Ingestion Harness" apps/web` must print nothing).
Run: `npm run typecheck && npm run lint` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/ui/BrandMark.tsx apps/web/src/ui/Icon.tsx apps/web/src/shell/AppShell.tsx apps/web/src/access/SignIn.tsx apps/web/src/styles.css apps/web/test/BrandMark.test.tsx apps/web/test/AppShell.test.tsx apps/web/test/SignIn.test.tsx
git commit -m "Brand: CT Studio mark and name in the app shell and sign-in"
```

---

### Task 3: Browser tab titles

**Files:**
- Modify: `apps/web/src/shell/derive.ts` (add `APP_NAME`, `pageTitle`, `routeTitle`)
- Create: `apps/web/src/shell/useDocumentTitle.ts`
- Modify: `apps/web/src/App.tsx` (`SignedInApp`)
- Modify: `apps/web/src/access/SignIn.tsx` (`AuthLayout` gets a `title` prop; `SignIn` passes `'Sign in'`)
- Test: `apps/web/test/shell-derive.test.ts`, `apps/web/test/App.test.tsx`, `apps/web/test/SignIn.test.tsx`

**Interfaces:**
- Consumes: `Route` from `apps/web/src/router.ts`.
- Produces: `APP_NAME = 'CT Studio'`; `pageTitle(page: string | null): string`; `routeTitle(route: Route): string`; `useDocumentTitle(title: string): void`; `AuthLayout({ title?: string | null, children })`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/shell-derive.test.ts` (extend the import with `pageTitle, routeTitle`):

```ts
describe('routeTitle', () => {
  it.each([
    [{ name: 'jobs' }, 'Jobs · CT Studio'],
    [{ name: 'review', jobId: 'j1' }, 'Review · CT Studio'],
    [{ name: 'results' }, 'Results · CT Studio'],
    [{ name: 'result', jobId: 'j1' }, 'Results · CT Studio'],
    [{ name: 'templates' }, 'Document types · CT Studio'],
    [{ name: 'template', templateId: 'invoice', version: 2 }, 'Document types · CT Studio'],
    [{ name: 'workbench' }, 'Workbench · CT Studio'],
    [{ name: 'project', projectId: 'invoice', tab: 'samples' }, 'Workbench · CT Studio'],
    [{ name: 'access' }, 'Access · CT Studio'],
  ] as const)('%o → %s', (route, title) => {
    expect(routeTitle(route)).toBe(title);
  });

  it('is the bare name without a page', () => {
    expect(pageTitle(null)).toBe('CT Studio');
    expect(pageTitle('Sign in')).toBe('Sign in · CT Studio');
  });
});
```

Add to `apps/web/test/App.test.tsx` (use its existing imports; add `waitFor` from `@testing-library/react` if missing, and reset `window.location.hash = ''` in an `afterEach` if the file has none):

```tsx
  it('titles the browser tab after the current page', async () => {
    window.location.hash = '#/workbench';
    render(<App api={fakeApi()} pollMs={0} />);
    await waitFor(() => expect(document.title).toBe('Workbench · CT Studio'));
    window.location.hash = '#/results';
    await waitFor(() => expect(document.title).toBe('Results · CT Studio'));
  });
```

Add to `apps/web/test/SignIn.test.tsx`:

```tsx
  it('titles the sign-in tab', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    await screen.findByRole('button', { name: 'Sign in' });
    expect(document.title).toBe('Sign in · CT Studio');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/web/test/shell-derive.test.ts apps/web/test/App.test.tsx apps/web/test/SignIn.test.tsx`
Expected: FAIL — `routeTitle` is not exported; `document.title` is not set.

- [ ] **Step 3: Implement**

Append to `apps/web/src/shell/derive.ts`:

```ts
/** The in-app product name (docs/brand/BRAND.md); docs use "Content Transformation Studio". */
export const APP_NAME = 'CT Studio';

/** Child screens take their parent page's name, as in the nav. */
const PAGE: Record<Route['name'], string> = {
  jobs: 'Jobs',
  review: 'Review',
  results: 'Results',
  result: 'Results',
  templates: 'Document types',
  template: 'Document types',
  workbench: 'Workbench',
  project: 'Workbench',
  access: 'Access',
};

/** Browser tab title: "<Page> · CT Studio", or just the name. */
export function pageTitle(page: string | null): string {
  return page === null ? APP_NAME : `${page} · ${APP_NAME}`;
}

export function routeTitle(route: Route): string {
  return pageTitle(PAGE[route.name]);
}
```

Create `apps/web/src/shell/useDocumentTitle.ts`:

```ts
import { useEffect } from 'react';

/** Keeps the browser tab title in step with the screen. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
```

In `apps/web/src/App.tsx`, inside `SignedInApp` right after `const route = useHashRoute();`:

```tsx
  useDocumentTitle(routeTitle(route));
```

(import `routeTitle` from `'./shell/derive.js'` — extend the existing import if there is one — and `useDocumentTitle` from `'./shell/useDocumentTitle.js'`.)

In `apps/web/src/access/SignIn.tsx`, change `AuthLayout` and pass the title from `SignIn`:

```tsx
/** Full-screen layout outside the app shell: sign in, loading, server unreachable. */
export function AuthLayout({ title = null, children }: { title?: string | null; children: ReactNode }) {
  useDocumentTitle(pageTitle(title));
  return (
```

and in `SignIn`'s return: `<AuthLayout title="Sign in">`. Import `pageTitle` from `'../shell/derive.js'` and `useDocumentTitle` from `'../shell/useDocumentTitle.js'`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/web/test/shell-derive.test.ts apps/web/test/App.test.tsx apps/web/test/SignIn.test.tsx` → PASS
Run: `npx vitest run --project web && npm run typecheck && npm run lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/derive.ts apps/web/src/shell/useDocumentTitle.ts apps/web/src/App.tsx apps/web/src/access/SignIn.tsx apps/web/test/shell-derive.test.ts apps/web/test/App.test.tsx apps/web/test/SignIn.test.tsx
git commit -m "Brand: browser tab titles read '<Page> · CT Studio'"
```

---

### Task 4: Product name in the docs and the API reference

**Files:**
- Modify: `apps/api/src/openapi/document.ts` (`DESCRIPTION` first sentence ~line 122, `info.title` ~146)
- Modify: `apps/api/src/openapi/plugin.ts` (`pageTitle` ~54)
- Regenerate: `docs/openapi.json` (`npm run openapi`)
- Modify: `README.md` (title + first paragraph), `CLAUDE.md` (intro + a Brand rule), `docs/architecture.md` (only if it names the product; currently it does not — leave it)
- Test: `apps/api/test/openapi.test.ts`

**Interfaces:**
- Consumes: `docs/brand/BRAND.md` (Task 1).

- [ ] **Step 1: Write the failing test** — add inside `describe('OpenAPI document', …)` in `apps/api/test/openapi.test.ts`:

```ts
  it('carries the product name', async () => {
    const doc = await openapi();
    expect(doc.info.title).toBe('Content Transformation Studio API');
    expect(doc.info.description).toMatch(/^Content Transformation Studio \(CT Studio\) extracts/);
    expect(JSON.stringify(doc.info)).not.toContain('Ingestion Harness');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project api apps/api/test/openapi.test.ts -t "product name"`
Expected: FAIL — title is "Ingestion Harness API".

- [ ] **Step 3: Implement**

`apps/api/src/openapi/document.ts`: the description's first sentence becomes "Content Transformation Studio (CT Studio) extracts the contents of PDFs whose structure is known in advance and" (rewrap the following line of the Markdown so lines stay under 100 chars; the text after it is unchanged), and `info: { title: 'Content Transformation Studio API', version, description: DESCRIPTION }`.

`apps/api/src/openapi/plugin.ts`: `pageTitle: 'Content Transformation Studio API',`.

Regenerate: `npm run openapi` (updates `docs/openapi.json`), then `npx vitest run --project api apps/api/test/openapi.test.ts` → PASS.

`README.md`: title `# Content Transformation Studio`; first paragraph begins "Content Transformation Studio (CT Studio) ingests PDF documents with a known structure, …" (rest of the sentence unchanged), followed by one new line: "The code, packages and images keep the project's original name, `ingestion-harness`; see [docs/brand/BRAND.md](docs/brand/BRAND.md)."

`CLAUDE.md`: first paragraph becomes "Content Transformation Studio (CT Studio; repo and code name `ingestion-harness`): ingests PDFs whose structure is known in advance, extracts their contents through an LLM prompt harness, and writes validated CSV/JSON to S3 (SeaweedFS)." Add to **Rules of the road**, before the **UI:** bullet:

```md
- **Brand ([docs/brand/BRAND.md](docs/brand/BRAND.md)):** the app says **CT Studio** (header, sign-in, tab titles `<Page> · CT Studio` via `routeTitle`/`useDocumentTitle`, PWA `short_name`); docs say **Content Transformation Studio**, first mention "Content Transformation Studio (CT Studio)". Code names stay `ingestion-harness` (`@ih/*`, `ih.*` keys, `--ih-*` tokens, images, env vars). The mark is `ui/BrandMark.tsx` (geometry by size, colours from `--ih-accent`/`--ih-accent-text`); icons live in `apps/web/public/`.
```

and extend the **UI:** bullet's last sentence with: "; the Workbench redesign handoff (screens predate the rename) is [docs/design/workbench-redesign/](docs/design/workbench-redesign/WORKBENCH-HANDOFF.md)".

- [ ] **Step 4: Verify everything**

Run: `npm run check` → green. Run: `npm run format:check` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/openapi/document.ts apps/api/src/openapi/plugin.ts docs/openapi.json README.md CLAUDE.md apps/api/test/openapi.test.ts
git commit -m "Brand: Content Transformation Studio in the README, CLAUDE.md and API reference"
```
