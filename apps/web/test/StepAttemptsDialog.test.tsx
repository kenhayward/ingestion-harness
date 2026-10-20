import type { RetriedRun, StepAttempts } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StepAttemptsDialog } from '../src/templates/StepAttemptsDialog.js';
import { fakeApi } from './fake-api.js';

const run = (jobId: string, fileName: string, attempts: number): RetriedRun => ({
  jobId,
  fileName,
  version: 2,
  startedAt: '2026-10-20T12:31:00Z',
  attempts,
  model: 'local/qwen',
  status: 'succeeded',
  trigger: 'process',
});

const attempt = (n: number, errors: string[] = []) => ({
  n,
  prompt: `the prompt of attempt ${n}`,
  response: `{"rows": "reply ${n}"}`,
  errors,
  inputTokens: 900,
  outputTokens: 1204,
});

const LOG: StepAttempts = {
  calls: [
    {
      label: 'data',
      attempts: [
        attempt(1, ['rows/3/qty: \'lots\' is not of type "integer"']),
        attempt(2, ['rows: return exactly 4 rows']),
        attempt(3),
      ],
    },
  ],
};

function setup(overrides = {}) {
  const api = fakeApi({
    listRetriedStepRuns: vi.fn(async () => ({
      runs: [run('11111111-1111-4111-8111-111111111111', 'invoice-04.pdf', 3)],
    })),
    getStepAttempts: vi.fn(async () => LOG),
    ...overrides,
  });
  const onClose = vi.fn();
  render(<StepAttemptsDialog api={api} templateId="letter" stepId="data" onClose={onClose} />);
  return { api, onClose };
}

describe('StepAttemptsDialog', () => {
  it("lists the step's retried runs and opens the newest one's first attempt", async () => {
    const { api } = setup();
    const dialog = await screen.findByRole('dialog', { name: 'Model log: data' });
    expect(api.listRetriedStepRuns).toHaveBeenCalledWith('letter', 'data');
    const nav = within(dialog).getByRole('navigation', { name: 'Runs and attempts' });
    expect(within(nav).getByText('invoice-04.pdf')).toBeInTheDocument();
    expect(within(nav).getByText(/v2 · 3 attempts/)).toBeInTheDocument();
    await within(nav).findByRole('button', { name: /Attempt 1/ });
    expect(api.getStepAttempts).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'data',
    );
    const shown = within(dialog).getByRole('region', { name: 'Attempt 1' });
    expect(within(shown).getByText('Errors that sent it back')).toBeInTheDocument();
    expect(
      within(shown).getByText('rows/3/qty: \'lots\' is not of type "integer"'),
    ).toBeInTheDocument();
    expect(within(shown).getByText('the prompt of attempt 1')).toBeInTheDocument();
    expect(within(shown).getByText('{"rows": "reply 1"}')).toBeInTheDocument();
    expect(within(shown).getByText(/1,204 output tokens/)).toBeInTheDocument();
  });

  it('marks each attempt refused or accepted, and shows the one picked', async () => {
    setup();
    const nav = await screen.findByRole('navigation', { name: 'Runs and attempts' });
    const third = await within(nav).findByRole('button', { name: 'Attempt 3 accepted' });
    expect(within(nav).getByRole('button', { name: 'Attempt 1 refused' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(third);
    expect(third).toHaveAttribute('aria-pressed', 'true');
    const shown = screen.getByRole('region', { name: 'Attempt 3' });
    expect(within(shown).getByText('Accepted: this reply passed the checks.')).toBeInTheDocument();
    expect(within(shown).queryByText('Errors that sent it back')).toBeNull();
  });

  it('opens another run when its name is picked', async () => {
    const { api } = setup({
      listRetriedStepRuns: vi.fn(async () => ({
        runs: [
          run('11111111-1111-4111-8111-111111111111', 'invoice-04.pdf', 3),
          run('22222222-2222-4222-8222-222222222222', 'invoice-02.pdf', 2),
        ],
      })),
    });
    const nav = await screen.findByRole('navigation', { name: 'Runs and attempts' });
    await userEvent.click(within(nav).getByRole('button', { name: /invoice-02\.pdf/ }));
    expect(api.getStepAttempts).toHaveBeenLastCalledWith(
      '22222222-2222-4222-8222-222222222222',
      'data',
    );
  });

  it('names each call of a step that made several (pages, occurrences)', async () => {
    setup({
      getStepAttempts: vi.fn(async () => ({
        calls: [
          { label: 'data.chunk-1', attempts: [attempt(1)] },
          { label: 'data.chunk-2', attempts: [attempt(1, ['bad']), attempt(2)] },
        ],
      })),
    });
    const nav = await screen.findByRole('navigation', { name: 'Runs and attempts' });
    expect(await within(nav).findByText('Pages, part 1')).toBeInTheDocument();
    expect(within(nav).getByText('Pages, part 2')).toBeInTheDocument();
  });

  it('says so when no run of the step needed a retry', async () => {
    setup({ listRetriedStepRuns: vi.fn(async () => ({ runs: [] })) });
    expect(
      await screen.findByText('No run of this step has needed a retry yet.'),
    ).toBeInTheDocument();
  });

  it('shows why a run has no log', async () => {
    setup({
      getStepAttempts: vi.fn(async () => {
        throw new Error('no saved attempts for step data of this job');
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'no saved attempts for step data of this job',
    );
  });
});
