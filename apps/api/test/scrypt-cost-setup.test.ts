import { expect, it } from 'vitest';
import { hashPassword } from '../src/access/passwords.js';

// test/setup.ts hashes cheaply so signing in does not dominate the suite (passwords.test.ts
// keeps the real cost).
it('hashes passwords cheaply in the API tests', async () => {
  expect(await hashPassword('a long test phrase')).toMatch(/^scrypt\$1024\$8\$1\$/);
});
