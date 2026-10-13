import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TemplateChange } from '@ih/shared';
import { ChecksPanel } from '../src/templates/ChecksPanel.js';
import { DraftChangesPanel } from '../src/templates/DraftChangesPanel.js';
import { fakeApi } from './fake-api.js';

const change = (overrides: Partial<TemplateChange> = {}): TemplateChange => ({
  id: '1',
  version: 4,
  at: '2026-10-12T08:40:00.000Z',
  source: 'hand',
  stage: null,
  proposalId: null,
  summary: 'Changed section supplier',
  diff: ['^(From|Supplier)\\b → ^(From|Supplier|Vendor)\\b'],
  by: 'Ken',
  ...overrides,
});

describe('ChecksPanel', () => {
  it('lists checks with a tone word and the link that fixes each', async () => {
    const onOpenSubTab = vi.fn();
    render(
      <ChecksPanel
        checks={[
          {
            tone: 'warn',
            text: 'due_date is not filled by any step.',
            link: { label: 'Add it to a step in Steps', hash: '#/workbench/invoice/steps' },
            subTabs: ['outputs', 'pipeline'],
          },
          {
            tone: 'danger',
            text: 'pipeline: Array must contain at least 1 element(s)',
            link: { label: 'Open Pipeline', subTab: 'pipeline' },
            subTabs: ['pipeline'],
          },
        ]}
        onOpenSubTab={onOpenSubTab}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Checks' });
    const items = within(panel).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Needs you: due_date is not filled by any step.');
    expect(
      within(items[0]!).getByRole('link', { name: 'Add it to a step in Steps' }),
    ).toHaveAttribute('href', '#/workbench/invoice/steps');
    expect(items[1]).toHaveTextContent('Error:');
    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Open Pipeline' }));
    expect(onOpenSubTab).toHaveBeenCalledWith('pipeline');
    expect(panel).toHaveAttribute('data-tone', 'warn');
  });

  it('has an ok border when every check passes', () => {
    render(
      <ChecksPanel
        checks={[
          { tone: 'ok', text: 'Sections, outputs and steps are valid.', link: null, subTabs: [] },
        ]}
        onOpenSubTab={vi.fn()}
      />,
    );
    expect(screen.getByRole('region', { name: 'Checks' })).toHaveAttribute('data-tone', 'ok');
  });
});

describe('DraftChangesPanel', () => {
  it('lists the changes since the live version, newest first, with tags and chips', async () => {
    const api = fakeApi({
      listDraftChanges: vi.fn(async () => [
        change(),
        change({
          id: '0',
          source: 'proposal',
          stage: 'outputs',
          summary: 'Added field due_date',
          diff: ['+ due_date'],
        }),
      ]),
    });
    render(
      <DraftChangesPanel api={api} projectId="invoice" version={4} published={3} refreshKey={0} />,
    );
    const panel = screen.getByRole('region', { name: 'Changes since v3' });
    const items = await within(panel).findAllByRole('listitem', { name: /./ });
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('BY HAND');
    expect(items[0]).toHaveTextContent('Changed section supplier');
    expect(items[0]).toHaveTextContent('^(From|Supplier)\\b → ^(From|Supplier|Vendor)\\b');
    expect(items[1]).toHaveTextContent('OUTPUTS PROPOSAL');
    expect(items[1]).toHaveTextContent('+ due_date');
    expect(within(items[0]!).getByText(/12 Oct/)).toHaveAttribute(
      'dateTime',
      '2026-10-12T08:40:00.000Z',
    );
  });

  it('opens the full diff from the live version', async () => {
    const api = fakeApi({
      diffVersions: vi.fn(async (_id: string, from: number, to: number) => ({
        from,
        to,
        changes: [{ kind: 'added' as const, path: 'outputs.fields[due_date]' }],
      })),
    });
    render(
      <DraftChangesPanel api={api} projectId="invoice" version={4} published={3} refreshKey={0} />,
    );
    const full = screen.getByRole('button', { name: 'Full diff' });
    expect(full).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(full);
    expect(api.diffVersions).toHaveBeenCalledWith('invoice', 3, 4);
    expect(await screen.findByRole('list', { name: 'Full diff from v3' })).toHaveTextContent(
      'added outputs.fields[due_date]',
    );
    expect(full).toHaveAttribute('aria-expanded', 'true');
  });

  it('names the draft when nothing is published, and says when nothing is recorded', async () => {
    render(
      <DraftChangesPanel
        api={fakeApi()}
        projectId="invoice"
        version={1}
        published={null}
        refreshKey={0}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Changes in draft v1' });
    expect(
      await within(panel).findByText('No changes recorded for this draft yet.'),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Full diff' })).not.toBeInTheDocument();
  });

  it('keeps the newest response when an older one arrives late', async () => {
    let resolveFirst: (v: TemplateChange[]) => void = () => {};
    const listDraftChanges = vi
      .fn()
      .mockImplementationOnce(() => new Promise<TemplateChange[]>((r) => (resolveFirst = r)))
      .mockResolvedValue([change({ summary: 'Newest' })]);
    const api = fakeApi({ listDraftChanges });
    const { rerender } = render(
      <DraftChangesPanel api={api} projectId="invoice" version={4} published={3} refreshKey={0} />,
    );
    rerender(
      <DraftChangesPanel api={api} projectId="invoice" version={4} published={3} refreshKey={1} />,
    );
    expect(await screen.findByText('Newest')).toBeInTheDocument();
    resolveFirst([change({ summary: 'Old' })]);
    await waitFor(() => expect(screen.queryByText('Old')).not.toBeInTheDocument());
  });

  it('says when the changes cannot be read', async () => {
    const api = fakeApi({
      listDraftChanges: vi.fn(async () => Promise.reject(new Error('offline'))),
    });
    render(
      <DraftChangesPanel api={api} projectId="invoice" version={4} published={3} refreshKey={0} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the changes: offline',
    );
  });
});
