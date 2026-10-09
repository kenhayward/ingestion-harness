import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewPage } from '../src/review/ReviewPage.js';
import { fakeApi } from './fake-api.js';
import { JOB_ID, reviewData } from './review-fixture.js';

function setup(overrides = {}) {
  const api = fakeApi({
    getReview: vi.fn(async () => reviewData()),
    ...overrides,
  });
  const onDone = vi.fn();
  render(<ReviewPage api={api} jobId={JOB_ID} onDone={onDone} />);
  return { api, onDone };
}

const fieldRow = (name: RegExp) => screen.getByRole('row', { name });

beforeEach(() => localStorage.clear());

describe('ReviewPage', () => {
  it('shows the document, review reasons and every field with its evidence', async () => {
    setup();
    expect(await screen.findByRole('heading', { name: /scan\.pdf/ })).toBeInTheDocument();
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
    await userEvent.click(within(fieldRow(/Execution Date/)).getByRole('button', { name: 'Edit' }));
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
    await userEvent.click(within(fieldRow(/compound/)).getByRole('button', { name: 'Edit' }));
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
    await userEvent.click(await screen.findByRole('tab', { name: /results \(3\)/ }));
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
    await userEvent.type(screen.getByLabelText('Note'), 'checked against scan');
    await userEvent.click(screen.getByRole('button', { name: 'Approve and publish' }));
    expect(api.approve).toHaveBeenCalledWith(JOB_ID, {
      reviewer: 'kh',
      note: 'checked against scan',
    });
    expect(onDone).toHaveBeenCalled();
  });

  it('rejects only with a reason', async () => {
    const { api, onDone } = setup();
    await screen.findByRole('heading', { name: /scan\.pdf/ });
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Rejection reason'), 'wrong document');
    await userEvent.click(reject);
    expect(api.reject).toHaveBeenCalledWith(JOB_ID, { reason: 'wrong document' });
    expect(onDone).toHaveBeenCalled();
  });

  it('is read-only once the job has left review', async () => {
    const data = reviewData();
    setup({
      getReview: vi.fn(async () => ({ ...data, job: { ...data.job, status: 'succeeded' } })),
    });
    await screen.findByRole('heading', { name: /scan\.pdf/ });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and publish' })).not.toBeInTheDocument();
  });
});
