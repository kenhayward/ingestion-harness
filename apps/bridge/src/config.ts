import { z } from 'zod';
import { parseMasterKey, type SecretsKeys } from './secrets.js';

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

const EnvSchema = z.object({
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
  BRIDGE_PACKAGE_RETENTION_DAYS: z.preprocess(
    blank,
    z.coerce.number().int().positive().default(30),
  ),
  BRIDGE_MAX_ATTEMPTS: z.preprocess(blank, z.coerce.number().int().positive().default(8)),
  BRIDGE_LEASE_SECONDS: z.preprocess(blank, z.coerce.number().int().positive().default(300)),
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
});

export type BridgeConfig = Omit<
  z.infer<typeof EnvSchema>,
  'BRIDGE_SECRETS_KEY' | 'BRIDGE_SECRETS_KEY_PREVIOUS'
> & { secrets: SecretsKeys };

/** The bridge's settings from the environment; one error lists every problem. */
export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid bridge configuration:\n  ${issues.join('\n  ')}`);
  }
  const { BRIDGE_SECRETS_KEY, BRIDGE_SECRETS_KEY_PREVIOUS, ...rest } = parsed.data;
  return {
    ...rest,
    secrets: { current: BRIDGE_SECRETS_KEY, previous: BRIDGE_SECRETS_KEY_PREVIOUS ?? null },
  };
}
