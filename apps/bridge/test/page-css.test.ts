import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGE_CSS } from '../src/page/css.js';

const TOKENS = readFileSync(
  fileURLToPath(new URL('../../web/src/styles/tokens.css', import.meta.url)),
  'utf8',
);

/** Every `--ih-*` token, by the selector of the block it is declared in. */
function tokensOf(css: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const key = selector!
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .trim();
    for (const [, name, value] of body!.matchAll(/(--ih-[\w-]+):\s*([^;]+);/g)) {
      if (!out.has(key)) out.set(key, new Map());
      out.get(key)!.set(name!, value!.trim());
    }
  }
  return out;
}

describe('the connections page in CT Studio tokens', () => {
  it("keeps CT Studio's token values, block by block", () => {
    const app = tokensOf(TOKENS);
    const page = tokensOf(PAGE_CSS);
    let count = 0;
    for (const [selector, tokens] of page) {
      for (const [name, value] of tokens) {
        expect({ selector, name, value }).toEqual({
          selector,
          name,
          value: app.get(selector)?.get(name),
        });
        count++;
      }
    }
    expect(count).toBeGreaterThan(40);
    expect([...page.keys()].sort()).toEqual(
      [
        ':root',
        ":root, :root[data-theme='light']",
        ":root[data-theme='dark']",
        ':root:not([data-theme])',
      ].sort(),
    );
  });

  it('loads nothing from anywhere', () => {
    expect(PAGE_CSS).not.toContain('url(');
    expect(PAGE_CSS).not.toContain('@import');
  });
});
