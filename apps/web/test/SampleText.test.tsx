import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SampleText, type TextMark } from '../src/workbench/SampleText.js';
import { fakeApi } from './fake-api.js';

function show(text: string, marks: TextMark[]) {
  const api = fakeApi({
    getSampleText: vi.fn(async () => ({
      sha256: 'abc',
      pages: [{ number: 1, text, ocr: false }],
    })),
  });
  render(<SampleText api={api} projectId="letter" sampleId="s1" marks={marks} />);
}

describe('SampleText marks', () => {
  it('prefers an exact line match over an earlier line that merely starts with the mark', async () => {
    show('TOTALS carried\nbody\nTOTAL\nend', [{ page: 1, line: 'TOTAL', label: 'total' }]);
    const note = await screen.findByRole('note', { name: 'total starts here' });
    expect(note.parentElement).toHaveTextContent('TOTAL');
    expect(note.parentElement).not.toHaveTextContent('TOTALS');
  });

  it('falls back to a prefix match when no line equals the mark', async () => {
    show('intro\nTOTALS carried\nend', [{ page: 1, line: 'TOTAL', label: 'total' }]);
    const note = await screen.findByRole('note', { name: 'total starts here' });
    expect(note.parentElement).toHaveTextContent('TOTALS carried');
  });

  it('ignores a mark with an empty line', async () => {
    show('intro\n\nbody', [{ page: 1, line: '', label: 'blank' }]);
    await screen.findByText(/intro/);
    expect(screen.queryByRole('note')).toBeNull();
  });
});
