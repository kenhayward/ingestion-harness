import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Plain node:path: the jsdom test environment's global URL does not resolve ../ against file URLs.
const web = (path: string) => resolve(dirname(fileURLToPath(import.meta.url)), '..', path);
const html = readFileSync(web('public/widget.html'), 'utf8');
const nginx = readFileSync(web('../../deploy/docker/nginx.conf'), 'utf8');

/**
 * The page a dashboard that copies a page onto its own site (3DEXPERIENCE) is given (ADR 0012):
 * it never changes between builds and only frames the app, which then runs on its own origin.
 */
describe('widget.html', () => {
  it('frames the app at its root, once', () => {
    expect(html.match(/<iframe\b/g)).toHaveLength(1);
    expect(html.match(/src="\/"/g)).toHaveLength(1);
    expect(html).toMatch(/<iframe[^>]*\ssrc="\/"/);
  });

  it('loads nothing else: no scripts, stylesheets or build assets that a deploy could rename', () => {
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/assets\//);
  });

  it('is rewritten by nginx to frame the absolute origin, revalidated on every load', () => {
    const block = nginx.match(/location = \/widget\.html \{([^}]*)\}/)?.[1] ?? '';
    expect(block).toContain(`sub_filter 'src="/"' 'src="$forwarded_proto://$http_host/"';`);
    expect(block).toContain('add_header Cache-Control "no-cache";');
    expect(block).toContain('include /etc/nginx/snippets/security-headers.conf;');
  });
});
