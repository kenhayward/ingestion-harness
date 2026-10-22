import { useEffect, useRef, useState } from 'react';
import { rowsThatFit } from './derive.js';

/** A row's height when none is drawn yet to measure (matches `.job-list td` in styles.css). */
const ROW_HEIGHT = 36;

/**
 * How many rows the box holds: its height over a drawn row's height, again whenever it
 * resizes (the window, the clean-up controls opening under it). `fallback` until it is
 * measured, and where it cannot be (no layout: tests).
 */
export function usePageSize<T extends HTMLElement>(fallback: number) {
  const box = useRef<T>(null);
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      if (el.clientHeight <= 0) return;
      const row = el.querySelector<HTMLElement>('tbody tr')?.offsetHeight || ROW_HEIGHT;
      setSize(rowsThatFit(el.clientHeight, row));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);
  return { box, size };
}
