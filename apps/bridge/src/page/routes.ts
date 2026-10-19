import { parse as parseQuery } from 'node:querystring';
import type { SinkDescribe } from '@ih/bridge-contract';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { connectionProblem, INTERNAL_CONNECTION_ID, type Connection } from '../connections/repo.js';
import { encryptSecret } from '../secrets.js';
import { SinkError } from '../sinks/port.js';
import {
  editPage,
  laterPage,
  listPage,
  message,
  PAGE_CSS,
  type FormValues,
  type Shell,
} from './html.js';
import {
  csrfMatches,
  newSession,
  openSession,
  sealSession,
  SESSION_COOKIE,
  SESSION_SECONDS,
  type PageSession,
} from './session.js';

const CSP = "default-src 'self'; form-action 'self'; frame-ancestors 'none'";
const EXPIRED = 'This link has expired. Open Connections again from CT Studio.';
const ENDED = 'Your session has ended. Open Connections again from CT Studio.';
/** A non-secret S3 field naming the variable its access key id is read from. */
const ACCESS_KEY_ENV = 'accessKeyIdEnv';

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
 * cookie with a CSRF token every form carries. Phase 2 serves admins' shared connections only.
 */
export const pageRoutes: FastifyPluginAsync = async (app) => {
  const { config } = app.deps;
  const publicUrl = new URL(config.BRIDGE_PUBLIC_URL);
  const base = publicUrl.pathname.replace(/\/+$/, '');
  const key = config.BRIDGE_CLIENT_KEY;

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

  const shell = (s?: PageSession): Shell => ({ base, ...(s ? { user: s.user } : {}) });
  const html = (reply: FastifyReply, code: number, body: string) =>
    reply.code(code).type('text/html; charset=utf-8').send(body);
  const toList = (reply: FastifyReply) =>
    reply.code(303).header('location', `${base}/connections`).send();

  /** The shared-connection sinks: their describe, by id. */
  const sharedSinks = async (): Promise<Record<string, SinkDescribe>> => {
    const out: Record<string, SinkDescribe> = {};
    for (const id of app.deps.sinks.ids()) {
      try {
        const d = await app.deps.sinks.get(id)!.describe();
        if (d.connectionKind === 'shared' && d.credentialFields.length) out[id] = d;
      } catch {
        // A sink that cannot describe itself offers nothing to connect to now.
      }
    }
    return out;
  };

  const session = (req: FastifyRequest) =>
    openSession(cookieOf(req, SESSION_COOKIE), key, Date.now());

  /** The admin session of a form post with its token; otherwise the refusal is sent. */
  const adminPost = (req: FastifyRequest, reply: FastifyReply): PageSession | null => {
    const s = session(req);
    if (!s) {
      void html(reply, 401, message(shell(), 'Session ended', ENDED));
      return null;
    }
    if (s.user.role !== 'admin' || !csrfMatches(s, formOf(req.body).csrf)) {
      void html(reply, 403, message(shell(s), 'Not allowed', 'You cannot change connections.'));
      return null;
    }
    return s;
  };

  const renderList = async (
    reply: FastifyReply,
    s: PageSession,
    code = 200,
    extra: { notice?: { text: string; error: boolean }; draft?: FormValues } = {},
  ) =>
    html(
      reply,
      code,
      listPage(shell(s), {
        connections: await app.deps.connections.list({ kind: 'shared' }),
        csrf: s.csrf,
        sinks: await sharedSinks(),
        builtIn: INTERNAL_CONNECTION_ID,
        ...extra,
      }),
    );

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

  /** Runs the sink's connection test; the failure's message, or null when it passed. */
  const tryCredential = async (
    sinkId: string,
    credential: Record<string, string>,
  ): Promise<string | null> => {
    try {
      await app.deps.sinks.get(sinkId)!.testConnection({ instanceId: '', credential });
      return null;
    } catch (err) {
      if (err instanceof SinkError) return err.error.message;
      return 'the test could not run';
    }
  };

  app.get('/connections/page.css', { schema: { hide: true } }, async (_req, reply) =>
    reply.type('text/css; charset=utf-8').send(PAGE_CSS),
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
    if (!user) return html(reply, 401, message(shell(), 'Link expired', EXPIRED));
    const value = sealSession(newSession(user, Date.now()), key);
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
    if (!s) return html(reply, 401, message(shell(), 'Session ended', ENDED));
    if (s.user.role !== 'admin') return html(reply, 200, laterPage(shell(s)));
    return renderList(reply, s);
  });

  /** The connection an admin may change: not the built-in one. */
  const editable = async (
    reply: FastifyReply,
    s: PageSession,
    id: string,
  ): Promise<Connection | null> => {
    if (id === INTERNAL_CONNECTION_ID) {
      void html(
        reply,
        403,
        message(shell(s), 'Built in', 'The built-in connection cannot be changed.'),
      );
      return null;
    }
    const c = await app.deps.connections.get(id);
    if (!c || c.kind !== 'shared') {
      void html(reply, 404, message(shell(s), 'Not found', `There is no connection ${id}.`));
      return null;
    }
    return c;
  };

  app.get('/connections/:id', { schema: { hide: true } }, async (req, reply) => {
    const s = session(req);
    if (!s) return html(reply, 401, message(shell(), 'Session ended', ENDED));
    if (s.user.role !== 'admin') return html(reply, 200, laterPage(shell(s)));
    const c = await editable(reply, s, (req.params as { id: string }).id);
    if (!c) return reply;
    return html(
      reply,
      200,
      editPage(shell(s), { connection: c, csrf: s.csrf, sinks: await sharedSinks() }),
    );
  });

  app.post('/connections', { schema: { hide: true } }, async (req, reply) => {
    const s = adminPost(req, reply);
    if (!s) return reply;
    const form = formOf(req.body);
    const sinks = await sharedSinks();
    const sinkId = form.sinkId ?? Object.keys(sinks)[0] ?? '';
    const sink = sinks[sinkId];
    if (!sink) return renderList(reply, s, 422, { notice: { text: 'Choose a kind', error: true } });
    const id = (form.id ?? '').trim();
    const draft = valuesOf(form, sink, id, sinkId);
    const refuse = (code: number, text: string) =>
      renderList(reply, s, code, { notice: { text, error: true }, draft });
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
    const failure = await tryCredential(sinkId, {
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
    return toList(reply);
  });

  app.post('/connections/:id', { schema: { hide: true } }, async (req, reply) => {
    const s = adminPost(req, reply);
    if (!s) return reply;
    const c = await editable(reply, s, (req.params as { id: string }).id);
    if (!c) return reply;
    const sink = (await sharedSinks())[c.sinkId];
    if (!sink)
      return renderList(reply, s, 422, {
        notice: { text: 'The sink is not available', error: true },
      });
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
      html(
        reply,
        422,
        editPage(shell(s), {
          connection: c,
          csrf: s.csrf,
          sinks: await sharedSinks(),
          notice: { text, error: true },
          draft,
        }),
      );
    if (!draft.name) return refuse('Enter a name.');
    let failure: string | null;
    try {
      const stored = (await app.deps.credentials.resolve(c.id, sink)) ?? {};
      const credential = { ...stored, ...draft.fields };
      if (secretField && secret) credential[secretField.id] = secret;
      failure = await tryCredential(c.sinkId, credential);
    } catch (err) {
      failure = err instanceof SinkError ? err.error.message : 'the test could not run';
    }
    if (failure && form.saveUntested !== 'on') {
      return refuse(`The test failed: ${failure}. Nothing was saved.`);
    }
    await app.deps.connections.put({
      id: c.id,
      kind: 'shared',
      owner: null,
      sinkId: c.sinkId,
      instanceId: c.instanceId,
      name: draft.name,
      fields,
      secretEnv: secret ? null : c.secretEnv,
      status: failure ? 'untested' : 'ok',
      statusReason: failure,
      ...(secret ? { secretEnc: encryptSecret(secret, config.secrets) } : {}),
    });
    return toList(reply);
  });

  app.post('/connections/:id/test', { schema: { hide: true } }, async (req, reply) => {
    const s = adminPost(req, reply);
    if (!s) return reply;
    const c = await editable(reply, s, (req.params as { id: string }).id);
    if (!c) return reply;
    const sink = (await sharedSinks())[c.sinkId];
    let failure: string | null = 'the sink is not available';
    if (sink) {
      try {
        failure = await tryCredential(
          c.sinkId,
          (await app.deps.credentials.resolve(c.id, sink)) ?? {},
        );
      } catch (err) {
        failure = err instanceof SinkError ? err.error.message : 'the test could not run';
      }
    }
    await app.deps.connections.mark(c.id, failure ? 'needs_attention' : 'ok', failure);
    return renderList(reply, s, 200, {
      notice: failure
        ? { text: `${c.name}: the test failed: ${failure}.`, error: true }
        : { text: `${c.name}: Connected.`, error: false },
    });
  });

  app.post('/connections/:id/delete', { schema: { hide: true } }, async (req, reply) => {
    const s = adminPost(req, reply);
    if (!s) return reply;
    const c = await editable(reply, s, (req.params as { id: string }).id);
    if (!c) return reply;
    const result = await app.deps.connections.remove(c.id);
    if (result === 'in_use') {
      const users = (await app.deps.targets.list())
        .filter((t) => t.connectionId === c.id)
        .map((t) => t.label);
      return renderList(reply, s, 409, {
        notice: {
          text: `${c.name} is used by ${users.join(', ')}. Change those targets first.`,
          error: true,
        },
      });
    }
    return toList(reply);
  });
};
