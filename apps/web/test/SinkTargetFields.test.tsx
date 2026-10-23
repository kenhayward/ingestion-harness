import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { SinkInfo } from '@ih/shared';
import { describe, expect, it, vi } from 'vitest';
import { SinkTargetFields, type SinkTargetValue } from '../src/access/SinkTargetFields.js';
import { fakeApi } from './fake-api.js';

const SINK: SinkInfo = {
  id: '3dexperience',
  name: '3DEXPERIENCE',
  status: 'available',
  contractVersion: 1,
  connectionKind: 'personal',
  instances: [{ id: 'sandbox-2', label: 'LSE Tenant' }],
  destinationFields: [
    {
      id: 'objectStorage',
      label: 'Object storage',
      kind: 'fixed',
      required: true,
      overridable: false,
      browse: true,
    },
    {
      id: 'folder',
      label: 'Folder',
      kind: 'fixed',
      required: true,
      overridable: false,
      browse: false,
    },
    {
      id: 'repository',
      label: 'Document repository',
      kind: 'fixed',
      required: false,
      overridable: false,
      browse: true,
    },
  ],
  credentialFields: [],
  capabilities: {
    browse: true,
    replace: true,
    withdraw: false,
    readBack: false,
    accepts: ['files', 'data'],
  },
};

const REPO = 'A'.repeat(32);
const leaf = (id: string, label: string) => ({
  id,
  label,
  kind: 'object-storage',
  hasChildren: false,
  selectable: true,
});

const browseSink = () =>
  vi.fn(async (req: { field: string }) =>
    req.field === 'objectStorage'
      ? { nodes: [leaf('os-1', 'CMC_Integration (dp-cmc)')], nextCursor: null }
      : { nodes: [leaf(REPO, 'Training (Rep-1)')], nextCursor: null },
  );

function Harness({ api, start }: { api: ReturnType<typeof fakeApi>; start: SinkTargetValue }) {
  const [value, setValue] = useState(start);
  return <SinkTargetFields api={api} sink={SINK} value={value} onChange={setValue} />;
}

describe('SinkTargetFields', () => {
  it("can't browse until an instance is chosen", async () => {
    const api = fakeApi({ browseSink: browseSink() } as never);
    render(<Harness api={api} start={{ instanceId: null, connectionId: null, destination: {} }} />);
    const browse = screen.getByRole('button', { name: 'Browse Object storage' });
    expect(browse).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Browse Document repository' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Instance' }), 'sandbox-2');
    expect(browse).toBeEnabled();
  });

  it('shows a picked storage by its name and project, with its id in brackets', async () => {
    const api = fakeApi({ browseSink: browseSink() } as never);
    render(
      <Harness
        api={api}
        start={{ instanceId: 'sandbox-2', connectionId: null, destination: {} }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Browse Object storage' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose object storage' });
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'CMC_Integration (dp-cmc)' }),
    );
    expect(screen.getByRole('textbox', { name: 'Object storage' })).toHaveValue(
      'CMC_Integration (dp-cmc) [os-1]',
    );
  });

  it("names a saved target's storage and repository, read from the sink", async () => {
    const api = fakeApi({ browseSink: browseSink() } as never);
    render(
      <Harness
        api={api}
        start={{
          instanceId: 'sandbox-2',
          connectionId: null,
          destination: { objectStorage: 'os-1', folder: 'reports', repository: REPO },
        }}
      />,
    );
    expect(await screen.findByDisplayValue('CMC_Integration (dp-cmc) [os-1]')).toBeVisible();
    expect(await screen.findByDisplayValue(`Training (Rep-1) [${REPO}]`)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('reports');
  });

  it("shows the id alone when the sink doesn't list it, and clears an optional one", async () => {
    const api = fakeApi({ browseSink: browseSink() } as never);
    render(
      <Harness
        api={api}
        start={{
          instanceId: 'sandbox-2',
          connectionId: null,
          destination: { objectStorage: 'os-gone', repository: REPO },
        }}
      />,
    );
    expect(await screen.findByDisplayValue('os-gone')).toBeVisible();
    await screen.findByDisplayValue(`Training (Rep-1) [${REPO}]`);
    await userEvent.click(screen.getByRole('button', { name: 'Clear Document repository' }));
    expect(screen.getByRole('textbox', { name: 'Document repository (optional)' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear Object storage' })).toBeNull();
  });
});
