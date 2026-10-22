/** How the Review page splits the document and the extracted data, remembered per browser. */
export interface ReviewLayout {
  /** The document's share of the width, in percent. */
  docWidth: number;
  /** A panel folded to a rail at its side, or none. */
  hidden: 'doc' | 'data' | null;
  /** Which side the document sits on. */
  docSide: 'left' | 'right';
}

export const DEFAULT_LAYOUT: ReviewLayout = { docWidth: 45, hidden: null, docSide: 'left' };
export const MIN_DOC_WIDTH = 20;
export const MAX_DOC_WIDTH = 80;
/** The document widths offered as buttons beside the divider (the data takes the rest). */
export const DOC_WIDTH_PRESETS = [30, 40, 50] as const;
/** How far one arrow key moves the divider. */
export const DOC_WIDTH_STEP = 5;

const KEY = 'ih.reviewLayout';

export const clampWidth = (n: number) =>
  Math.round(Math.min(MAX_DOC_WIDTH, Math.max(MIN_DOC_WIDTH, n)));

/** The stored layout, or the default; anything unreadable falls back field by field. */
export function loadLayout(): ReviewLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ReviewLayout> | null;
    if (!raw || typeof raw !== 'object') return DEFAULT_LAYOUT;
    return {
      docWidth:
        typeof raw.docWidth === 'number' && Number.isFinite(raw.docWidth)
          ? clampWidth(raw.docWidth)
          : DEFAULT_LAYOUT.docWidth,
      hidden: raw.hidden === 'doc' || raw.hidden === 'data' ? raw.hidden : null,
      docSide: raw.docSide === 'right' ? 'right' : 'left',
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(layout: ReviewLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // storage unavailable (private mode etc.): the layout just isn't remembered
  }
}

/**
 * A long table name and the reference it ends with, shown on two lines:
 * "Test Parameters (Table IX)" → "Test Parameters" and "Table IX". Names without one stay whole.
 */
export function splitName(name: string): { title: string; ref: string | null } {
  const m = /^(.+?)\s*\(([^()]+)\)$/.exec(name.trim());
  return m ? { title: m[1]!, ref: m[2]! } : { title: name, ref: null };
}
