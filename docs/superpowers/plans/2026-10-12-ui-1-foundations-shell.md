# UI redesign PR 1: foundations, app shell and sign in. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web app the redesign's tokens, fonts, Light/Dark/System theme, the new top bar
and side nav, and the restyled Sign in screen. Every existing page keeps working and picks up the
new look through base styles.

**Architecture:**
- **Design tokens:** `apps/web/src/styles/tokens.css` holds the redesign's CSS variables.
- **Base styles:** `styles.css` is rewritten on top of the tokens.
- **Theme:** `apps/web/src/theme.ts` holds the theme preference, persists it, and sets
  `<html data-theme>`.
- **Shared primitives:** `apps/web/src/ui/` (`Icon`, `Segmented`, `ThemeSwitch`).
- **Shell:** `apps/web/src/shell/` (`AppShell`, `useJobs`, pure helpers).
- **App wiring:** `App.tsx` keeps the sign-in gate and now hosts the shell. The jobs poll moves up
  into the shell, because the nav badge needs it on every page.
- **Search:** the search box is plain state passed to the list pages as a `query` prop.

**Tech Stack:** React 19, Vite 7, Vitest + Testing Library (jsdom), `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`.

**Spec:** `docs/design/ui-redesign/README.md`, `SPEC.md` §0 (App shell) and §7 (Sign in), `FEATURES_AND_API.md`
rows 1–3, 27, 28 (phase 1). Visual reference: the handoff's `screenshots/*/01-jobs*.png`, `07–09-sign-in*.png`,
`design-source/Main.dc.html` (scratchpad copy; not committed).

## Global Constraints

- Theme persisted in `localStorage` key `ih.theme`; values `light` | `dark` | `system`; `system` = no `data-theme` attribute. Every storage access wrapped in try/catch.
- Fonts: IBM Plex Sans 400/500/600 and IBM Plex Mono 400/500, self-hosted via `@fontsource` (no Google Fonts).
- 14 px base, no gradients except the sign-in dot grid, no emoji, inline stroke SVG icons (`aria-hidden`).
- Icon-only buttons have `aria-label`; primary controls are 40–44 px tall.
- Accessible names: search `Search jobs, results and document types`; colour mode group `Colour mode` with buttons `Light` / `Dark` / `System` (`aria-pressed`); `Upload PDF`; `Sign out`; nav `Main`; sign-in form `Sign in`, field `Access token`, toggle `Show token` / `Hide token` (`aria-pressed`).
- Nav badge counts `awaiting_review + needs_review + failed`; text "N need attention" for assistive tech.
- Sign-in error copy unchanged: "That token is invalid or has expired." / "Too many attempts. Try again in a few minutes.".
- Session-ended copy: "Your session has ended" + "It expired, was revoked, or the admin token rotated. Sign in again to continue."
- Hint copy: "Ask an administrator for an access token." + "Administrators: the admin token is printed in the API log on each restart."
- At 390 px: nav stacks above content, top bar wraps, no horizontal page scroll.
- Unit tests never touch the network; web tests query by role/label, never class names.

## Review Focus

1. **Blocked or corrupt storage:** `localStorage` throws, or `ih.theme` holds junk like `purple`. Expect the theme to fall back to System and the switch to keep working for the session. Tests are in Task 1.
2. **A search that matches nothing:** the Jobs page should say "No jobs match …", not "No jobs yet." Tested in Task 5.
3. **Ctrl K versus plain typing:** Ctrl/Cmd+K focuses the search box from anywhere; a plain "k" typed into any field does nothing special. Tested in Task 4.
4. **Zero jobs needing attention:** no badge (not a "0" badge), and the badge follows the poll. Tested in Task 4.
5. **Upload PDF from another page:** clicking it on Results lands on Jobs and opens the file picker once. Going back to Jobs later must not reopen it. Tested in Task 6.

---

### Task 1: Tokens, fonts and the theme module

**Files:**
- Create: `apps/web/src/styles/tokens.css` (copy of the handoff `design-tokens/tokens.css`, minus its trailing `body`/`code` rules, which move into `styles.css` in Task 8)
- Create: `apps/web/src/theme.ts`
- Modify: `apps/web/src/main.tsx`, `apps/web/package.json` (+ lockfile)
- Test: `apps/web/test/theme.test.ts`

**Interfaces:**
- Produces: `type ThemePref = 'light' | 'dark' | 'system'`, `THEME_KEY = 'ih.theme'`,
  `themeAttr(pref): 'light' | 'dark' | null`, `loadTheme(): ThemePref`, `saveTheme(pref): void`,
  `applyTheme(pref, root?: HTMLElement): void`, `useTheme(): [ThemePref, (pref: ThemePref) => void]`.

- [ ] **Step 1: Write the failing test** (`apps/web/test/theme.test.ts`)

```ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, loadTheme, saveTheme, themeAttr, THEME_KEY, useTheme } from '../src/theme.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

describe('themeAttr', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', null],
  ] as const)('%s → %s', (pref, attr) => expect(themeAttr(pref)).toBe(attr));
});

describe('loadTheme / saveTheme', () => {
  it.each([
    [null, 'system'],
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
    ['purple', 'system'],
  ])('stored %s → %s', (stored, pref) => {
    if (stored !== null) localStorage.setItem(THEME_KEY, stored);
    expect(loadTheme()).toBe(pref);
  });

  it('round-trips through ih.theme', () => {
    saveTheme('dark');
    expect(localStorage.getItem('ih.theme')).toBe('dark');
  });

  it('falls back to system when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadTheme()).toBe('system');
    expect(() => saveTheme('dark')).not.toThrow();
  });
});

describe('applyTheme', () => {
  it('sets and clears data-theme', () => {
    applyTheme('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    applyTheme('system');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });
});

describe('useTheme', () => {
  it('starts from storage, applies and persists changes', () => {
    localStorage.setItem(THEME_KEY, 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe('light');
    act(() => result.current[1]('dark'));
    expect(result.current[0]).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
  });

  it('still switches for the session when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTheme());
    act(() => result.current[1]('light'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });
});
```

- [ ] **Step 2: Run it.** Run `npx vitest run apps/web/test/theme.test.ts`. Expected: FAIL, because `../src/theme.js` can't be resolved.

- [ ] **Step 3: Implement `apps/web/src/theme.ts`**

```ts
import { useCallback, useState } from 'react';

/** Colour mode (UI handoff): light, dark, or follow the OS. Remembered per browser. */
export type ThemePref = 'light' | 'dark' | 'system';
export const THEME_KEY = 'ih.theme';
const PREFS: readonly ThemePref[] = ['light', 'dark', 'system'];

/** The `data-theme` value for a preference; `system` = no attribute (prefers-color-scheme decides). */
export function themeAttr(pref: ThemePref): 'light' | 'dark' | null {
  return pref === 'system' ? null : pref;
}

export function loadTheme(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return PREFS.includes(stored as ThemePref) ? (stored as ThemePref) : 'system';
  } catch {
    return 'system'; // storage blocked (private window, policy)
  }
}

export function saveTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  const attr = themeAttr(pref);
  if (attr) root.dataset.theme = attr;
  else delete root.dataset.theme;
}

export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(loadTheme);
  const choose = useCallback((next: ThemePref) => {
    applyTheme(next);
    saveTheme(next);
    setPref(next);
  }, []);
  return [pref, choose];
}
```

- [ ] **Step 4: Run it.** Run `npx vitest run apps/web/test/theme.test.ts`. Expected: PASS.

- [ ] **Step 5: Add the tokens, fonts and boot-time theme**
  - **Fonts:** run `npm i -w apps/web @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono`.
  - **Tokens:** create `apps/web/src/styles/tokens.css` from the handoff file (scratchpad
    `ui-handoff/.../design-tokens/tokens.css`). Delete its last two lines (the `body {…}` and
    `code, kbd, .mono {…}` rules).
  - **`main.tsx`:** apply the theme before the first render, so there is no flash of the wrong
    theme.

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import { App } from './App.js';
import { httpApi } from './api/client.js';
import { applyTheme, loadTheme } from './theme.js';
import './styles/tokens.css';
import './styles.css';

applyTheme(loadTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={httpApi} />
  </StrictMode>,
);
```

- [ ] **Step 6: Typecheck and commit.** Run `npm run typecheck`, then commit:
  `git add -A apps/web package-lock.json docs/design && git commit -m "Web: design tokens, IBM Plex fonts, persisted Light/Dark/System theme"`

---

### Task 2: Icons, Segmented and ThemeSwitch

**Files:**
- Create: `apps/web/src/ui/Icon.tsx`, `apps/web/src/ui/Segmented.tsx`, `apps/web/src/ui/ThemeSwitch.tsx`
- Test: `apps/web/test/ui.test.tsx`

**Interfaces:**
- Consumes: `useTheme`, `ThemePref` (Task 1).
- Produces:
  - `Icon({ name, size? }: { name: IconName; size?: number })`, where `IconName` is `'brand' | 'search' | 'sun' | 'moon' | 'monitor' | 'upload' | 'signOut' | 'jobs' | 'results' | 'types' | 'key' | 'eye' | 'eyeOff' | 'alert' | 'clock'`.
  - `Segmented<T extends string>({ label, options, value, onChange })`, where `options: readonly { value: T; label: string; icon?: IconName }[]`.
  - `ThemeSwitch()`.

- [ ] **Step 1: Write the failing test** (`apps/web/test/ui.test.tsx`)

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Segmented } from '../src/ui/Segmented.js';
import { ThemeSwitch } from '../src/ui/ThemeSwitch.js';

describe('Segmented', () => {
  it('is a labelled group of pressed/unpressed buttons', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Fills"
        options={[
          { value: 'fields', label: 'Fields' },
          { value: 'table', label: 'A table' },
        ]}
        value="fields"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole('group', { name: 'Fills' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fields' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'A table' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'A table' }));
    expect(onChange).toHaveBeenCalledWith('table');
  });
});

describe('ThemeSwitch', () => {
  it('defaults to System and switches the document theme', async () => {
    render(<ThemeSwitch />);
    expect(screen.getByRole('group', { name: 'Colour mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem('ih.theme')).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });
});
```

- [ ] **Step 2: Run it.** Run `npx vitest run apps/web/test/ui.test.tsx`. Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement**

`apps/web/src/ui/Icon.tsx`: the paths are copied from the design source (`stroke="currentColor"`, round caps).

```tsx
const PATHS = {
  brand: <><path d="M5 7h14" /><path d="M5 12h9" /><path d="M5 17h5" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v4h16v-4" /></>,
  signOut: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
  jobs: <path d="M4 6h16M4 12h16M4 18h10" />,
  results: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 10h16M10 10v10" /></>,
  types: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /><path d="M10 13h6M10 17h4" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M3 3l18 18" /><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.3 2 12 2 12s3.5 7 10 7a9.9 9.9 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5h.01" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
} as const;

export type IconName = keyof typeof PATHS;

/** Inline stroke icon; always decorative (the control carries the accessible name). */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="icon"
    >
      {PATHS[name]}
    </svg>
  );
}
```

`apps/web/src/ui/Segmented.tsx`:

```tsx
import { Icon, type IconName } from './Icon.js';

export type SegmentedOption<T extends string> = { value: T; label: string; icon?: IconName };

/** One-of-n choice as a group of toggle buttons (aria-pressed), e.g. colour mode, token expiry. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

`apps/web/src/ui/ThemeSwitch.tsx`:

```tsx
import { useTheme, type ThemePref } from '../theme.js';
import { Segmented } from './Segmented.js';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
] as const;

export function ThemeSwitch() {
  const [pref, setPref] = useTheme();
  return (
    <Segmented<ThemePref> label="Colour mode" options={OPTIONS} value={pref} onChange={setPref} />
  );
}
```

- [ ] **Step 4: Run it.** Run `npx vitest run apps/web/test/ui.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Web: Icon, Segmented and ThemeSwitch primitives"`

---

### Task 3: Pure shell helpers

**Files:**
- Create: `apps/web/src/shell/derive.ts`
- Test: `apps/web/test/shell-derive.test.ts`

**Interfaces:**
- Produces:
  - `type StatusGroup = 'attention' | 'active' | 'done'`;
  - `statusGroup(status: JobStatus): StatusGroup`;
  - `attentionCount(jobs: readonly JobSummary[]): number`;
  - `initials(label: string): string`;
  - `matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import type { JobStatus } from '@ih/shared';
import { attentionCount, initials, matchesQuery, statusGroup } from '../src/shell/derive.js';
import { job } from './fake-api.js';

describe('statusGroup', () => {
  it.each<[JobStatus, string]>([
    ['queued', 'active'],
    ['running', 'active'],
    ['awaiting_review', 'attention'],
    ['needs_review', 'attention'],
    ['failed', 'attention'],
    ['succeeded', 'done'],
    ['rejected', 'done'],
    ['cancelled', 'done'],
  ])('%s → %s', (status, group) => expect(statusGroup(status)).toBe(group));
});

describe('attentionCount', () => {
  it('counts awaiting_review, needs_review and failed', () => {
    const jobs = (['awaiting_review', 'needs_review', 'failed', 'running', 'succeeded'] as const).map(
      (status) => job({ status }),
    );
    expect(attentionCount(jobs)).toBe(3);
    expect(attentionCount([])).toBe(0);
  });
});

describe('initials', () => {
  it.each([
    ['admin', 'AD'],
    ['Ken – laptop', 'KL'],
    ['Ops – review station', 'OR'],
    ['  x  ', 'X'],
    ['élodie b', 'ÉB'],
    ['ci-runner-2', 'CR'],
    ['', '?'],
    ['– –', '?'],
  ])('%j → %s', (label, expected) => expect(initials(label)).toBe(expected));
});

describe('matchesQuery', () => {
  it.each<[string, (string | null)[], boolean]>([
    ['', ['anything'], true],
    ['   ', ['anything'], true],
    ['ACME', ['inv-0042-acme.pdf'], true],
    ['acme 0042', ['inv-0042-acme.pdf', 'supplier-invoice'], true],
    ['acme invoice', ['inv-0042-acme.pdf', 'supplier-invoice'], true],
    ['acme globex', ['inv-0042-acme.pdf'], false],
    ['qwen', [null, 'local/qwen3.8-27b-mtp'], true],
    ['x', [null], false],
  ])('%j in %j → %s', (query, fields, expected) =>
    expect(matchesQuery(query, ...fields)).toBe(expected),
  );
});
```

- [ ] **Step 2: Run it.** Run `npx vitest run apps/web/test/shell-derive.test.ts`. Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `apps/web/src/shell/derive.ts`**

```ts
import type { JobStatus, JobSummary } from '@ih/shared';

/** Which bucket a status belongs to: someone must act, still running, or finished. */
export type StatusGroup = 'attention' | 'active' | 'done';

const GROUP: Record<JobStatus, StatusGroup> = {
  queued: 'active',
  running: 'active',
  awaiting_review: 'attention',
  needs_review: 'attention',
  failed: 'attention',
  succeeded: 'done',
  rejected: 'done',
  cancelled: 'done',
};

export function statusGroup(status: JobStatus): StatusGroup {
  return GROUP[status];
}

/** The nav badge: jobs waiting on a person (reviewer or operator). */
export function attentionCount(jobs: readonly JobSummary[]): number {
  return jobs.filter((j) => statusGroup(j.status) === 'attention').length;
}

/** Avatar initials for a token label: first letters of the first two words, or two letters of one. */
export function initials(label: string): string {
  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Client-side search: every whitespace-separated term must appear (case-insensitively) in some field. */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = fields.filter((f): f is string => !!f).map((f) => f.toLowerCase());
  return terms.every((t) => haystack.some((f) => f.includes(t)));
}
```

- [ ] **Step 4: Run it.** Run `npx vitest run apps/web/test/shell-derive.test.ts`. Expected: PASS. (A `Record<JobStatus, …>` makes a newly added status a compile error.)
- [ ] **Step 5: Commit.** `git commit -m "Web: status groups, attention count, initials and search matching"`

---

### Task 4: App shell (top bar, side nav, jobs poll lifted)

**Files:**
- Create: `apps/web/src/shell/AppShell.tsx`, `apps/web/src/shell/useJobs.ts`
- Modify: `apps/web/src/App.tsx` (`SignedInApp` renders `AppShell`; `JobsView` takes `jobs`, `error`, `refresh` props)
- Test: `apps/web/test/AppShell.test.tsx`; update `apps/web/test/SignIn.test.tsx` (user chip copy)

**Interfaces:**
- Consumes: `ThemeSwitch`, `Icon` (Task 2); `attentionCount`, `initials` (Task 3).
- Produces:
  - `useJobs(api: Api, pollMs: number): { jobs: JobSummary[]; error: string | null; refresh: () => Promise<void> }`.
  - `AppShell({ me, route, jobs, query, onQuery, onUpload, onSignOut, children })`, where `route: Route` and `onUpload: () => void`.
  - The search input has the accessible name `Search jobs, results and document types`.

- [ ] **Step 1: Write the failing tests** (`apps/web/test/AppShell.test.tsx`)

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { fakeApi, job } from './fake-api.js';

afterEach(() => {
  window.location.hash = '';
});

describe('app shell', () => {
  it('has a top bar with search, colour mode, Upload PDF and the signed-in token', async () => {
    const api = fakeApi({
      me: vi.fn(async () => ({ role: 'user' as const, label: 'Ken – laptop', expiresAt: null })),
    });
    render(<App api={api} pollMs={0} />);
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('searchbox', { name: 'Search jobs, results and document types' })).toBeInTheDocument();
    expect(within(banner).getByRole('group', { name: 'Colour mode' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Upload PDF' })).toBeInTheDocument();
    expect(within(banner).getByRole('group', { name: 'Signed in as Ken – laptop (user)' })).toHaveTextContent('KL');
    expect(within(banner).getByRole('link', { name: 'Ingestion Harness' })).toHaveAttribute('href', '#/');
  });

  it('badges Jobs with the number of jobs needing attention', async () => {
    const api = fakeApi({
      listJobs: vi.fn(async () =>
        (['awaiting_review', 'failed', 'running', 'succeeded'] as const).map((status) => job({ status })),
      ),
    });
    render(<App api={api} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(await within(nav).findByText('2 need attention')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /^Jobs/ })).toHaveAttribute('aria-current', 'page');
  });

  it('shows no badge when nothing needs attention', async () => {
    render(<App api={fakeApi({ listJobs: vi.fn(async () => [job({ status: 'succeeded' })]) })} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await screen.findByText('invoice.pdf');
    expect(within(nav).queryByText(/need attention/)).not.toBeInTheDocument();
  });

  it('marks the parent page current on child screens', async () => {
    window.location.hash = '#/templates/x/1';
    render(<App api={fakeApi()} pollMs={0} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Document types' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: /^Jobs/ })).not.toHaveAttribute('aria-current');
  });

  it('focuses search on Ctrl+K, not on a plain k', async () => {
    render(<App api={fakeApi()} pollMs={0} />);
    const search = await screen.findByRole('searchbox', { name: 'Search jobs, results and document types' });
    await userEvent.keyboard('k');
    expect(search).not.toHaveFocus();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(search).toHaveFocus();
    await userEvent.type(search, 'acme{Escape}');
    expect(search).toHaveValue('');
  });
});
```

- [ ] **Step 2: Update the existing sign-in tests to the new chip.** This is a deliberate copy change, not a weakened test: the chip shows the label and role separately and names the group.
  - In `SignIn.test.tsx` 'asks for a token…', replace `expect(screen.getByText('Ken – laptop · user'))…` with `expect(screen.getByRole('group', { name: 'Signed in as Ken – laptop (user)' })).toBeInTheDocument();`.
  - In 'shows the Access link to admins only', replace `getByText('admin · admin')` with `getByRole('group', { name: 'Signed in as admin (admin)' })`, and `findByText('Ken · user')` with `findByRole('group', { name: 'Signed in as Ken (user)' })`.

- [ ] **Step 3: Run it.** Run `npx vitest run apps/web/test/AppShell.test.tsx apps/web/test/SignIn.test.tsx`. Expected: FAIL. There is no `banner`, no searchbox, no group named "Signed in as …".

- [ ] **Step 4: Implement**

`apps/web/src/shell/useJobs.ts` (moved out of `JobsView`, unchanged behaviour):

```ts
import { useCallback, useEffect, useState } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Api } from '../api/client.js';

/** The jobs poll, shared by the nav badge and the Jobs page. pollMs <= 0 = load once (tests). */
export function useJobs(api: Api, pollMs: number) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setJobs(await api.listJobs());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return { jobs, error, refresh };
}
```

`apps/web/src/shell/AppShell.tsx`:

```tsx
import { useEffect, useRef, type ReactNode } from 'react';
import type { JobSummary } from '@ih/shared';
import type { Me } from '../api/client.js';
import type { Route } from '../router.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { ThemeSwitch } from '../ui/ThemeSwitch.js';
import { attentionCount, initials } from './derive.js';

type Section = 'jobs' | 'results' | 'templates' | 'access';

/** Child screens highlight their parent: Review → Jobs, Editor → Document types, Result → Results. */
const SECTION: Record<Route['name'], Section> = {
  jobs: 'jobs',
  review: 'jobs',
  results: 'results',
  result: 'results',
  templates: 'templates',
  template: 'templates',
  access: 'access',
};

function NavLink({
  href, icon, label, current, children,
}: { href: string; icon: IconName; label: string; current: boolean; children?: ReactNode }) {
  return (
    <a href={href} aria-current={current ? 'page' : undefined}>
      <Icon name={icon} size={18} />
      <span className="nav-label">{label}</span>
      {children}
    </a>
  );
}

export function AppShell({
  me, route, jobs, query, onQuery, onUpload, onSignOut, children,
}: {
  me: Me;
  route: Route;
  jobs: readonly JobSummary[];
  query: string;
  onQuery: (query: string) => void;
  onUpload: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const search = useRef<HTMLInputElement>(null);
  const section = SECTION[route.name];
  const attention = attentionCount(jobs);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app-shell">
      <header className="top-bar">
        <a className="brand" href="#/">
          <span className="brand-mark"><Icon name="brand" size={18} /></span>
          Ingestion Harness
        </a>
        <label className="search">
          <Icon name="search" />
          <input
            ref={search}
            type="search"
            aria-label="Search jobs, results and document types"
            placeholder="Search jobs, results, document types…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onQuery('');
            }}
          />
          <kbd aria-hidden="true">Ctrl K</kbd>
        </label>
        <div className="top-actions">
          <ThemeSwitch />
          <button type="button" className="primary" onClick={onUpload}>
            <Icon name="upload" />
            Upload PDF
          </button>
          <div className="user-chip" role="group" aria-label={`Signed in as ${me.label} (${me.role})`}>
            <span className="avatar" aria-hidden="true">{initials(me.label)}</span>
            <span className="who" aria-hidden="true">
              <span>{me.label}</span>
              <small>{me.role}</small>
            </span>
            <button type="button" className="icon" aria-label="Sign out" title="Sign out" onClick={onSignOut}>
              <Icon name="signOut" size={18} />
            </button>
          </div>
        </div>
      </header>
      <div className="app-body">
        <nav className="side-nav" aria-label="Main">
          <NavLink href="#/" icon="jobs" label="Jobs" current={section === 'jobs'}>
            {attention > 0 && (
              <span className="nav-badge">
                <span aria-hidden="true">{attention}</span>
                <span className="visually-hidden">{attention} need attention</span>
              </span>
            )}
          </NavLink>
          <NavLink href="#/results" icon="results" label="Results" current={section === 'results'} />
          <NavLink href="#/templates" icon="types" label="Document types" current={section === 'templates'} />
          {me.role === 'admin' && (
            <>
              <span className="nav-heading">Admin</span>
              <NavLink href="#/access" icon="key" label="Access" current={section === 'access'} />
            </>
          )}
        </nav>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
```

`App.tsx`: `SignedInApp` keeps the existing route-to-page selection and now does the following.

```tsx
  const route = useHashRoute();
  const { jobs, error, refresh } = useJobs(api, pollMs);
  const [query, setQuery] = useState('');
  // … page selection as before, JobsView now gets jobs/error/refresh/query/pickRequest …
  return (
    <AppShell me={me} route={route} jobs={jobs} query={query} onQuery={setQuery}
      onUpload={() => { navigate('#/'); setPickRequest((n) => n + 1); }} onSignOut={onSignOut}>
      {page}
    </AppShell>
  );
```

  - **`JobsView`:** drops its own polling state and reads the props instead.
  - **`pickRequest` and the `query` filtering:** the state is declared here, but its behaviour
    lands in Tasks 5 and 6. Until then, pass `query` through unused and keep `pickRequest` at 0.
  - **Old markup:** remove the old `<main className=…>` and `nav.top-nav` markup.
  - **The `wide` class:** drop it. Every page now uses the full content width, and the editor and
    results pages already set their own layout.

- [ ] **Step 5: Run it.** Run `npx vitest run --project web`. Expected: all web tests pass. If an existing test queries the nav link `Jobs` by exact name, switch it to `/^Jobs/` (the badge adds text to the name). No existing test does at the time of writing.
- [ ] **Step 6: Commit.** `git commit -m "Web: app shell with top bar, side nav, attention badge and Ctrl K search focus"`

---

### Task 5: Search filters the current list

**Files:**
- Modify: `apps/web/src/App.tsx` (`JobsView`), `apps/web/src/templates/TemplatesPage.tsx`, `apps/web/src/results/ResultsPage.tsx`, `apps/web/src/access/AccessPage.tsx`
- Test: `apps/web/test/AppShell.test.tsx` (new `describe('search')`)

**Interfaces:**
- Consumes: `matchesQuery` (Task 3).
- Produces: an optional `query?: string` prop on `TemplatesPage`, `ResultsPage` and `AccessPage` (default `''`).
- **Field sets:**
  - Jobs: `filename`, `specId`, `modelOverride`, `...modelsUsed`, `status`.
  - Document types: `id`, `name`.
  - Results: `filename`, `specId`. These are the loaded rows only; PR 4 moves this to the API's `q`.
  - Access: `label`, `role`.

- [ ] **Step 1: Write the failing tests**

```tsx
describe('search', () => {
  it('filters jobs and says when nothing matches', async () => {
    const api = fakeApi({
      listJobs: vi.fn(async () => [
        job({ filename: 'inv-0042-acme.pdf' }),
        job({ filename: 'coa-lot-7781.pdf', specId: 'certificate' }),
      ]),
    });
    render(<App api={api} pollMs={0} />);
    await screen.findByText('coa-lot-7781.pdf');
    const search = screen.getByRole('searchbox', { name: 'Search jobs, results and document types' });
    await userEvent.type(search, 'acme');
    expect(screen.getByText('inv-0042-acme.pdf')).toBeInTheDocument();
    expect(screen.queryByText('coa-lot-7781.pdf')).not.toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'globex');
    expect(screen.getByText('No jobs match “globex”.')).toBeInTheDocument();
    expect(screen.queryByText('No jobs yet.')).not.toBeInTheDocument();
  });

  it('filters document types by name or id', async () => {
    window.location.hash = '#/templates';
    const api = fakeApi({
      listTemplates: vi.fn(async () => [
        { id: 'supplier-invoice', name: 'Supplier invoice', published: 3, draft: null },
        { id: 'coa', name: 'Certificate of analysis', published: 2, draft: null },
      ]),
    });
    render(<App api={api} pollMs={0} />);
    await screen.findByText('Certificate of analysis');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search jobs, results and document types' }), 'invoice');
    expect(screen.getByText('Supplier invoice')).toBeInTheDocument();
    expect(screen.queryByText('Certificate of analysis')).not.toBeInTheDocument();
  });

  it('filters access tokens by label', async () => {
    window.location.hash = '#/access';
    const api = fakeApi({
      listTokens: vi.fn(async () => [
        { id: '1', label: 'Ken – laptop', role: 'user' as const, createdAt: '', expiresAt: null, revokedAt: null, lastUsedAt: null, status: 'active' as const },
        { id: '2', label: 'Ops station', role: 'user' as const, createdAt: '', expiresAt: null, revokedAt: null, lastUsedAt: null, status: 'active' as const },
      ]),
    });
    render(<App api={api} pollMs={0} />);
    await screen.findByText('Ops station');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search jobs, results and document types' }), 'ken');
    expect(screen.getByText('Ken – laptop')).toBeInTheDocument();
    expect(screen.queryByText('Ops station')).not.toBeInTheDocument();
  });

  it('filters loaded results by file name', async () => {
    window.location.hash = '#/results';
    render(<App api={fakeApi()} pollMs={0} />);
    // uses the fakeApi listResults default rows; see Step 3 note
  });
});
```

  - **`TemplateListItem` fixture:** check its actual shape in `client.ts` before running, and
    match the fixture to it.
  - **The results test:** first set `fakeApi({ listResults: vi.fn(async () => ({ items: [resultSummary({ filename: 'a-acme.pdf' }), resultSummary({ filename: 'b-globex.pdf' })], … })) })`,
    using the existing results fixture (`test/result-fixture.ts`) and the real
    `listResults` return type.
  - **Then assert:** typing `acme` hides `b-globex.pdf` and keeps `a-acme.pdf`.

- [ ] **Step 2: Run it.** Run `npx vitest run apps/web/test/AppShell.test.tsx -t search`. Expected: FAIL, because nothing is filtered.

- [ ] **Step 3: Implement.**

  `JobsView`:

```tsx
  const shown = jobs.filter((j) =>
    matchesQuery(query, j.filename, j.specId, j.modelOverride, j.status, ...j.modelsUsed),
  );
  // …
  {jobs.length > 0 && shown.length === 0 ? (
    <p>No jobs match “{query.trim()}”.</p>
  ) : (
    <JobsTable api={api} jobs={shown} onChanged={refresh} retryModel={retryModel} />
  )}
```

  `TemplatesPage`: `const shown = items.filter((t) => matchesQuery(query, t.id, t.name));`. Render
  `shown` in place of `items`. When `items` isn't empty but `shown` is, show
  `No document types match “{query.trim()}”.`.

  `ResultsPage`: `rows.filter((r) => matchesQuery(query, r.filename, r.specId))`, with the same
  empty-match message, "No results match …".

  `AccessPage`: `tokens.filter((t) => matchesQuery(query, t.label, t.role))`.

  In `App.tsx`, pass `query={query}` to all four.

- [ ] **Step 4: Run it.** Run `npx vitest run --project web`. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "Web: top-bar search filters jobs, document types, results and tokens"`

---

### Task 6: Upload PDF opens the file picker on Jobs

**Files:**
- Modify: `apps/web/src/App.tsx`, `apps/web/src/components/UploadForm.tsx`
- Test: `apps/web/test/AppShell.test.tsx`

**Interfaces:**
- Produces: a new `UploadForm` prop, `pickRequest?: number`. Each increase above the previously
  seen value opens the file picker once.

- [ ] **Step 1: Write the failing test**

```tsx
it('Upload PDF goes to Jobs and opens the file picker once', async () => {
  window.location.hash = '#/results';
  const click = vi.spyOn(HTMLInputElement.prototype, 'click');
  render(<App api={fakeApi()} pollMs={0} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Upload PDF' }));
  const input = await screen.findByLabelText('PDF');
  await vi.waitFor(() => expect(click.mock.contexts).toContain(input));
  expect(window.location.hash).toBe('#/');
  const opened = click.mock.contexts.filter((c) => c === input).length;
  // leaving and returning to Jobs must not reopen the picker
  window.location.hash = '#/results';
  await screen.findByRole('heading', { name: 'Results' });
  window.location.hash = '#/';
  await screen.findByLabelText('PDF');
  expect(click.mock.contexts.filter((c) => c instanceof HTMLInputElement && c.type === 'file')).toHaveLength(opened);
  click.mockRestore();
});
```

Confirm that the Results page heading name is "Results" before running. If it differs, use the
heading the page actually renders.

- [ ] **Step 2: Run it.** Run `npx vitest run apps/web/test/AppShell.test.tsx -t "Upload PDF"`. Expected: FAIL, because the picker is never clicked.

- [ ] **Step 3: Implement**
  - **`App.tsx`:**
    - `const [pickRequest, setPickRequest] = useState(0)`, which lives in `SignedInApp` and
      outlives `JobsView`;
    - `onUpload` calls `navigate('#/')` and then `setPickRequest((n) => n + 1)`;
    - `JobsView` passes `pickRequest` to `UploadForm`.
  - **`UploadForm`:** remember the last request it served in a module-level `let served = 0`. A
    `useRef` would reset on every remount, so a re-mounted Jobs page would reopen the picker.

```tsx
/** Highest Upload PDF request already served; module-level so a re-mounted form doesn't re-open. */
let served = 0;
// in the component:
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (pickRequest > served) {
      served = pickRequest;
      fileInput.current?.click();
    }
  }, [pickRequest]);
// and on the file input: ref={fileInput}
```

  A module-level `served` would leak between tests that use fresh `App` instances, because
  `pickRequest` restarts at 0. That's fine, since every request number in a test exceeds 0 only
  after a click. To be safe, also export `resetPickRequests()` for tests, and call it in
  `test/setup.ts`'s `afterEach`.

- [ ] **Step 4: Run it.** Run `npx vitest run --project web`. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "Web: Upload PDF in the top bar opens the file picker on Jobs"`

---

### Task 7: Sign in, loading and unreachable screens

**Files:**
- Modify: `apps/web/src/access/SignIn.tsx`, `apps/web/src/App.tsx` (unreachable + loading markup)
- Test: `apps/web/test/SignIn.test.tsx`

**Interfaces:**
- Consumes: `ThemeSwitch`, `Icon`.
- Produces: `AuthLayout({ children })` (exported from `SignIn.tsx`). It is the full-screen
  dot-grid layout with the colour-mode switch top-right and the brand mark, and `App.tsx` reuses
  it for the loading and unreachable states.

- [ ] **Step 1: Write the failing tests.** Add the following to `SignIn.test.tsx`, and change the
  ended assertion to the new copy (a deliberate copy change).

```tsx
  it('returns to sign-in when the session ends mid-use', async () => {
    const api = fakeApi();
    render(<App api={api} pollMs={0} />);
    await screen.findByText('No jobs yet.');
    act(() => api.expireSession());
    expect(await screen.findByLabelText('Access token')).toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Your session has ended');
    expect(status).toHaveTextContent(
      'It expired, was revoked, or the admin token rotated. Sign in again to continue.',
    );
  });

  it('shows and hides the token', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    const field = await screen.findByLabelText('Access token');
    const toggle = screen.getByRole('button', { name: 'Show token' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(field).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide token' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Hide token' }));
    expect(field).toHaveAttribute('type', 'password');
  });

  it('marks the field invalid on an error and clears it on edit', async () => {
    const api = fakeApi({
      me: vi.fn(async () => null),
      login: vi.fn(async () => {
        throw statusError(401, 'nope');
      }),
    });
    render(<App api={api} pollMs={0} />);
    const field = await screen.findByLabelText('Access token');
    await userEvent.type(field, 'ih_x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await userEvent.type(field, 'y');
    expect(field).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers the colour mode switch and the admin hint before sign-in', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => null) })} pollMs={0} />);
    expect(await screen.findByRole('group', { name: 'Colour mode' })).toBeInTheDocument();
    expect(
      screen.getByText(/the admin token is printed in the API log on each restart/),
    ).toBeInTheDocument();
  });
```

The existing tests stay as they are: the 401/429 copy, sign out, admins-only Access link and
unreachable/Retry.

- [ ] **Step 2: Run it.** Run `npx vitest run apps/web/test/SignIn.test.tsx`. Expected: FAIL, because there is no toggle, no `aria-invalid`, no colour mode on sign-in, and the old ended copy.

- [ ] **Step 3: Implement `SignIn.tsx`**

```tsx
import { useState, type FormEvent, type ReactNode } from 'react';
import type { Api, Me } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { ThemeSwitch } from '../ui/ThemeSwitch.js';

function message(err: unknown): string {
  const status = (err as { status?: number }).status;
  if (status === 401) return 'That token is invalid or has expired.';
  if (status === 429) return 'Too many attempts. Try again in a few minutes.';
  return `Sign-in failed: ${(err as Error).message}`;
}

/** Full-screen layout for screens outside the app shell (sign in, loading, unreachable). */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-top">
        <ThemeSwitch />
      </div>
      <main className="auth-main">
        <div className="auth-column">
          <div className="auth-brand">
            <span className="brand-mark large"><Icon name="brand" size={26} /></span>
            <h1>Ingestion Harness</h1>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

export function SignIn({ api, ended, onSignedIn }: { api: Api; ended: boolean; onSignedIn: (me: Me) => void }) {
  const [token, setToken] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(token.trim()));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <form className="card auth-card" onSubmit={submit} aria-label="Sign in">
        {ended && (
          <div role="status" className="callout tone-info">
            <Icon name="clock" size={18} />
            <span>
              <strong>Your session has ended</strong>
              <span>It expired, was revoked, or the admin token rotated. Sign in again to continue.</span>
            </span>
          </div>
        )}
        <label className="token-field">
          Access token
          <span className={error ? 'token-input invalid' : 'token-input'}>
            <Icon name="key" size={18} />
            <input
              type={shown ? 'text' : 'password'}
              autoComplete="off"
              autoFocus
              placeholder="Paste your token"
              aria-invalid={error !== null}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setError(null);
              }}
            />
            <button
              type="button"
              className="icon"
              aria-label={shown ? 'Hide token' : 'Show token'}
              aria-pressed={shown}
              onClick={() => setShown((s) => !s)}
            >
              <Icon name={shown ? 'eyeOff' : 'eye'} size={18} />
            </button>
          </span>
        </label>
        {error && (
          <p role="alert" className="field-error">
            <Icon name="alert" />
            {error}
          </p>
        )}
        <button type="submit" className="primary block" disabled={busy || !token.trim()}>
          Sign in
        </button>
      </form>
      <p className="auth-hint">
        Ask an administrator for an access token.
        <br />
        Administrators: the admin token is printed in the API log on each restart.
      </p>
    </AuthLayout>
  );
}
```

  **Note on the toggle's label.** The show/hide button sits inside the `<label>`, so its text
  could leak into the label's accessible name. Testing Library computes the field's name from the
  label's text content, and an icon-only button contributes nothing (the SVG is `aria-hidden`).
  If `getByLabelText('Access token')` then fails anyway, give the input `id="access-token"`, add
  a `<label htmlFor>` containing only the text, and move the wrapper `span` out of the label.

  **`App.tsx`:** wrap the unreachable state and "Loading…" in `<AuthLayout>`. Keep the
  `role="alert"` text "Can't reach the server (…)." and the `Retry` button.

- [ ] **Step 4: Run it.** Run `npx vitest run --project web`. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "Web: restyled sign in with colour mode, show/hide token and inline error state"`

---

### Task 8: Base styles on the tokens, visual check, docs

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `CLAUDE.md` (Layout / Rules: a one-line UI note)

CSS has no unit tests. This task is verified in the browser pane against the screenshots, in
light, dark and System, at 1440 px and 390 px.

- [ ] **Step 1: Rewrite `styles.css` on the tokens.** Keep every existing layout class
  (`.review-body`, `.row-table`, `.form-rows`, `.step-prompts`, `.job-cleanup`, `.new-token`,
  etc.). Change only the following, plus the new shell and auth rules.
  - **Base:**
    - `body`: `margin: 0; background: var(--ih-bg); color: var(--ih-text); font: 400 var(--ih-text-base)/1.45 var(--ih-font-sans)`.
    - `code, kbd, .mono, input.code, textarea.code`: `font-family: var(--ih-font-mono)`.
    - `h1`: 22 px, 600.
    - `a`: `var(--ih-accent-soft-text)`.
  - **Controls:**
    - `input`, `select`, `textarea`: 40 px height (textareas auto), `1px solid var(--ih-border)`,
      `var(--ih-radius-md)`, `background: var(--ih-surface2)`, `color: inherit`, `font: inherit`;
      focus ring `outline: 2px solid var(--ih-accent); outline-offset: 1px`.
    - `button`: secondary style, `height: var(--ih-control-h)`, `padding: 0 14px`,
      `border: 1px solid var(--ih-border-strong)`, `radius: var(--ih-radius-md)`,
      `background: transparent`, `color: var(--ih-text)`, weight 500.
    - `button.primary`: accent fill.
    - `button.danger`: danger text.
    - `button.icon`: 40×40, borderless, muted.
    - `button.block`: full width, 46 px.
    - `button:disabled`: `opacity: .55`.
    - `button.link`: keep it, but recolour to `var(--ih-accent-soft-text)`.
  - **Tables:** `th` 12 px, 500, muted; `td`/`th` `border-bottom: 1px solid var(--ih-border-soft)`.
  - **Hard-coded colours:** replace each one (`#1a7f37`, `#cf222e`, `#9a6700`, `#0969da`,
    `#57606a`, `#fff`, …) with the tone tokens (`--ih-ok-fg`, `--ih-danger-fg`, `--ih-warn-fg`,
    `--ih-info-fg`, `--ih-neutral-fg`, `--ih-paper`).
    - `.status-*` become pills: `display: inline-flex; padding: 2px 8px; border-radius: var(--ih-radius-pill); font-size: 12px; font-weight: 500` with the matching `--ih-<tone>-bg/fg`.
    - **Tone mapping:**

      | Status | Tone |
      |---|---|
      | queued | neutral |
      | running | info |
      | awaiting_review | warn |
      | needs_review | alert |
      | failed | danger |
      | succeeded | ok |
      | rejected, cancelled | neutral |
  - **Shell:**
    - `.app-shell` is a column flex at `min-height: 100vh`.
    - `.top-bar` is the design-source header: flex-wrap, `gap: 12px 20px`, `padding: 12px 24px`,
      surface background, bottom border.
    - `.brand` and `.brand-mark` (30 px accent square, 7 px radius; `.large` 48 px, 12 px radius).
    - `.search` is `flex: 1 1 260px; max-width: 520px`, 40 px, surface2.
    - `.top-actions` has `margin-left: auto`.
    - `.user-chip` has a left border, and the `.avatar` is a 32 px circle in neutral tone.
  - **Body and nav:**
    - `.app-body` is `flex: 1; display: flex; flex-wrap: wrap`.
    - `.side-nav` is `flex: 1 1 220px`, a column, `gap: 4px`, `padding: 20px 12px`, surface
      background with a right border.
    - Nav `a` items are 44 px, 12 px gap, 8 px radius, no underline, text colour; when
      `[aria-current=page]`, `background: var(--ih-accent-soft); color: var(--ih-accent-soft-text); font-weight: 600`.
    - `.nav-badge` is a 22 px warn pill.
    - `.nav-heading` is 11 px uppercase muted, `margin: 16px 12px 4px`.
  - **Page and segmented:**
    - `.page` is `flex: 999 1 640px; min-width: 0; padding: 24px 28px 40px`.
    - `.segmented` is the design-source group (3 px padding, 9 px radius, surface2). Its
      `button[aria-pressed=true]` uses `var(--ih-seg-active)` + `var(--ih-seg-shadow)`.
  - **Auth screens:**
    - `.auth` is the dot grid:
      `background-image: radial-gradient(var(--ih-border) 1px, transparent 1.2px); background-size: 22px 22px`.
    - `.auth-column` is `max-width: 420px`.
    - `.card` is the surface with a 14 px radius, `--ih-shadow-card` and 28 px padding.
    - `.callout.tone-info` uses the info bg/fg.
    - `.token-input` is the 46 px bordered row; `.invalid` gets a danger border.
    - `.field-error` uses the danger fg.
  - **Utility:** `.visually-hidden` is the standard clip pattern.
  - **Small screens:** under `@media (max-width: 640px)`, `.page` padding drops to 16 px and
    `.top-bar` padding to `12px 16px`.

- [ ] **Step 2: Check it visually.**
  - **Run:** start `npm run dev:web` against a `fakeApi`-free dev API, or reuse the earlier
    approach: Vite with `VITE_API_PROXY` pointed at a local API on a scratch Postgres.
  - **Compare:** the Jobs page and Sign in against `01-jobs.png` and `07/08/09-sign-in*.png`, in
    light and dark, at 1440 and 390 px.
  - **At 390 px:** no horizontal page scroll (`document.documentElement.scrollWidth <= innerWidth`).
  - **Existing pages still readable in both themes:** Review, Results, Document types, Editor
    and Access.
  - **Fix and re-check:** fix anything broken, then check again.

- [ ] **Step 3: Update `CLAUDE.md`.** Add one rule under "Rules of the road":
  `- **UI:** design tokens in `apps/web/src/styles/tokens.css` (light/dark; theme in `ih.theme` via `theme.ts`), shared primitives in `apps/web/src/ui/`, app shell in `apps/web/src/shell/`; the redesign handoff is `docs/design/ui-redesign/`.`

- [ ] **Step 4: Run the full check.** Run `npm run check` and `npm run format:check`. Expected: green.
- [ ] **Step 5: Commit.** `git commit -m "Web: base styles on design tokens, shell and sign-in layout; CLAUDE.md UI note"`
