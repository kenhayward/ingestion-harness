import type { JobSummary, PluginInfo } from '@ih/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    expect(screen.getByRole('link', { name: /Jobs/ })).toHaveAttribute('href', '#/jobs');
    expect(screen.getByText('1 of 2 awaiting review')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Next document/ })).toHaveAttribute(
      'href',
      '#/review/next-id',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    const chip = screen.getByRole('button', { name: /Why this needs review \(2\)/ });
    await userEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Why this needs review' })).toHaveTextContent(
      'check batch_check: 1 unmatched',
    );
  });

  it('closes the reasons on Escape, back to the chip, and on a click outside', async () => {
    setup();
    const chip = await screen.findByRole('button', { name: /Why this needs review/ });
    await userEvent.click(chip);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Why this needs review' })).toBeNull();
    expect(chip).toHaveFocus();
    await userEvent.click(chip);
    await userEvent.click(screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByRole('dialog', { name: 'Why this needs review' })).toBeNull();
  });

  it('shows no reasons once the job has left review', async () => {
    const data = reviewData();
    data.job.status = 'succeeded';
    setup({ getReview: vi.fn(async () => data) });
    await screen.findByRole('heading', { level: 1, name: 'scan.pdf' });
    expect(screen.queryByRole('button', { name: /Why this needs review/ })).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByText(/check batch_check/)).toBeNull();
  });

  it('shows no reasons chip for a job awaiting review without reasons', async () => {
    const data = reviewData();
    data.job.reviewReasons = [];
    setup({ getReview: vi.fn(async () => data) });
    await screen.findByRole('heading', { level: 1, name: 'scan.pdf' });
    expect(screen.queryByRole('button', { name: /Why this needs review/ })).toBeNull();
  });

  it('keeps the full file name on hover and the recipe, version and model in the header', async () => {
    setup();
    const h1 = await screen.findByRole('heading', { level: 1, name: 'scan.pdf' });
    expect(h1).toHaveAttribute('title', 'scan.pdf');
    const header = h1.closest('header')!;
    expect(header).toHaveTextContent('Template demo · v1');
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
    // The hint is the page arrows' hover text, so the toolbar stays one row.
    expect(within(pane).queryByText('Click a value to find it on the page')).toBeNull();
    for (const name of ['Previous page', 'Next page']) {
      expect(within(pane).getByRole('button', { name })).toHaveAttribute(
        'title',
        'Click a value to find it on the page',
      );
    }
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
    expect(within(tabs).getByRole('tab', { name: 'results 3 (2 flagged)' })).toBeInTheDocument();
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

  it("shows a check plugin's message on a flagged value", async () => {
    const data = reviewData();
    data.document.checks.batch_check!.rows[1] = {
      value: 'GX',
      status: 'unmatched',
      matched: null,
      distance: null,
      count: 1,
      message: 'GX is not a released batch',
    };
    setup({ getReview: vi.fn(async () => data) });
    await userEvent.click(await screen.findByRole('tab', { name: /^results/ }));
    expect(await screen.findByTitle('batch_check: GX is not a released batch')).toBeInTheDocument();
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
    // The reasons sit behind the header's chip.
    await userEvent.click(screen.getByRole('button', { name: /Why this needs review/ }));
    expect(screen.getByText(/check batch_check: 1 unmatched/)).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
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
    const rows = screen.getByRole('group', { name: 'Rows' });
    expect(within(rows).getByRole('button', { name: 'All rows' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(within(rows).getByRole('button', { name: 'Flagged only' }));
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

  it('lists step runs and re-runs a step with another model choice and guidance', async () => {
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
    await waitFor(() => expect(row).toHaveTextContent('Main Production Model'));
    expect(row).not.toHaveTextContent('local/qwen');
    await userEvent.click(within(row).getByRole('button', { name: 'Re-run data' }));
    const dialog = screen.getByRole('dialog', { name: 'Re-run data' });
    expect(dialog).toHaveTextContent('Only data calls the model again');
    const model = within(dialog).getByRole('combobox', { name: 'Model' });
    expect(within(model).getByRole('option', { name: 'Step default' })).toBeInTheDocument();
    // The model choices, by label (ADR 0010, phase 4c).
    await within(model).findByRole('option', { name: 'New for testing only' });
    await userEvent.selectOptions(model, 'New for testing only');
    await userEvent.type(screen.getByLabelText('Guidance for re-run'), 'Results are numeric.');
    const pages = screen.getByLabelText('Pages to show the model');
    expect(pages).toHaveValue('1'); // defaults to the page in the viewer
    await userEvent.clear(pages);
    await userEvent.type(pages, '3, 2');
    await userEvent.click(screen.getByRole('button', { name: 'Queue re-run' }));
    expect(api.rerunStep).toHaveBeenCalledWith(JOB_ID, 'data', {
      model: 'test',
      instructions: 'Results are numeric.',
      pageImages: [3, 2],
    });
    expect(onDone).toHaveBeenCalled();
  });

  describe('re-running a plugin step', () => {
    const plugin = (ref: string, egress: 'none' | 'model'): PluginInfo => ({
      ref,
      id: ref.split('@')[0]!,
      major: 1,
      summary: 'A plugin.',
      egress,
      kind: 'step',
      settingsSchema: { type: 'object' },
    });
    const withPlugin = (uses: string) => {
      const data = reviewData();
      const head = data.template.pipeline[0] as { fields: string[] };
      data.template.pipeline[0] = {
        type: 'plugin',
        id: 'head',
        uses,
        fields: head.fields,
        sections: ['all'],
        context: {},
        with: {},
      } as (typeof data.template.pipeline)[number];
      return data;
    };
    const open = async (uses: string, egress: 'none' | 'model') => {
      const ctx = setup({
        getReview: vi.fn(async () => withPlugin(uses)),
        listPlugins: vi.fn(async () => [plugin(uses, egress)]),
      });
      await userEvent.click(await screen.findByRole('tab', { name: 'Steps 2' }));
      const row = await screen.findByRole('row', { name: /head/ });
      await userEvent.click(within(row).getByRole('button', { name: 'Re-run head' }));
      return { ...ctx, dialog: screen.getByRole('dialog', { name: 'Re-run head' }) };
    };

    it('runs a plugin that calls no model again with guidance only', async () => {
      const { api, dialog } = await open('text.pattern@1', 'none');
      expect(dialog).toHaveTextContent('Only head runs again (OCR is reused)');
      await waitFor(() =>
        expect(within(dialog).queryByRole('combobox', { name: 'Model' })).toBeNull(),
      );
      expect(within(dialog).queryByLabelText('Pages to show the model')).toBeNull();
      await userEvent.type(within(dialog).getByLabelText('Guidance for re-run'), 'Ref: first.');
      await userEvent.click(screen.getByRole('button', { name: 'Queue re-run' }));
      expect(api.rerunStep).toHaveBeenCalledWith(JOB_ID, 'head', { instructions: 'Ref: first.' });
    });

    it('offers a model for a plugin that asks one, and no page images', async () => {
      const { api, dialog } = await open('acme.ask@1', 'model');
      const model = await within(dialog).findByRole('combobox', { name: 'Model' });
      await within(model).findByRole('option', { name: 'New for testing only' });
      await userEvent.selectOptions(model, 'New for testing only');
      expect(within(dialog).queryByLabelText('Pages to show the model')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Queue re-run' }));
      expect(api.rerunStep).toHaveBeenCalledWith(JOB_ID, 'head', { model: 'test' });
    });
  });

  it("opens a step's model log for this job from the Steps tab", async () => {
    const { api } = setup({
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
      getStepAttempts: vi.fn(async () => ({
        calls: [
          {
            label: 'data',
            attempts: [
              {
                n: 1,
                prompt: 'p',
                response: 'r',
                errors: ['bad'],
                inputTokens: null,
                outputTokens: null,
              },
            ],
          },
        ],
      })),
    });
    await userEvent.click(await screen.findByRole('tab', { name: /Steps/ }));
    const row = await screen.findByRole('row', { name: /data/ });
    await userEvent.click(await within(row).findByRole('button', { name: 'Model log of data' }));
    const dialog = await screen.findByRole('dialog', { name: 'Model log: data' });
    expect(api.getStepAttempts).toHaveBeenCalledWith(JOB_ID, 'data');
    expect(api.listRetriedStepRuns).not.toHaveBeenCalled();
    expect(await within(dialog).findByText('bad')).toBeInTheDocument();
    const head = screen.getByRole('row', { name: /head/ });
    expect(within(head).queryByRole('button', { name: 'Model log of head' })).toBeNull();
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
    const save = screen.getByRole('button', { name: 'Save as reference' });
    // What a reference is for is the button's hover text, not a line of its own.
    expect(save).toHaveAttribute(
      'title',
      'Save these (reviewed) values as a reference: recipe changes can then be regression-tested against this document.',
    );
    expect(screen.queryByText(/Finished\. Save these/)).toBeNull();
    await userEvent.click(save);
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
        throw new Error('job did not run a recipe');
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

describe('ReviewPage graph (ADR 0011 step 5)', () => {
  const graphOutput = {
    outputId: 'graph',
    stage: 'draft' as const,
    format: 'rdf' as const,
    bucket: 'outputs',
    key: `${JOB_ID}/graph.ttl`,
    rowCount: null,
    targetId: null,
  };

  it('has no Graph tab without a graph output', async () => {
    setup();
    await screen.findByRole('tab', { name: /Fields/ });
    expect(screen.queryByRole('tab', { name: /Graph/ })).toBeNull();
  });

  it('shows the graph and its SHACL results, each opening the output it names', async () => {
    const data = reviewData();
    data.job = { ...data.job, outputs: [graphOutput] };
    data.job.reviewReasons = ['SHACL: LetterShape on results.batch: batches are known'];
    const { api } = setup({
      getReview: vi.fn(async () => data),
      getOutputText: vi.fn(async () => '<a> <b> <c> .'),
      getShaclReport: vi.fn(async () => ({
        conforms: false,
        results: [
          {
            severity: 'Violation' as const,
            shape: 'https://a/LetterShape',
            focus: 'https://d/x',
            path: 'https://a/batch',
            output: 'results.batch',
            message: 'batches are known',
            value: 'GX',
          },
          {
            severity: 'Warning' as const,
            shape: 'https://a/LetterShape',
            focus: 'https://d/x',
            path: 'https://a/product',
            output: 'product',
            message: 'short product',
            value: 'R',
          },
        ],
      })),
    });
    await userEvent.click(await screen.findByRole('tab', { name: /Graph 1 \(1 flagged\)/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Turtle' }));
    expect(await screen.findByText('<a> <b> <c> .')).toBeInTheDocument();
    expect(api.getShaclReport).toHaveBeenCalledWith(JOB_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Show results.batch' }));
    expect(screen.getByRole('tab', { name: /results/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: /Graph/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Show product' }));
    expect(screen.getByRole('tab', { name: /Fields/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('ReviewPage layout', () => {
  const separator = () =>
    screen.getByRole('separator', { name: 'Resize the document and the data' });

  it('lists fields and tables in an outline, with flag counts and a filter', async () => {
    setup();
    const outline = await screen.findByRole('tablist', { name: 'Extracted data' });
    expect(outline).toHaveAttribute('aria-orientation', 'vertical');
    expect(within(outline).getByText('Tables')).toBeInTheDocument();
    expect(within(outline).getByText('1 flagged')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a table or field' }), 'res');
    expect(within(outline).getByRole('tab', { name: /^results/ })).toBeInTheDocument();
    expect(within(outline).queryByRole('tab', { name: /^Fields/ })).toBeNull();
    expect(within(outline).queryByRole('tab', { name: /^Steps/ })).toBeNull();
  });

  it("shows a table's long name with its reference on a second line", async () => {
    const data = reviewData();
    data.template.outputs.tables[0]!.name = 'Test Parameters (Table IX)';
    setup({ getReview: vi.fn(async () => data) });
    const tab = await screen.findByRole('tab', { name: /^Test Parameters \(Table IX\) 3/ });
    expect(within(tab).getByText('Table IX')).toBeInTheDocument();
    expect(within(tab).getByText('Test Parameters')).toBeInTheDocument();
  });

  it('steps between tables from the open table', async () => {
    const data = reviewData();
    data.template.outputs.tables.push({
      id: 'extra',
      name: 'Extra',
      columns: [{ id: 'note', type: 'text' }],
    });
    data.document.tables.extra = [{ note: 'n' }];
    setup({ getReview: vi.fn(async () => data) });
    await userEvent.click(await screen.findByRole('tab', { name: /^results/ }));
    expect(screen.getByRole('button', { name: 'Previous table' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next table: Extra' }));
    expect(screen.getByRole('tab', { name: /^Extra/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('explains the flagged value Next flagged lands on, with a way to edit it', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: /Next flagged/ }));
    const note = screen.getByRole('region', { name: 'Flagged value' });
    expect(note).toHaveTextContent('Row 2 · batch');
    expect(note).toHaveTextContent('batch_check');
    await userEvent.click(screen.getByRole('button', { name: /Next flagged/ }));
    expect(note).toHaveTextContent('Row 2 · value');
    expect(note).toHaveTextContent("'Complies' is not a valid decimal");
    await userEvent.click(within(note).getByRole('button', { name: 'Edit value' }));
    expect(
      screen.getByRole('textbox', { name: 'New value for results row 2 value' }),
    ).toHaveFocus();
  });

  it('resizes the document beside the data and remembers it', async () => {
    const { unmount } = render(
      <ReviewPage
        api={fakeApi({ getReview: vi.fn(async () => reviewData()) })}
        jobId={JOB_ID}
        onDone={vi.fn()}
      />,
    );
    await screen.findByRole('region', { name: 'Source PDF' });
    expect(separator()).toHaveAttribute('aria-valuenow', '45');
    separator().focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(separator()).toHaveAttribute('aria-valuenow', '50');
    await userEvent.click(screen.getByRole('button', { name: 'Document 30%' }));
    expect(separator()).toHaveAttribute('aria-valuenow', '30');
    unmount();
    setup();
    await screen.findByRole('region', { name: 'Source PDF' });
    expect(separator()).toHaveAttribute('aria-valuenow', '30');
  });

  it('follows a drag of the divider and remembers it once the drag ends', async () => {
    setup();
    await screen.findByRole('region', { name: 'Source PDF' });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 1000, height: 600 }),
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const divider = separator();
    // jsdom's PointerEvent has no clientX: a MouseEvent of the pointer type carries it.
    const pointer = (type: string, clientX: number) =>
      fireEvent(divider, new MouseEvent(type, { bubbles: true, clientX }));
    pointer('pointerdown', 450);
    pointer('pointermove', 500);
    pointer('pointermove', 550);
    pointer('pointermove', 600);
    expect(divider).toHaveAttribute('aria-valuenow', '60');
    const layoutWrites = () => setItem.mock.calls.filter(([key]) => key === 'ih.reviewLayout');
    expect(layoutWrites()).toHaveLength(0);
    pointer('pointerup', 600);
    expect(layoutWrites()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('ih.reviewLayout')!)).toMatchObject({ docWidth: 60 });
    vi.restoreAllMocks();
  });

  it('hides either panel to a rail at its side, and shows it again', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Hide the document' }));
    expect(screen.queryByRole('region', { name: 'Source PDF' })).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show the document' }));
    expect(screen.getByRole('region', { name: 'Source PDF' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide the data' }));
    expect(screen.queryByRole('region', { name: 'Extracted data' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show the data' }));
    expect(screen.getByRole('region', { name: 'Extracted data' })).toBeInTheDocument();
  });

  it('swaps the document to the other side', async () => {
    setup();
    const source = await screen.findByRole('region', { name: 'Source PDF' });
    const data = screen.getByRole('region', { name: 'Extracted data' });
    const before = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(source, data)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Swap sides' }));
    expect(
      before(
        screen.getByRole('region', { name: 'Extracted data' }),
        screen.getByRole('region', { name: 'Source PDF' }),
      ),
    ).toBe(true);
  });

  it('shows page thumbnails, marking pages with flagged fields', async () => {
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
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(pages).getAllByRole('button')).toHaveLength(3);
    expect(within(pages).getByRole('button', { name: 'Page 1' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      within(pages).getByRole('button', { name: 'Page 3 (flagged values)' }),
    ).toBeInTheDocument();
    await userEvent.click(within(pages).getByRole('button', { name: 'Page 2' }));
    expect(screen.getByRole('img', { name: 'Page 2 of 3' })).toBeInTheDocument();
  });
});

describe('ReviewPage long text values', () => {
  it('edits a text value in a multi-line box: Shift+Enter starts a line, Enter saves', async () => {
    const { api } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Medicinal Product' }));
    const box = screen.getByRole('textbox', { name: 'New value for product' });
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveValue('Richfer capsules');
    await userEvent.clear(box);
    await userEvent.type(box, 'Line one{Shift>}{Enter}{/Shift}line two');
    expect(api.addEdit).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(api.addEdit).toHaveBeenCalledWith(JOB_ID, {
      field: 'product',
      value: 'Line one\nline two',
    });
  });

  it('keeps a one-line box for values that are not text', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Execution Date' }));
    expect(screen.getByRole('textbox', { name: 'New value for executed_on' }).tagName).toBe(
      'INPUT',
    );
  });
});

describe('ReviewPage page columns', () => {
  /** The results table with a Page column: row 2 (the flagged one) was found on page 2. */
  const withPages = () => {
    const data = reviewData();
    data.template.outputs.tables[0]!.columns.push({ id: 'page', name: 'Page', type: 'integer' });
    data.document.tables.results = [
      { batch: 'G1', value: 137.8, page: 3 },
      { batch: 'GX', value: 'Complies', page: 2 },
      { batch: 'G1', value: 120.1, page: 9 },
    ];
    return data;
  };

  it("opens the page a row's page column names", async () => {
    setup({ getReview: vi.fn(async () => withPages()) });
    await userEvent.click(await screen.findByRole('tab', { name: /^results/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Show page 3' }));
    expect(screen.getByRole('img', { name: 'Page 3 of 3' })).toBeInTheDocument();
    // Only page numbers the document has, and only in the page column.
    expect(screen.queryByRole('button', { name: 'Show page 9' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Show page 137/ })).toBeNull();
  });

  it('turns to the page of the flagged row Next flagged lands on, and marks it', async () => {
    setup({ getReview: vi.fn(async () => withPages()) });
    await userEvent.click(await screen.findByRole('button', { name: /Next flagged/ }));
    expect(screen.getByRole('img', { name: 'Page 2 of 3' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('button', {
        name: 'Page 2 (flagged values)',
      }),
    ).toBeInTheDocument();
  });
});

describe('ReviewPage help', () => {
  it('explains reviewing from the top right of the header', async () => {
    setup();
    const help = await screen.findByRole('button', { name: 'Help: Reviewing a document' });
    expect(help.closest('.review-header')).not.toBeNull();
    await userEvent.click(help);
    expect(screen.getByRole('dialog', { name: 'Reviewing a document' })).toBeInTheDocument();
  });
});
