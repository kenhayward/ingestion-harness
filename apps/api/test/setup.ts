import { afterEach, expect } from 'vitest';
import { setScryptCost } from '../src/access/passwords.js';
import { takeViolations } from './openapi-conformance.js';

// Cheap password hashing: the real cost made signing in a third of the API suite's time.
// passwords.test.ts checks the real cost.
setScryptCost(1024);

// Responses of documented routes must match their docs (test/openapi-conformance.ts).
afterEach(() => {
  expect(takeViolations(), 'responses that do not match the API docs').toEqual([]);
});
