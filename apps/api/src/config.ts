import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const defaultSpecsDir = fileURLToPath(new URL('../../../specs', import.meta.url));

const EnvSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_INBOX: z.string().default('ingest-inbox'),
  S3_BUCKET_OUTPUTS: z.string().default('ingest-outputs'),
  SPECS_DIR: z.string().default(defaultSpecsDir),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(50),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid API configuration:\n  ${issues.join('\n  ')}`);
  }
  return parsed.data;
}
