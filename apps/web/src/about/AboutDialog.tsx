import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { versionLink, type VersionInfo } from '@ih/shared';
import { versionText } from '../shell/NavVersion.js';
import { BrandMark } from '../ui/BrandMark.js';
import { useModalFocus } from '../ui/Dialog.js';
import { noteBody, noteDateLabel, RELEASE_NOTES, type ReleaseNote } from './releaseNotes.js';

/** A note's text: loading, shown, or failed to load. */
type Shown = { id: string; html: string | null; failed: boolean };

/**
 * About (the account menu, and the version at the bottom of the nav): Help's layout. The app mark,
 * this build's version and the release notes by date (latest first) on the left; the picked note
 * on the right, styled by the app's theme. Escape, a click outside or Close closes it. A link within
 * a note scrolls to its section here; it never changes the app's address.
 */
export function AboutDialog({
  notes = RELEASE_NOTES,
  note: initial,
  version,
  onClose,
}: {
  notes?: readonly ReleaseNote[];
  /** The note to open on (its id, `2026-10-18`); the latest otherwise. */
  note?: string;
  version: VersionInfo;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState(
    () => notes.find((n) => n.id === initial)?.id ?? notes[0]?.id ?? null,
  );
  const [shown, setShown] = useState<Shown | null>(null);
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const trapTab = useModalFocus(box);
  // On open, the open note's date takes the focus (not the GitHub link before it).
  const focusNext = useRef(true);
  const current = notes.find((n) => n.id === picked) ?? null;
  const github = versionLink(version);

  // Load the picked note; one picked meanwhile wins.
  useEffect(() => {
    if (!current) return;
    let live = true;
    current.load().then(
      (html) => live && setShown({ id: current.id, html: noteBody(html), failed: false }),
      () => live && setShown({ id: current.id, html: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [current]);

  // A new note starts at its top; one reached with the arrow keys takes the focus.
  useEffect(() => {
    body.current?.scrollTo?.({ top: 0 });
    if (!focusNext.current) return;
    focusNext.current = false;
    box.current?.querySelector<HTMLButtonElement>(`[data-note="${picked}"]`)?.focus();
  }, [picked]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step && notes.length > 0 && (e.target as HTMLElement).closest('.about-menu')) {
      e.preventDefault();
      const i = notes.findIndex((n) => n.id === picked);
      setPicked(notes[(i + step + notes.length) % notes.length]!.id);
      focusNext.current = true;
      return;
    }
    trapTab(e);
  };

  // The note's own contents links: scroll to the section within the dialog.
  const onNoteClick = (e: MouseEvent) => {
    const link = (e.target as Element).closest('a');
    const href = link?.getAttribute('href');
    if (!href?.startsWith('#')) return;
    e.preventDefault();
    const id = href.slice(1);
    const target = [...(body.current?.querySelectorAll('[id]') ?? [])].find((el) => el.id === id);
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const html = shown && shown.id === picked ? shown : null;

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className="dialog profile-dialog help-center about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <aside className="profile-side help-center-side">
          <div className="profile-id">
            <BrandMark size={64} />
            <span className="profile-who">
              <span>CT Studio</span>
              <small className="muted">{versionText(version)}</small>
              {github && (
                <a className="about-build" href={github} target="_blank" rel="noopener">
                  View this build on GitHub
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              )}
            </span>
          </div>
          <nav aria-label="Release notes" className="help-center-menu about-menu">
            <h3 className="about-menu-head">Release notes</h3>
            {notes.length === 0 ? (
              <p className="muted">No release notes yet.</p>
            ) : (
              <ul>
                {notes.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      data-note={n.id}
                      aria-current={n.id === picked ? 'page' : undefined}
                      onClick={() => setPicked(n.id)}
                    >
                      {noteDateLabel(n)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
        </aside>
        <section className="profile-main">
          <header className="profile-header">
            <h2 id={titleId}>About</h2>
            {current && <span className="muted">/ Release notes · {noteDateLabel(current)}</span>}
          </header>
          <div ref={body} className="profile-body help-center-body">
            {!current ? null : !html ? (
              <p className="muted">Loading…</p>
            ) : html.failed ? (
              <p role="alert">This release note could not be loaded.</p>
            ) : (
              // A committed release note, tidied by noteBody (styles, scripts and handlers removed).
              <div
                className="release-note"
                onClick={onNoteClick}
                dangerouslySetInnerHTML={{ __html: html.html! }}
              />
            )}
          </div>
          <footer className="profile-footer">
            <button type="button" onClick={onClose}>
              Close
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
