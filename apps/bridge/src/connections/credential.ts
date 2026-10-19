import { bridgeError, type SinkDescribe } from '@ih/bridge-contract';
import { decryptSecret, type SecretsKeys } from '../secrets.js';
import { SinkError } from '../sinks/port.js';
import { INTERNAL_CREDENTIAL } from '../sinks/s3.js';
import { CREDENTIAL_ENV_NAMES, INTERNAL_CONNECTION_ID, type ConnectionRepo } from './repo.js';

/** A non-secret field naming the variable that holds the access key id (env-keyed S3). */
const ACCESS_KEY_ENV = 'accessKeyIdEnv';

const fromEnv = (env: Record<string, string | undefined>, name: string, what: string): string => {
  const value = CREDENTIAL_ENV_NAMES.has(name) ? env[name] : undefined;
  if (!value) {
    throw new SinkError(bridgeError('credential_missing', `the connection's ${what} is not set`));
  }
  return value;
};

/**
 * Turns a connection into the credential a sink is called with: its declared non-secret fields
 * plus its secret under the sink's secret field, decrypted with `BRIDGE_SECRETS_KEY` or read from
 * an allowlisted environment variable of the bridge. The seeded `internal` connection becomes the
 * S3 sink's marker for the bridge's own S3 settings. Fields a sink does not declare are dropped,
 * so a stored field can never pose as that marker.
 */
export class Credentials {
  constructor(
    private readonly deps: {
      connections: ConnectionRepo;
      secrets: SecretsKeys;
      env: Record<string, string | undefined>;
    },
  ) {}

  async resolve(
    connectionId: string | null,
    sink: SinkDescribe,
  ): Promise<Record<string, string> | null> {
    if (connectionId === null) return null;
    const connection = await this.deps.connections.get(connectionId);
    const stored = await this.deps.connections.secretOf(connectionId);
    if (!connection || !stored) {
      throw new SinkError(
        bridgeError('connection_missing', `no connection ${connectionId}`, { connectionId }),
      );
    }
    if (connectionId === INTERNAL_CONNECTION_ID) return { ...INTERNAL_CREDENTIAL };
    const declared = new Map(sink.credentialFields.map((f) => [f.id, f]));
    const credential: Record<string, string> = {};
    for (const [id, value] of Object.entries(connection.fields)) {
      if (declared.has(id) && !declared.get(id)!.secret) credential[id] = value;
    }
    const keyEnv = connection.fields[ACCESS_KEY_ENV];
    if (keyEnv) credential.accessKeyId = fromEnv(this.deps.env, keyEnv, 'access key variable');
    const secretField = sink.credentialFields.find((f) => f.secret);
    if (secretField) {
      if (stored.secretEnc) {
        try {
          credential[secretField.id] = decryptSecret(stored.secretEnc, this.deps.secrets);
        } catch {
          throw new SinkError(
            bridgeError(
              'credential_missing',
              `the secret of ${connection.name} cannot be decrypted`,
            ),
          );
        }
      } else if (stored.secretEnv) {
        credential[secretField.id] = fromEnv(this.deps.env, stored.secretEnv, 'secret variable');
      }
    }
    return credential;
  }
}
