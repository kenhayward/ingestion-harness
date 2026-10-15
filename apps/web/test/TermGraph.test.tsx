import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Neighbourhood } from '@ih/shared';
import type { GraphRenderer } from '../src/ontologies/graphRenderer.js';
import { TermGraph } from '../src/ontologies/TermGraph.js';
import { fakeApi } from './fake-api.js';

const C = 'https://x.org/#';
const data: Neighbourhood = {
  nodes: [
    { iri: C + 'Batch', label: 'Batch', kind: 'class', focus: true },
    { iri: C + 'Thing', label: 'Thing', kind: 'class', focus: false },
    { iri: 'https://o.org/Item', label: 'Item', kind: 'external', focus: false },
  ],
  edges: [
    { source: C + 'Batch', target: C + 'Thing', kind: 'subClassOf' },
    { source: C + 'Batch', target: 'https://o.org/Item', kind: 'subClassOf' },
  ],
  truncated: true,
};

describe('TermGraph', () => {
  it('draws the neighbourhood and lists it for keyboard users', async () => {
    const cleanup = vi.fn();
    const renderer = vi.fn<GraphRenderer>(() => cleanup);
    const api = fakeApi({ getNeighbourhood: vi.fn(async () => data) });
    const onSelect = vi.fn();
    const { unmount } = render(
      <TermGraph
        api={api}
        ontologyId="pv"
        version={1}
        iri={C + 'Batch'}
        onSelect={onSelect}
        renderer={renderer}
      />,
    );
    await waitFor(() =>
      expect(renderer).toHaveBeenCalledWith(expect.any(HTMLElement), data, onSelect),
    );
    expect(api.getNeighbourhood).toHaveBeenCalledWith('pv', 1, C + 'Batch', 1);
    expect(screen.getByText(/Showing the first 3 terms/)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Links' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('Batch is a subclass of Thing');
    // A term outside the version is named, not linked.
    expect(within(second!).queryByRole('button', { name: 'Item' })).not.toBeInTheDocument();
    await userEvent.click(within(first!).getByRole('button', { name: 'Thing' }));
    expect(onSelect).toHaveBeenCalledWith(C + 'Thing');
    unmount();
    expect(cleanup).toHaveBeenCalled();
  });

  it('goes two hops on request', async () => {
    const api = fakeApi({ getNeighbourhood: vi.fn(async () => data) });
    render(
      <TermGraph
        api={api}
        ontologyId="pv"
        version={1}
        iri={C + 'Batch'}
        onSelect={vi.fn()}
        renderer={() => () => {}}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: '2 hops' }));
    await waitFor(() =>
      expect(api.getNeighbourhood).toHaveBeenLastCalledWith('pv', 1, C + 'Batch', 2),
    );
  });

  it('shows the error when the neighbourhood cannot be read', async () => {
    const api = fakeApi({
      getNeighbourhood: vi.fn(async () => {
        throw new Error('version not found');
      }),
    });
    render(
      <TermGraph
        api={api}
        ontologyId="pv"
        version={1}
        iri={C + 'Batch'}
        onSelect={vi.fn()}
        renderer={() => () => {}}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('version not found');
  });
});
