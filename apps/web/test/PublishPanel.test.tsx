import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PublishPanel } from '../src/workbench/PublishPanel.js';
import { fakeApi, gateView, projectView, publication } from './fake-api.js';

function panel(overrides = {}) {
  const api = fakeApi({ getProject: vi.fn(async () => projectView()), ...overrides });
  const onPublished = vi.fn();
  render(<PublishPanel api={api} projectId="letter" draft={2} onPublished={onPublished} />);
  return { api, onPublished };
}

describe('PublishPanel', () => {
  it('publishes directly when the gate passes', async () => {
    const { api, onPublished } = panel({
      getPublishGate: vi.fn(async () =>
        gateView({ passes: true, reason: 'holdout score 95% meets the threshold 90%' }),
      ),
      publish: vi.fn(async () => ({
        publication: publication({ version: 2 }),
        project: projectView(),
      })),
    });
    expect(
      await screen.findByText('holdout score 95% meets the threshold 90%'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Override reason')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect(api.publish).toHaveBeenCalledWith('letter', undefined);
    expect(await screen.findByText('Published v2')).toBeInTheDocument();
    expect(onPublished).toHaveBeenCalled();
  });

  it('needs an override reason below the threshold', async () => {
    const { api } = panel({
      getPublishGate: vi.fn(async () =>
        gateView({ passes: false, reason: 'holdout score 80% is below the threshold 90%' }),
      ),
      publish: vi.fn(async () => ({ publication: publication(), project: projectView() })),
    });
    const button = await screen.findByRole('button', { name: 'Publish v2' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Override reason'), 'Known bad scan in holdout');
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(api.publish).toHaveBeenCalledWith('letter', 'Known bad scan in holdout');
  });

  it('saves the threshold as a fraction', async () => {
    const { api } = panel({ setPublishThreshold: vi.fn(async () => projectView()) });
    const input = await screen.findByLabelText('Publish threshold (%)');
    await userEvent.clear(input);
    await userEvent.type(input, '80');
    await userEvent.click(screen.getByRole('button', { name: 'Save threshold' }));
    expect(api.setPublishThreshold).toHaveBeenCalledWith('letter', 0.8);
  });

  it('shows the gate reason when the API refuses, and keeps the override text', async () => {
    panel({
      getPublishGate: vi.fn(async () => gateView({ passes: false })),
      publish: vi.fn(async () => {
        throw new Error('holdout score 80% is below the threshold 90%');
      }),
    });
    await userEvent.type(
      await screen.findByLabelText('Override reason'),
      'Known bad scan in holdout',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('below the threshold 90%');
    expect(screen.getByLabelText('Override reason')).toHaveValue('Known bad scan in holdout');
  });

  it('lists recent publications with their override reasons', async () => {
    panel({
      listPublications: vi.fn(async () => [
        publication({ version: 1, score: 0.95 }),
        publication({ version: 2, score: null, overrideReason: 'Known bad scan' }),
      ]),
    });
    const list = await screen.findByRole('list', { name: 'Publications' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('v1');
    expect(items[0]).toHaveTextContent('95%');
    expect(items[1]).toHaveTextContent('override: Known bad scan');
  });
});
