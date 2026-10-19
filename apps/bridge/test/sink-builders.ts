import { readFileSync } from 'node:fs';
import { PackageSchema, type SinkDeliverRequest } from '@ih/bridge-contract';

/** The contract's document fixture. */
export const documentPackage = PackageSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/bridge-contract/test/fixtures/package-document.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ),
);

export const deliverRequest = (over: Partial<SinkDeliverRequest> = {}): SinkDeliverRequest => ({
  instanceId: null,
  credential: null,
  destination: { bucket: 'b' },
  idempotencyKey: documentPackage.idempotencyKey,
  actingUser: null,
  package: documentPackage,
  ...over,
});
