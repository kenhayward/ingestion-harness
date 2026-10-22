import type { SinkDescribe } from '@ih/bridge-contract';
import type { Connection } from '../connections/repo.js';

/** Server-rendered templates of the connections page: no client script, no inline style. */

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
}

export function layout(shell: Shell, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · CT Studio bridge</title>
<link rel="stylesheet" href="${esc(shell.base)}/connections/page.css">
</head>
<body>
<header><strong>Connections</strong>${shell.user ? `<span>${esc(shell.user.name)}</span>` : ''}</header>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>`;
}

export const PAGE_CSS = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --muted: #6b6b73; --line: #d9d9de;
  --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; font-family: system-ui, sans-serif; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --bg: #16161a; --muted: #a0a0ab;
  --line: #34343c; --ok: #3fb950; --warn: #d29922; --bad: #f85149; } }
body { margin: 0; background: var(--bg); color: var(--fg); }
header { display: flex; justify-content: space-between; padding: 12px 16px;
  border-bottom: 1px solid var(--line); }
main { max-width: 960px; margin: 0 auto; padding: 16px; }
table { width: 100%; border-collapse: collapse; margin: 16px 0; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
td form { display: inline; }
.muted { color: var(--muted); }
.ok { color: var(--ok); } .needs_attention { color: var(--warn); } .untested { color: var(--muted); }
.notice { padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; margin: 12px 0; }
.error { border-color: var(--bad); color: var(--bad); }
fieldset { border: 1px solid var(--line); border-radius: 6px; padding: 12px 16px; }
label { display: block; margin: 8px 0; }
label span { display: block; font-size: 0.9em; color: var(--muted); }
input[type=text], input[type=password], select { width: 100%; max-width: 420px; padding: 6px; }
button { padding: 6px 12px; margin-right: 8px; }
`;

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

function row(base: string, c: Connection, csrf: string, builtIn: boolean): string {
  const status = statusCell(c);
  const actions = builtIn
    ? '<span class="muted">Built in</span>'
    : `<a href="${esc(base)}/connections/${esc(c.id)}">Edit</a>
       <form method="post" action="${esc(base)}/connections/${esc(c.id)}/test">${hidden(csrf)}<button>Test</button></form>
       <form method="post" action="${esc(base)}/connections/${esc(c.id)}/delete">${hidden(csrf)}<button>Delete</button></form>`;
  return `<tr>
<td>${esc(c.name)}<br><span class="muted">${esc(c.id)}</span></td>
<td>${esc(c.sinkId)}</td>
<td>${builtIn ? 'This deployment’s storage' : esc(c.fields.endpoint ?? '')}</td>
<td>${status}</td>
<td>${lastUsed(c)}</td>
<td>${builtIn ? '' : secretNote(c)}</td>
<td>${actions}</td>
</tr>`;
}

const lastUsed = (c: Connection) =>
  c.lastUsedAt
    ? esc(c.lastUsedAt.toISOString().slice(0, 16).replace('T', ' '))
    : '<span class="muted">Never</span>';

const statusCell = (c: Connection) =>
  `<span class="${c.status}">${STATUS[c.status]}</span>${
    c.statusReason ? `<br><span class="muted">${esc(c.statusReason)}</span>` : ''
  }`;

/** The label of a personal connection's instance, as its sink describes it. */
export function instanceLabel(sink: SinkDescribe | undefined, instanceId: string | null): string {
  if (instanceId === null) return '';
  return sink?.instances.find((i) => i.id === instanceId)?.label ?? instanceId;
}

function personalRow(
  base: string,
  c: Connection,
  csrf: string,
  sinks: Record<string, SinkDescribe>,
): string {
  const sink = sinks[c.sinkId];
  return `<tr>
<td>${esc(c.name)}</td>
<td>${esc(sink?.name ?? c.sinkId)}</td>
<td>${esc(instanceLabel(sink, c.instanceId))}</td>
<td>${statusCell(c)}</td>
<td>${lastUsed(c)}</td>
<td><a href="${esc(base)}/connections/${esc(c.id)}">Edit</a>
  <form method="post" action="${esc(base)}/connections/${esc(c.id)}/test">${hidden(csrf)}<button>Test</button></form>
  <form method="post" action="${esc(base)}/connections/${esc(c.id)}/delete">${hidden(csrf)}<button>Delete</button></form></td>
</tr>`;
}

/** What a user typed into a personal add form, shown again after a refusal (never the secret). */
export interface PersonalDraft {
  sinkId: string;
  instanceId: string;
  name: string;
  fields: Record<string, string>;
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

/** One add form per personal sink: its instances, a name, and the credentials it asks for. */
function personalAddForm(
  base: string,
  csrf: string,
  sinkId: string,
  sink: SinkDescribe,
  draft: PersonalDraft | undefined,
): string {
  const values = draft?.sinkId === sinkId ? draft : undefined;
  const instances = sink.instances.length
    ? `<label><span>Instance</span><select name="instanceId">${sink.instances
        .map(
          (i) =>
            `<option value="${esc(i.id)}"${i.id === values?.instanceId ? ' selected' : ''}>${esc(i.label)}</option>`,
        )
        .join('')}</select></label>`
    : '';
  return `<form method="post" action="${esc(base)}/connections">
<fieldset><legend>Add a connection to ${esc(sink.name)}</legend>
${hidden(csrf)}
<input type="hidden" name="kind" value="personal">
<input type="hidden" name="sinkId" value="${esc(sinkId)}">
${instances}
<label><span>Name</span><input type="text" name="name" value="${esc(values?.name ?? '')}" maxlength="80" required></label>
${credentialInputs(sink, values?.fields ?? {}, false)}
<label><input type="checkbox" name="saveUntested"> Save even if the test fails</label>
<button>Test and save</button>
</fieldset>
</form>`;
}

function personalSection(
  base: string,
  csrf: string,
  connections: Connection[],
  sinks: Record<string, SinkDescribe>,
  draft: PersonalDraft | undefined,
): string {
  const intro =
    '<p class="muted">Your own logins to the systems CT Studio delivers to. Deliveries made as you use them. CT Studio never sees what you enter here.</p>';
  if (!Object.keys(sinks).length && !connections.length) {
    return `${intro}<p>No system here uses personal connections yet.</p>`;
  }
  const table = connections.length
    ? `<table>
<thead><tr><th>Name</th><th>System</th><th>Instance</th><th>Status</th><th>Last used</th><th></th></tr></thead>
<tbody>${connections.map((c) => personalRow(base, c, csrf, sinks)).join('\n')}</tbody>
</table>`
    : '<p class="muted">You have no connections yet.</p>';
  const forms = Object.entries(sinks)
    .map(([id, sink]) => personalAddForm(base, csrf, id, sink, draft))
    .join('\n');
  return `${intro}${table}${forms}`;
}

export interface FormValues {
  id: string;
  name: string;
  sinkId: string;
  fields: Record<string, string>;
}

/** The fields of a connection form: id and name, then the sink's credential fields. */
function connectionFields(
  sinks: Record<string, SinkDescribe>,
  values: FormValues,
  editing: boolean,
): string {
  const sink = sinks[values.sinkId];
  const sinkChoice = editing
    ? `<input type="hidden" name="sinkId" value="${esc(values.sinkId)}">`
    : `<label><span>Kind</span><select name="sinkId">${Object.entries(sinks)
        .map(
          ([id, d]) =>
            `<option value="${esc(id)}"${id === values.sinkId ? ' selected' : ''}>${esc(d.name)}</option>`,
        )
        .join('')}</select></label>`;
  const credentials = sink ? credentialInputs(sink, values.fields, editing) : '';
  return `${sinkChoice}
<label><span>Name</span><input type="text" name="name" value="${esc(values.name)}" required></label>
${editing ? '' : `<label><span>Id (a-z, 0-9, - and _)</span><input type="text" name="id" value="${esc(values.id)}" required></label>`}
${credentials}
<label><input type="checkbox" name="saveUntested"> Save even if the test fails</label>`;
}

export function listPage(
  shell: Shell,
  opts: {
    /** The session user's personal connections, and the sinks they can add one for. */
    personal: Connection[];
    personalSinks: Record<string, SinkDescribe>;
    /** The shared connections and their sinks: admins only (null for everyone else). */
    shared: {
      connections: Connection[];
      sinks: Record<string, SinkDescribe>;
      builtIn: string;
      draft?: FormValues;
    } | null;
    csrf: string;
    notice?: { text: string; error: boolean };
    personalDraft?: PersonalDraft;
  },
): string {
  const { base } = shell;
  const notice = opts.notice
    ? `<p class="notice${opts.notice.error ? ' error' : ''}">${esc(opts.notice.text)}</p>`
    : '';
  const personal = personalSection(
    base,
    opts.csrf,
    opts.personal,
    opts.personalSinks,
    opts.personalDraft,
  );
  return layout(
    shell,
    'Connections',
    `${notice}
<h2>Your connections</h2>
${personal}
${opts.shared ? sharedSection(base, opts.csrf, opts.shared) : ''}`,
  );
}

function sharedSection(
  base: string,
  csrf: string,
  shared: NonNullable<Parameters<typeof listPage>[1]['shared']>,
): string {
  const rows = shared.connections
    .map((c) => row(base, c, csrf, c.id === shared.builtIn))
    .join('\n');
  const draft = shared.draft ?? {
    id: '',
    name: '',
    sinkId: Object.keys(shared.sinks)[0] ?? '',
    fields: {},
  };
  return `<h2>Shared connections</h2>
<p class="muted">Credentials that publishing targets deliver with. Secrets are encrypted here and never shown again.</p>
<table>
<thead><tr><th>Name</th><th>Kind</th><th>Endpoint</th><th>Status</th><th>Last used</th><th>Keys</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
<form method="post" action="${esc(base)}/connections">
<fieldset><legend>Add a shared connection</legend>
${hidden(csrf)}
${connectionFields(shared.sinks, draft, false)}
<button>Test and save</button>
</fieldset>
</form>`;
}

export function editPage(
  shell: Shell,
  opts: {
    connection: Connection;
    csrf: string;
    sinks: Record<string, SinkDescribe>;
    notice?: { text: string; error: boolean };
    draft?: FormValues;
  },
): string {
  const c = opts.connection;
  const values = opts.draft ?? { id: c.id, name: c.name, sinkId: c.sinkId, fields: c.fields };
  const notice = opts.notice
    ? `<p class="notice${opts.notice.error ? ' error' : ''}">${esc(opts.notice.text)}</p>`
    : '';
  const instance =
    c.kind === 'personal'
      ? `<p class="muted">${esc(opts.sinks[c.sinkId]?.name ?? c.sinkId)}${
          c.instanceId ? `, ${esc(instanceLabel(opts.sinks[c.sinkId], c.instanceId))}` : ''
        }</p>`
      : '';
  const envNote = c.secretEnv
    ? `<p class="muted">Keys are read from ${esc(c.secretEnv)}. Entering a secret stores it here instead.</p>`
    : '';
  return layout(
    shell,
    `Edit ${c.name}`,
    `${notice}${instance}${envNote}
<form method="post" action="${esc(shell.base)}/connections/${esc(c.id)}">
<fieldset>
${hidden(opts.csrf)}
${connectionFields(opts.sinks, values, true)}
<button>Test and save</button>
<a href="${esc(shell.base)}/connections">Cancel</a>
</fieldset>
</form>`,
  );
}
