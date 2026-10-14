# CT Studio — brand kit

**Content Transformation Studio** (short name **CT Studio**). Mark: option C, "Studio C with data" —
an open C holding data cells.

## Naming rules

| Where | Use |
| --- | --- |
| In the app (header, sign-in, browser tab title, PWA `short_name`, emails sent by the app) | **CT Studio** |
| Documentation, release notes, README titles, slide titles, first mention anywhere written | **Content Transformation Studio** — then "CT Studio" afterwards is fine: "Content Transformation Studio (CT Studio)" |
| Code, packages, repo, env vars, Docker images | Unchanged for now (`ingestion-harness`, `@ih/*`, `ih.*` storage keys) — renaming those is a separate, breaking change |

Browser tab titles: `<Page> · CT Studio` (e.g. "Jobs · CT Studio").
The header brand link carries `aria-label="CT Studio — Content Transformation Studio, home"`
and `title="Content Transformation Studio"` so the full name is available on hover and to
screen readers.

## Terminology

| Term | Means |
| --- | --- |
| **Transformation recipe** (short: **recipe**) | The definition that turns a document of a type into outputs: its outputs (fields and typed tables), layout (sections and anchors), pipeline steps, review policy and default model. Versioned: a draft is editable, a published version is immutable. |
| **Document type** | The kind of document a recipe reads (e.g. "Analytical Method Validation Report"). Each type has numbered versions of its recipe. |

Use the long form, "transformation recipe", where there is room (first mention, headings,
docs); use "recipe" afterwards and in tight UI (tabs, buttons, nav). Keep both terms: "document
type" for the kind of document, "recipe" for its definition.

Code names stay `template`, just as code names stay `ingestion-harness`: API paths
(`/api/templates/…`), the `templates` table, `template.yaml` files, and the `Template` type in
`@ih/shared`. Renaming those is a separate, breaking change.

## The mark

Tile 64×64 viewBox, corner radius 15 (14 at 32 px, 12 at 16 px). Three geometries — always use
the one made for the size, never scale the large one down:

| Geometry | Use at | Arc stroke | Cells |
| --- | --- | --- | --- |
| Full (`ct-studio-icon-*.svg`) | ≥ 64 px, docs, splash, app stores | 5.5 | three cells, stroke 2.6 |
| Small (`ct-studio-icon-small-*.svg`) | 24–48 px — app header (30 px), sign-in (52 px), inline in docs | 7 | one cell, stroke 4 |
| Tiny (in `favicon.ico` 16 px) | 16 px | 8 | one cell, stroke 5 |

Colours (match the app tokens): light tile `#0A5BB0` with white glyph; dark tile `#5EA3EE` with
glyph `#061321`. Monochrome glyph-only versions for print, watermarks and single-colour use.

Clear space: at least ¼ of the tile width on every side. Minimum size: 16 px (tiny geometry).
Don't recolour the glyph to anything other than the pairs above, don't add effects, don't place
the light tile on blue backgrounds (use the mono white glyph instead).

## Lockups

| File | Use |
| --- | --- |
| `svg/ct-studio-lockup-app-*.svg` | Mark + "CT Studio" — product UI contexts, slides about the app |
| `svg/ct-studio-lockup-docs-*.svg` | Mark + "Content Transformation / Studio" (two lines, "Studio" in accent) — document covers, headers, Confluence/SharePoint pages |
| `png/*@3x.png` | The same lockups as PNG for Word / PowerPoint |

Lockup SVGs embed IBM Plex Sans 600 (latin subset), so they render correctly without the font
installed.

## Files

```
BRAND.md                         this file
svg/  ct-studio-icon-{light,dark}.svg          full geometry
      ct-studio-icon-small-{light,dark}.svg    small geometry
      ct-studio-glyph-mono-{black,white}.svg   glyph only
      ct-studio-lockup-{app,docs}-{light,dark}.svg
png/  ct-studio-icon-{16,32,48,64,128,256}.png
      ct-studio-lockup-*@3x.png
web/  favicon.ico (16/32/48)  favicon.svg (switches to the dark tile in dark OS mode)
      apple-touch-icon.png (180, full-bleed)  icon-192.png  icon-512.png  icon-maskable-512.png
      site.webmanifest  head-snippet.html
      (in the app, apps/web/public/, also icon-{48,64,128,256}.png from png/, shortcut-*.png and
      screenshot-*.png for the installed app: docs/design/pwa.md)
CLAUDE-CODE-RENAME.md            the in-app rename task for Claude Code
```
