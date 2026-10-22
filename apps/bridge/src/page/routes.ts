import { randomBytes } from 'node:crypto';
import { parse as parseQuery } from 'node:querystring';
import type { SinkDescribe } from '@ih/bridge-contract';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  ConnectionConflict,
  connectionProblem,
  INTERNAL_CONNECTION_ID,
  PERSONAL_ID_PREFIX,
  type Connection,
} from '../connections/repo.js';
import { encryptSecret } from '../secrets.js';
import { SinkError } from '../sinks/port.js';
import {
  connectionsPage,
  instanceLabel,
  message,
  PAGE_CSS,
  type FormValues,
  type ListItem,
  type PersonalDraft,
  type Selected,
  type Shell,
  type Tab,
} from './html.js';
import { PAGE_JS } from './script.js';
import {
  csrfMatches,
  newSession,
  openSession,
  sealSession,
  SESSION_COOKIE,
  SESSION_SECONDS,
  type PageSession,
} from './session.js';

/** The page's headers' CSP: framed by CT Studio's origin alone (BRIDGE_APP_ORIGIN), or nobody. */
const cspFor = (appOrigin: string | undefined) =>
  `default-src 'self'; form-action 'self'; frame-ancestors ${appOrigin ?? "'none'"}`;
const EXPIRED = 'This link has expired. Open Connections again from CT Studio.';
const ENDED = 'Your session has ended. Open Connections again from CT Studio.';
/** A non-secret S3 field naming the variable its access key id is read from. */
const ACCESS_KEY_ENV = 'accessKeyIdEnv';
/** The longest name a person may give a connection. */
const NAME_MAX = 80;

type Form = Record<string, string>;

function cookieOf(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const formOf = (body: unknown): Form =>
  Object.fromEntries(
    Object.entries((body ?? {}) as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : '',
    ]),
  );

/**
 * The bridge's connections page: server-rendered, no client script, reached through a one-time
 * handoff code CT Studio mints (`/connections/start?code=`), then a signed `HttpOnly` session
 * cookie with a CSRF token every form carries.
 *
 * Everyone manages their own personal connections here (for the sinks whose describe says
 * `personal`); admins also manage the shared ones. A personal connection is reached by its owner
 * only: anyone else, an admin included, gets 404.
 */
export const pageRoutes: FastifyPluginAsync = async (app) => {
  const { config } = app.deps;
  const publicUrl = new URL(config.BRIDGE_PUBLIC_URL);
  const base = publicUrl.pathname.replace(/\/+$/, '');
  const key = config.BRIDGE_CLIENT_KEY;
  const CSP = cspFor(config.BRIDGE_APP_ORIGIN);
  const appOrigin = config.BRIDGE_APP_ORIGIN ?? null;

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_req, body, done) => done(null, parseQuery(body as string)),
  );

  app.addHook('onSend', async (_req, reply) => {
    reply.header('content-security-policy', CSP);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  const shell = (s?: PageSession, event?: Shell['event']): Shell => ({
    base,
    appOrigin,
    ...(s ? { user: s.user } : {}),
    ...(s?.theme ? { theme: s.theme } : {}),
    ...(event ? { event } : {}),
  });
  /** The pages that end a session: CT Studio offers to open the page again. */
  const ended = (reply: FastifyReply, title: string, text: string) =>
    html(reply, 401, message(shell(undefined, 'ended'), title, text));
  const html = (reply: FastifyReply, code: number, body: string) =>
    reply.code(code).type('text/html; charset=utf-8').send(body);
  /** After a change, back to `path` (under /connections), which then tells CT Studio. */
  const changedTo = (reply: FastifyReply, path: string) =>
    reply
      .code(303)
      .header('location', `${base}/connections${path}${path.includes('?') ? '&' : '?'}changed=1`)
      .send();

  /** The sinks of one connection kind that ask for credentials: their describe, by id. */
  const sinksOf = async (kind: Connection['kind']): Promise<Record<string, SinkDescribe>> => {
    const out: Record<string, SinkDescribe> = {};
    for (const id of app.deps.sinks.ids()) {
      try {
        const d = await app.deps.sinks.get(id)!.describe();
        if (d.connectionKind === kind && d.credentialFields.length) out[id] = d;
      } catch {
        // A sink that cannot describe itself offers nothing to connect to now.
      }
    }
    return out;
  };
  const sharedSinks = () => sinksOf('shared');
  const personalSinks = () => sinksOf('personal');

  const session = (req: FastifyRequest) =>
    openSession(cookieOf(req, SESSION_COOKIE), key, Date.now());

  const notAllowed = (reply: FastifyReply, s: PageSession) =>
    html(reply, 403, message(shell(s), 'Not allowed', 'You cannot change connections.'));

  /** The session of a form post with its token; otherwise the refusal is sent. */
  const formPost = (req: FastifyRequest, reply: FastifyReply): PageSession | null => {
    const s = session(req);
    if (!s) {
      void ended(reply, 'Session ended', ENDED);
      return null;
    }
    if (!csrfMatches(s, formOf(req.body).csrf)) {
      void notAllowed(reply, s);
      return null;
    }
    return s;
  };
  const isAdmin = (s: PageSession) => s.user.role === 'admin';

  /** What the page shows: a tab, and in it a connection, an add form or a delete question. */
  interface View {
    tab?: Tab;
    /** The connection to show (its tab follows from its kind). */
    show?: Connection;
    /** Ask before deleting `show`. */
    confirm?: boolean;
    add?: { sinkId?: string; draft?: FormValues; personalDraft?: PersonalDraft };
    /** What a refused edit of `show` sent, shown again. */
    draft?: FormValues;
    notice?: { text: string; error: boolean };
    /** A connection was added, saved, tested or deleted: CT Studio refreshes its lists. */
    changed?: boolean;
  }

  const tabOf = (c: Connection): Tab => (c.kind === 'shared' ? 'shared' : 'mine');

  const renderPage = async (reply: FastifyReply, s: PageSession, code: number, v: View) => {
    const tabs: Tab[] = isAdmin(s) ? ['mine', 'shared'] : ['mine'];
    const wanted = v.show ? tabOf(v.show) : v.tab;
    const tab: Tab = wanted && tabs.includes(wanted) ? wanted : 'mine';
    const sinks = tab === 'shared' ? await sharedSinks() : await personalSinks();
    const listed =
      tab === 'shared'
        ? await app.deps.connections.list({ kind: 'shared' })
        : await app.deps.connections.list({ kind: 'personal', owner: s.user.id });
    const builtIn = (c: Connection) => c.id === INTERNAL_CONNECTION_ID;
    // The built-in connection last: the ones people made come first.
    const ordered = [...listed.filter((c) => !builtIn(c)), ...listed.filter(builtIn)];
    const list: ListItem[] = ordered.map((c) => ({
      id: c.id,
      name: c.name,
      system: sinks[c.sinkId]?.name ?? c.sinkId,
      builtIn: builtIn(c),
    }));
    const shown = v.add ? undefined : (v.show ?? ordered[0]);
    let selected: Selected;
    if (shown && v.confirm) selected = { kind: 'confirm-delete', connection: shown };
    else if (shown) {
      selected = {
        kind: 'connection',
        connection: shown,
        sinks,
        builtIn: builtIn(shown),
        ...(v.draft ? { draft: v.draft } : {}),
      };
    } else selected = { kind: 'add', sinks, ...v.add };
    return html(
      reply,
      code,
      connectionsPage(shell(s, v.changed ? 'changed' : undefined), {
        tab,
        tabs,
        list,
        ...(shown ? { selectedId: shown.id } : {}),
        selected,
        csrf: s.csrf,
        ...(v.notice ? { notice: v.notice } : {}),
      }),
    );
  };

  const query = (req: FastifyRequest) => req.query as Record<string, unknown>;
  const tabParam = (req: FastifyRequest): Tab | undefined =>
    query(req).tab === 'shared' ? 'shared' : query(req).tab === 'mine' ? 'mine' : undefined;

  /** A form's values for a sink: id, name and its declared non-secret fields (blanks dropped). */
  const valuesOf = (form: Form, sink: SinkDescribe, id: string, sinkId: string): FormValues => ({
    id,
    sinkId,
    name: (form.name ?? '').trim(),
    fields: Object.fromEntries(
      sink.credentialFields
        .filter((f) => !f.secret && (form[f.id] ?? '').trim() !== '')
        .map((f) => [f.id, form[f.id]!.trim()]),
    ),
  });

  /**
   * Runs the sink's connection test against an instance (`''` for a shared sink): who the sink
   * says the credential is, or the failure's message.
   */
  const tryCredential = async (
    sinkId: string,
    instanceId: string | null,
    credential: Record<string, string>,
  ): Promise<{ failure: string | null; identity: string | null }> => {
    try {
      const { identity } = await app.deps.sinks
        .get(sinkId)!
        .testConnection({ instanceId: instanceId ?? '', credential });
      return { failure: null, identity };
    } catch (err) {
      if (err instanceof SinkError) return { failure: err.error.message, identity: null };
      return { failure: 'the test could not run', identity: null };
    }
  };

  /** What a passing test of a connection says. */
  const connected = (c: { kind: Connection['kind']; name: string }, identity: string | null) =>
    c.kind === 'personal' && identity
      ? `${c.name}: connected as ${identity}.`
      : `${c.name}: Connected.`;

  app.get('/connections/page.css', { schema: { hide: true } }, async (_req, reply) =>
    reply.type('text/css; charset=utf-8').send(PAGE_CSS),
  );

  app.get('/connections/page.js', { schema: { hide: true } }, async (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').send(PAGE_JS),
  );

  app.get('/connections/start', { schema: { hide: true } }, async (req, reply) => {
    const code = (req.query as Record<string, unknown>).code;
    let user = null;
    if (typeof code === 'string' && code.length > 0 && code.length <= 200) {
      try {
        user = await app.deps.producer.redeem(code);
      } catch (err) {
        req.log.error({ err }, 'handoff redeem failed');
        return html(
          reply,
          502,
          message(shell(), 'Try again', 'CT Studio could not be reached. Try again shortly.'),
        );
      }
    }
    if (!user) return ended(reply, 'Link expired', EXPIRED);
    const asked = (req.query as Record<string, unknown>).theme;
    const theme = asked === 'light' || asked === 'dark' ? asked : undefined;
    const value = sealSession(newSession(user, Date.now(), theme), key);
    const attrs = [
      `${SESSION_COOKIE}=${value}`,
      `Path=${base || '/'}`,
      `Max-Age=${SESSION_SECONDS}`,
      'HttpOnly',
      'SameSite=Lax',
      ...(config.BRIDGE_COOKIE_SECURE ? ['Secure'] : []),
    ];
    return reply
      .code(303)
      .header('set-cookie', attrs.join('; '))
      .header('location', `${base}/connections`)
      .send();
  });

  app.get('/connections', { schema: { hide: true } }, async (req, reply) => {
    const s = session(req);
    if (!s) return ended(reply, 'Session ended', ENDED);
    const tab = tabParam(req);
    return renderPage(reply, s, 200, {
      ...(tab ? { tab } : {}),
      changed: query(req).changed === '1',
    });
  });

  app.get('/connections/new', { schema: { hide: true } }, async (req, reply) => {
    const s = session(req);
    if (!s) return ended(reply, 'Session ended', ENDED);
    const sink = query(req).sink;
    const tab = tabParam(req);
    return renderPage(reply, s, 200, {
      ...(tab ? { tab } : {}),
      add: typeof sink === 'string' ? { sinkId: sink } : {},
    });
  });

  /**
   * The connection this session may see: its own personal one, or (for an admin) a shared one.
   * Anything else is not found, so nobody learns another user's ids.
   */
  const visible = async (
    reply: FastifyReply,
    s: PageSession,
    id: string,
  ): Promise<Connection | null> => {
    const c = await app.deps.connections.get(id);
    const mine = c?.kind === 'personal' && c.owner === s.user.id;
    if (!mine && !(c?.kind === 'shared' && isAdmin(s))) {
      void html(reply, 404, message(shell(s), 'Not found', `There is no connection ${id}.`));
      return null;
    }
    return c;
  };

  /** The connection this session may change: one it sees, other than the built-in. */
  const editable = async (
    reply: FastifyReply,
    s: PageSession,
    id: string,
  ): Promise<Connection | null> => {
    const c = await visible(reply, s, id);
    if (!c) return null;
    if (id === INTERNAL_CONNECTION_ID) {
      void html(
        reply,
        403,
        message(shell(s), 'Built in', 'The built-in connection cannot be changed.'),
      );
      return null;
    }
    return c;
  };
  const sinksFor = (c: Connection) => (c.kind === 'shared' ? sharedSinks() : personalSinks());

  app.get('/connections/:id', { schema: { hide: true } }, async (req, reply) => {
    const s = session(req);
    if (!s) return ended(reply, 'Session ended', ENDED);
    const c = await visible(reply, s, (req.params as { id: string }).id);
    if (!c) return reply;
    return renderPage(reply, s, 200, { show: c, changed: query(req).changed === '1' });
  });

  app.get('/connections/:id/delete', { schema: { hide: true } }, async (req, reply) => {
    const s = session(req);
    if (!s) return ended(reply, 'Session ended', ENDED);
    const c = await editable(reply, s, (req.params as { id: string }).id);
    if (!c) return reply;
    return renderPage(reply, s, 200, { show: c, confirm: true });
  });

  /** Adds the session user's personal connection to a sink instance, tested first. */
  const addPersonal = async (reply: FastifyReply, s: PageSession, form: Form) => {
    const sinks = await personalSinks();
    const sinkId = form.sinkId ?? '';
    const sink = sinks[sinkId];
    if (!sink) {
      return renderPage(reply, s, 422, {
        tab: 'mine',
        add: {},
        notice: { text: 'Choose a system', error: true },
      });
    }
    const instanceId = sink.instances.length ? (form.instanceId ?? '') : null;
    const values = valuesOf(form, sink, '', sinkId);
    const personalDraft = {
      sinkId,
      instanceId: instanceId ?? '',
      name: values.name,
      fields: values.fields,
    };
    const refuse = (code: number, text: string) =>
      renderPage(reply, s, code, {
        tab: 'mine',
        add: { sinkId, personalDraft },
        notice: { text, error: true },
      });
    if (instanceId !== null && !sink.instances.some((i) => i.id === instanceId)) {
      return refuse(422, 'Choose an instance.');
    }
    if (!values.name) return refuse(422, 'Enter a name.');
    if (values.name.length > NAME_MAX)
      return refuse(422, `A name is ${NAME_MAX} characters at most.`);
    const place = instanceLabel(sink, instanceId) || sink.name;
    const taken = `You already have a connection for ${place}: update that one.`;
    if (await app.deps.connections.findPersonal(s.user.id, sinkId, instanceId)) {
      return refuse(409, taken);
    }
    const secretField = sink.credentialFields.find((f) => f.secret);
    const secret = secretField ? (form[secretField.id] ?? '') : '';
    if (secretField && !secret) return refuse(422, `Enter the ${secretField.label.toLowerCase()}.`);
    const { failure, identity } = await tryCredential(sinkId, instanceId, {
      ...values.fields,
      ...(secretField ? { [secretField.id]: secret } : {}),
    });
    if (failure && form.saveUntested !== 'on') {
      return refuse(422, `The test failed: ${failure}. Nothing was saved.`);
    }
    const id = `${PERSONAL_ID_PREFIX}${randomBytes(8).toString('hex')}`;
    try {
      await app.deps.connections.put({
        id,
        kind: 'personal',
        owner: s.user.id,
        sinkId,
        instanceId,
        name: values.name,
        fields: values.fields,
        secretEnv: null,
        status: failure ? 'untested' : 'ok',
        statusReason: failure,
        secretEnc: secret ? encryptSecret(secret, config.secrets) : null,
      });
    } catch (err) {
      if (err instanceof ConnectionConflict) return refuse(409, taken);
      throw err;
    }
    const saved = await app.deps.connections.get(id);
    return renderPage(reply, s, 200, {
      ...(saved ? { show: saved } : { tab: 'mine' }),
      changed: true,
      notice: failure
        ? { text: `${values.name}: saved untested: ${failure}.`, error: true }
        : { text: connected({ kind: 'personal', name: values.name }, identity), error: false },
    });
  };

  app.post('/connections', { schema: { hide: true } }, async (req, reply) => {
    const s = formPost(req, reply);
    if (!s) return reply;
    const form = formOf(req.body);
    if (form.kind === 'personal') return addPersonal(reply, s, form);
    if (!isAdmin(s)) return notAllowed(reply, s);
    const sinks = await sharedSinks();
    const sinkId = form.sinkId ?? Object.keys(sinks)[0] ?? '';
    const sink = sinks[sinkId];
    if (!sink) {
      return renderPage(reply, s, 422, {
        tab: 'shared',
        add: {},
        notice: { text: 'Choose a kind', error: true },
      });
    }
    const id = (form.id ?? '').trim();
    const draft = valuesOf(form, sink, id, sinkId);
    const refuse = (code: number, text: string) =>
      renderPage(reply, s, code, {
        tab: 'shared',
        add: { sinkId, draft },
        notice: { text, error: true },
      });
    if (id.startsWith(PERSONAL_ID_PREFIX)) {
      return refuse(422, `Ids starting ${PERSONAL_ID_PREFIX} are kept for personal connections.`);
    }
    if (id === INTERNAL_CONNECTION_ID || (await app.deps.connections.get(id))) {
      return refuse(409, `A connection with the id ${id} exists.`);
    }
    const secretField = sink.credentialFields.find((f) => f.secret);
    const secret = secretField ? (form[secretField.id] ?? '') : '';
    if (secretField && !secret) return refuse(422, `Enter the ${secretField.label.toLowerCase()}.`);
    const record = {
      id,
      kind: 'shared' as const,
      owner: null,
      sinkId,
      instanceId: null,
      name: draft.name,
      fields: draft.fields,
      secretEnv: null,
      status: 'untested' as const,
      statusReason: null,
    };
    const problem = connectionProblem(record) ?? (draft.name ? null : 'Enter a name.');
    if (problem) return refuse(422, problem);
    const { failure } = await tryCredential(sinkId, null, {
      ...draft.fields,
      ...(secretField ? { [secretField.id]: secret } : {}),
    });
    if (failure && form.saveUntested !== 'on') {
      return refuse(422, `The test failed: ${failure}. Nothing was saved.`);
    }
    await app.deps.connections.put({
      ...record,
      status: failure ? 'untested' : 'ok',
      statusReason: failure,
      secretEnc: secret ? encryptSecret(secret, config.secrets) : null,
    });
    return changedTo(reply, `/${encodeURIComponent(id)}`);
  });

  app.post('/connections/:id', { schema: { hide: true } }, async (req, reply) => {
    const s = formPost(req, reply);
    if (!s) return reply;
    const c = await editable(reply, s, (req.params as { id: string }).id);
    if (!c) return reply;
    const sinks = await sinksFor(c);
    const sink = sinks[c.sinkId];
    if (!sink) {
      return renderPage(reply, s, 422, {
        show: c,
        notice: { text: 'The sink is not available', error: true },
      });
    }
    const form = formOf(req.body);
    const draft = valuesOf(form, sink, c.id, c.sinkId);
    const secretField = sink.credentialFields.find((f) => f.secret);
    const secret = secretField ? (form[secretField.id] ?? '') : '';
    // Env-keyed keys stay env-keyed until a secret is entered here.
    const fields =
      !secret && c.fields[ACCESS_KEY_ENV] && !draft.fields.accessKeyId
        ? { ...draft.fields, [ACCESS_KEY_ENV]: c.fields[ACCESS_KEY_ENV] }
        : draft.fields;
    const refuse = async (text: string) =>
      renderPage(reply, s, 422, { show: c, draft, notice: { text, error: true } });
    if (!draft.name) return refuse('Enter a name.');
    if (c.kind === 'personal' && draft.name.length > NAME_MAX) {
      return refuse(`A name is ${NAME_MAX} characters at most.`);
    }
    let failure: string | null;
    try {
      const stored = (await app.deps.credentials.resolve(c.id, sink)) ?? {};
      const credential = { ...stored, ...draft.fields };
      if (secretField && secret) credential[secretField.id] = secret;
      ({ failure } = await tryCredential(c.sinkId, c.instanceId, credential));
    } catch (err) {
      failure = err instanceof SinkError ? err.error.message : 'the test could not run';
    }
    if (failure && form.saveUntested !== 'on') {
      return refuse(`The test failed: ${failure}. Nothing was saved.`);
    }
    await app.deps.connections.put({
      id: c.id,
      kind: c.kind,
      owner: c.owner,
      sinkId: c.sinkId,
      instanceId: c.instanceId,
      name: draft.name,
      fields,
      secretEnv: secret ? null : c.secretEnv,
      status: failure ? 'untested' : 'ok',
      statusReason: failure,
      ...(secret ? { secretEnc: encryptSecret(secret, config.secrets) } : {}),
    });
    return changedTo(reply, `/${encodeURIComponent(c.id)}`);
  });

  app.post('/connections/:id/test', { schema: { hide: true } }, async (req, reply) => {
    const s = formPost(req, reply);
    if (!s) return reply;
    const c = await editable(reply, s, (req.params as { id: string }).id);
    if (!c) return reply;
    const sink = (await sinksFor(c))[c.sinkId];
    let failure: string | null = 'the sink is not available';
    let identity: string | null = null;
    if (sink) {
      try {
        ({ failure, identity } = await tryCredential(
          c.sinkId,
          c.instanceId,
          (await app.deps.credentials.resolve(c.id, sink)) ?? {},
        ));
      } catch (err) {
        failure = err instanceof SinkError ? err.error.message : 'the test could not run';
      }
    }
    await app.deps.connections.mark(c.id, failure ? 'needs_attention' : 'ok', failure);
    return renderPage(reply, s, 200, {
      show: (await app.deps.connections.get(c.id)) ?? c,
      changed: true,
      notice: failure
        ? { text: `${c.name}: the test failed: ${failure}.`, error: true }
        : { text: connected(c, identity), error: false },
    });
  });

  app.post('/connections/:id/delete', { schema: { hide: true } }, async (req, reply) => {
    const s = formPost(req, reply);
    if (!s) return reply;
    const c = await editable(reply, s, (req.params as { id: string }).id);
    if (!c) return reply;
    const result = await app.deps.connections.remove(c.id);
    if (result === 'in_use') {
      const users = (await app.deps.targets.list())
        .filter((t) => t.connectionId === c.id)
        .map((t) => t.label);
      return renderPage(reply, s, 409, {
        show: c,
        notice: {
          text: `${c.name} is used by ${users.join(', ')}. Change those targets first.`,
          error: true,
        },
      });
    }
    return changedTo(reply, `?tab=${tabOf(c)}`);
  });
};
