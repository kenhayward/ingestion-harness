import type { JobStatus, JobSummary } from '@ih/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { JobList } from '../src/jobs/JobList.js';
import { fakeApi, job, MODEL_CHOICES } from './fake-api.js';

type Props = ComponentProps<typeof JobList>;

const listElement = (jobs: JobSummary[], o: Partial<Props> = {}) => (
  <JobList
    api={fakeApi()}
    jobs={jobs}
    selectedId={null}
    onSelect={vi.fn()}
    onChanged={vi.fn()}
    models={MODEL_CHOICES}
    specTitles={new Map()}
    now={Date.parse('2026-10-12T12:00:00Z')}
    {...o}
  />
);
const renderList = (jobs: JobSummary[], o: Partial<Props> = {}) => render(listElement(jobs, o));

const row = (name: string) =>
  screen.getByRole('button', { name: `Show details for ${name}` }).closest('tr')!;
const openMenu = (name: string) =>
  userEvent.click(within(row(name)).getByRole('button', { name: `More actions for ${name}` }));
/** Text of the open menu's items (buttons and links), in order. */
const menuItems = (name: string) =>
  [...screen.getByRole('group', { name: `Actions for ${name}` }).querySelectorAll('button, a')].map(
    (e) => e.textContent,
  );

describe('JobList main action', () => {
  it('shows one main action per status', () => {
    renderList([
      job({ id: 'a', filename: 'await.pdf', status: 'awaiting_review' }),
      job({ id: 'b', filename: 'done.pdf', status: 'succeeded' }),
      job({ id: 'c', filename: 'run.pdf', status: 'running' }),
      job({ id: 'd', filename: 'fail.pdf', status: 'failed' }),
      job({ id: 'e', filename: 'rej.pdf', status: 'rejected' }),
    ]);
    expect(within(row('await.pdf')).getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      '#/review/a',
    );
    expect(within(row('done.pdf')).getByRole('link', { name: 'View' })).toHaveAttribute(
      'href',
      '#/review/b',
    );
    expect(within(row('run.pdf')).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(
      within(row('fail.pdf')).getByRole('button', { name: 'Retry fail.pdf' }),
    ).toHaveTextContent('Retry…');
    expect(within(row('rej.pdf')).queryByRole('link', { name: /Review|View/ })).toBeNull();
    expect(within(row('rej.pdf')).queryByRole('button', { name: /^(Retry|Cancel)/ })).toBeNull();
  });

  it.each<[JobStatus, string[]]>([
    ['queued', ['Open PDF']],
    ['running', ['Open PDF']],
    ['awaiting_review', ['Open PDF']],
    ['succeeded', ['Re-process…', 'Open PDF', 'Delete']],
    ['failed', ['Open PDF', 'Delete']],
    ['needs_review', ['Open PDF', 'Delete']],
    ['cancelled', ['Open PDF', 'Delete']],
    ['rejected', ['Open PDF', 'Delete']],
  ])('%s jobs offer %j in the menu', async (status, expected) => {
    renderList([job({ filename: 'a.pdf', status })]);
    await openMenu('a.pdf');
    expect(menuItems('a.pdf')).toEqual(expected);
  });

  it('links Open PDF to the uploaded document', async () => {
    renderList([job({ id: 'a', filename: 'a.pdf', status: 'failed' })]);
    await openMenu('a.pdf');
    expect(screen.getByRole('link', { name: 'Open PDF' })).toHaveAttribute(
      'href',
      '/api/jobs/a/document',
    );
  });

  it('offers the original of a Word document as a download', async () => {
    renderList([
      job({
        id: 'w',
        filename: 'r.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        status: 'failed',
      }),
    ]);
    await openMenu('r.docx');
    const link = screen.getByRole('link', { name: 'Download original (.docx)' });
    expect(link).toHaveAttribute('href', '/api/jobs/w/document');
    expect(link).not.toHaveAttribute('target');
    expect(screen.queryByRole('link', { name: 'Open PDF' })).not.toBeInTheDocument();
    expect(menuItems('r.docx')).toEqual(['Download original (.docx)', 'Delete']);
  });

  it('closes the menu on Escape', async () => {
    renderList([job({ filename: 'a.pdf', status: 'failed' })]);
    const more = screen.getByRole('button', { name: 'More actions for a.pdf' });
    await userEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Open PDF' })).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });
});

describe('JobList menu position', () => {
  it('closes the menu when the page scrolls under it', async () => {
    renderList([job({ filename: 'a.pdf', status: 'failed' })]);
    const more = screen.getByRole('button', { name: 'More actions for a.pdf' });
    await userEvent.click(more);
    fireEvent.scroll(window);
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('JobList rows', () => {
  it('selects a job from its file name and marks it', async () => {
    const onSelect = vi.fn();
    renderList([job({ id: 'a', filename: 'a.pdf' }), job({ id: 'b', filename: 'b.pdf' })], {
      onSelect,
      selectedId: 'b',
    });
    expect(screen.getByRole('button', { name: 'Show details for b.pdf' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show details for a.pdf' }));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it.each([
    [{ modelsUsed: ['local/qwen', 'anthropic/haiku'] }, 'local/qwen, anthropic/haiku'],
    [{ modelsUsed: [], modelOverride: 'anthropic/opus' }, 'anthropic/opus'],
    [{ modelsUsed: [], modelOverride: null }, 'Spec default'],
  ])('shows the document type and model: %j', (fields, shown) => {
    renderList([job({ filename: 'a.pdf', specId: 'inv', specVersion: 3, ...fields })], {
      specTitles: new Map([['inv', 'Supplier invoice']]),
    });
    expect(within(row('a.pdf')).getByText('Supplier invoice v3')).toBeInTheDocument();
    expect(within(row('a.pdf')).getByText(shown)).toBeInTheDocument();
  });

  it('shows the status, a context note and when it was created', () => {
    renderList([
      job({
        filename: 'a.pdf',
        status: 'failed',
        error: 'schema mismatch',
        createdAt: '2026-10-12T11:54:00Z',
      }),
    ]);
    expect(within(row('a.pdf')).getByText('Failed')).toBeInTheDocument();
    expect(within(row('a.pdf')).getByText('schema mismatch')).toBeInTheDocument();
    expect(within(row('a.pdf')).getByText('6 min ago')).toBeInTheDocument();
  });

  it('shows under the created time how long processing took, with a clock', () => {
    renderList([
      job({
        filename: 'done.pdf',
        status: 'succeeded',
        startedAt: '2026-10-12T11:50:00Z',
        finishedAt: '2026-10-12T11:51:34Z',
      }),
      job({ filename: 'running.pdf', status: 'running', startedAt: '2026-10-12T11:36:56Z' }),
      job({ filename: 'queued.pdf', status: 'queued' }),
    ]);
    const done = within(row('done.pdf')).getByLabelText('Processing time 1:34');
    expect(done).toHaveTextContent('1:34');
    expect(done.querySelector('svg')).not.toBeNull();
    // Still running: counts up to now.
    expect(within(row('running.pdf')).getByLabelText('Processing time 23:04')).toBeInTheDocument();
    expect(within(row('queued.pdf')).queryByLabelText(/Processing time/)).toBeNull();
  });

  it('says when there are no jobs', () => {
    renderList([]);
    expect(screen.getByText('No jobs yet.')).toBeInTheDocument();
  });
});

describe('JobList confirmations', () => {
  it('confirms before deleting, mentions published copies, and refreshes', async () => {
    const api = fakeApi();
    const onChanged = vi.fn();
    const j = job({ filename: 'a.pdf', status: 'succeeded' });
    renderList([j], { api, onChanged });
    await openMenu('a.pdf');
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    expect(within(row('a.pdf')).getByText(/Delete a\.pdf\?/)).toHaveTextContent(
      'Published copies in the target are kept.',
    );
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Keep a.pdf' }));
    expect(api.deleteJob).not.toHaveBeenCalled();
    await openMenu('a.pdf');
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(row('a.pdf')).getByRole('button', { name: 'Confirm delete a.pdf' }),
    );
    expect(api.deleteJob).toHaveBeenCalledWith(j.id);
    expect(onChanged).toHaveBeenCalled();
  });

  it('confirms before cancelling', async () => {
    const api = fakeApi();
    const j = job({ filename: 'a.pdf', status: 'running' });
    renderList([j], { api });
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Cancel' }));
    expect(within(row('a.pdf')).getByText('Cancel job?')).toBeInTheDocument();
    await userEvent.click(
      within(row('a.pdf')).getByRole('button', { name: 'Confirm cancel a.pdf' }),
    );
    expect(api.cancelJob).toHaveBeenCalledWith(j.id);
  });

  it('shows action errors in the row', async () => {
    const api = fakeApi({
      deleteJob: vi.fn(async () => {
        throw new Error('a running job cannot be deleted');
      }),
    });
    renderList([job({ filename: 'a.pdf', status: 'failed' })], { api });
    await openMenu('a.pdf');
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(row('a.pdf')).getByRole('button', { name: 'Confirm delete a.pdf' }),
    );
    expect(await within(row('a.pdf')).findByRole('alert')).toHaveTextContent(
      'a running job cannot be deleted',
    );
  });

  it("retries in the re-process dialog, with the job's model choice to start with", async () => {
    const api = fakeApi();
    const onChanged = vi.fn();
    const j = job({ id: 'a', filename: 'a.pdf', status: 'failed', modelOverride: 'test' });
    renderList([j], { api, onChanged });
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Retry a.pdf' }));
    const dialog = screen.getByRole('dialog', { name: 'Retry a.pdf' });
    expect(dialog).toHaveTextContent(
      'a.pdf runs again from the start, on the latest version of its document type.',
    );
    const model = within(dialog).getByRole('combobox', { name: 'Model' });
    expect(model).toHaveValue('test');
    expect(model).toHaveFocus();
    expect(api.retryJob).not.toHaveBeenCalled();
    await userEvent.selectOptions(model, 'Main Production Model (default)');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(api.retryJob).toHaveBeenCalledWith('a', 'main');
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("names the job's document type model in the retry dialog", async () => {
    const j = job({ filename: 'a.pdf', status: 'failed', specId: 'letter' });
    renderList([j], { typeModels: new Map([['letter', { model: 'test' }]]) });
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Retry a.pdf' }));
    expect(
      screen.getByRole('option', { name: "Document type's model (New for testing only)" }),
    ).toBeInTheDocument();
  });

  it("retries with the document type's models (clearing the override)", async () => {
    const api = fakeApi();
    const j = job({ id: 'a', filename: 'a.pdf', status: 'failed' });
    renderList([j], { api });
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Retry a.pdf' }));
    const dialog = screen.getByRole('dialog', { name: 'Retry a.pdf' });
    expect(within(dialog).getByRole('combobox', { name: 'Model' })).toHaveValue('');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(api.retryJob).toHaveBeenCalledWith('a', null);
  });

  it('cancels the dialog without retrying', async () => {
    const api = fakeApi();
    renderList([job({ filename: 'a.pdf', status: 'failed' })], { api });
    const retry = within(row('a.pdf')).getByRole('button', { name: 'Retry a.pdf' });
    await userEvent.click(retry);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.retryJob).not.toHaveBeenCalled();
    expect(retry).toHaveFocus();
  });

  it('shows a refused retry in the dialog', async () => {
    const api = fakeApi({
      retryJob: vi.fn(async () => {
        throw new Error('unknown model choice gone');
      }),
    });
    renderList([job({ filename: 'a.pdf', status: 'failed' })], { api });
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Retry a.pdf' }));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unknown model choice gone');
    expect(screen.getByRole('dialog', { name: 'Retry a.pdf' })).toBeInTheDocument();
  });

  it('moves focus into the confirmation and back to the menu button', async () => {
    const j = job({ filename: 'a.pdf', status: 'succeeded' });
    renderList([j]);
    await openMenu('a.pdf');
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    const confirm = within(row('a.pdf')).getByRole('button', { name: 'Confirm delete a.pdf' });
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAccessibleDescription(
      'Delete a.pdf? Published copies in the target are kept.',
    );
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Keep a.pdf' }));
    expect(
      within(row('a.pdf')).getByRole('button', { name: 'More actions for a.pdf' }),
    ).toHaveFocus();
  });

  it('re-processes a succeeded job in the dialog, saying what it discards', async () => {
    const api = fakeApi();
    const onChanged = vi.fn();
    const j = job({ filename: 'a.pdf', status: 'succeeded' });
    renderList([j], { api, onChanged });
    await openMenu('a.pdf');
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Re-process a.pdf' }));
    const dialog = screen.getByRole('dialog', { name: 'Re-process a.pdf' });
    expect(dialog).toHaveTextContent(
      'a.pdf is extracted again on the latest template version; earlier review edits are discarded.',
    );
    expect(api.retryJob).not.toHaveBeenCalled();
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Model' }),
      'New for testing only',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Re-process' }));
    expect(api.retryJob).toHaveBeenCalledWith(j.id, 'test');
    expect(onChanged).toHaveBeenCalled();
    // Focus goes back to the row's menu button (the menu item is gone).
    expect(
      within(row('a.pdf')).getByRole('button', { name: 'More actions for a.pdf' }),
    ).toHaveFocus();
  });

  it('keeps an open confirmation when the list refreshes', async () => {
    const j = job({ id: 'a', filename: 'a.pdf', status: 'failed' });
    const { rerender } = renderList([j]);
    await openMenu('a.pdf');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    rerender(listElement([{ ...j, updatedAt: '2026-10-12T00:00:01Z' }]));
    expect(screen.getByRole('button', { name: 'Confirm delete a.pdf' })).toBeInTheDocument();
  });
});
