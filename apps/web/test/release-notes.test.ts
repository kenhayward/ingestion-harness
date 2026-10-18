import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  noteBody,
  noteDateLabel,
  noteFromPath,
  RELEASE_NOTES,
  releaseNotesFrom,
} from '../src/about/releaseNotes.js';

// Plain node:path: the jsdom test environment's global URL does not resolve ../ against file URLs.
const notesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/release-notes');

const load = (text: string) => () => Promise.resolve(text);

describe('noteFromPath', () => {
  it.each([
    ['../docs/release-notes/Release-Notes-20261018.html', '2026-10-18', 1],
    ['Release-Notes-20261018-2.html', '2026-10-18-2', 2],
    ['/x/Release-Notes-20270101.html', '2027-01-01', 1],
  ])('reads %s', (path, id, seq) => {
    expect(noteFromPath(path)).toEqual({ id, date: id.slice(0, 10), seq });
  });

  it.each([
    'Release-Notes-2026-10-18.html',
    'Release-Notes-20261018.md',
    'release-notes-20261018.html',
    'Release-Notes-20261318.html',
    'Release-Notes-20260230.html',
    'Release-Notes-20261018-1.html',
    'Release-Notes-20261018-x.html',
  ])('ignores %s', (path) => {
    expect(noteFromPath(path)).toBeNull();
  });
});

describe('releaseNotesFrom', () => {
  it('lists the notes latest first, a second note of a day before the first', () => {
    const notes = releaseNotesFrom({
      'a/Release-Notes-20261001.html': load('one'),
      'a/Release-Notes-20261018.html': load('two'),
      'a/Release-Notes-20261018-2.html': load('three'),
      'a/notes.txt': load('ignored'),
      'a/Release-Notes-20260901.html': load('four'),
    });
    expect(notes.map((n) => n.id)).toEqual([
      '2026-10-18-2',
      '2026-10-18',
      '2026-10-01',
      '2026-09-01',
    ]);
  });

  it('loads a note when asked', async () => {
    const [note] = releaseNotesFrom({ 'Release-Notes-20261018.html': load('<main>hi</main>') });
    await expect(note!.load()).resolves.toBe('<main>hi</main>');
  });
});

describe('noteDateLabel', () => {
  it('names the day, and a second note of a day', () => {
    expect(noteDateLabel({ date: '2026-10-18', seq: 1 })).toBe('18 October 2026');
    expect(noteDateLabel({ date: '2026-10-18', seq: 2 })).toBe('18 October 2026 (2)');
  });
});

describe('noteBody', () => {
  const page = `<!doctype html><html><head><title>T</title>
    <style>body { background: black }</style>
    <link rel="stylesheet" href="x.css"></head>
    <body><header>not this</header><main>
      <style>.x { color: red }</style>
      <nav class="toc" id="contents"><a href="#major">Major</a></nav>
      <h2 id="major" onclick="alert(1)">Major</h2>
      <p>See <a href="https://github.com/x/y/pull/1">#1</a> and
        <a href="javascript:alert(1)">this</a>.</p>
      <script>alert(1)</script>
      <iframe src="https://example.com"></iframe>
    </main></body></html>`;

  const body = () => {
    const div = document.createElement('div');
    div.innerHTML = noteBody(page);
    return div;
  };

  it('keeps only what is inside <main>', () => {
    const div = body();
    expect(div.textContent).not.toContain('not this');
    expect(div.querySelector('h2')).toHaveTextContent('Major');
  });

  it('drops styles, scripts, frames and event handlers', () => {
    const div = body();
    expect(div.querySelector('style, script, link, iframe')).toBeNull();
    expect(div.querySelector('[onclick]')).toBeNull();
    expect(div.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('prefixes ids and the links to them, so they cannot clash with the app', () => {
    const div = body();
    expect(div.querySelector('h2')).toHaveAttribute('id', 'rn-major');
    expect(div.querySelector('nav')).toHaveAttribute('id', 'rn-contents');
    expect(div.querySelector('nav a')).toHaveAttribute('href', '#rn-major');
  });

  it('opens other links in a new tab', () => {
    const link = body().querySelector('a[href^="https:"]')!;
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
  });

  it('takes the body when a note has no <main>', () => {
    const div = document.createElement('div');
    div.innerHTML = noteBody('<html><body><p>Just this</p></body></html>');
    expect(div).toHaveTextContent('Just this');
  });
});

describe('the release notes in docs/release-notes', () => {
  const files = readdirSync(notesDir);

  it('are all named Release-Notes-YYYYMMDD[-N].html', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(noteFromPath(file), file).not.toBeNull();
  });

  it('each hold a <main>, and every link within a note has its target', () => {
    for (const file of files) {
      const doc = new DOMParser().parseFromString(
        readFileSync(resolve(notesDir, file), 'utf8'),
        'text/html',
      );
      const main = doc.querySelector('main');
      expect(main, file).not.toBeNull();
      for (const a of main!.querySelectorAll('a[href^="#"]')) {
        const id = a.getAttribute('href')!.slice(1);
        expect(doc.getElementById(id), `${file}: ${id}`).not.toBeNull();
      }
    }
  });

  it('are what the app lists, latest first', () => {
    expect(RELEASE_NOTES.map((n) => n.id)).toEqual(
      files
        .map((f) => noteFromPath(f)!)
        .sort((a, b) => b.date.localeCompare(a.date) || b.seq - a.seq)
        .map((n) => n.id),
    );
    expect(RELEASE_NOTES.map((n) => n.id)).toContain('2026-10-18');
  });
});
