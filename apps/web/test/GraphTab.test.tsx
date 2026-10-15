import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ShaclReport } from '@ih/shared';
import { GraphTab } from '../src/review/GraphTab.js';
import { fakeApi } from './fake-api.js';

const report: ShaclReport = {
  conforms: false,
  results: [
    {
      severity: 'Violation',
      shape: 'https://acme.example/def/LetterShape',
      focus: 'https://data.acme.example/doc/ab',
      path: 'https://acme.example/def/sentBy',
      output: 'sender',
      message: 'a letter names its sender',
      value: '',
    },
    {
      severity: 'Warning',
      shape: 'https://acme.example/def/LineShape',
      focus: 'https://data.acme.example/doc/ab/letter/lines/1',
      path: 'https://acme.example/def/qty',
      output: 'lines.qty',
      message: 'quantities are small',
      value: '900',
    },
  ],
};

describe('the Review Graph tab (ADR 0011 step 5)', () => {
  it('shows the Turtle and the SHACL results, each opening the output it names', async () => {
    const onOpen = vi.fn();
    const api = fakeApi({
      getOutputText: vi.fn(async () => '<a> <b> <c> .'),
      getShaclReport: vi.fn(async () => report),
    });
    render(<GraphTab api={api} jobId="j1" onOpenOutput={onOpen} />);
    expect(await screen.findByText('<a> <b> <c> .')).toBeInTheDocument();
    expect(api.getOutputText).toHaveBeenCalledWith('j1', 'graph', 'draft');
    const results = screen.getByRole('list', { name: 'SHACL results' });
    expect(within(results).getAllByRole('listitem')).toHaveLength(2);
    expect(results).toHaveTextContent('Violation');
    expect(results).toHaveTextContent('a letter names its sender');
    await userEvent.click(within(results).getByRole('button', { name: 'Show sender' }));
    expect(onOpen).toHaveBeenCalledWith('sender');
    await userEvent.click(within(results).getByRole('button', { name: 'Show lines.qty' }));
    expect(onOpen).toHaveBeenCalledWith('lines.qty');
  });

  it('says when the graph conforms, and when the recipe pins no shapes', async () => {
    const conforms = fakeApi({
      getOutputText: vi.fn(async () => ''),
      getShaclReport: vi.fn(async () => ({ conforms: true, results: [] })),
    });
    const { unmount } = render(<GraphTab api={conforms} jobId="j1" onOpenOutput={vi.fn()} />);
    expect(await screen.findByText('The graph conforms to the shapes.')).toBeInTheDocument();
    unmount();
    const none = fakeApi({
      getOutputText: vi.fn(async () => ''),
      getShaclReport: vi.fn(async () => null),
    });
    render(<GraphTab api={none} jobId="j1" onOpenOutput={vi.fn()} />);
    expect(await screen.findByText(/No SHACL report/)).toBeInTheDocument();
  });
});

describe('a result on a property no output publishes', () => {
  it('names the path and offers nothing to open', async () => {
    const api = fakeApi({
      getOutputText: vi.fn(async () => ''),
      getShaclReport: vi.fn(async () => ({
        conforms: false,
        results: [{ ...report.results[0]!, output: 'https://acme.example/def/signedBy' }],
      })),
    });
    render(<GraphTab api={api} jobId="j1" onOpenOutput={vi.fn()} />);
    const results = await screen.findByRole('list', { name: 'SHACL results' });
    expect(results).toHaveTextContent('https://acme.example/def/signedBy');
    expect(within(results).queryByRole('button')).toBeNull();
  });
});
