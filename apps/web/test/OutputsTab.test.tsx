import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import { StagePanel } from '../src/workbench/StagePanel.js';
import { changeProposalView, fakeApi, templateView } from './fake-api.js';

const LIVE = {
  id: 'letter',
  version: 3,
  outputs: {
    fields: [
      { id: 'supplier_name', name: 'Supplier', type: 'text' },
      { id: 'currency', type: 'enum', enum: ['GBP', 'EUR'] },
      { id: 'supplier_address', type: 'text' },
    ],
    tables: [{ id: 'line_items', columns: [{ id: 'description' }, { id: 'amount' }] }],
  },
};
const DRAFT = {
  id: 'letter',
  version: 4,
  outputs: {
    fields: [
      { id: 'supplier_name', name: 'Supplier', type: 'text' },
      { id: 'due_date', type: 'date' },
      { id: 'currency', type: 'enum', enum: ['GBP', 'EUR', 'USD'] },
    ],
    tables: [
      {
        id: 'line_items',
        columns: [{ id: 'description' }, { id: 'amount', description: 'Line total' }],
      },
    ],
  },
};

function outputsPanel(
  overrides: Partial<Api> = {},
  props: Partial<Parameters<typeof StagePanel>[0]> = {},
) {
  const api = fakeApi({
    listProposals: vi.fn(async () => [
      changeProposalView({ status: 'accepted', acceptedChanges: [0, 1], briefVersion: 3 }),
    ]),
    getTemplate: vi.fn(async (_id: string, version: number) =>
      version === 4 ? templateView(DRAFT) : templateView(LIVE, 'published'),
    ),
    ...overrides,
  });
  render(
    <StagePanel
      api={api}
      projectId="letter"
      stage="outputs"
      title="Outputs"
      dataPolicy="local"
      hasDraft
      draft={4}
      published={3}
      briefVersion={3}
      pollMs={1}
      onApplied={vi.fn()}
      onSkipped={vi.fn()}
      {...props}
    />,
  );
  return api;
}

describe('Outputs tab', () => {
  it('summarises the draft outputs against the live version', async () => {
    const api = outputsPanel();
    expect(await screen.findByText('3 fields')).toBeInTheDocument();
    expect(api.getTemplate).toHaveBeenCalledWith('letter', 4);
    expect(api.getTemplate).toHaveBeenCalledWith('letter', 3);
    expect(screen.getByText('1 table · 2 columns')).toBeInTheDocument();
    expect(screen.getByText('+1 added')).toBeInTheDocument();
    expect(screen.getByText('~2 changed')).toBeInTheDocument();
    expect(screen.getByText('−1 removed')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Outputs in draft v4' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Compared with live v3')).toBeInTheDocument();
  });

  it('tags each output against live, with removed outputs struck through', async () => {
    outputsPanel();
    const added = await screen.findByRole('row', { name: /due_date/ });
    expect(within(added).getByText('+ ADDED')).toBeInTheDocument();
    const removed = screen.getByRole('row', { name: /supplier_address/ });
    expect(within(removed).getByText('− REMOVED')).toBeInTheDocument();
    expect(removed).toHaveClass('removed');
    expect(screen.getByRole('columnheader', { name: 'vs v3' })).toBeInTheDocument();
  });

  it('filters to the outputs changed since live', async () => {
    outputsPanel();
    await screen.findByRole('row', { name: /due_date/ });
    await userEvent.click(screen.getByRole('button', { name: 'Changed since v3' }));
    expect(screen.queryByRole('row', { name: /supplier_name/ })).toBeNull();
    expect(screen.getByRole('row', { name: /line_items/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /amount/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /description/ })).toBeNull();
  });

  it('has no comparison before the first publish', async () => {
    outputsPanel({}, { published: null });
    expect(await screen.findByText('3 fields')).toBeInTheDocument();
    expect(screen.queryByText(/added$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Changed since/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: /^vs v/ })).toBeNull();
  });

  it('says when the proposal used an older brief', async () => {
    outputsPanel(
      {
        listProposals: vi.fn(async () => [changeProposalView({ briefVersion: 2 })]),
      },
      { briefVersion: 3 },
    );
    expect(await screen.findByRole('note')).toHaveTextContent(
      'This proposal used brief v2; the brief is now v3.',
    );
  });

  it('names what changed when the stage is stale', async () => {
    outputsPanel(
      {},
      {
        item: {
          stage: 'outputs',
          state: 'stale',
          status: 'Stale — Survey changed after it was accepted',
          metrics: [],
        },
      },
    );
    expect(await screen.findByRole('note')).toHaveTextContent(
      'Stale — Survey changed after it was accepted.',
    );
  });

  it('keeps the proposal when the draft cannot be loaded', async () => {
    outputsPanel({
      getTemplate: vi.fn(async () => {
        throw new Error('store down');
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load draft v4: store down',
    );
    expect(screen.getByRole('region', { name: 'Proposal' })).toBeInTheDocument();
  });

  it('says what the tab does', async () => {
    outputsPanel();
    expect(
      await screen.findByText(
        'The fields and tables every document of this type produces. The model proposes them from the brief and survey; you choose which to apply.',
      ),
    ).toBeInTheDocument();
  });
});
