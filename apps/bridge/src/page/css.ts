/** The connections page's styles, in CT Studio's look (no inline style, no web font). */
export const PAGE_CSS = `/* CT Studio's design tokens (apps/web/src/styles/tokens.css), the ones this page uses: a test
   fails when a value here drifts from the app's. Theme: <html data-theme="light|dark">; no
   attribute = follow the OS. */
:root {
  color-scheme: light dark;
  --ih-font-sans: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
  --ih-text-sm: 12px;
  --ih-text-md: 13px;
  --ih-text-base: 14px;
  --ih-text-lg: 15px;
  --ih-text-xl: 17px;
  --ih-radius-sm: 6px;
  --ih-radius-md: 8px;
  --ih-radius-lg: 12px;
  --ih-space-1: 4px;
  --ih-space-2: 8px;
  --ih-space-3: 12px;
  --ih-space-4: 16px;
  --ih-space-5: 20px;
  --ih-space-6: 24px;
  --ih-control-h: 40px;
  --ih-control-h-sm: 34px;
}
:root,
:root[data-theme='light'] {
  color-scheme: light;
  --ih-bg: #f3f5f8;
  --ih-surface: #ffffff;
  --ih-surface2: #f6f8fb;
  --ih-border: #dce2ea;
  --ih-border-soft: #e9edf2;
  --ih-border-strong: #b4bfcd;
  --ih-text: #0f1b2d;
  --ih-muted: #4f5d70;
  --ih-accent: #0a5bb0;
  --ih-accent-text: #ffffff;
  --ih-accent-soft: #e4eefa;
  --ih-accent-soft-text: #0a4f99;
  --ih-sel-row: #eef4fc;
  --ih-neutral-bg: #eceff3;
  --ih-neutral-fg: #46546a;
  --ih-ok-bg: #dff2e6;
  --ih-ok-fg: #17633a;
  --ih-warn-bg: #fcf0da;
  --ih-warn-fg: #7a4300;
  --ih-danger-bg: #fbe4e2;
  --ih-danger-fg: #a4231b;
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --ih-bg: #0b1119;
  --ih-surface: #121a25;
  --ih-surface2: #0e151f;
  --ih-border: #243041;
  --ih-border-soft: #1b2532;
  --ih-border-strong: #3a4b62;
  --ih-text: #e5ebf2;
  --ih-muted: #9dabbd;
  --ih-accent: #5ea3ee;
  --ih-accent-text: #061321;
  --ih-accent-soft: #15283e;
  --ih-accent-soft-text: #a9cdf7;
  --ih-sel-row: #15233a;
  --ih-neutral-bg: #1e2834;
  --ih-neutral-fg: #b2bdcb;
  --ih-ok-bg: #11301f;
  --ih-ok-fg: #86d9a4;
  --ih-warn-bg: #33270f;
  --ih-warn-fg: #f3c77f;
  --ih-danger-bg: #3a1716;
  --ih-danger-fg: #ffa39b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    color-scheme: dark;
    --ih-bg: #0b1119;
    --ih-surface: #121a25;
    --ih-surface2: #0e151f;
    --ih-border: #243041;
    --ih-border-soft: #1b2532;
    --ih-border-strong: #3a4b62;
    --ih-text: #e5ebf2;
    --ih-muted: #9dabbd;
    --ih-accent: #5ea3ee;
    --ih-accent-text: #061321;
    --ih-accent-soft: #15283e;
    --ih-accent-soft-text: #a9cdf7;
    --ih-sel-row: #15233a;
    --ih-neutral-bg: #1e2834;
    --ih-neutral-fg: #b2bdcb;
    --ih-ok-bg: #11301f;
    --ih-ok-fg: #86d9a4;
    --ih-warn-bg: #33270f;
    --ih-warn-fg: #f3c77f;
    --ih-danger-bg: #3a1716;
    --ih-danger-fg: #ffa39b;
  }
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  display: flex;
  flex-direction: column;
  background: var(--ih-surface);
  color: var(--ih-text);
  font-family: var(--ih-font-sans);
  font-size: var(--ih-text-base);
  line-height: 1.45;
}
a { color: var(--ih-accent); }
header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ih-space-4);
  min-height: 52px;
  padding: 0 var(--ih-space-5);
  border-bottom: 1px solid var(--ih-border);
}
.who { color: var(--ih-muted); font-size: var(--ih-text-md); }
main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
main > h1, main > p { margin: var(--ih-space-5) var(--ih-space-5) 0; }
h1 { font-size: var(--ih-text-xl); }
h2 { margin: 0 0 var(--ih-space-3); font-size: var(--ih-text-xl); font-weight: 600; }
h3 { margin: var(--ih-space-5) 0 var(--ih-space-2); font-size: var(--ih-text-lg); font-weight: 600; }
.muted { color: var(--ih-muted); }

/* The tabs: CT Studio's segmented look, the current one in the accent's soft colour. */
.tabs { display: flex; gap: var(--ih-space-1); align-self: stretch; align-items: center; }
.tabs a {
  display: inline-flex;
  align-items: center;
  min-height: var(--ih-control-h-sm);
  padding: 0 var(--ih-space-3);
  border-radius: var(--ih-radius-md);
  color: var(--ih-text);
  font-weight: 500;
  text-decoration: none;
}
.tabs a:hover { background: var(--ih-surface2); }
.tabs a[aria-current='page'] {
  background: var(--ih-accent-soft);
  color: var(--ih-accent-soft-text);
  font-weight: 600;
}

.intro { flex: none; margin: 0; padding: var(--ih-space-3) var(--ih-space-5); font-size: var(--ih-text-md); border-bottom: 1px solid var(--ih-border-soft); }
.split { flex: 1; min-height: 0; display: grid; grid-template-columns: 260px 1fr; }

/* The list, as Profile's side column. */
.list {
  overflow: auto;
  padding: var(--ih-space-3);
  border-right: 1px solid var(--ih-border);
  background: var(--ih-surface2);
}
.list ul { list-style: none; margin: var(--ih-space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.list a {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--ih-space-2) var(--ih-space-3);
  border-radius: var(--ih-radius-md);
  color: var(--ih-text);
  text-decoration: none;
}
.list a:hover { background: var(--ih-sel-row); }
.list .selected > a, .list a.add.selected {
  background: var(--ih-accent-soft);
  color: var(--ih-accent-soft-text);
}
.list .name { font-weight: 600; overflow-wrap: anywhere; }
.list .system { color: var(--ih-muted); font-size: var(--ih-text-sm); }
.list .selected .system { color: inherit; }
.list a.add {
  flex-direction: row;
  justify-content: center;
  border: 1px dashed var(--ih-border-strong);
  font-weight: 500;
}
.tag {
  display: inline-block;
  margin-left: var(--ih-space-1);
  padding: 0 6px;
  border-radius: 999px;
  background: var(--ih-neutral-bg);
  color: var(--ih-neutral-fg);
  font-size: var(--ih-text-sm);
}

/* The details. */
.details { overflow: auto; padding: var(--ih-space-5) var(--ih-space-6); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: var(--ih-space-2) var(--ih-space-5); margin: 0 0 var(--ih-space-4); font-size: var(--ih-text-md); }
.facts dt { color: var(--ih-muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.status { font-weight: 600; }
.status.ok { color: var(--ih-ok-fg); }
.status.needs_attention { color: var(--ih-warn-fg); }
.status.untested { color: var(--ih-muted); }
.notice {
  margin: 0 0 var(--ih-space-4);
  padding: var(--ih-space-2) var(--ih-space-3);
  border-radius: var(--ih-radius-md);
  background: var(--ih-ok-bg);
  color: var(--ih-ok-fg);
}
.notice.error { background: var(--ih-danger-bg); color: var(--ih-danger-fg); }
.choices { padding-left: var(--ih-space-5); }
.choices li { margin: var(--ih-space-2) 0; }

form { margin: 0; }
.details > form { max-width: 480px; }
form.edit { padding-top: var(--ih-space-2); border-top: 1px solid var(--ih-border-soft); }
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: var(--ih-space-3) 0;
  font-size: var(--ih-text-sm);
  font-weight: 500;
  color: var(--ih-muted);
}
label.check { flex-direction: row; align-items: center; gap: 6px; color: var(--ih-text); font-size: var(--ih-text-md); }
input:not([type='checkbox']), select {
  min-height: var(--ih-control-h);
  padding: 0 10px;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-md);
  background: var(--ih-surface2);
  color: var(--ih-text);
  font: inherit;
  font-size: var(--ih-text-base);
}
input[type='checkbox'] { accent-color: var(--ih-accent); width: 16px; height: 16px; }
input:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible {
  outline: 2px solid var(--ih-accent);
  outline-offset: 0;
}
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--ih-space-2); margin: var(--ih-space-3) 0; }
button, a.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--ih-control-h);
  padding: 0 14px;
  border: 1px solid var(--ih-border-strong);
  border-radius: var(--ih-radius-md);
  background: transparent;
  color: var(--ih-text);
  font: inherit;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
}
button:hover, a.button:hover { background: var(--ih-surface2); }
button.primary { border-color: var(--ih-accent); background: var(--ih-accent); color: var(--ih-accent-text); }
button.primary:hover { filter: brightness(1.08); }
.danger { color: var(--ih-danger-fg) !important; }

/* Narrow (a phone, or a small frame): the list above the details. */
@media (max-width: 640px) {
  header { padding: 0 var(--ih-space-3); }
  .split { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .list { max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--ih-border); }
  .details { padding: var(--ih-space-4); }
}
`;
