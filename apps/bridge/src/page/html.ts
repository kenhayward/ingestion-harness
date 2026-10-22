import type { SinkDescribe } from '@ih/bridge-contract';
import type { Connection } from '../connections/repo.js';

/** Server-rendered templates of the connections page: no inline script or style. */

export const esc = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export interface Shell {
  /** The page's path prefix under BRIDGE_PUBLIC_URL (`''` or e.g. `/bridge`). */
  base: string;
  user?: { name: string };
  /** BRIDGE_APP_ORIGIN: where the page's script tells CT Studio of news; null: nowhere. */
  appOrigin: string | null;
  /** The colour mode to show; unset: the OS's. */
  theme?: 'light' | 'dark';
  /** News for CT Studio: connections changed, or the session ended. */
  event?: 'changed' | 'ended';
}

/**
 * The page around a body. `top` replaces the header's title (the connections page puts its tabs
 * there); a page without it shows `title` as its heading.
 */
export function layout(shell: Shell, title: string, body: string, top?: string): string {
  const theme = shell.theme ? ` data-theme="${shell.theme}"` : '';
  const event = shell.event ? ` data-event="${shell.event}"` : '';
  const user = shell.user ? `<span class="who">${esc(shell.user.name)}</span>` : '';
  const heading = top ? '' : `<h1>${esc(title)}</h1>\n`;
  return `<!doctype html>
<html lang="en"${theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · CT Studio bridge</title>
<link rel="stylesheet" href="${esc(shell.base)}/connections/page.css">
<script src="${esc(shell.base)}/connections/page.js" defer></script>
</head>
<body data-app-origin="${esc(shell.appOrigin ?? '')}"${event}>
<header>${top ?? '<strong>Connections</strong>'}${user}</header>
<main>
${heading}${body}
</main>
</body>
</html>`;
}

export function message(shell: Shell, title: string, text: string): string {
  return layout(shell, title, `<p>${esc(text)}</p>`);
}

const STATUS: Record<Connection['status'], string> = {
  ok: 'OK',
  needs_attention: 'Needs attention',
  untested: 'Untested',
};

function secretNote(c: Connection): string {
  if (c.secretEnv) return `Keys from ${esc(c.secretEnv)}`;
  if (c.secretSet) return 'Secret stored';
  return '<span class="muted">No secret</span>';
}

const hidden = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

const lastUsed = (c: Connection) =>
  c.lastUsedAt
    ? esc(c.lastUsedAt.toISOString().slice(0, 16).replace('T', ' '))
    : '<span class="muted">Never</span>';

const statusCell = (c: Connection) =>
  `<span class="status ${c.status}">${STATUS[c.status]}</span>${
    c.statusReason ? `<br><span class="muted">${esc(c.statusReason)}</span>` : ''
  }`;

/** The label of a personal connection's instance, as its sink describes it. */
export function instanceLabel(sink: SinkDescribe | undefined, instanceId: string | null): string {
  if (instanceId === null) return '';
  return sink?.instances.find((i) => i.id === instanceId)?.label ?? instanceId;
}

/** What a user typed into a personal add form, shown again after a refusal (never the secret). */
export interface PersonalDraft {
  sinkId: string;
  instanceId: string;
  name: string;
  fields: Record<string, string>;
}

export interface FormValues {
  id: string;
  name: string;
  sinkId: string;
  fields: Record<string, string>;
}

export type Tab = 'mine' | 'shared';

/** One row of the list: a connection's name and its system, nothing more. */
export interface ListItem {
  id: string;
  name: string;
  system: string;
  builtIn: boolean;
}

/** What the right-hand panel shows. */
export type Selected =
  | {
      kind: 'connection';
      connection: Connection;
      sinks: Record<string, SinkDescribe>;
      builtIn: boolean;
      draft?: FormValues;
    }
  | {
      kind: 'add';
      /** The systems one can add a connection to in this tab, by id. */
      sinks: Record<string, SinkDescribe>;
      /** The chosen one; unset: the choice (or its form, when there is one system). */
      sinkId?: string;
      draft?: FormValues;
      personalDraft?: PersonalDraft;
    }
  | { kind: 'confirm-delete'; connection: Connection };

export interface PageView {
  tab: Tab;
  /** The tabs this person has: admins both, everyone else their own. */
  tabs: Tab[];
  list: ListItem[];
  /** The selected row's id, when a connection is shown. */
  selectedId?: string;
  selected: Selected;
  csrf: string;
  notice?: { text: string; error: boolean };
}

const TAB_LABEL: Record<Tab, string> = { mine: 'Your connections', shared: 'Shared connections' };

const INTRO: Record<Tab, string> = {
  mine: 'Your own logins to the systems CT Studio delivers to. Deliveries made as you use them. CT Studio never sees what you enter here.',
  shared:
    'Credentials that publishing targets deliver with. Secrets are encrypted here and never shown again.',
};

function tabStrip(base: string, view: PageView): string {
  const links = view.tabs
    .map(
      (t) =>
        `<a href="${esc(base)}/connections?tab=${t}"${t === view.tab ? ' aria-current="page"' : ''}>${TAB_LABEL[t]}</a>`,
    )
    .join('');
  return `<nav class="tabs" aria-label="Connections">${links}</nav>`;
}

function listPanel(base: string, view: PageView): string {
  const adding = view.selected.kind === 'add';
  const items = view.list
    .map((i) => {
      const on = i.id === view.selectedId;
      const tag = i.builtIn ? ' <span class="tag">Built in</span>' : '';
      return `<li class="item${on ? ' selected' : ''}"><a href="${esc(base)}/connections/${esc(i.id)}"${on ? ' aria-current="true"' : ''}><span class="name">${esc(i.name)}</span><span class="system">${esc(i.system)}${tag}</span></a></li>`;
    })
    .join('\n');
  return `<nav class="list" aria-label="${TAB_LABEL[view.tab]}">
<a class="add${adding ? ' selected' : ''}" href="${esc(base)}/connections/new?tab=${view.tab}">Add connection</a>
<ul>
${items}
</ul>
</nav>`;
}

function credentialInputs(sink: SinkDescribe, fields: Record<string, string>, editing: boolean) {
  return sink.credentialFields
    .map((f) => {
      if (f.secret) {
        const hint = editing ? 'Leave blank to keep the stored secret' : '';
        return `<label><span>${esc(f.label)}</span><input type="password" name="${esc(f.id)}" autocomplete="new-password" placeholder="${esc(hint)}"></label>`;
      }
      return `<label><span>${esc(f.label)}</span><input type="text" name="${esc(f.id)}" value="${esc(fields[f.id] ?? '')}"></label>`;
    })
    .join('\n');
}

const SAVE_UNTESTED =
  '<label class="check"><input type="checkbox" name="saveUntested"> Save even if the test fails</label>';

/** A shared connection's form, adding (with its id) or editing, for one chosen sink. */
function sharedFields(sink: SinkDescribe | undefined, values: FormValues, editing: boolean) {
  const id = editing
    ? ''
    : `<label><span>Id (a-z, 0-9, - and _)</span><input type="text" name="id" value="${esc(values.id)}" required></label>`;
  return `<input type="hidden" name="sinkId" value="${esc(values.sinkId)}">
<label><span>Name</span><input type="text" name="name" value="${esc(values.name)}" required></label>
${id}
${sink ? credentialInputs(sink, values.fields, editing) : ''}
${SAVE_UNTESTED}`;
}

/** One personal sink's add form: its instances, a name, and the credentials it asks for. */
function personalAddForm(
  base: string,
  csrf: string,
  sinkId: string,
  sink: SinkDescribe,
  draft: PersonalDraft | undefined,
): string {
  const values = draft?.sinkId === sinkId ? draft : undefined;
  const options = sink.instances
    .map(
      (i) =>
        `<option value="${esc(i.id)}"${i.id === values?.instanceId ? ' selected' : ''}>${esc(i.label)}</option>`,
    )
    .join('');
  const instances = sink.instances.length
    ? `<label><span>Instance</span><select name="instanceId">${options}</select></label>`
    : '';
  return `<form method="post" action="${esc(base)}/connections">
<h2>Add a connection to ${esc(sink.name)}</h2>
${hidden(csrf)}
<input type="hidden" name="kind" value="personal">
<input type="hidden" name="sinkId" value="${esc(sinkId)}">
${instances}
<label><span>Name</span><input type="text" name="name" value="${esc(values?.name ?? '')}" maxlength="80" required></label>
${credentialInputs(sink, values?.fields ?? {}, false)}
${SAVE_UNTESTED}
<div class="actions"><button class="primary">Test and save</button></div>
</form>`;
}

function addPanel(base: string, view: PageView, sel: Extract<Selected, { kind: 'add' }>) {
  const ids = Object.keys(sel.sinks);
  if (!ids.length) {
    return view.tab === 'mine'
      ? '<p>No system here uses personal connections yet.</p>'
      : '<p>No system here takes shared connections.</p>';
  }
  const asked = sel.sinkId && sel.sinks[sel.sinkId] ? sel.sinkId : undefined;
  const chosen = asked ?? (ids.length === 1 ? ids[0] : undefined);
  if (!chosen) {
    const choices = ids
      .map(
        (id) =>
          `<li><a href="${esc(base)}/connections/new?tab=${view.tab}&amp;sink=${esc(id)}">${esc(sel.sinks[id]!.name)}</a></li>`,
      )
      .join('');
    return `<h2>Add a connection</h2>
<p class="muted">Choose the system it connects to.</p>
<ul class="choices">${choices}</ul>`;
  }
  const sink = sel.sinks[chosen]!;
  if (view.tab === 'mine') return personalAddForm(base, view.csrf, chosen, sink, sel.personalDraft);
  const values =
    sel.draft?.sinkId === chosen ? sel.draft : { id: '', name: '', sinkId: chosen, fields: {} };
  return `<form method="post" action="${esc(base)}/connections">
<h2>Add a shared connection to ${esc(sink.name)}</h2>
${hidden(view.csrf)}
${sharedFields(sink, values, false)}
<div class="actions"><button class="primary">Test and save</button></div>
</form>`;
}

function connectionPanel(
  base: string,
  csrf: string,
  sel: Extract<Selected, { kind: 'connection' }>,
): string {
  const c = sel.connection;
  const sink = sel.sinks[c.sinkId];
  const instance = instanceLabel(sink, c.instanceId);
  let where = '';
  if (c.kind === 'shared') {
    const endpoint = sel.builtIn ? 'This deployment’s storage' : esc(c.fields.endpoint ?? '');
    where = `<dt>Endpoint</dt><dd>${endpoint}</dd>`;
  } else if (instance) {
    where = `<dt>Instance</dt><dd>${esc(instance)}</dd>`;
  }
  const facts = `<dl class="facts">
<dt>System</dt><dd>${esc(sink?.name ?? c.sinkId)}</dd>
${where}
<dt>Status</dt><dd>${statusCell(c)}</dd>
<dt>Last used</dt><dd>${lastUsed(c)}</dd>
${sel.builtIn ? '' : `<dt>Keys</dt><dd>${secretNote(c)}</dd>`}
${c.kind === 'shared' ? `<dt>Id</dt><dd class="muted">${esc(c.id)}</dd>` : ''}
</dl>`;
  if (sel.builtIn) return `<h2>${esc(c.name)}</h2>\n${facts}`;
  const values = sel.draft ?? { id: c.id, name: c.name, sinkId: c.sinkId, fields: c.fields };
  const envNote = c.secretEnv
    ? `<p class="muted">Keys are read from ${esc(c.secretEnv)}. Entering a secret stores it here instead.</p>`
    : '';
  const fields =
    c.kind === 'shared'
      ? sharedFields(sink, values, true)
      : `<input type="hidden" name="sinkId" value="${esc(c.sinkId)}">
<label><span>Name</span><input type="text" name="name" value="${esc(values.name)}" maxlength="80" required></label>
${sink ? credentialInputs(sink, values.fields, true) : ''}
${SAVE_UNTESTED}`;
  return `<h2>${esc(c.name)}</h2>
${facts}
<div class="actions">
<form method="post" action="${esc(base)}/connections/${esc(c.id)}/test">${hidden(csrf)}<button>Test</button></form>
<a class="button danger" href="${esc(base)}/connections/${esc(c.id)}/delete">Delete</a>
</div>
<form method="post" action="${esc(base)}/connections/${esc(c.id)}" class="edit">
<h3>Change</h3>
${envNote}
${hidden(csrf)}
${fields}
<div class="actions"><button class="primary">Test and save</button></div>
</form>`;
}

function confirmPanel(base: string, csrf: string, c: Connection): string {
  return `<h2>Delete ${esc(c.name)}?</h2>
<p>Targets using it stop delivering.</p>
<form method="post" action="${esc(base)}/connections/${esc(c.id)}/delete" class="actions">
${hidden(csrf)}
<button class="danger">Delete</button>
<a class="button" href="${esc(base)}/connections/${esc(c.id)}">Cancel</a>
</form>`;
}

/** The connections page: tabs, the tab's list on the left, the selection on the right. */
export function connectionsPage(shell: Shell, view: PageView): string {
  const { base } = shell;
  const notice = view.notice
    ? `<p class="notice${view.notice.error ? ' error' : ''}">${esc(view.notice.text)}</p>\n`
    : '';
  const sel = view.selected;
  const panel =
    sel.kind === 'connection'
      ? connectionPanel(base, view.csrf, sel)
      : sel.kind === 'add'
        ? addPanel(base, view, sel)
        : confirmPanel(base, view.csrf, sel.connection);
  return layout(
    shell,
    TAB_LABEL[view.tab],
    `<p class="intro muted">${INTRO[view.tab]}</p>
<div class="split">
${listPanel(base, view)}
<section class="details">
${notice}${panel}
</section>
</div>`,
    tabStrip(base, view),
  );
}
