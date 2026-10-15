import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal's focus: the first control takes focus on open, Tab stays inside, and focus goes back
 * to whatever had it on close. Returns the Tab handler for the modal's `onKeyDown`.
 */
export function useModalFocus(box: RefObject<HTMLElement | null>): (e: KeyboardEvent) => void {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => opener?.focus();
  }, [box]);

  return (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

/**
 * Modal dialog: labelled by its title, takes focus on open, keeps Tab inside, closes on Escape,
 * Cancel or a click on the backdrop, and gives focus back to whatever had it before.
 * With an `icon` or a `description` it is the richer layout (New project): an icon tile beside
 * the title, the description under it, and the actions in a strip along the bottom.
 */
export function Dialog({
  title,
  onClose,
  children,
  actions,
  icon,
  description,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** The primary action(s), beside Cancel (a submit button can target a form by `form`). */
  actions?: ReactNode;
  /** Shown in a tile left of the title (decorative). */
  icon?: ReactNode;
  /** Under the title; it describes the dialog to assistive technology. */
  description?: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const rich = icon !== undefined || description !== undefined;
  const box = useRef<HTMLDivElement>(null);
  const trapTab = useModalFocus(box);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    trapTab(e);
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className={rich ? 'dialog dialog-rich' : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        onKeyDown={onKeyDown}
      >
        {rich ? (
          <>
            <div className="dialog-header">
              {icon !== undefined && (
                <span className="dialog-icon" aria-hidden="true">
                  {icon}
                </span>
              )}
              <div>
                <h2 id={titleId}>{title}</h2>
                {description !== undefined && (
                  <p id={descriptionId} className="dialog-description">
                    {description}
                  </p>
                )}
              </div>
            </div>
            <div className="dialog-body">{children}</div>
          </>
        ) : (
          <>
            <h2 id={titleId}>{title}</h2>
            {children}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          {actions}
        </div>
      </div>
    </div>
  );
}
