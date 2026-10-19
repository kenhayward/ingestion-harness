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
