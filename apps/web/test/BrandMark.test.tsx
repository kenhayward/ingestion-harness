import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandMark, brandGeometry } from '../src/ui/BrandMark.js';

describe('brandGeometry', () => {
  it.each([
    [16, 'tiny'],
    [23, 'tiny'],
    [24, 'small'],
    [30, 'small'],
    [52, 'small'],
    [63, 'small'],
    [64, 'full'],
    [256, 'full'],
  ] as const)('uses the %i px geometry: %s', (size, geometry) => {
    expect(brandGeometry(size)).toBe(geometry);
  });
});

describe('BrandMark', () => {
  it('is decorative by default and sized in pixels', () => {
    const { container } = render(<BrandMark size={30} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '30');
    expect(svg).toHaveAttribute('height', '30');
    expect(svg).toHaveAttribute('viewBox', '0 0 64 64');
    expect(svg).toHaveAttribute('data-geometry', 'small');
  });

  it('colours the tile and glyph from the theme tokens', () => {
    const { container } = render(<BrandMark size={30} />);
    expect(container.querySelector('rect')!.style.fill).toBe('var(--ih-accent)');
    expect(container.querySelector('g')!.style.stroke).toBe('var(--ih-accent-text)');
  });

  it.each([
    [64, 'full', 15, 2],
    [30, 'small', 14, 2],
    [52, 'small', 15, 2],
    [16, 'tiny', 12, 2],
  ] as const)('draws the %i px mark with the %s geometry', (size, geometry, rx, paths) => {
    const { container } = render(<BrandMark size={size} />);
    expect(container.querySelector('svg')).toHaveAttribute('data-geometry', geometry);
    expect(container.querySelector('rect')).toHaveAttribute('rx', String(rx));
    expect(container.querySelectorAll('path')).toHaveLength(paths);
  });

  it('draws three data cells only in the full geometry', () => {
    const cells = (size: number) =>
      render(<BrandMark size={size} />)
        .container.querySelectorAll('path')[1]!
        .getAttribute('d');
    expect(cells(64)).toBe('M26 26h5v5h-5zM34 26h5v5h-5zM26 34h5v5h-5z');
    expect(cells(30)).toBe('M28 28h8v8h-8z');
  });

  it('becomes an image with a name when given a label', () => {
    const { getByRole } = render(<BrandMark size={64} label="CT Studio" />);
    expect(getByRole('img', { name: 'CT Studio' })).toBeInTheDocument();
  });
});
