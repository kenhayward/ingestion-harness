import type { ComponentProps } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api/client.js';
import { ReviseFeedback } from '../src/workbench/ReviseFeedback.js';
import { fakeApi, feedbackItem, iterationView, revisePreview, sampleView } from './fake-api.js';

const definition = revisePreview().draft!.definition;

function list(
  props: Partial<ComponentProps<typeof ReviseFeedback>> = {},
  overrides: Partial<Api> = {},
) {
  const api = fakeApi({
    addFeedback: vi.fn(async () => feedbackItem()),
    deleteFeedback: vi.fn(async () => undefined),
    ...overrides,
  });
  const onChanged = vi.fn();
  render(
    <ReviseFeedback
      api={api}
      projectId="letter"
      items={[]}
      notSent={[]}
      samples={[]}
      iterations={[]}
      definition={definition}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { api, onChanged };
}

describe('ReviseFeedback', () => {
  it('numbers each item with its target, sample, body and origin', () => {
    const run = iterationView({ id: crypto.randomUUID(), templateVersion: 4 });
    const s = sampleView({ id: crypto.randomUUID(), filename: 'inv-0012-initech.pdf' });
    list({
      samples: [s],
      iterations: [run],
      items: [
        feedbackItem({
          targetId: 'total',
          sampleId: s.id,
          iterationId: run.id,
          body: 'Take TOTAL DUE',
        }),
        feedbackItem({ target: 'table', targetId: 'line_items', body: 'Rows split across pages' }),
      ],
    });
    const section = screen.getByRole('region', { name: /Your feedback/ });
    expect(
      within(section).getByRole('heading', { name: 'Your feedback 2 open' }),
    ).toBeInTheDocument();
    const [first, second] = within(section).getAllByRole('listitem');
    expect(first).toHaveTextContent('FIELD');
    expect(first).toHaveTextContent('total');
    expect(first).toHaveTextContent('inv-0012-initech.pdf');
    expect(first).toHaveTextContent('Take TOTAL DUE');
    expect(first).toHaveTextContent(
      `From Evaluate · dev run v4 · ${new Date(run.createdAt).toLocaleDateString()}`,
    );
    expect(second).toHaveTextContent('TABLE');
    expect(second).toHaveTextContent('Added here');
    expect(within(second!).getByRole('button', { name: 'Delete feedback 2' })).toBeEnabled();
  });

  it('lists feedback that is not sent apart, unnumbered, and still deletable', async () => {
    const sent = feedbackItem({ body: 'goes' });
    const held = feedbackItem({ body: 'stays home', targetId: 'total' });
    const { api } = list({ items: [sent], notSent: [held] });
    expect(screen.getByRole('heading', { name: 'Your feedback 1 open' })).toBeInTheDocument();
    const note = screen.getByRole('region', { name: 'Not sent' });
    expect(note).toHaveTextContent('sample is no longer a ready dev sample');
    expect(note).toHaveTextContent('stays home');
    await userEvent.click(
      within(note).getByRole('button', { name: 'Delete feedback not sent: total' }),
    );
    expect(api.deleteFeedback).toHaveBeenCalledWith('letter', held.id);
  });

  it('marks answered feedback and offers no Delete for it', () => {
    list({ items: [feedbackItem({ body: 'Done', resolvedBy: crypto.randomUUID() })] });
    const item = screen.getByRole('listitem');
    expect(within(item).getByText('ANSWERED')).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Your feedback 0 open' })).toBeInTheDocument();
  });

  it('deletes open feedback', async () => {
    const f = feedbackItem();
    const { api, onChanged } = list({ items: [f] });
    await userEvent.click(screen.getByRole('button', { name: 'Delete feedback 1' }));
    expect(api.deleteFeedback).toHaveBeenCalledWith('letter', f.id);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('fills the id list from the draft for the chosen target', async () => {
    list();
    const about = screen.getByRole('group', { name: 'Add feedback about' });
    expect(within(about).getByRole('button', { name: 'Field' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const id = screen.getByRole('combobox', { name: 'Id' });
    expect(
      within(id)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['sender', 'total']);
    await userEvent.click(within(about).getByRole('button', { name: 'Table' }));
    expect(
      within(id)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['line_items']);
    await userEvent.click(within(about).getByRole('button', { name: 'Section' }));
    expect(
      within(id)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['all']);
  });

  it('adds feedback with only a target, an id and the text: never a sample or a run (RV3)', async () => {
    const { api, onChanged } = list();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Id' }), 'total');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Feedback' }),
      'Take the TOTAL DUE line',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(api.addFeedback).toHaveBeenCalledWith('letter', {
      target: 'field',
      targetId: 'total',
      body: 'Take the TOTAL DUE line',
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: 'Feedback' })).toHaveValue('');
  });

  it('says why Add is disabled', async () => {
    list({ definition: { outputs: { fields: [{ id: 'total' }], tables: [] } } });
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', 'Write the feedback first');
    await userEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByRole('combobox', { name: 'Id' })).toBeDisabled();
    expect(add).toHaveAttribute('title', 'The draft has no tables yet');
  });

  it('caps the text at what the API accepts and shows a refusal', async () => {
    list({}, { addFeedback: vi.fn(async () => Promise.reject(new Error('nope'))) });
    expect(screen.getByRole('textbox', { name: 'Feedback' })).toHaveAttribute('maxlength', '2000');
    await userEvent.type(screen.getByRole('textbox', { name: 'Feedback' }), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});
