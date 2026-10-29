import { z } from 'zod';
import { parseMasterKey, type SecretsKeys } from './secrets.js';
import { parseSinkEntries, type SinkEntry } from './sinks/registry.js';

/** docker-compose passes unset optional variables as ''. */
const blank = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());

function masterKey(name: string) {
  return z.string().transform((v, ctx) => {
    try {
      return parseMasterKey(v, name);
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: (err as Error).message });
      return z.NEVER;
    }
  });
}

/** A bare http(s) origin (`https://ctstudio.app`, `http://localhost:8081`), normalised. */
const origin = z.string().transform((v, ctx) => {
  let url: URL | null = null;
  try {
    url = new URL(v);
  } catch {
    // reported below
  }
  if (!url || !/^https?:$/.test(url.protocol) || v.replace(/\/$/, '') !== url.origin) {
    ctx.addIssue({ code: 'custom', message: 'must be an origin such as https://ct.example.com' });
    return z.NEVER;
  }
  return url.origin;
});

/** A page on the app's own origin is never framed: its DOM would be in the app's reach. */
const SAME_ORIGIN =
  "BRIDGE_APP_ORIGIN must differ from BRIDGE_PUBLIC_URL's origin: a page on the app's own origin is never framed";
const sameOrigin = (env: { BRIDGE_APP_ORIGIN?: string; BRIDGE_PUBLIC_URL: string }) =>
  env.BRIDGE_APP_ORIGIN !== undefined &&
  env.BRIDGE_APP_ORIGIN === new URL(env.BRIDGE_PUBLIC_URL).origin;

const EnvSchema = z
  .object({
    HOST: z.preprocess(blank, z.string().default('0.0.0.0')),
    PORT: z.preprocess(blank, z.coerce.number().int().default(3100)),
    LOG_LEVEL: z.preprocess(
      blank,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    ),
    DATABASE_URL: z.string().url(),
    /** Shared with CT Studio: signs every request in both directions. */
    BRIDGE_CLIENT_KEY: z.string().min(32),
    /** Where delivery events are posted (CT Studio's API); unset: events stay in the outbox. */
    BRIDGE_EVENTS_URL: optional(z.string().url()),
    BRIDGE_MAX_PACKAGE_MB: z.preprocess(blank, z.coerce.number().int().positive().default(50)),
    /** The largest watched-folder file the bridge reads (larger: 422 `content_rejected`). */
    BRIDGE_MAX_SOURCE_MB: z.preprocess(blank, z.coerce.number().int().positive().default(100)),
    BRIDGE_PACKAGE_RETENTION_DAYS: z.preprocess(
      blank,
      z.coerce.number().int().positive().default(30),
    ),
    BRIDGE_MAX_ATTEMPTS: z.preprocess(blank, z.coerce.number().int().positive().default(8)),
    BRIDGE_LEASE_SECONDS: z.preprocess(blank, z.coerce.number().int().positive().default(300)),
    /** Delivery runner loops in this process; each tenant's lanes still bound what runs at once. */
    BRIDGE_DELIVERY_RUNNERS: z.preprocess(blank, z.coerce.number().int().min(1).max(32).default(4)),
    /** The deployment's own S3 (SeaweedFS): internal targets and the package staging bucket. */
    S3_ENDPOINT: z.string().url(),
    /** Another URL the deployment's S3 answers on: a connection there keeps to its bucket rules. */
    S3_PUBLIC_URL: optional(z.string().url()),
    /** CT Studio's own buckets on the same S3 (shared env): no target may use them. */
    S3_BUCKET_INBOX: z.preprocess(blank, z.string().default('ingest-inbox')),
    S3_BUCKET_OUTPUTS: z.preprocess(blank, z.string().default('ingest-outputs')),
    S3_BUCKET_RUNS: z.preprocess(blank, z.string().default('ingest-runs')),
    S3_BUCKET_BACKUPS: z.preprocess(blank, z.string().default('ingest-backups')),
    S3_REGION: z.preprocess(blank, z.string().default('us-east-1')),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    /** Where accepted packages wait until their deliveries are done. */
    BRIDGE_STAGING_BUCKET: z.preprocess(blank, z.string().default('ingest-bridge')),
    /** CT Studio's API base, for signed calls back (handoff codes), e.g. http://api:3000/api. */
    BRIDGE_PRODUCER_URL: z.string().url(),
    /** Where browsers reach the connections page: its own origin, or a path under CT Studio's. */
    BRIDGE_PUBLIC_URL: z.string().url(),
    /** The origin people reach CT Studio at: it alone may frame the page. Unset: nobody. */
    BRIDGE_APP_ORIGIN: optional(origin),
    /** Marks the page's session cookie Secure (turn off only for plain-HTTP local use). */
    BRIDGE_COOKIE_SECURE: z.preprocess(
      blank,
      z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
    ),
    /** Encrypts connection secrets at rest (32 bytes, base64). */
    BRIDGE_SECRETS_KEY: masterKey('BRIDGE_SECRETS_KEY'),
    /** The key before a rotation: still decrypts. */
    BRIDGE_SECRETS_KEY_PREVIOUS: optional(masterKey('BRIDGE_SECRETS_KEY_PREVIOUS')),
    /** How often each sink is described again (its describe is cached between). */
    BRIDGE_SINK_REFRESH_SECONDS: z.preprocess(
      blank,
      z.coerce.number().int().positive().default(300),
    ),
  })
  .superRefine((env, ctx) => {
    if (sameOrigin(env)) {
      ctx.addIssue({ code: 'custom', path: ['BRIDGE_APP_ORIGIN'], message: SAME_ORIGIN });
    }
  });

export type BridgeConfig = Omit<
  z.infer<typeof EnvSchema>,
  'BRIDGE_SECRETS_KEY' | 'BRIDGE_SECRETS_KEY_PREVIOUS'
> & {
  secrets: SecretsKeys;
  /** External sinks (BRIDGE_SINKS or BRIDGE_SINKS_FILE): none when unset. */
  sinks: SinkEntry[];
};

/** The bridge's settings from the environment; one error lists every problem. */
export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid bridge configuration:\n  ${issues.join('\n  ')}`);
  }
  const { BRIDGE_SECRETS_KEY, BRIDGE_SECRETS_KEY_PREVIOUS, ...rest } = parsed.data;
  let sinks: SinkEntry[];
  try {
    sinks = parseSinkEntries(env);
  } catch (err) {
    throw new Error(`Invalid bridge configuration:
  ${(err as Error).message}`);
  }
  return {
    ...rest,
    secrets: { current: BRIDGE_SECRETS_KEY, previous: BRIDGE_SECRETS_KEY_PREVIOUS ?? null },
    sinks,
  };
}

/** A host's site, roughly: an IP address or `localhost` itself, else its last two labels. */
const siteOf = (url: URL): string => {
  const host = url.hostname;
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.startsWith('[')) return host;
  return host.split('.').slice(-2).join('.');
};

/**
 * Why the framed page would fail, or null: a page on another site than the app's is a
 * third-party frame, whose `SameSite=Lax` session cookie browsers block, so the modal would keep
 * saying the session ended. A warning, not a refusal: without the public suffix list the site is
 * a guess (`a.co.uk` and `b.co.uk` look alike).
 */
export function crossSiteWarning(appOrigin: string | undefined, publicUrl: string): string | null {
  if (!appOrigin) return null;
  const app = new URL(appOrigin);
  const page = new URL(publicUrl);
  if (app.protocol === page.protocol && siteOf(app) === siteOf(page)) return null;
  return `BRIDGE_PUBLIC_URL (${page.origin}) is not on the same site as BRIDGE_APP_ORIGIN (${app.origin}): use a subdomain of the app's domain, or the connections modal will keep saying the session ended`;
}
