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

const expires: DraftChange = {
  op: 'putFieldMapping',
  field: 'expires',
  mapping: { property: 'dcterms:date' },
  reason: 'Expiry is a date of the batch',
  confidence: 'medium',
  evidence: ['31/12/2027'],
  alternatives: [{ iri: `${PH}validUntil`, label: 'valid until', score: 0.2 }],
};
const tests: DraftChange = {
  op: 'putTableMapping',
  table: 'tests',
  mapping: {
    link: 'pharma:hasResult',
    class: 'pharma:AssayResult',
    columns: { assay: { property: 'pharma:assayName' } },
  },
  reason: 'Each row is one assay result',
  confidence: 'low',
};
const review = changeProposalView({
  stage: 'mapping',
  body: { notes: 'Retrieval was lexical only for pharma v1.', changes: [lot, expires, tests] },
});

/** An outline item's row (its button names the item). */
const itemRow = (outline: HTMLElement, name: string) =>
  within(outline).getByRole('button', { name }).closest('li')!;

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

  it('shows a value node by its class', () => {
    const semantics = definition.semantics as Record<string, unknown>;
    const withNode = {
      ...definition,
      semantics: {
        ...semantics,
        fields: { lot: { node: { class: 'pharma:LotIdentifier' } } },
      },
    };
    expect(mappingRows(withNode).find((r) => r.path === 'lot')).toEqual({
      path: 'lot',
      term: 'node of pharma:LotIdentifier',
    });
  });
});

describe('MappingTab', () => {
  it('says the stage is not used until a vocabulary is pinned on Survey', async () => {
    const { onNavigate } = show(false);
    expect(screen.getByText(/Not used: no vocabulary is pinned on Survey/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Choose ontologies on Survey' }));
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/batch/survey/ontologies');
    expect(screen.queryByRole('button', { name: 'Propose a mapping' })).toBeNull();
  });

  it('says the stage is not used while RDF is off on the Outputs tab', async () => {
    const unmapped: Record<string, unknown> = { ...definition };
    delete unmapped.semantics;
    const api = fakeApi({ listProposals: vi.fn(async () => [proposal]) });
    const onNavigate = vi.fn();
    render(
      <MappingTab
        api={api}
        projectId="batch"
        used
        definition={unmapped}
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
    expect(screen.getByText(/Not used: RDF is off on the Outputs tab/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Turn RDF on in Outputs' }));
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/batch/outputs');
    expect(screen.queryByRole('button', { name: 'Propose a mapping' })).toBeNull();
  });

  it('reviews the proposal in the outline: markers, a checkbox per change, the counts', async () => {
    show(true, { listProposals: vi.fn(async () => [review]) });
    const outline = await screen.findByRole('navigation', { name: 'Mapping outline' });
    // One checkbox per change, on the item it changes; a column changed by its table has none.
    for (const name of [/Apply: MAPPING lot/, /Apply: MAPPING expires/, /Apply: MAPPING tests/]) {
      expect(within(outline).getByRole('checkbox', { name })).toBeChecked();
    }
    expect(within(outline).getAllByRole('checkbox')).toHaveLength(3);
    expect(itemRow(outline, 'expires')).toHaveTextContent('NEW');
    expect(itemRow(outline, 'tests.assay')).toHaveTextContent('NEW');
    expect(itemRow(outline, 'Table tests')).toHaveTextContent('CHANGED');
    expect(itemRow(outline, 'lot')).not.toHaveTextContent(/NEW|CHANGED/);
    const bar = screen.getByRole('region', { name: 'Proposal' });
    expect(bar).toHaveTextContent('3 changes');
    expect(bar).toHaveTextContent('1 high');
    expect(bar).toHaveTextContent('1 medium');
    expect(bar).toHaveTextContent('1 low');
    expect(bar).toHaveTextContent('3 of 3 selected');
    expect(screen.getByText('Retrieval was lexical only for pharma v1.')).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 mapped now/)).toHaveTextContent(
      '1 of 3 mapped now · 3 after applying the selected changes',
    );
  });

  it('opens on the first proposed change and shows now against proposed, with the evidence', async () => {
    show(true, { listProposals: vi.fn(async () => [review]) });
    const inspector = await screen.findByRole('region', { name: 'lot' });
    expect(inspector).toHaveTextContent('Seen in samples');
    await userEvent.click(screen.getByRole('button', { name: 'expires' }));
    const expires = screen.getByRole('region', { name: 'expires' });
    const property = within(expires).getByRole('row', { name: /Property/ });
    expect(property).toHaveTextContent('Default vocabulary');
    expect(property).toHaveTextContent('dcterms:date');
    expect(expires).toHaveTextContent('medium');
    expect(expires).toHaveTextContent('Expiry is a date of the batch');
    expect(within(expires).getByText('31/12/2027')).toBeInTheDocument();
    expect(within(expires).getByText('valid until')).toBeInTheDocument();
    expect(within(expires).getByRole('checkbox', { name: /Apply this change/ })).toBeChecked();
  });

  it('sends a column changed with its table to the table, where its checkbox is', async () => {
    show(true, { listProposals: vi.fn(async () => [review]) });
    await userEvent.click(await screen.findByRole('button', { name: 'tests.assay' }));
    const column = screen.getByRole('region', { name: 'tests.assay' });
    expect(column).toHaveTextContent('Changed with Table tests: apply it there.');
    expect(within(column).getByRole('row', { name: /Property/ })).toHaveTextContent(
      'pharma:assayName',
    );
    await userEvent.click(within(column).getByRole('button', { name: 'Open Table tests' }));
    expect(screen.getByRole('region', { name: 'Table tests' })).toHaveTextContent(
      'Low'.toLowerCase(),
    );
  });

  it('applies only the selected changes', async () => {
    const decideProposal = vi.fn(async () => ({
      ...review,
      status: 'partially_accepted' as const,
      acceptedChanges: [0, 2],
    }));
    const { api } = show(true, { listProposals: vi.fn(async () => [review]), decideProposal });
    const outline = await screen.findByRole('navigation', { name: 'Mapping outline' });
    await userEvent.click(
      within(outline).getByRole('checkbox', { name: /Apply: MAPPING expires/ }),
    );
    expect(screen.getByRole('region', { name: 'Proposal' })).toHaveTextContent('2 of 3 selected');
    expect(screen.getByText(/1 of 3 mapped now/)).toHaveTextContent('2 after applying');
    await userEvent.click(screen.getByRole('button', { name: 'Apply 2 selected changes' }));
    expect(api.decideProposal).toHaveBeenCalledWith('batch', review.id, 'accepted', [0, 2]);
  });

  it('rejects the whole proposal', async () => {
    const decideProposal = vi.fn(async () => ({ ...review, status: 'rejected' as const }));
    const { api } = show(true, { listProposals: vi.fn(async () => [review]), decideProposal });
    await userEvent.click(await screen.findByRole('button', { name: 'Reject all' }));
    expect(api.decideProposal).toHaveBeenCalledWith('batch', review.id, 'rejected');
  });

  it('filters the outline to the proposed changes or the unmapped outputs', async () => {
    show(true, { listProposals: vi.fn(async () => [review]) });
    const outline = await screen.findByRole('navigation', { name: 'Mapping outline' });
    await userEvent.click(screen.getByRole('button', { name: /^Proposed/ }));
    expect(within(outline).getByRole('button', { name: 'expires' })).toBeInTheDocument();
    expect(within(outline).queryByRole('button', { name: 'Ontologies' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Unmapped/ }));
    expect(within(outline).getByRole('button', { name: 'expires' })).toBeInTheDocument();
    expect(within(outline).queryByRole('button', { name: 'lot' })).toBeNull();
  });

  it('shows the current mapping read-only in the outline when no proposal waits', async () => {
    show(true, { listProposals: vi.fn(async () => []) });
    const outline = await screen.findByRole('navigation', { name: 'Mapping outline' });
    expect(within(outline).getByRole('button', { name: 'expires' })).toHaveAccessibleDescription(
      'unmapped (not mapped)',
    );
    expect(within(outline).queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove the mapping' })).toBeNull();
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
