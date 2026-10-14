# Installable app (PWA)

Content Transformation Studio (CT Studio) can be installed from Edge or Chrome as an app. On
Windows it gets its own window, a Start menu entry, a taskbar icon with shortcuts, and an entry
in Explorer's **Open with** menu for PDF and Word files. It is the same web app, served by the same
nginx. Nothing is installed from a store, and an installed copy always runs the build the server
is serving.

## Installing

The site must be served over HTTPS (the outer proxy does this) or from `localhost`. Browsers never
offer install on plain `http://` to another host.

- **Edge:** the *App available* icon in the address bar, or **…** → **Apps** → **Install CT
  Studio**.
- **In the app:** the install button at the top right (monitor with a down arrow, *Install CT
  Studio*), and for admins the same item in the account menu. Both show only while the browser
  offers install (`beforeinstallprompt`), so they go away once it is installed.
- **Across an organisation:** IT can install it on every machine with the Edge policy
  [`WebAppInstallForceList`](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies#webappinstallforcelist)
  (`url` = the site's address, `default_launch_container` = `window`).

To uninstall: right-click the app in Start → **Uninstall**, or `edge://apps`.

## What the manifest declares (`apps/web/public/site.webmanifest`)

| Member | Value | Why |
| --- | --- | --- |
| `id` | `/` | The installed app's identity. **Never change it**: a new `id` makes Windows see a different app, and existing installs stop receiving manifest updates. |
| `start_url`, `scope` | `/` | The whole site; the router uses the hash (`#/jobs`), which stays in scope. |
| `display_override` | `window-controls-overlay`, `standalone` | The top bar is drawn into the title bar; the window's chevron switches back to a plain title bar. |
| `icons` | 48, 64, 128, 192, 256, 512, maskable 512 | The small sizes keep the taskbar and Start icons sharp at every Windows scale. 48-256 are the brand PNGs (`docs/brand/png`). |
| `shortcuts` | Upload documents (`/#/upload`), Jobs, Workbench | Right-click on the taskbar icon. Icons `shortcut-*.png` (96 px) use the nav glyphs on the brand tile. |
| `file_handlers` | `.pdf`, `.docx` → `/` | **Open with → CT Studio** in Explorer. Exactly what `SOURCE_ACCEPT` takes (a test holds them in step). Windows asks the person to allow it the first time. |
| `launch_handler` | `focus-existing` | Files and shortcuts go to the window already open instead of a new one. |
| `screenshots` | wide 1280×800, narrow 540×960 | The richer install dialog. Synthetic data only, never real documents. |

## Launches (`apps/web/src/pwa/launch.ts`)

Chromium hands every launch of the installed app to `window.launchQueue`. `main.tsx` sets the
consumer before the first render, so no launch is lost:

- **Files** (Open with): read from their handles into `LaunchedFiles`, a small store that keeps
  them until the upload strip takes them. A launch before sign-in waits for it. `App` goes to Home
  from any other page, and the files join the upload list exactly as if dropped there. Anything
  that is not a PDF or Word document is listed as *Not a PDF or Word document* and skipped. The
  person still picks the document type and presses **Upload**: nothing is uploaded by itself.
- **Shortcuts** in a reused window: the browser does not navigate it (`focus-existing`), so the
  consumer goes to the shortcut's hash itself. The same hash again is announced too (`goTo`), so
  pressing *Upload documents* twice focuses the strip twice.

`#/upload` is Home with the file chooser focused. Browsers only open a file dialog after a click
or a key press, so a shortcut cannot open it: it leaves it one key (Enter or Space) or click away.

## Service worker (`apps/web/public/sw.js`)

The worker does one thing: when a page load (a navigation) cannot reach the server, because there
is no network or a proxy answers 502, 503 or 504, it shows `offline.html` instead of the browser's
error page. It is registered only in production builds (`pwa/register.ts`), after the page loads.

**What it never does:**

- It never answers anything but page loads. `/api/*` (the live job stream, uploads, the 650 MB
  bundle import), `/assets/*`, the manifest and the icons always go straight to the network.
- It never caches the app. Only `offline.html` is cached, so a deploy can never leave anyone on an
  old build: `index.html` stays `no-cache` and the hashed assets stay immutable, as before.
- It never loads `/api/docs/` (a page on the API) from anywhere but the network.

`offline.html` is self-contained (inline styles, the mark as inline SVG, no requests) and follows
the app's colour mode (`ih.theme`). It is cached under `ct-offline-v1`: **bump `CACHE` in `sw.js`
whenever `offline.html` changes**; the new worker drops the old cache on activate. The worker
activates straight away (`skipWaiting`, `clients.claim`), which is safe because nothing it caches
depends on the build.

## Title bar (window controls overlay)

In `@media (display-mode: window-controls-overlay)` (`styles.css`) the top bar is the title bar:
its empty space drags the window (`app-region: drag`), its controls stay clickable (`no-drag`),
and its right padding keeps clear of the minimise, maximise and close buttons the OS draws there
(`env(titlebar-area-x)`, `env(titlebar-area-width)`). The window frame colour comes from the
`theme-color` metas in `index.html` (light and dark).

## Serving (`deploy/docker/nginx.conf`)

nginx's `mime.types` has no `.webmanifest`, so `location = /site.webmanifest` names
`application/manifest+json`. The manifest and `sw.js` are `no-cache`, so changes reach installed
copies on the browser's next check (the browser checks the manifest of an installed app at most
about once a day; icon changes need new file names to show up sooner). The smoke test checks the
types, the caching and the security headers.

## Tests

- `test/web-manifest.test.ts`: the install fields, every icon, shortcut icon and screenshot at its
  claimed size, shortcuts routing where they say, file handlers equal to `SOURCE_ACCEPT`, the
  offline page self-contained.
- `test/service-worker.test.ts`: runs `public/sw.js` in a fake worker scope (Node `vm`): what it
  leaves alone, network first, the offline page on a network error or a 502-504.
- `test/pwa.test.ts`: `LaunchedFiles`, `consumeLaunches`, `goTo`, `InstallPrompt`,
  `registerServiceWorker`.
- `test/pwa-app.test.tsx`: opened files reach the upload strip (after sign-in, from another page),
  `#/upload` focuses the chooser, the install button and menu item.

## Checking it by hand on Windows

`localhost` counts as secure, so the Docker stack on `http://localhost:8080` can be installed
without the proxy. After a change:

1. Install from Edge; the app opens in its own window with the top bar in the title bar.
2. Start menu and taskbar icons are sharp; right-click the taskbar icon: the three shortcuts work,
   also with the window already open.
3. Right-click a PDF and a `.docx` in Explorer → **Open with** → **CT Studio**: they appear in
   the upload strip on Home (sign in first if asked).
4. Stop the app container: reloading shows the offline page; start it again and **Try again**.
5. Toggle the title bar chevron, and check light and dark.
6. Uninstall from Start.
