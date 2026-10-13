/** The CT Studio mark (docs/brand/BRAND.md): an open C holding data cells, on the accent tile. */
export type BrandGeometry = 'full' | 'small' | 'tiny';

/** Each size has its own drawing; the large one is never scaled down. */
export function brandGeometry(size: number): BrandGeometry {
  if (size >= 64) return 'full';
  if (size >= 24) return 'small';
  return 'tiny';
}

const SMALL_ARC = 'M46 17A21 21 0 1 0 46 47';
const ONE_CELL = 'M28 28h8v8h-8z';

const SHAPES: Record<
  BrandGeometry,
  { arc: string; arcWidth: number; cells: string; cellWidth: number }
> = {
  full: {
    arc: 'M45.4 18.6A19 19 0 1 0 45.4 45.4',
    arcWidth: 5.5,
    cells: 'M26 26h5v5h-5zM34 26h5v5h-5zM26 34h5v5h-5z',
    cellWidth: 2.6,
  },
  small: { arc: SMALL_ARC, arcWidth: 7, cells: ONE_CELL, cellWidth: 4 },
  // BRAND.md gives the tiny mark only inside favicon.ico: the small drawing, heavier strokes.
  tiny: { arc: SMALL_ARC, arcWidth: 8, cells: ONE_CELL, cellWidth: 5 },
};

/** Corner radius in viewBox units: 15, 14 at 32 px and below, 12 at 16 px. */
function radius(geometry: BrandGeometry, size: number): number {
  if (geometry === 'tiny') return 12;
  if (geometry === 'small' && size <= 32) return 14;
  return 15;
}

export function BrandMark({
  size,
  label,
  className,
}: {
  size: number;
  /** Omit for a decorative mark next to the name (the default). */
  label?: string;
  className?: string;
}) {
  const geometry = brandGeometry(size);
  const shape = SHAPES[geometry];
  const a11y = label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label };
  return (
    <svg
      className={className === undefined ? 'brand-mark' : `brand-mark ${className}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      focusable="false"
      data-geometry={geometry}
      {...a11y}
    >
      {/* Tokens via style: CSS variables do not resolve in SVG presentation attributes. */}
      <rect
        width="64"
        height="64"
        rx={radius(geometry, size)}
        style={{ fill: 'var(--ih-accent)' }}
      />
      <g
        style={{ stroke: 'var(--ih-accent-text)' }}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={shape.arc} strokeWidth={shape.arcWidth} />
        <path d={shape.cells} strokeWidth={shape.cellWidth} />
      </g>
    </svg>
  );
}
