import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DraftChange } from '@ih/shared';
import { mappingBadge, mappingNote, mappingRows } from '../src/workbench/mapping.js';
import { MappingTab } from '../src/workbench/MappingTab.js';
import { changeProposalView, fakeApi } from './fake-api.js';

const PH = 'https://ex.example/pharma#';
const lot: DraftChange = {
  op: 'putFieldMapping',
  field: 'lot',
  mapping: { property: 'pharma:batchNumber' },
  reason: 'The lot is the batch number',
  confidence: 'high',
  evidence: ['G17230211', 'G17230212'],
  alternatives: [{ iri: `${PH}productName`, label: 'product name', score: 0.016 }],
};
const proposal = changeProposalView({
  stage: 'mapping',
  body: { notes: 'Retrieval was lexical only for pharma v1.', changes: [lot] },
});

const definition = {
  id: 'batch',
  version: 2,
  outputs: {
    fields: [
      { id: 'lot', type: 'text' },
      { id: 'expires', type: 'date' },
    ],
    tables: [{ id: 'tests', columns: [{ id: 'assay', type: 'text' }] }],
  },
  semantics: {
    prefixes: { pharma: PH },
    document: { class: 'pharma:BatchRecord' },
    fields: { lot: { property: 'pharma:batchNumber' } },
    tables: { tests: { link: 'pharma:hasResult', class: 'pharma:TestResult', columns: {} } },
  },
};

function show(used: boolean, overrides = {}) {
  const api = fakeApi({ listProposals: vi.fn(async () => [proposal]), ...overrides });
  const onNavigate = vi.fn();
  render(
    <MappingTab
      api={api}
      projectId="batch"
      used={used}
      definition={definition}
      dataPolicy="local"
      hasDraft
      draft={2}
      published={1}
      briefVersion={1}
      pollMs={1}
      item={null}
      onApplied={vi.fn()}
      onSkipped={vi.fn()}
      onNavigate={onNavigate}
    />,
  );
  return { api, onNavigate };
}

describe('mapping helpers', () => {
  it('shows a change as suggested with its confidence, the values seen and the alternatives', () => {
    expect(mappingBadge(lot)).toBe('Suggested · high');
    expect(mappingNote(lot)).toBe('Seen: G17230211, G17230212 · Alternatives: product name');
    expect(
      mappingBadge({ op: 'putField', field: { id: 'x', type: 'text' }, reason: '' } as DraftChange),
    ).toBeNull();
  });

  it('lists every output with what it maps to, or that it uses the default vocabulary', () => {
    expect(mappingRows(definition)).toEqual([
      { path: 'document', term: 'pharma:BatchRecord' },
      { path: 'lot', term: 'pharma:batchNumber' },
      { path: 'expires', term: null },
      { path: 'tests', term: 'pharma:hasResult → pharma:TestResult' },
      { path: 'tests.assay', term: null },
    ]);
  });
});

describe('MappingTab', () => {
  it('says the stage is not used until a vocabulary is pinned on Survey', async () => {
    const { onNavigate } = show(false);
    expect(screen.getByText(/Not used: no vocabulary is pinned on Survey/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Choose ontologies on Survey' }));
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/batch/survey');
    expect(screen.queryByRole('button', { name: 'Propose a mapping' })).toBeNull();
  });

  it('shows a proposal with confidence, values and alternatives, and applies it', async () => {
    const decideProposal = vi.fn(async () => ({
      ...proposal,
      status: 'accepted' as const,
      acceptedChanges: [0],
    }));
    const { api } = show(true, { decideProposal });
    const change = await screen.findByRole('checkbox', { name: /Apply: MAPPING lot/ });
    const row = change.closest('li')!;
    expect(row).toHaveTextContent('Suggested · high');
    expect(row).toHaveTextContent('Seen: G17230211, G17230212 · Alternatives: product name');
    expect(screen.getByText('Retrieval was lexical only for pharma v1.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Apply 1 selected change' }));
    expect(api.decideProposal).toHaveBeenCalledWith('batch', proposal.id, 'accepted', [0]);
  });

  it('summarises the current mapping and links to the recipe to edit it', async () => {
    show(true);
    const current = await screen.findByRole('table', { name: 'Current mapping' });
    expect(within(current).getByRole('row', { name: /expires/ })).toHaveTextContent(
      'Default vocabulary',
    );
    expect(within(current).getByRole('row', { name: /lot/ })).toHaveTextContent(
      'pharma:batchNumber',
    );
    expect(
      screen.getByRole('link', { name: 'Edit the mapping on the Recipe tab' }),
    ).toHaveAttribute('href', '#/workbench/batch/template');
  });

  it('previews a dev sample graph', async () => {
    const startGraphPreview = vi.fn(async () => ({
      jobId: 'g1',
      status: 'queued' as const,
      error: null,
      result: null,
    }));
    show(true, { startGraphPreview });
    await userEvent.click(screen.getByRole('button', { name: 'Preview on dev samples' }));
    expect(startGraphPreview).toHaveBeenCalledWith('batch');
  });
});
