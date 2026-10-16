import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { baseIriProblem, CUSTOMER_SLUG_RE } from '@ih/shared';

const defaultSpecsDir = fileURLToPath(new URL('../../../specs', import.meta.url));

/** docker-compose passes unset optional variables as ''. */
const blank = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blank, schema.optional());

/** One `frame-ancestors` source: an https origin, optionally `*.` for every subdomain. */
const FRAME_SOURCE = /^https:\/\/(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+(:\d{1,5})?$/i;

/**
 * Sites allowed to show the app in a frame (space-separated https origins, `*.` wildcards),
 * normalised to single spaces; null (blank) = no framing. The app's nginx sends the same value.
 */
const FrameAncestors = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().split(/\s+/).filter(Boolean).join(' ') || null : null),
  z
    .string()
    .refine((v) => v.split(' ').every((source) => FRAME_SOURCE.test(source)), {
      message: 'FRAME_ANCESTORS takes https origins only, e.g. https://*.example.com',
    })
    .nullable(),
);

const EnvSchema = z
  .object({
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
    S3_BUCKET_RUNS: z.string().default('ingest-runs'),
    // Final target for published outputs (read back by the Results page). Mirrors the worker:
    // any unset value falls back to the S3_* connection above.
    TARGET_S3_ENDPOINT: optional(z.string().url()),
    TARGET_S3_REGION: optional(z.string()),
    TARGET_S3_ACCESS_KEY: optional(z.string()),
    TARGET_S3_SECRET_KEY: optional(z.string()),
    TARGET_S3_BUCKET: z.preprocess(blank, z.string().default('ingest-published')),
    TARGET_S3_PREFIX: z.preprocess(blank, z.string().default('')),
    /** The URL the data lake reads the publish bucket through (the proxy, ADR 0008); display only. */
    S3_PUBLIC_URL: optional(z.string().url()),
    /** The URL consumers reach Fuseki's dataset through (the proxy, ADR 0011); display only. */
    RDF_PUBLIC_URL: optional(z.string().url()),
    SPECS_DIR: z.string().default(defaultSpecsDir),
    MAX_UPLOAD_MB: z.coerce.number().positive().default(50),
    /** Hosts ontologies may be imported from by URL (ADR 0011), comma-separated; empty: off. */
    ONTOLOGY_FETCH_ALLOW: z.preprocess(blank, z.string().default('')),
    /** Fetched ontology files over this many bytes are refused (the worker enforces it). */
    ONTOLOGY_MAX_BYTES: z.coerce.number().int().positive().default(104857600),
    /** The deployment's customer, `slug=Name` (ADR 0011); seeds the Linked data settings once. */
    LINKED_DATA_CUSTOMER: optional(
      z.string().refine((v) => CUSTOMER_SLUG_RE.test(v.split('=')[0]!.trim()), {
        message: 'the customer id (before =) must be lower case letters, digits and -',
      }),
    ),
    /** The customer's own base IRI; seeds the Linked data settings once. */
    LINKED_DATA_BASE_IRI: optional(
      z.string().superRefine((v, ctx) => {
        const problem = baseIriProblem(v);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      }),
    ),
    /** Proxies whose X-Forwarded-* headers are trusted (default: private networks). */
    TRUST_PROXY: optional(z.string()),
    /** Sites that may embed the app in a frame (e.g. https://*.3dexperience.3ds.com); null: none. */
    FRAME_ANCESTORS: FrameAncestors,
    /** The GitHub OAuth app users link their accounts with (docs/design/profile.md); both or none. */
    GITHUB_CLIENT_ID: optional(z.string()),
    GITHUB_CLIENT_SECRET: optional(z.string()),
    /** The callback registered with that app; unset: from the request (proxy headers). */
    GITHUB_REDIRECT_URL: optional(z.string().url()),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.GITHUB_CLIENT_ID) !== Boolean(env.GITHUB_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_CLIENT_ID'],
        message: 'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET go together',
      });
    }
    if (env.LINKED_DATA_BASE_IRI && !env.LINKED_DATA_CUSTOMER) {
      ctx.addIssue({
        code: 'custom',
        path: ['LINKED_DATA_BASE_IRI'],
        message: 'LINKED_DATA_BASE_IRI needs LINKED_DATA_CUSTOMER',
      });
    }
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

export interface TargetConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
}

/** The publish target, resolved exactly like worker/src/ingest_worker/config.py. */
export function targetConfig(c: Config): TargetConfig {
  return {
    endpoint: c.TARGET_S3_ENDPOINT ?? c.S3_ENDPOINT,
    region: c.TARGET_S3_REGION ?? c.S3_REGION,
    accessKeyId: c.TARGET_S3_ACCESS_KEY ?? c.S3_ACCESS_KEY,
    secretAccessKey: c.TARGET_S3_SECRET_KEY ?? c.S3_SECRET_KEY,
    bucket: c.TARGET_S3_BUCKET,
    prefix: c.TARGET_S3_PREFIX,
  };
}

/**
 * Read-only S3 keys (ADR 0008) are issued through the local SeaweedFS's IAM, for the internal
 * publishing targets; whether any can be issued depends on whether one exists.
 */
export function s3KeysConfig(c: Config): { endpoint: string | null } {
  return { endpoint: c.S3_PUBLIC_URL ?? null };
}

/** The GitHub OAuth app, or null when users cannot link GitHub accounts. */
export function githubConfig(
  c: Config,
): { clientId: string; clientSecret: string; redirectUrl: string | null } | null {
  if (!c.GITHUB_CLIENT_ID || !c.GITHUB_CLIENT_SECRET) return null;
  return {
    clientId: c.GITHUB_CLIENT_ID,
    clientSecret: c.GITHUB_CLIENT_SECRET,
    redirectUrl: c.GITHUB_REDIRECT_URL ?? null,
  };
}
