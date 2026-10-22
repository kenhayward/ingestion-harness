import type { SinkView } from '@ih/bridge-contract';

/** The fake external sink as the bridge's catalog lists it. */
export const FAKE_SINK: SinkView = {
  id: 'fake',
  name: 'Fake sink',
  status: 'available',
  contractVersion: 1,
  capabilities: {
    browse: true,
    replace: true,
    withdraw: false,
    readBack: false,
    accepts: ['files', 'data'],
  },
  connectionKind: 'shared',
  instances: [],
  destinationFields: [
    {
      id: 'space',
      label: 'Space',
      kind: 'fixed',
      required: true,
      overridable: false,
      browse: true,
    },
    {
      id: 'name',
      label: 'Name',
      kind: 'pattern',
      required: true,
      overridable: true,
      browse: false,
    },
  ],
  credentialFields: [{ id: 'token', label: 'Token', secret: true }],
};
