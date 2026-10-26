import { useCallback, useEffect, useState } from 'react';
import { rowsThatFit } from './derive.js';

/** A row's height when none is drawn yet to measure (matches `.job-list td` in styles.css). */
const ROW_HEIGHT = 36;

/**
 * How many rows the box holds: its height over a drawn row's height, again whenever it
 * resizes (the window, the clean-up controls opening under it). `fallback` until it is
 * measured, and where it cannot be (no layout: tests). `rowSelector` picks the row to measure
 * (Results: a result, not a shorter day heading). `box` is a callback ref, so a box drawn only
 * later (the batch view's, once its batch has loaded) or drawn again is measured from then on.
 */
export function usePageSize<T extends HTMLElement>(fallback: number, rowSelector = 'tbody tr') {
  const [el, setEl] = useState<T | null>(null);
  const box = useCallback((node: T | null) => setEl(node), []);
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      if (el.clientHeight <= 0) return;
      const row = el.querySelector<HTMLElement>(rowSelector)?.offsetHeight || ROW_HEIGHT;
      setSize(rowsThatFit(el.clientHeight, row));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [el, rowSelector]);
  return { box, size };
}
