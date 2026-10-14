import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RETIRED_REASON, retiredLine, retiredNote, unretireHint } from '../src/ui/retired.js';
import { RetiredBanner } from '../src/ui/RetiredBanner.js';

const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };

describe('retired helpers', () => {
  it('says who retired it and when', () => {
    expect(retiredLine(retirement)).toBe('Retired by ken on 14 Oct 2026');
    expect(retiredLine({ ...retirement, retiredBy: null })).toBe('Retired on 14 Oct 2026');
  });
  it('gives one reason for every disabled action', () => {
    expect(RETIRED_REASON).toBe(
      'This document type is retired: an admin can unretire it through the API',
    );
  });
  it('names the route an admin unretires with (API only, D14)', () => {
    expect(unretireHint('letter')).toBe(
      'An admin can unretire it through the API: DELETE /api/specs/letter/retirement.',
    );
    expect(retiredNote(retirement, 'letter')).toBe(
      'Retired by ken on 14 Oct 2026. An admin can unretire it through the API: DELETE /api/specs/letter/retirement.',
    );
  });
});

describe('RetiredBanner', () => {
  it('explains what retired means and how an admin brings it back, with no button', () => {
    render(<RetiredBanner retirement={retirement} typeId="letter" />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Retired by ken on 14 Oct 2026');
    expect(note).toHaveTextContent(/Nothing new runs for it/);
    expect(note).toHaveTextContent('DELETE /api/specs/letter/retirement');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
