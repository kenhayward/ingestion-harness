import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout: CodeMirror (YAML editor) measures text ranges after edits.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => {
  cleanup();
  // Remembered selections must not leak between tests.
  localStorage.clear();
  sessionStorage.clear();
});
