import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.js';

/**
 * *More actions → Delete draft* with its inline confirm (UI handoff §5). Deleting is
 * irreversible: the confirm opens on Keep, so a stray Enter keeps the draft; Keep and Escape
 * return focus to More actions.
 */
export function DraftMenu({ version, onDelete }: { version: number; onDelete: () => void }) {
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [returnFocus, setReturnFocus] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);

  // The menu closes on a click anywhere else (like the job row menus).
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menu]);

  useEffect(() => {
    if (confirming) keepButton.current?.focus();
    else if (returnFocus) {
      more.current?.focus();
      setReturnFocus(false);
    }
  }, [confirming, returnFocus]);

  return (
    <>
      <div
        className="menu-anchor"
        ref={anchor}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && menu) {
            setMenu(false);
            more.current?.focus();
          }
        }}
      >
        <button
          ref={more}
          type="button"
          className="icon bordered"
          aria-label="More actions"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <Icon name="more" />
        </button>
        {menu && (
          <div className="menu menu-down" role="group" aria-label="More actions">
            <button
              type="button"
              className="danger"
              onClick={() => {
                setMenu(false);
                setConfirming(true);
              }}
            >
              Delete draft
            </button>
          </div>
        )}
      </div>
      {confirming && (
        <div className="inline-confirm delete-confirm" role="group" aria-label="Confirm delete">
          <span>Delete draft v{version}? This cannot be undone.</span>
          <button
            type="button"
            className="danger-fill"
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
          >
            Delete draft v{version}
          </button>
          <button
            ref={keepButton}
            type="button"
            onClick={() => {
              setConfirming(false);
              setReturnFocus(true);
            }}
          >
            Keep
          </button>
        </div>
      )}
    </>
  );
}
