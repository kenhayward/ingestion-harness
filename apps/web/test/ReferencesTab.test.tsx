import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OverviewItem, ReferenceRow } from '@ih/shared';
import { ReferencesTab } from '../src/workbench/ReferencesTab.js';
import {
  fakeApi,
  job,
  referenceDetail,
  referenceInfo,
  referenceRow,
  sampleView,
  templateView,
} from './fake-api.js';

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

  it('says No score yet instead of 0 / 0 when nothing counts', async () => {
    tab({ dev: [referenceRow({ filename: 'a.pdf' })] });
    const right = (await screen.findByRole('heading', { name: 'Right first time' })).closest(
      'section',
    )!;
    expect(right).toHaveTextContent('No score yet');
    expect(right).not.toHaveTextContent('0 / 0');
  });

  it('does not claim every output has a step when the draft has no outputs', async () => {
    tab(
      { dev: [saved('a.pdf')] },
      {
        getTemplate: vi.fn(async () =>
          templateView({ ...definition, outputs: { fields: [], tables: [] }, pipeline: [] }),
        ),
      },
    );
    const right = (await screen.findByRole('heading', { name: 'Right first time' })).closest(
      'section',
    )!;
    await screen.findByText('No outputs in the draft yet');
    expect(right).not.toHaveTextContent('Every output has a step');
  });

  it('says how many verified dev references the needs strip counts', async () => {
    tab({ dev: [saved('a.pdf'), saved('b.pdf'), referenceRow({ filename: 'c.pdf' })] });
    expect(await screen.findByText(/across 2 verified dev references/)).toBeInTheDocument();
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

describe('ReferencesTab samples list', () => {
  it('groups dev and holdout samples with their line, tracker, corrections and Review link', async () => {
    tab({
      dev: [
        saved('inv-0012.pdf', {
          version: 2,
          reverified: { from: 1, changed: [] },
          sourceJobId: 'src-1',
          corrections: [{ key: 'total', kind: 'corrected', proposed: '3,912.00' }],
        }),
        referenceRow({ filename: 'inv-0031.pdf', run: run('awaiting_review', 'j31') }),
      ],
      holdout: [saved('inv-0019.pdf', { carriedFrom: 1 })],
    });
    const list = await screen.findByRole('region', { name: 'Samples' });
    const dev = within(list).getByRole('group', { name: 'Dev samples' });
    expect(dev).toHaveTextContent('1 of 2 verified · run by the draft model');
    const first = within(dev).getByRole('button', { name: /inv-0012\.pdf/ });
    expect(first).toHaveTextContent(/Re-verified in v2 · .+ · was v1/);
    expect(
      within(first).getByRole('img', { name: 'Run: done · Reviewed: done · Saved: done' }),
    ).toBeInTheDocument();
    expect(first).toHaveTextContent('Verified');
    expect(first).toHaveTextContent('Corrected: total');
    const reviews = within(dev).getAllByRole('link', { name: 'Review' });
    expect(reviews.map((a) => a.getAttribute('href'))).toEqual(['#/review/src-1', '#/review/j31']);
    const second = within(dev).getByRole('button', { name: /inv-0031\.pdf/ });
    expect(second).toHaveTextContent('Awaiting review');
    expect(
      within(second).getByRole('img', { name: 'Run: done · Reviewed: not yet · Saved: not yet' }),
    ).toBeInTheDocument();
    const holdout = within(list).getByRole('group', { name: 'Holdout samples' });
    expect(holdout).toHaveTextContent('HOLDOUT');
    expect(holdout).toHaveTextContent(
      '1 of 1 verified · run by the live template, sealed from drafting',
    );
    expect(holdout).toHaveTextContent(/Carried from v1 · /);
  });

  it('filters All / Corrected / Needs you with counts', async () => {
    tab({
      dev: [
        saved('a.pdf', { corrections: [{ key: 'total', kind: 'corrected', proposed: '1' }] }),
        saved('b.pdf'),
        referenceRow({ filename: 'c.pdf' }),
      ],
    });
    const list = await screen.findByRole('region', { name: 'Samples' });
    const all = within(list).getByRole('button', { name: 'All 3' });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(list).getByRole('button', { name: 'Corrected 1' }));
    expect(within(list).getByRole('button', { name: 'Corrected 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(list).queryByText('b.pdf')).toBeNull();
    expect(within(list).getByText('a.pdf')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Needs you 1' }));
    expect(within(list).getByText('c.pdf')).toBeInTheDocument();
    expect(within(list).queryByText('a.pdf')).toBeNull();
  });

  it('runs the template on unverified holdout samples from the holdout group, with a reason when it cannot', async () => {
    const { api, onChanged } = tab(
      { holdout: [referenceRow({ filename: 'h.pdf' })] },
      { startHoldoutReferenceRuns: vi.fn(async () => [job()]) },
    );
    const holdout = await screen.findByRole('group', { name: 'Holdout samples' });
    await userEvent.click(
      within(holdout).getByRole('button', { name: 'Run the template on 1 unverified' }),
    );
    expect(api.startHoldoutReferenceRuns).toHaveBeenCalledWith('letter');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('disables the holdout run with a reason when every holdout sample is verified', async () => {
    tab({ holdout: [saved('h.pdf')] });
    const holdout = await screen.findByRole('group', { name: 'Holdout samples' });
    const button = within(holdout).getByRole('button', {
      name: 'Run the template on 0 unverified',
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Every holdout sample has a verified reference');
  });

  it('names the samples not counted and links to Samples', async () => {
    tab(
      { dev: [saved('a.pdf')] },
      {
        listSamples: vi.fn(async () => [
          sampleView({ filename: 'inv-0055.pdf', state: 'preparing' }),
          sampleView({ filename: 'inv-0056.pdf', state: 'failed' }),
          sampleView({ filename: 'a.pdf', state: 'ready' }),
        ]),
      },
    );
    const foot = await screen.findByText(/Not counted:/);
    expect(foot).toHaveTextContent(
      'Not counted: inv-0055.pdf is still preparing · inv-0056.pdf failed to prepare.',
    );
    expect(screen.getByRole('link', { name: 'Samples' })).toHaveAttribute(
      'href',
      '#/workbench/letter/samples',
    );
  });

  it('polls while a run is active', async () => {
    const dev = vi
      .fn()
      .mockResolvedValueOnce([referenceRow({ run: run('running') })])
      .mockResolvedValue([referenceRow({ run: run('awaiting_review') })]);
    tab(
      {},
      {
        listReferenceRows: vi.fn(async (_id: string, set?: string) =>
          set === 'holdout' ? [] : dev(),
        ),
      },
    );
    expect(await screen.findByText('Awaiting review')).toBeInTheDocument();
  });

  it('tells the page when the runs have finished', async () => {
    const dev = vi
      .fn()
      .mockResolvedValueOnce([referenceRow({ run: run('running') })])
      .mockResolvedValue([referenceRow({ run: run('awaiting_review') })]);
    const { onChanged } = tab(
      {},
      {
        listReferenceRows: vi.fn(async (_id: string, set?: string) =>
          set === 'holdout' ? [] : dev(),
        ),
      },
    );
    await screen.findByText('Awaiting review');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('ignores a slow response that arrives after a newer one', async () => {
    let n = 0;
    let release: (rows: ReferenceRow[]) => void = () => {};
    const slow = new Promise<ReferenceRow[]>((resolve) => (release = resolve));
    tab(
      {},
      {
        listReferenceRows: vi.fn(async (_id: string, set?: string) => {
          if (set === 'holdout') return [];
          n += 1;
          if (n === 1) return [referenceRow({ run: run('running') })];
          if (n === 2) return slow;
          return [referenceRow({ run: run('awaiting_review') })];
        }),
      },
    );
    await screen.findByText('Awaiting review');
    release([referenceRow({ run: run('running') })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
    expect(screen.queryByText('Running')).toBeNull();
  });
});

describe('ReferencesTab detail panel', () => {
  it('opens the first saved sample and shows provenance per output, the model value struck through', async () => {
    const a = saved('inv-0012.pdf', { sourceJobId: 'src-1' });
    const getReferenceDetail = vi.fn(async () =>
      referenceDetail({
        sampleId: a.sampleId,
        filename: 'inv-0012.pdf',
        reference: a.reference!,
        run: { jobId: 'src-1', modelOverride: 'draft', models: ['local/qwen'] },
        values: [
          {
            id: 'sender',
            kind: 'field',
            value: 'Initech Ltd',
            provenance: 'model',
            proposed: null,
            corrections: [],
          },
          {
            id: 'total',
            kind: 'field',
            value: '4,694.40',
            provenance: 'corrected',
            proposed: '3,912.00',
            corrections: [{ key: 'total', kind: 'corrected', proposed: '3,912.00' }],
          },
          {
            id: 'due_date',
            kind: 'field',
            value: '2026-09-11',
            provenance: 'entered',
            proposed: null,
            corrections: [{ key: 'due_date', kind: 'entered', proposed: null }],
          },
          {
            id: 'line_items',
            kind: 'table',
            value: [{}, {}],
            provenance: 'model',
            proposed: null,
            corrections: [],
          },
        ],
        corrections: [
          { key: 'total', kind: 'corrected', proposed: '3,912.00' },
          { key: 'due_date', kind: 'entered', proposed: null },
        ],
      }),
    );
    tab({ dev: [a] }, { getReferenceDetail });
    const panel = await screen.findByRole('complementary', { name: 'Reference inv-0012.pdf' });
    expect(getReferenceDetail).toHaveBeenCalledWith('letter', a.sampleId);
    expect(
      within(screen.getByRole('region', { name: 'Samples' })).getByRole('button', {
        name: /inv-0012\.pdf/,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(panel).toHaveTextContent(/saved .+ by ken/);
    expect(panel).toHaveTextContent(
      'Run by the draft model (local/qwen) · src-1 · 2 of 4 values changed in Review',
    );
    const table = within(panel).getByRole('table', { name: 'Reference values' });
    const [, sender, total, due, lines] = within(table).getAllByRole('row');
    expect(sender).toHaveTextContent('MODEL ✓');
    expect(within(total!).getByText('3,912.00').tagName).toBe('DEL');
    expect(total).toHaveTextContent('CORRECTED');
    expect(due).toHaveTextContent('BY HAND');
    expect(lines).toHaveTextContent('2 rows');
    expect(within(panel).getByRole('link', { name: 'Open in Review' })).toHaveAttribute(
      'href',
      '#/review/src-1',
    );
    expect(panel).toHaveTextContent('Saving again replaces this reference for v2.');
    expect(panel).toHaveTextContent(
      'To change a value, run the sample again and save a new reference.',
    );
  });

  it('says an outdated output is not verified, whether or not corrections are known', async () => {
    const a = saved('a.pdf');
    a.reference = { ...a.reference!, outdated: ['field:due_date'] };
    tab(
      { dev: [a] },
      {
        getReferenceDetail: vi.fn(async () =>
          referenceDetail({
            sampleId: a.sampleId,
            filename: 'a.pdf',
            reference: a.reference!,
            values: [
              {
                id: 'sender',
                kind: 'field',
                value: 'x',
                provenance: 'model',
                proposed: null,
                corrections: [],
              },
              {
                id: 'due_date',
                kind: 'field',
                value: null,
                provenance: null,
                proposed: null,
                corrections: [],
              },
            ],
            corrections: null,
          }),
        ),
      },
    );
    const panel = await screen.findByRole('complementary', { name: 'Reference a.pdf' });
    const [, sender, due] = within(within(panel).getByRole('table')).getAllByRole('row');
    expect(sender).not.toHaveTextContent('re-verify');
    expect(due).toHaveTextContent('Not verified for this version — re-verify');
    expect(due).not.toHaveTextContent('MODEL ✓');
  });

  it('shows no re-verify text for an unknown-provenance output that is not outdated', async () => {
    const a = saved('a.pdf');
    tab(
      { dev: [a] },
      {
        getReferenceDetail: vi.fn(async () =>
          referenceDetail({
            sampleId: a.sampleId,
            filename: 'a.pdf',
            reference: a.reference!,
            values: [
              {
                id: 'sender',
                kind: 'field',
                value: 'x',
                provenance: null,
                proposed: null,
                corrections: [],
              },
            ],
            corrections: null,
          }),
        ),
      },
    );
    const panel = await screen.findByRole('complementary', { name: 'Reference a.pdf' });
    const [, sender] = within(within(panel).getByRole('table')).getAllByRole('row');
    expect(sender).toHaveTextContent('x');
    expect(sender).not.toHaveTextContent('re-verify');
  });

  it('shows a placeholder instead of an empty column when no sample has a reference', async () => {
    tab({ dev: [referenceRow({ filename: 'a.pdf' })] });
    expect(
      await screen.findByText('Select a verified sample to see its values'),
    ).toBeInTheDocument();
  });

  it('refetches the detail when a sample is saved again', async () => {
    const sampleId = 'same-sample';
    const first = referenceRow({
      sampleId,
      filename: 'a.pdf',
      reference: referenceInfo({ id: 'r1' }),
      run: run('running'),
    });
    const second = referenceRow({
      sampleId,
      filename: 'a.pdf',
      reference: referenceInfo({ id: 'r2' }),
    });
    const dev = vi.fn().mockResolvedValueOnce([first]).mockResolvedValue([second]);
    const getReferenceDetail = vi.fn(async () =>
      referenceDetail({ sampleId, filename: 'a.pdf', reference: first.reference! }),
    );
    tab(
      {},
      {
        getReferenceDetail,
        listReferenceRows: vi.fn(async (_id: string, set?: string) =>
          set === 'holdout' ? [] : dev(),
        ),
      },
    );
    await waitFor(() => expect(getReferenceDetail).toHaveBeenCalledTimes(2));
  });

  it('switches to a holdout sample with the sealed note', async () => {
    const h = saved('inv-0033.pdf');
    const getReferenceDetail = vi.fn(async (_p: string, sid: string) =>
      referenceDetail({
        sampleId: sid,
        filename: 'inv-0033.pdf',
        role: 'holdout',
        reference: h.reference!,
        run: { jobId: 'hj', modelOverride: null, models: [] },
      }),
    );
    tab({ dev: [saved('a.pdf')], holdout: [h] }, { getReferenceDetail });
    await userEvent.click(await screen.findByRole('button', { name: /inv-0033\.pdf/ }));
    const panel = await screen.findByRole('complementary', { name: 'Reference inv-0033.pdf' });
    expect(panel).toHaveAttribute('data-role', 'holdout');
    expect(panel).toHaveTextContent('Run by the live template v1');
    expect(panel).toHaveTextContent('Holdout values are only scored, never shown to drafting.');
  });

  it('says when the corrections are unknown', async () => {
    const a = saved('a.pdf', { corrections: null, verifiedBy: null });
    tab(
      { dev: [a] },
      {
        getReferenceDetail: vi.fn(async () =>
          referenceDetail({
            sampleId: a.sampleId,
            reference: a.reference!,
            run: null,
            values: [
              {
                id: 'sender',
                kind: 'field',
                value: 'x',
                provenance: null,
                proposed: null,
                corrections: [],
              },
            ],
            corrections: null,
          }),
        ),
      },
    );
    const panel = await screen.findByRole('complementary', { name: 'Reference a.pdf' });
    expect(panel).toHaveTextContent('Which values were changed in Review is not known');
    expect(within(panel).getByRole('table', { name: 'Reference values' })).not.toHaveTextContent(
      'MODEL ✓',
    );
  });
});
