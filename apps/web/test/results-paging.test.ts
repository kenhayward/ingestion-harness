import { describe, expect, it } from 'vitest';
import { layOutPage } from '../src/results/paging.js';

const r = (id: string, day: string) => ({ id, day });
const dayOf = (x: { day: string }) => x.day;
/** The lines as text: `#Day`, `#Day (continued)` or the row's id. */
const text = (lines: ReturnType<typeof layOutPage<{ id: string; day: string }>>['lines']) =>
  lines.map((l) => (l.kind === 'day' ? `#${l.day}${l.continued ? ' (continued)' : ''}` : l.row.id));

describe('layOutPage', () => {
  it('puts a heading before each day, counting it as a line', () => {
    const rows = [r('a', 'Today'), r('b', 'Today'), r('c', 'Yesterday'), r('d', 'Yesterday')];
    const page = layOutPage(rows, 10, dayOf, null);
    expect(text(page.lines)).toEqual(['#Today', 'a', 'b', '#Yesterday', 'c', 'd']);
    expect(page.shown).toBe(4);
  });

  it('stops when the lines run out, never ending on a heading', () => {
    const rows = [r('a', 'Today'), r('b', 'Today'), r('c', 'Yesterday'), r('d', 'Yesterday')];
    // 4 lines: #Today a b, then #Yesterday c would need 2 more.
    const page = layOutPage(rows, 4, dayOf, null);
    expect(text(page.lines)).toEqual(['#Today', 'a', 'b']);
    expect(page.shown).toBe(2);
  });

  it('marks the first heading continued when the page starts inside a day', () => {
    const page = layOutPage([r('c', 'Today'), r('d', 'Yesterday')], 10, dayOf, 'Today');
    expect(text(page.lines)).toEqual(['#Today (continued)', 'c', '#Yesterday', 'd']);
  });

  it('shows at least one row however few lines there are', () => {
    expect(layOutPage([r('a', 'Today')], 1, dayOf, null).shown).toBe(1);
  });

  it('shows nothing for no rows', () => {
    expect(layOutPage([], 10, dayOf, null)).toEqual({ lines: [], shown: 0 });
  });
});
