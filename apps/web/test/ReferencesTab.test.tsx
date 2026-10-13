import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OverviewItem, ReferenceRow } from '@ih/shared';
import { ReferencesTab } from '../src/workbench/ReferencesTab.js';
import { fakeApi, job, referenceInfo, referenceRow, templateView } from './fake-api.js';

const definition = {
  id: 'letter',
  version: 2,
  name: 'Letter',
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: {
    fields: [{ id: 'sender' }, { id: 'total' }, { id: 'due_date' }],
    tables: [],
  },
  pipeline: [{ type: 'extract', id: 'head', fields: ['sender', 'total'], sections: ['all'] }],
};
const item: OverviewItem = {
  stage: 'references',
  state: 'pending',
  status: 'Optional, not started',
  metrics: [],
};
const run = (status: NonNullable<ReferenceRow['run']>['status'], jobId = 'j1') => ({
  jobId,
  status,
  error: null,
  modelOverride: 'draft',
});
const saved = (filename: string, o = {}) =>
  referenceRow({ filename, reference: referenceInfo({ name: filename, ...o }) });

function tab(
  rows: { dev?: ReferenceRow[]; holdout?: ReferenceRow[] } = {},
  overrides = {},
  props: Partial<{ draft: number | null; published: number | null }> = {},
) {
  const api = fakeApi({
    listReferenceRows: vi.fn(async (_id: string, set?: string) =>
      set === 'holdout' ? (rows.holdout ?? []) : (rows.dev ?? []),
    ),
    getTemplate: vi.fn(async () => templateView(definition)),
    ...overrides,
  });
  const onChanged = vi.fn();
  render(
    <ReferencesTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      draft={props.draft === undefined ? 2 : props.draft}
      published={props.published === undefined ? 1 : props.published}
      item={item}
      pollMs={1}
      onChanged={onChanged}
    />,
  );
  return { api, onChanged };
}

describe('ReferencesTab', () => {
  it('has the tab header with the optional status, the description and Skip', async () => {
    const { api, onChanged } = tab({}, { skipStage: vi.fn(async () => []) });
    const header = (await screen.findByRole('heading', { level: 2, name: 'References' })).closest(
      'header',
    )!;
    expect(within(header).getByText('Optional, not started')).toBeInTheDocument();
    expect(
      within(header).getByText(
        /you correct and approve them in Review and save them as the reference/,
      ),
    ).toBeInTheDocument();
    await userEvent.click(within(header).getByRole('button', { name: 'Skip this stage' }));
    expect(api.skipStage).toHaveBeenCalledWith('letter', 'references');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('runs the draft model on the unverified count, and gives the reason when it cannot', async () => {
    const { api, onChanged } = tab(
      { dev: [referenceRow({ filename: 'a.pdf' }), saved('b.pdf')] },
      { proposeReferences: vi.fn(async () => [job()]) },
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Run the draft model on 1 unverified' }),
    );
    expect(api.proposeReferences).toHaveBeenCalledWith('letter');
    expect(onChanged).toHaveBeenCalled();
  });

  it.each<[string, ReferenceRow[], number | null, string]>([
    ['no draft', [referenceRow()], null, 'Start a draft version first'],
    ['every dev sample verified', [saved('a.pdf')], 2, 'Every dev sample has a verified reference'],
    [
      'runs in progress',
      [referenceRow({ run: run('running') })],
      2,
      'Reference runs are still running',
    ],
  ])('disables the dev run button: %s', async (_name, dev, draft, reason) => {
    tab({ dev }, {}, { draft });
    const button = await screen.findByRole('button', {
      name: /^Run the draft model on \d+ unverified$/,
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', reason);
  });

  it('shows the ready banner with why references were re-verified, and links to Evaluate', async () => {
    tab({
      dev: [
        saved('a.pdf', { reverified: { from: 1, changed: ['field:due_date'] } }),
        saved('b.pdf'),
      ],
      holdout: [saved('h.pdf')],
    });
    const banner = await screen.findByRole('region', { name: 'Ready to evaluate' });
    expect(banner).toHaveTextContent(
      'Ready to evaluate. 2 dev and 1 holdout references match the draft v2 outputs. 1 was re-verified this version because these outputs changed: due_date.',
    );
    expect(within(banner).getByRole('link', { name: 'Go to Evaluate' })).toHaveAttribute(
      'href',
      '#/workbench/letter/evaluate',
    );
  });

  it('has no ready banner while a sample is unverified', async () => {
    tab({ dev: [saved('a.pdf'), referenceRow({ filename: 'b.pdf' })] });
    await screen.findByText('1 / 2'); // the rows have loaded (the Samples list arrives in Task 8)
    expect(screen.queryByRole('region', { name: 'Ready to evaluate' })).toBeNull();
  });

  it('shows the dev, holdout and right-first-time cards', async () => {
    tab({
      dev: [
        saved('a.pdf'),
        saved('b.pdf', { corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }] }),
        referenceRow({ filename: 'c.pdf' }),
      ],
      holdout: [saved('h.pdf'), referenceRow({ filename: 'i.pdf' })],
    });
    const dev = (await screen.findByRole('heading', { name: 'Dev references' })).closest(
      'section',
    )!;
    expect(dev).toHaveTextContent('2 / 3verified for v2');
    expect(
      within(dev).getByRole('img', { name: 'Dev references verified: 67%' }),
    ).toBeInTheDocument();
    const holdout = screen.getByRole('heading', { name: 'Holdout references' }).closest('section')!;
    expect(holdout).toHaveTextContent('1 / 2verified for v2');
    expect(holdout).toHaveTextContent(
      'Extracted by the template’s own models — never seen by drafting',
    );
    const right = screen.getByRole('heading', { name: 'Right first time' }).closest('section')!;
    expect(right).toHaveTextContent('3 / 475% of dev values');
    expect(right).toHaveTextContent('Excludes due_date, which no step fills yet');
  });

  it('counts per output where the draft model needed you, and links an output without a step to Steps', async () => {
    tab({
      dev: [
        saved('a.pdf', {
          corrections: [
            { key: 'total', kind: 'corrected', proposed: '1' },
            { key: 'due_date', kind: 'entered', proposed: null },
          ],
        }),
        saved('b.pdf', { corrections: [{ key: 'due_date', kind: 'entered', proposed: null }] }),
      ],
    });
    const strip = (
      await screen.findByRole('heading', { name: 'Where the draft model needed you' })
    ).closest('section')!;
    const chips = within(strip).getAllByRole('listitem');
    expect(chips.map((c) => c.textContent)).toEqual([
      'sender 0 — right first time',
      'total 1 — corrected',
      'due_date 2 — entered by hand',
    ]);
    expect(within(strip).getByRole('link', { name: 'the Steps tab' })).toHaveAttribute(
      'href',
      '#/workbench/letter/steps',
    );
    expect(strip).toHaveTextContent('due_date has no step yet — add one on the Steps tab.');
  });
});
