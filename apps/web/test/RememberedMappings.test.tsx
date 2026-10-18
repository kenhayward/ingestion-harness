import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MappingMemoryEntry, MappingMemoryPage } from '@ih/shared';
import { answerInWords } from '../src/ontologies/memory.js';
import { RememberedMappings } from '../src/ontologies/RememberedMappings.js';
import { fakeApi } from './fake-api.js';

const E = 'https://ex.example/v#';

const entry = (over: Partial<MappingMemoryEntry> = {}): MappingMemoryEntry => ({
  id: 'm-1',
  kind: 'column',
  signatureKey: 'value|water content|number|%',
  name: 'Water content',
  description: '',
  type: 'number',
  unit: '%',
  answer: { form: 'node', class: `${E}WaterFraction`, unit: 'http://qudt.org/vocab/unit/PERCENT' },
  ontologies: ['afo'],
  status: 'learned',
  stale: null,
  votes: 2,
  refusals: 0,
  recipes: [
    { id: 'covalidation', path: 'appearance.water', version: 3 },
    { id: 'stability', path: 'results.water', version: 1 },
  ],
  reviewedBy: null,
  reviewedAt: null,
  note: null,
  updatedAt: '2026-10-18T12:00:00.000Z',
  ...over,
});

const page = (entries: MappingMemoryEntry[]): MappingMemoryPage => ({
  entries,
  total: entries.length,
  labels: {
    [`${E}WaterFraction`]: {
      label: 'water mass fraction',
      kind: 'class',
      deprecated: false,
      ontology: 'afo@1',
      altLabels: ['water content'],
      definition: 'The mass of water in a portion of material divided by its total mass.',
    },
    [`${E}batchNumber`]: {
      label: 'batch number',
      kind: 'datatype_property',
      deprecated: false,
      ontology: 'afo@1',
      altLabels: [],
      definition: null,
    },
  },
});

describe('answerInWords', () => {
  it.each([
    [
      { form: 'node', class: `${E}WaterFraction`, unit: 'http://qudt.org/vocab/unit/PERCENT' },
      'Value node of water mass fraction, in PERCENT',
    ],
    [{ form: 'literal', property: `${E}batchNumber` }, 'Value of batch number'],
    [{ form: 'unmapped' }, 'Left unmapped'],
    [
      { form: 'table', link: `${E}has`, class: `${E}WaterFraction` },
      'Rows of water mass fraction, linked by has',
    ],
  ] as const)('%j', (answer, words) => {
    expect(answerInWords(answer as MappingMemoryEntry['answer'], page([]).labels)).toBe(words);
  });
});

describe('RememberedMappings', () => {
  it('lists what was accepted in words, with the recipes that use it', async () => {
    const api = fakeApi({ listMappingMemory: vi.fn(async () => page([entry()])) });
    render(<RememberedMappings api={api} />);
    const row = await screen.findByRole('row', { name: /Water content/ });
    expect(within(row).getByText('Value node of water mass fraction, in PERCENT')).toBeTruthy();
    expect(within(row).getByText('Used by 2 recipes')).toBeTruthy();
    expect(within(row).getByText('Learned')).toBeTruthy();
    expect(api.listMappingMemory).toHaveBeenCalledWith({ status: 'review', q: undefined });
  });

  it('says what the answer terms mean', async () => {
    const api = fakeApi({ listMappingMemory: vi.fn(async () => page([entry()])) });
    render(<RememberedMappings api={api} />);
    const row = await screen.findByRole('row', { name: /Water content/ });
    await userEvent.click(within(row).getByText('What the terms mean'));
    expect(
      within(row).getByText(
        'The mass of water in a portion of material divided by its total mass.',
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText('Also called: water content')).toBeInTheDocument();
  });

  it('filters by status', async () => {
    const api = fakeApi({ listMappingMemory: vi.fn(async () => page([])) });
    render(<RememberedMappings api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Confirmed' }));
    expect(api.listMappingMemory).toHaveBeenLastCalledWith({ status: 'confirmed', q: undefined });
  });

  it('confirms and rejects an entry', async () => {
    const confirmed = entry({ status: 'confirmed', reviewedBy: 'Ada' });
    const api = fakeApi({
      listMappingMemory: vi.fn(async () => page([entry()])),
      reviewMappingMemoryEntry: vi.fn(async () => ({ entry: confirmed, labels: {} })),
    });
    render(<RememberedMappings api={api} />);
    const row = await screen.findByRole('row', { name: /Water content/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Confirm' }));
    expect(api.reviewMappingMemoryEntry).toHaveBeenCalledWith('m-1', { status: 'confirmed' });
    await userEvent.click(within(row).getByRole('button', { name: 'Reject' }));
    expect(api.reviewMappingMemoryEntry).toHaveBeenLastCalledWith('m-1', { status: 'rejected' });
  });

  it('says why an entry is stale', async () => {
    const api = fakeApi({
      listMappingMemory: vi.fn(async () =>
        page([entry({ stale: 'water mass fraction is deprecated in afo v2' })]),
      ),
    });
    render(<RememberedMappings api={api} />);
    expect(await screen.findByText('water mass fraction is deprecated in afo v2')).toBeTruthy();
  });

  it('deletes an entry after a confirmation', async () => {
    const api = fakeApi({ listMappingMemory: vi.fn(async () => page([entry()])) });
    render(<RememberedMappings api={api} />);
    const row = await screen.findByRole('row', { name: /Water content/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this remembered mapping?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(api.deleteMappingMemoryEntry).toHaveBeenCalledWith('m-1');
  });

  it('corrects the class of an answer', async () => {
    const api = fakeApi({
      listMappingMemory: vi.fn(async () => page([entry()])),
      reviewMappingMemoryEntry: vi.fn(async () => ({
        entry: entry({ status: 'confirmed' }),
        labels: {},
      })),
    });
    render(<RememberedMappings api={api} />);
    const row = await screen.findByRole('row', { name: /Water content/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit remembered mapping' });
    const cls = within(dialog).getByRole('textbox', { name: 'Class' });
    await userEvent.clear(cls);
    await userEvent.type(cls, `${E}Water`);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and confirm' }));
    expect(api.reviewMappingMemoryEntry).toHaveBeenCalledWith('m-1', {
      answer: { form: 'node', class: `${E}Water`, unit: 'http://qudt.org/vocab/unit/PERCENT' },
    });
  });

  it('adds a mapping by hand and shows a refusal', async () => {
    const api = fakeApi({
      listMappingMemory: vi.fn(async () => page([])),
      addMappingMemoryEntry: vi.fn(async () => {
        throw new Error('not in the ontology library: https://nowhere/x');
      }),
    });
    render(<RememberedMappings api={api} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a mapping' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a remembered mapping' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Output name' }), 'Lot no.');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Property' }),
      'https://nowhere/x',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(api.addMappingMemoryEntry).toHaveBeenCalledWith({
      kind: 'column',
      name: 'Lot no.',
      type: 'text',
      answer: { form: 'literal', property: 'https://nowhere/x' },
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'not in the ontology library: https://nowhere/x',
    );
  });
});
