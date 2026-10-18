/**
 * The release notes About shows: the hand-written `docs/release-notes/Release-Notes-YYYYMMDD.html`
 * files (a second note of a day `…YYYYMMDD-2.html`), bundled when the app is built. Each note is
 * dated by its file name, never by a version, and its text is its own chunk, loaded when shown.
 */

export type NoteDate = {
  /** `2026-10-18`, or `2026-10-18-2` for a day's second note: the note's address (`#/about/<id>`). */
  id: string;
  /** `2026-10-18`. */
  date: string;
  /** 1 for a day's first note, then 2, 3… */
  seq: number;
};

export type ReleaseNote = NoteDate & {
  /** The note's whole HTML file. */
  load: () => Promise<string>;
};

const FILE = /(?:^|\/)Release-Notes-(\d{4})(\d{2})(\d{2})(?:-([2-9]|[1-9]\d+))?\.html$/;

/** The note a file name names, or null when it is no release note (or no real date). */
export function noteFromPath(path: string): NoteDate | null {
  const m = FILE.exec(path);
  if (!m) return null;
  const [, y, mo, d, n] = m;
  const date = `${y}-${mo}-${d}`;
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) return null;
  return n ? { id: `${date}-${n}`, date, seq: Number(n) } : { id: date, date, seq: 1 };
}

/** The notes among these files, latest first (a day's later note before its earlier one). */
export function releaseNotesFrom(
  files: Record<string, () => Promise<string>>,
): readonly ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  for (const [path, load] of Object.entries(files)) {
    const note = noteFromPath(path);
    if (note) notes.push({ ...note, load });
  }
  return notes.sort((a, b) => b.date.localeCompare(a.date) || b.seq - a.seq);
}

/** Every release note in the repository, latest first. */
export const RELEASE_NOTES = releaseNotesFrom(
  import.meta.glob<string>('../../../../docs/release-notes/Release-Notes-*.html', {
    query: '?raw',
    import: 'default',
  }),
);

/** `18 October 2026`, and `18 October 2026 (2)` for a day's second note: as the notes write it. */
export function noteDateLabel({ date, seq }: Pick<NoteDate, 'date' | 'seq'>): string {
  const day = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return seq > 1 ? `${day} (${seq})` : day;
}

/** What a note's ids and its links to them are prefixed with, so they never clash with the app's. */
export const NOTE_ID_PREFIX = 'rn-';

const DROPPED = 'style, script, link, meta, iframe, frame, object, embed, base, form';

/**
 * The part of a note's file that About shows: what is inside `<main>` (else `<body>`), without its
 * styles (the app's theme styles it), scripts, frames or event handlers. Ids and the links to them
 * are prefixed (`rn-`); links elsewhere open in a new tab. The files are written by hand and
 * committed, so this tidies trusted HTML rather than sanitising untrusted input.
 */
export function noteBody(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.querySelector('main') ?? doc.body;
  for (const el of root.querySelectorAll(DROPPED)) el.remove();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const { name } of [...el.attributes]) {
      if (name.startsWith('on')) el.removeAttribute(name);
    }
    if (el.id) el.id = NOTE_ID_PREFIX + el.id;
  }
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')!.trim();
    if (href.startsWith('#')) {
      a.setAttribute('href', `#${NOTE_ID_PREFIX}${href.slice(1)}`);
    } else if (/^\s*javascript:/i.test(href)) {
      a.removeAttribute('href');
    } else {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    }
  }
  return root.innerHTML;
}
