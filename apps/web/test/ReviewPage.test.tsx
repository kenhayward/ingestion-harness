import type { JobSummary } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { ReviewPage } from '../src/review/ReviewPage.js';
import { fakeApi, job } from './fake-api.js';
import { JOB_ID, reviewData } from './review-fixture.js';

function setup(overrides = {}, jobs: JobSummary[] = []) {
  const api = fakeApi({
    getReview: vi.fn(async () => reviewData()),
    ...overrides,
  });
  const onDone = vi.fn();
  render(<ReviewPage api={api} jobId={JOB_ID} onDone={onDone} jobs={jobs} />);
  return { api, onDone };
}

const fieldRow = (name: RegExp) => screen.getByRole('row', { name });

beforeEach(() => localStorage.clear());

describe('ReviewPage header and source', () => {
  it('shows the header with the queue position and Next document', async () => {
    const self = job({ id: JOB_ID, status: 'awaiting_review', createdAt: '2026-01-01T00:00:00Z' });
    const other = job({
      id: 'next-id',
      status: 'awaiting_review',
      createdAt: '2026-01-02T00:00:00Z',
    });
    setup({}, [self, other]);
    expect(await screen.findByRole('heading', { level: 1, name: 'scan.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Jobs/ })).toHaveAttribute('href', '#/');
    expect(screen.getByText('1 of 2 awaiting review')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Next document/ })).toHaveAttribute(
      'href',
      '#/review/next-id',
    );
    expect(screen.getByRole('note', { name: 'Why this needs review' })).toHaveTextContent(
      'check batch_check: 1 unmatched',
    );
  });

  it('hides Next document when this is the only one awaiting review', async () => {
    setup({}, [job({ id: JOB_ID, status: 'awaiting_review' })]);
    await screen.findByRole('heading', { level: 1, name: 'scan.pdf' });
    expect(screen.queryByRole('link', { name: /Next document/ })).not.toBeInTheDocument();
  });

  it('names the source pane and its page controls', async () => {
    setup();
    const pane = await screen.findByRole('region', { name: 'Source PDF' });
    expect(within(pane).getByText('Page 1 of 3')).toBeInTheDocument();
    expect(within(pane).getByText('Click a value to find it on the page')).toBeInTheDocument();
  });
});

describe('ReviewPage extracted data', () => {
  const withFieldIssue = () => {
    const data = reviewData();
    data.document.issues.push({
      step: 'head',
      target: 'kind',
      row: null,
      column: null,
      raw: 'x',
      message: 'not an option',
    });
    return data;
  };

  it('counts each tab and marks tabs with flagged content', async () => {
    setup();
    const tabs = await screen.findByRole('tablist', { name: 'Extracted data' });
    expect(within(tabs).getByRole('tab', { name: 'Fields 4' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(tabs).getByRole('tab', { name: 'results 3 (flagged)' })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'Edits 0' })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'Steps 2' })).toBeInTheDocument();
  });

  it('cycles through flagged values, switching tabs', async () => {
    const data = withFieldIssue();
    setup({ getReview: vi.fn(async () => data) });
    const next = await screen.findByRole('button', { name: 'Next flagged (3)' });
    await userEvent.click(next);
    expect(fieldRow(/kind/)).toHaveFocus();
    expect(within(fieldRow(/kind/)).getByText('not an option')).toBeInTheDocument();
    await userEvent.click(next);
    expect(screen.getByRole('tab', { name: /^results/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('cell', { name: /GX/ })).toHaveFocus();
    await userEvent.click(next);
    expect(screen.getByRole('cell', { name: /Complies/ })).toHaveFocus();
    await userEvent.click(next); // wraps to the first
    expect(screen.getByRole('tab', { name: /^Fields/ })).toHaveAttribute('aria-selected', 'true');
    expect(fieldRow(/kind/)).toHaveFocus();
  });

  it('hides Next flagged when nothing is flagged', async () => {
    const data = reviewData();
    data.document.issues = [];
    data.document.checks = {};
    setup({ getReview: vi.fn(async () => data) });
    await screen.findByRole('tablist', { name: 'Extracted data' });
    expect(screen.queryByRole('button', { name: /Next flagged/ })).not.toBeInTheDocument();
  });

  it('selects a field to find it on the page, and keeps the page for fields without one', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: /^Execution Date/ }));
    expect(screen.getByRole('img', { name: /page 3 of 3/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^kind/ }));
    expect(screen.getByRole('img', { name: /page 3 of 3/i })).toBeInTheDocument();
  });

  it('shows who edited a value and what it was', async () => {
    const data = reviewData({
      edits: [
        {
          id: 1,
          at: '2026-10-12T10:00:00Z',
          field: 'product',
          table: null,
          row: null,
          column: null,
          oldValue: 'Richfer',
          newValue: 'Richfer capsules 50',
          editor: 'khd1',
          reason: null,
        },
      ],
    });
    setup({ getReview: vi.fn(async () => data) });
    const row = await screen.findByRole('row', { name: /Medicinal Product/ });
    expect(within(row).getByText('Edited by khd1 · was Richfer')).toBeInTheDocument();
  });
});

describe('ReviewPage', () => {
  it('shows the document, review reasons and every field with its evidence', async () => {
    setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'scan.pdf' })).toBeInTheDocument();
    expect(screen.getByText(/check batch_check: 1 unmatched/)).toBeInTheDocument();
    const row = fieldRow(/Execution Date/);
    expect(within(row).getByText('2023-02-16')).toBeInTheDocument();
    expect(within(row).getByText(/Made 16\/02\/2023/)).toBeInTheDocument();
    expect(within(fieldRow(/compound/)).getByText('Carbonyl Iron, Folic Acid')).toBeInTheDocument();
  });

  it('jumps the page viewer to the page a value was found on', async () => {
    setup();
    const image = await screen.findByRole('img', { name: /page 1 of 3/i });
    expect(image).toHaveAttribute('src', `/api/jobs/${JOB_ID}/pages/1`);
    await userEvent.click(within(fieldRow(/Execution Date/)).getByRole('button', { name: 'p. 3' }));
    expect(screen.getByRole('img', { name: /page 3 of 3/i })).toHaveAttribute(
      'src',
      `/api/jobs/${JOB_ID}/pages/3`,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(screen.getByRole('img', { name: /page 2 of 3/i })).toBeInTheDocument();
  });

  it('edits a field and records the reviewer name', async () => {
    const { api } = setup();
    await screen.findByRole('heading', { name: /scan\.pdf/ });
    await userEvent.type(screen.getByLabelText('Reviewer'), 'kh');
    await userEvent.click(
      within(fieldRow(/Execution Date/)).getByRole('button', { name: 'Edit Execution Date' }),
    );
    const input = screen.getByRole('textbox', { name: 'New value for executed_on' });
    await userEvent.clear(input);
    await userEvent.type(input, '17/02/2023{Enter}');
    expect(api.addEdit).toHaveBeenCalledWith(JOB_ID, {
      field: 'executed_on',
      value: '17/02/2023',
      editor: 'kh',
    });
    expect(api.getReview).toHaveBeenCalledTimes(2); // reloaded after the edit
  });

  it('edits list fields as comma-separated values', async () => {
    const { api } = setup();
    await screen.findByRole('heading', { name: /scan\.pdf/ });
    await userEvent.click(
      within(fieldRow(/compound/)).getByRole('button', { name: 'Edit compound' }),
    );
    const input = screen.getByRole('textbox', { name: 'New value for compound' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Carbonyl Iron, Zinc{Enter}');
    expect(api.addEdit).toHaveBeenCalledWith(JOB_ID, {
      field: 'compound',
      value: ['Carbonyl Iron', 'Zinc'],
    });
  });

  it('shows tables with flagged cells and can filter to flagged rows', async () => {
    setup();
    await userEvent.click(await screen.findByRole('tab', { name: /^results 3/ }));
    const table = screen.getByRole('table', { name: 'results' });
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3
    const flagged = within(table).getByTitle("'Complies' is not a valid decimal");
    expect(flagged).toHaveTextContent('Complies');
    await userEvent.click(screen.getByRole('checkbox', { name: /flagged rows only/i }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });

  it('edits a table cell', async () => {
    const { api } = setup();
    await userEvent.click(await screen.findByRole('tab', { name: /results/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit results row 2 value' }));
    const input = screen.getByRole('textbox', { name: 'New value for results row 2 value' });
    await userEvent.clear(input);
    await userEvent.type(input, '98.5{Enter}');
    expect(api.addEdit).toHaveBeenCalledWith(JOB_ID, {
      table: 'results',
      row: 2,
      column: 'value',
      value: '98.5',
    });
  });

  it('approves with reviewer and note', async () => {
    const { api, onDone } = setup();
    await screen.findByRole('heading', { name: /scan\.pdf/ });
    await userEvent.type(screen.getByLabelText('Reviewer'), 'kh');
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'checked against scan');
    await userEvent.click(screen.getByRole('button', { name: 'Approve and publish' }));
    expect(api.approve).toHaveBeenCalledWith(JOB_ID, {
      reviewer: 'kh',
      note: 'checked against scan',
    });
    expect(onDone).toHaveBeenCalled();
  });

  it('rejects only with a reason, after Reject…', async () => {
    const { api, onDone } = setup();
    await screen.findByRole('heading', { level: 1, name: 'scan.pdf' });
    await userEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    expect(screen.queryByLabelText('Note (optional)')).not.toBeInTheDocument();
    const reason = screen.getByLabelText('Rejection reason (required — rejecting is final)');
    expect(reason).toHaveFocus();
    const reject = screen.getByRole('button', { name: 'Reject document' });
    expect(reject).toBeDisabled();
    await userEvent.type(reason, 'wrong document');
    await userEvent.click(reject);
    expect(api.reject).toHaveBeenCalledWith(JOB_ID, { reason: 'wrong document' });
    expect(onDone).toHaveBeenCalled();
  });

  it('never approves or rejects on Enter (both are final)', async () => {
    const { api } = setup();
    await screen.findByRole('heading', { level: 1, name: 'scan.pdf' });
    await userEvent.type(screen.getByLabelText('Reviewer'), 'kh{Enter}');
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'ok{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    await userEvent.type(screen.getByLabelText(/Rejection reason/), 'bad{Enter}');
    expect(api.approve).not.toHaveBeenCalled();
    expect(api.reject).not.toHaveBeenCalled();
  });

  it('keeps reviewing without sending anything', async () => {
    const { api } = setup();
    await screen.findByRole('heading', { level: 1, name: 'scan.pdf' });
    await userEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    await userEvent.type(screen.getByLabelText(/Rejection reason/), 'oops');
    await userEvent.click(screen.getByRole('button', { name: 'Keep reviewing' }));
    expect(api.reject).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Note (optional)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    expect(screen.getByLabelText(/Rejection reason/)).toHaveValue('');
  });

  it('lists step runs and re-runs a step with a different model and guidance', async () => {
    const { api, onDone } = setup({
      getStepRuns: vi.fn(async () => [
        {
          id: 1,
          stepId: 'data',
          trigger: 'process',
          model: 'local/qwen',
          attempts: 2,
          inputTokens: 900,
          outputTokens: 300,
          status: 'succeeded',
          cached: false,
          error: null,
          startedAt: '2026-10-09T10:00:00Z',
          finishedAt: '2026-10-09T10:01:00Z',
        },
      ]),
    });
    await userEvent.click(await screen.findByRole('tab', { name: /Steps/ }));
    const row = await screen.findByRole('row', { name: /data/ });
    expect(row).toHaveTextContent('local/qwen');
    await userEvent.click(within(row).getByRole('button', { name: 'Re-run data' }));
    await userEvent.type(screen.getByLabelText('Model for re-run'), 'other/better');
    await userEvent.type(screen.getByLabelText('Guidance for re-run'), 'Results are numeric.');
    const pages = screen.getByLabelText('Pages to show the model');
    expect(pages).toHaveValue('1'); // defaults to the page in the viewer
    await userEvent.clear(pages);
    await userEvent.type(pages, '3, 2');
    await userEvent.click(screen.getByRole('button', { name: 'Queue re-run' }));
    expect(api.rerunStep).toHaveBeenCalledWith(JOB_ID, 'data', {
      model: 'other/better',
      instructions: 'Results are numeric.',
      pageImages: [3, 2],
    });
    expect(onDone).toHaveBeenCalled();
  });

  it('shows a step served from the step cache as cached', async () => {
    setup({
      getStepRuns: vi.fn(async () => [
        {
          id: 1,
          stepId: 'data',
          trigger: 'process',
          model: 'local/qwen',
          attempts: 1,
          inputTokens: null,
          outputTokens: null,
          status: 'succeeded',
          cached: true,
          error: null,
          startedAt: '2026-10-09T10:00:00Z',
          finishedAt: '2026-10-09T10:00:00Z',
        },
      ]),
    });
    await userEvent.click(await screen.findByRole('tab', { name: /Steps/ }));
    const row = await screen.findByRole('row', { name: /data/ });
    expect(row).toHaveTextContent('cached');
    expect(row).not.toHaveTextContent('attempt');
  });

  it('approves a test run awaiting review (a workbench reference run)', async () => {
    const data = reviewData();
    const { api } = setup({
      getReview: vi.fn(async () => ({ ...data, job: { ...data.job, test: true } })),
    });
    await screen.findByRole('heading', { name: /scan\.pdf/ });
    await userEvent.click(screen.getByRole('button', { name: 'Approve and publish' }));
    expect(api.approve).toHaveBeenCalledWith(JOB_ID, {});
  });

  it('saves a finished test run as a reference', async () => {
    const data = reviewData();
    const { api } = setup({
      getReview: vi.fn(async () => ({
        ...data,
        job: { ...data.job, test: true, status: 'succeeded' },
      })),
    });
    await userEvent.type(await screen.findByLabelText('Reference name'), 'acme-2023');
    await userEvent.click(screen.getByRole('button', { name: 'Save as reference' }));
    expect(api.createReference).toHaveBeenCalledWith('tdemo', JOB_ID, 'acme-2023');
  });

  it('saves a finished document as a reference for its document type', async () => {
    const data = reviewData();
    const { api } = setup({
      getReview: vi.fn(async () => ({ ...data, job: { ...data.job, status: 'succeeded' } })),
    });
    await userEvent.type(await screen.findByLabelText('Reference name'), 'acme-2023');
    await userEvent.click(screen.getByRole('button', { name: 'Save as reference' }));
    expect(api.createReference).toHaveBeenCalledWith('tdemo', JOB_ID, 'acme-2023');
    expect(await screen.findByRole('status')).toHaveTextContent('Saved reference acme-2023');
  });

  it('is read-only once the job has left review', async () => {
    const data = reviewData();
    setup({
      getReview: vi.fn(async () => ({ ...data, job: { ...data.job, status: 'succeeded' } })),
    });
    await screen.findByRole('heading', { name: /scan\.pdf/ });
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and publish' })).not.toBeInTheDocument();
  });

  it('explains that legacy-spec documents have no review view and links to their results', async () => {
    setup({
      getReview: vi.fn(async () => {
        throw new Error('job is not a template document');
      }),
    });
    expect(await screen.findByText(/This document type has no review view/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Results page' })).toHaveAttribute(
      'href',
      `#/results/${JOB_ID}`,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('still reports other load errors', async () => {
    setup({
      getReview: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load review: boom');
  });
});

describe('ReviewPage between documents', () => {
  it('starts fresh on Next document (no reason or note carried over)', async () => {
    window.location.hash = `#/review/${JOB_ID}`;
    const other = '22222222-2222-4222-8222-222222222222';
    const api = fakeApi({
      getReview: vi.fn(async (id: string) => {
        const data = reviewData();
        return { ...data, job: { ...data.job, id, filename: id === other ? 'b.pdf' : 'scan.pdf' } };
      }),
    });
    render(<App api={api} pollMs={0} />);
    await screen.findByRole('heading', { level: 1, name: 'scan.pdf' });
    await userEvent.click(screen.getByRole('button', { name: 'Reject…' }));
    await userEvent.type(screen.getByLabelText(/Rejection reason/), 'wrong supplier');
    window.location.hash = `#/review/${other}`;
    await screen.findByRole('heading', { level: 1, name: 'b.pdf' });
    expect(screen.queryByLabelText(/Rejection reason/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Note (optional)')).toHaveValue('');
    window.location.hash = '';
  });

  it('moves the source page to a flagged field on Next flagged', async () => {
    const data = reviewData();
    data.document.issues.push({
      step: 'head',
      target: 'executed_on',
      row: null,
      column: null,
      raw: 'x',
      message: 'odd date',
    });
    setup({ getReview: vi.fn(async () => data) });
    await userEvent.click(await screen.findByRole('button', { name: /Next flagged/ }));
    expect(screen.getByRole('img', { name: /page 3 of 3/i })).toBeInTheDocument();
  });
});
