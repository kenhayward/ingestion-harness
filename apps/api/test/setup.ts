import { afterEach, expect } from 'vitest';
import { takeViolations } from './openapi-conformance.js';

// Responses of documented routes must match their docs (test/openapi-conformance.ts).
afterEach(() => {
  expect(takeViolations(), 'responses that do not match the API docs').toEqual([]);
});
