import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { UserDialog } from '../src/access/UserDialog.js';
import { ReviewPage } from '../src/review/ReviewPage.js';
import { ADMIN_ME, fakeApi } from './fake-api.js';
import { JOB_ID, reviewData } from './review-fixture.js';

const OPERATOR = { ...ADMIN_ME, role: 'operator' as const, label: 'Olu', email: 'olu@example.com' };
const DESIGNER = { ...OPERATOR, role: 'designer' as const, label: 'Dee' };

const nav = async () => within(await screen.findByRole('navigation', { name: 'Main' }));

describe('operators', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('see only Home, Jobs and Results in the menu, and no API docs link', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => OPERATOR) })} pollMs={0} />);
    const menu = await nav();
    expect(menu.getAllByRole('link').map((l) => l.textContent?.trim())).toEqual([
      'Home',
      'Jobs',
      'Results',
    ]);
    expect(screen.queryByRole('link', { name: /API docs/ })).toBeNull();
  });

  it('designers keep every page and the API docs link', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => DESIGNER) })} pollMs={0} />);
    const menu = await nav();
    for (const name of ['Document types', 'Ontologies', 'Workbench']) {
      expect(menu.getByRole('link', { name })).toBeInTheDocument();
    }
    expect(menu.getByRole('link', { name: /API docs/ })).toBeInTheDocument();
  });

  it.each(['#/workbench', '#/templates', '#/ontologies', '#/workbench/letter'])(
    'opening %s says it is not for operators',
    async (hash) => {
      window.location.hash = hash;
      const api = fakeApi({ me: vi.fn(async () => OPERATOR) });
      render(<App api={api} pollMs={0} />);
      expect(
        await screen.findByRole('heading', { name: 'Not available to operators' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go to Home' })).toHaveAttribute('href', '#/');
      expect(api.listProjectPage).not.toHaveBeenCalled();
    },
  );

  it('the account menu names the role', async () => {
    render(<App api={fakeApi({ me: vi.fn(async () => OPERATOR) })} pollMs={0} />);
    expect(
      await screen.findByRole('button', { name: 'Olu (Operator): account menu' }),
    ).toBeInTheDocument();
  });

  it('review a job but cannot re-run a step', async () => {
    const api = fakeApi({
      getReview: vi.fn(async () => reviewData()),
      getStepRuns: vi.fn(async () => [
        {
          id: 1,
          stepId: 'data',
          model: 'main',
          trigger: 'process' as const,
          cached: false,
          inputTokens: null,
          outputTokens: null,
          attempts: 1,
          status: 'succeeded' as const,
          error: null,
          startedAt: '2026-10-09T10:00:00Z',
          finishedAt: '2026-10-09T10:01:00Z',
        },
      ]),
    });
    render(<ReviewPage api={api} jobId={JOB_ID} onDone={vi.fn()} role="operator" />);
    await userEvent.click(await screen.findByRole('tab', { name: /Steps/ }));
    await screen.findByRole('row', { name: /data/ });
    expect(screen.queryByRole('button', { name: /^Re-run/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeInTheDocument();
  });

  it('cannot save a finished job as a reference', async () => {
    const data = reviewData();
    const api = fakeApi({
      getReview: vi.fn(async () => ({
        ...data,
        job: { ...data.job, status: 'succeeded' as const },
      })),
    });
    render(<ReviewPage api={api} jobId={JOB_ID} onDone={vi.fn()} role="operator" />);
    await screen.findByRole('heading', { level: 1, name: 'scan.pdf' });
    expect(screen.queryByRole('form', { name: 'Save as reference' })).toBeNull();
  });
});

describe('Users: roles', () => {
  it('offers Administrator, Designer and Operator; a new user is a Designer', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<UserDialog onSave={onSave} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Add user' });
    const role = within(dialog).getByRole('group', { name: 'Role' });
    expect(
      within(role)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Operator', 'Designer', 'Administrator']);
    expect(within(role).getByRole('button', { name: 'Designer' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Olu');
    await userEvent.type(within(dialog).getByLabelText('Email address'), 'olu@example.com');
    await userEvent.click(within(role).getByRole('button', { name: 'Operator' }));
    expect(within(dialog).getByRole('note')).toHaveTextContent(
      'Operators upload documents, follow and review jobs, and read results',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add user' }));
    expect(onSave).toHaveBeenCalledWith({
      name: 'Olu',
      email: 'olu@example.com',
      role: 'operator',
    });
  });
});
