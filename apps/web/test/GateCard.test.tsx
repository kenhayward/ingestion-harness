import type { ComponentProps } from 'react';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PublishGateView } from '@ih/shared';
import type { Api } from '../src/api/client.js';
import { GateCard, PublicationsLog, useGate } from '../src/workbench/GateCard.js';
import { fakeApi, projectView, publication, publishGateView } from './fake-api.js';

function card(props: Partial<ComponentProps<typeof GateCard>> = {}, overrides: Partial<Api> = {}) {
  const api = fakeApi({
    setPublishThreshold: vi.fn(async () => projectView()),
    publish: vi.fn(async () => ({
      publication: publication({ version: 2 }),
      project: projectView(),
    })),
    ...overrides,
  });
  const onChanged = vi.fn();
  const onPublished = vi.fn();
  const element = (over: Partial<ComponentProps<typeof GateCard>> = {}) => (
    <GateCard
      api={api}
      projectId="letter"
      draft={2}
      published={1}
      gate={publishGateView()}
      publications={[]}
      threshold={{ value: 0.9, setBy: null, setAt: null }}
      devScore={null}
      onChanged={onChanged}
      onPublished={onPublished}
      {...props}
      {...over}
    />
  );
  const view = render(element());
  return { api, onChanged, onPublished, view: { element, rerender: view.rerender } };
}

function cardWithView() {
  return card();
}

const below = publishGateView({
  iterationId: crypto.randomUUID(),
  score: 0.88,
  reason: 'holdout score 88% is below the threshold 90%',
});

describe('GateCard', () => {
  it('is informational below the threshold: Publish stays available, no override', () => {
    card({ gate: below, devScore: 0.91 });
    const gate = screen.getByRole('region', { name: 'Publish gate' });
    expect(within(gate).getByText('BELOW THRESHOLD')).toBeInTheDocument();
    expect(
      within(gate).getByRole('heading', {
        name: 'Publish v2 — holdout score 88% is below the threshold 90%',
      }),
    ).toBeInTheDocument();
    expect(
      within(gate).getByRole('img', { name: 'Holdout score: 88%, threshold 90%' }),
    ).toBeInTheDocument();
    expect(
      within(gate).getByRole('img', { name: 'Dev score: 91%, threshold 90%' }),
    ).toBeInTheDocument();
    expect(within(gate).getByText('measured against the threshold')).toBeInTheDocument();
    expect(within(gate).getByText('guides your changes')).toBeInTheDocument();
    expect(within(gate).getByRole('button', { name: 'Publish v2' })).toBeEnabled();
    expect(within(gate).queryByText(/LOCKED/)).toBeNull();
    expect(within(gate).queryByRole('button', { name: /Publish anyway/ })).toBeNull();
    expect(within(gate).queryByLabelText(/override/i)).toBeNull();
    expect(
      within(gate).getByText('Evaluation is optional: you can publish v2 at any time.'),
    ).toBeInTheDocument();
  });

  it('meets the threshold', () => {
    card({
      gate: publishGateView({ passes: true, score: 0.95, iterationId: crypto.randomUUID() }),
    });
    expect(screen.getByText('MEETS THRESHOLD')).toBeInTheDocument();
  });

  it('says when no holdout run measures the draft', () => {
    card();
    expect(screen.getByText('NOT MEASURED')).toBeInTheDocument();
    expect(
      screen.getByText(
        'No holdout run of v2 yet. Run one below to measure v2 against the threshold.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Holdout score: no score yet' })).toBeInTheDocument();
  });

  it('shows a published version without meters or a Publish button', () => {
    card({ draft: null, published: 2, gate: null });
    expect(screen.getByText('PUBLISHED')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: 'v2 is live. Start the next version on the Recipe tab.',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Publish v/ })).toBeNull();
  });

  it("lists what's lowering the score with a link to the fixing tab", () => {
    card({
      gate: {
        ...below,
        hints: [
          { key: 'due_date', accuracy: 0, cause: 'no_step', stage: 'steps' },
          { key: 'po_number', accuracy: 0.5, cause: 'low_accuracy', stage: 'revise' },
        ],
      },
    });
    const hints = screen.getByRole('complementary', { name: "What's lowering the score" });
    const items = within(hints).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(
      'due_date scores 0% on holdout: no step of the draft fills it.',
    );
    expect(within(items[0]!).getByRole('link', { name: 'Open Pipeline' })).toHaveAttribute(
      'href',
      '#/workbench/letter/steps',
    );
    expect(within(items[1]!).getByRole('link', { name: 'Open Revise' })).toHaveAttribute(
      'href',
      '#/workbench/letter/revise',
    );
  });

  it('says when nothing is below the threshold', () => {
    card({
      gate: publishGateView({ iterationId: crypto.randomUUID(), score: 0.95, passes: true }),
    });
    expect(screen.getByText('No output is below the threshold.')).toBeInTheDocument();
  });

  it('validates the threshold and saves it as a fraction', async () => {
    const { api, onChanged } = card();
    const input = screen.getByLabelText('Publish threshold (%)');
    const save = screen.getByRole('button', { name: 'Save threshold' });
    expect(input).toHaveValue(90);
    for (const bad of ['', '120', '85.5']) {
      await userEvent.clear(input);
      if (bad) await userEvent.type(input, bad);
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute('title', 'Enter a whole percentage from 0 to 100');
    }
    await userEvent.clear(input);
    await userEvent.type(input, '80');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(api.setPublishThreshold).toHaveBeenCalledWith('letter', 0.8);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('shows who last set the threshold, and when', () => {
    const at = '2026-10-01T09:30:00.000Z';
    card({ threshold: { value: 0.9, setBy: 'ken', setAt: at } });
    expect(
      screen.getByText(`Threshold set by ken on ${new Date(at).toLocaleDateString()}`),
    ).toBeInTheDocument();
  });

  it('names the live version', () => {
    const at = '2026-10-02T11:04:00.000Z';
    card({ publications: [publication({ version: 1, score: 0.9, publishedAt: at })] });
    expect(
      screen.getByText(`Live: v1 · published ${new Date(at).toLocaleDateString()} at 90%`),
    ).toBeInTheDocument();
  });

  it('says when nothing is live', () => {
    card({ published: null });
    expect(screen.getByText('Not published yet')).toBeInTheDocument();
  });

  it('publishes with no override reason', async () => {
    const { api, onPublished, onChanged } = card({ gate: below });
    await userEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect(api.publish).toHaveBeenCalledWith('letter', undefined);
    expect(await screen.findByText('Published v2')).toBeInTheDocument();
    expect(onPublished).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows why the API refused', async () => {
    card({}, { publish: vi.fn(async () => Promise.reject(new Error('the draft is not valid'))) });
    await userEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the draft is not valid');
  });

  it('says nothing about who set the threshold when it was never set', () => {
    card();
    expect(screen.queryByText(/Threshold set by/)).toBeNull();
  });

  it('keeps "Published vN" once the draft is gone, with no Publish button', async () => {
    const { api, view } = cardWithView();
    await userEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect(await screen.findByText('Published v2')).toBeInTheDocument();
    expect(api.publish).toHaveBeenCalledTimes(1);
    view.rerender(view.element({ draft: null, published: 2, gate: null }));
    expect(screen.getByText('Published v2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Publish v/ })).toBeNull();
  });

  it('publishes directly when the gate passes', async () => {
    const { api } = card({
      gate: publishGateView({ passes: true, score: 0.95, iterationId: crypto.randomUUID() }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect(api.publish).toHaveBeenCalledWith('letter', undefined);
    expect(await screen.findByText('Published v2')).toBeInTheDocument();
  });

  it('places the threshold label under its tick and draws the tick without a score', () => {
    card();
    const label = screen.getByText('Threshold 90%');
    expect(label.style.left).toBe('66.67%');
    const holdout = screen.getByRole('img', { name: 'Holdout score: no score yet' });
    expect(holdout.querySelector('.meter-tick')).not.toBeNull();
  });

  it('encodes the project id in hint links', () => {
    card({
      projectId: 'a b',
      gate: { ...below, hints: [{ key: 'k', accuracy: 0, cause: 'no_step', stage: 'steps' }] },
    });
    expect(screen.getByRole('link', { name: 'Open Pipeline' })).toHaveAttribute(
      'href',
      '#/workbench/a%20b/steps',
    );
  });
});

describe('PublicationsLog', () => {
  it('lists publications, keeping old override reasons', () => {
    render(
      <PublicationsLog
        publications={[
          publication({ version: 2, score: 0.95 }),
          publication({ version: 1, score: 0.87, overrideReason: 'AP pilot needed it' }),
        ]}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Publications' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('v2');
    expect(items[0]).toHaveTextContent('95%');
    expect(items[1]).toHaveTextContent('override: AP pilot needed it');
  });

  it('renders nothing without publications', () => {
    const { container } = render(<PublicationsLog publications={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useGate', () => {
  it('asks for no gate without a draft', async () => {
    const api = fakeApi({ getProject: vi.fn(async () => projectView()) });
    const { result } = renderHook(() => useGate(api, 'letter', null, ''));
    await waitFor(() =>
      expect(result.current.threshold).toEqual({ value: 0.9, setBy: null, setAt: null }),
    );
    expect(api.getPublishGate).not.toHaveBeenCalled();
    expect(result.current.gate).toBeNull();
  });

  it('reloads when the refresh key changes', async () => {
    const api = fakeApi({ getProject: vi.fn(async () => projectView()) });
    const { rerender } = renderHook(({ k }) => useGate(api, 'letter', 2, k), {
      initialProps: { k: 'a' },
    });
    await waitFor(() => expect(api.getPublishGate).toHaveBeenCalledTimes(1));
    rerender({ k: 'b' });
    await waitFor(() => expect(api.getPublishGate).toHaveBeenCalledTimes(2));
  });

  it('ignores a slow response that a newer load has superseded', async () => {
    let release: (v: PublishGateView) => void = () => {};
    const slow = new Promise<PublishGateView>((r) => (release = r));
    const getPublishGate = vi
      .fn()
      .mockReturnValueOnce(slow)
      .mockResolvedValue(publishGateView({ reason: 'newer' }));
    const api = fakeApi({ getProject: vi.fn(async () => projectView()), getPublishGate });
    const { result, rerender } = renderHook(({ k }) => useGate(api, 'letter', 2, k), {
      initialProps: { k: 'a' },
    });
    rerender({ k: 'b' });
    await waitFor(() => expect(result.current.gate?.reason).toBe('newer'));
    await act(async () => release(publishGateView({ reason: 'stale' })));
    expect(result.current.gate?.reason).toBe('newer');
  });

  it('shows why a load failed', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      listPublications: vi.fn(async () => Promise.reject(new Error('store down'))),
    });
    const { result } = renderHook(() => useGate(api, 'letter', 2, ''));
    await waitFor(() => expect(result.current.error).toBe('store down'));
  });
});
