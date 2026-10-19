import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  BridgeErrorSchema,
  BridgeEventSchema,
  CreateDeliveriesRequestSchema,
  DeliveryViewSchema,
  PackageSchema,
  SinkDescribeSchema,
} from '../src/index.js';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

/** The shared fixtures both sides of the contract parse (the worker reads them too). */
describe('contract fixtures', () => {
  it.each<[string, z.ZodType]>([
    ['describe.json', SinkDescribeSchema],
    ['package-document.json', PackageSchema],
    ['package-graph.json', PackageSchema],
    ['delivery-request.json', CreateDeliveriesRequestSchema],
    ['delivery-view.json', DeliveryViewSchema],
    ['event.json', BridgeEventSchema],
    ['error.json', BridgeErrorSchema],
  ])('%s parses unchanged', (file, schema) => {
    const json: unknown = JSON.parse(readFileSync(fixture(file), 'utf8'));
    expect(schema.parse(json)).toEqual(json);
  });
});
