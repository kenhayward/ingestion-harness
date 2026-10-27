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

/** A sink that takes decomposed documents (contract version 2), as the bridge's catalog lists it. */
export const FAKE_DOCUMENT_SINK: SinkView = {
  ...FAKE_SINK,
  id: 'docs',
  name: 'Document sink',
  contractVersion: 2,
  capabilities: {
    ...FAKE_SINK.capabilities,
    readBack: true,
    accepts: ['document', 'images'],
    decomposedDocuments: { equations: ['mathml'] },
  },
};

/** A sink that declares administration (contract version 3), as the bridge's catalog lists it. */
export const FAKE_ADMIN_SINK: SinkView = {
  ...FAKE_SINK,
  id: 'admin-sink',
  name: 'Administered sink',
  contractVersion: 3,
  capabilities: {
    ...FAKE_SINK.capabilities,
    administration: {
      instances: true,
      clients: true,
      instanceFields: [
        { id: 'address', label: 'Address', required: true, hint: 'Where it is reached' },
        { id: 'region', label: 'Region', required: false, hint: null },
      ],
    },
  },
};
