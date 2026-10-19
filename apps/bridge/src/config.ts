import { z } from 'zod';

/** docker-compose passes unset optional variables as ''. */
const blank = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());

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
});

export type BridgeConfig = z.infer<typeof EnvSchema>;

/** The bridge's settings from the environment; one error lists every problem. */
export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid bridge configuration:\n  ${issues.join('\n  ')}`);
  }
  return parsed.data;
}
