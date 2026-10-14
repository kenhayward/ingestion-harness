import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSourceFile, SOURCE_ACCEPT } from '../src/documents.js';
import { parseHash } from '../src/router.js';

// Plain node:path: the jsdom test environment's global URL does not resolve ../ against file URLs.
const web = (path: string) => resolve(dirname(fileURLToPath(import.meta.url)), '..', path);

type Image = { src: string; sizes: string; type: string; purpose?: string; form_factor?: string };
type Manifest = {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: string;
  start_url: string;
  scope: string;
  display: string;
  display_override: string[];
  theme_color: string;
  background_color: string;
  icons: Image[];
  shortcuts: { name: string; short_name?: string; url: string; icons: Image[] }[];
  file_handlers: { action: string; accept: Record<string, string[]>; launch_type?: string }[];
  launch_handler: { client_mode: string | string[] };
  screenshots: (Image & { label: string })[];
};

const manifest = JSON.parse(readFileSync(web('public/site.webmanifest'), 'utf8')) as Manifest;

/** Width × height from a PNG's IHDR chunk. */
function pngSize(path: string): string {
  const png = readFileSync(web(`public${path}`));
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

/** Every image a manifest entry names exists, is a PNG, and is the size it claims. */
function expectImages(images: readonly Image[]) {
  for (const image of images) {
    expect(image.type).toBe('image/png');
    expect(existsSync(web(`public${image.src}`)), image.src).toBe(true);
    expect(pngSize(image.src), image.src).toBe(image.sizes);
  }
}

describe('web manifest (installable app, docs/design/pwa.md)', () => {
  it('has what Edge and Chrome need to offer install', () => {
    // The id is the installed app's identity: changing it makes Windows see a new app.
    expect(manifest.id).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.lang).toBe('en');
    expect(manifest.description).not.toBe('');
    const sizes = manifest.icons.filter((i) => i.purpose !== 'maskable').map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('ships every icon at the size it claims, small ones for the Windows taskbar', () => {
    expectImages(manifest.icons);
    const sizes = manifest.icons.map((i) => i.sizes);
    for (const small of ['48x48', '64x64', '128x128', '256x256']) expect(sizes).toContain(small);
  });

  it('draws the header into the title bar, falling back to a plain window', () => {
    expect(manifest.display_override).toEqual(['window-controls-overlay', 'standalone']);
  });

  it('offers shortcuts that open the pages they name', () => {
    expect(manifest.shortcuts.map((s) => [s.name, s.url])).toEqual([
      ['Upload documents', '/#/upload'],
      ['Jobs', '/#/jobs'],
      ['Workbench', '/#/workbench'],
    ]);
    const routes = manifest.shortcuts.map((s) => parseHash(s.url.slice(1)));
    expect(routes).toEqual([
      { name: 'home', focusUpload: true },
      { name: 'jobs' },
      { name: 'workbench' },
    ]);
    for (const shortcut of manifest.shortcuts) expectImages(shortcut.icons);
  });

  it('opens exactly the files the upload strip takes (Open with in Explorer)', () => {
    expect(manifest.file_handlers).toHaveLength(1);
    const [handler] = manifest.file_handlers;
    expect(handler!.action).toBe('/');
    expect(handler!.launch_type).toBe('single-client');
    const accepted = Object.entries(handler!.accept).flatMap(([type, exts]) => [type, ...exts]);
    expect(new Set(accepted)).toEqual(new Set(SOURCE_ACCEPT.split(',')));
    for (const [type, exts] of Object.entries(handler!.accept)) {
      for (const ext of exts) expect(isSourceFile(new File([], `a${ext}`, { type }))).toBe(true);
    }
  });

  it('reuses the open window for files and shortcuts', () => {
    expect(manifest.launch_handler.client_mode).toEqual(['focus-existing', 'auto']);
  });

  it('has a wide and a narrow screenshot for the install dialog', () => {
    expectImages(manifest.screenshots);
    expect(manifest.screenshots.map((s) => s.form_factor)).toEqual(['wide', 'narrow']);
    for (const s of manifest.screenshots) expect(s.label).not.toBe('');
  });

  it('ships the offline page the service worker falls back to', () => {
    const html = readFileSync(web('public/offline.html'), 'utf8');
    expect(html).toContain('<title>Offline · CT Studio</title>');
    // Self-contained: the network is gone when it shows, so it may load nothing else.
    expect(html).not.toMatch(/<(link|script|img)\b[^>]*(href|src)=/);
    expect(html).toContain('prefers-color-scheme: dark');
  });
});
