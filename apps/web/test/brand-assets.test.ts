import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Plain node:path: the jsdom test environment's global URL does not resolve ../ against file URLs.
const web = (path: string) => resolve(dirname(fileURLToPath(import.meta.url)), '..', path);

describe('brand assets', () => {
  it.each([
    'favicon.ico',
    'favicon.svg',
    'apple-touch-icon.png',
    'icon-192.png',
    'icon-512.png',
    'icon-maskable-512.png',
    'site.webmanifest',
  ])('ships public/%s', (file) => {
    expect(existsSync(web(`public/${file}`))).toBe(true);
  });

  it('names the app in the web manifest', () => {
    const manifest = JSON.parse(readFileSync(web('public/site.webmanifest'), 'utf8')) as {
      name: string;
      short_name: string;
      icons: { src: string }[];
    };
    expect(manifest.name).toBe('Content Transformation Studio');
    expect(manifest.short_name).toBe('CT Studio');
    for (const icon of manifest.icons) expect(existsSync(web(`public${icon.src}`))).toBe(true);
  });

  it('links the icons and manifest from index.html', () => {
    const html = readFileSync(web('index.html'), 'utf8');
    expect(html).toContain('<title>CT Studio</title>');
    expect(html).not.toContain('Ingestion Harness');
    for (const href of [
      '/favicon.ico',
      '/favicon.svg',
      '/apple-touch-icon.png',
      '/site.webmanifest',
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});
