import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders its children into a slot another component owns (the Administration dialog's header
 * holds each tab's main button), so the state behind them stays where it is used. Without a slot
 * (`undefined`) they render in place; while the slot is mounting (`null`), nowhere.
 */
export function InSlot({
  slot,
  children,
}: {
  slot: HTMLElement | null | undefined;
  children: ReactNode;
}) {
  if (slot === undefined) return <>{children}</>;
  return slot ? createPortal(children, slot) : null;
}
