import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * A dropdown or menu anchored to its trigger: closes on a click outside it, and on Escape, which
 * goes no further (an enclosing dialog stays open) and puts focus back on the trigger.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close();
    }
  };

  return { open, setOpen, close, box, trigger, onKeyDown };
}

/** ↑/↓ between the items matching `selector` inside `container`, from wherever focus is. */
export function moveFocus(e: KeyboardEvent, container: HTMLElement | null, selector: string) {
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (!step || !container) return;
  const items = [...container.querySelectorAll<HTMLElement>(selector)];
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = at === -1 ? (step > 0 ? 0 : items.length - 1) : at + step;
  items[(next + items.length) % items.length]!.focus();
}
