import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BridgeErrorSchema,
  BridgeEventSchema,
  ConnectionSummarySchema,
  CreateDeliveriesRequestSchema,
  DeliveryViewSchema,
  PackageSchema,
  SinkDescribeSchema,
  TargetTestResultSchema,
  UsersReconcileRequestSchema,
} from '../src/index.js';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

/** The shared fixtures both sides of the contract parse (the worker reads them too). */
describe('contract fixtures', () => {
  it.each<[string, z.ZodType]>([
    ['describe.json', SinkDescribeSchema],
    ['package-document.json', PackageSchema],
    ['package-graph.json', PackageSchema],
    ['package-document-rdf.json', PackageSchema],
    ['delivery-request.json', CreateDeliveriesRequestSchema],
    ['delivery-view.json', DeliveryViewSchema],
    ['event.json', BridgeEventSchema],
    ['error.json', BridgeErrorSchema],
    ['target-test-result.json', TargetTestResultSchema],
    ['connection-summary.json', z.array(ConnectionSummarySchema)],
  ])('%s parses unchanged', (file, schema) => {
    const json: unknown = JSON.parse(readFileSync(fixture(file), 'utf8'));
    expect(schema.parse(json)).toEqual(json);
  });
});

describe('personal connections', () => {
  it('a reconcile names at least one live user', () => {
    expect(UsersReconcileRequestSchema.safeParse({ liveUserIds: [] }).success).toBe(false);
    expect(UsersReconcileRequestSchema.safeParse({ liveUserIds: ['u1'] }).success).toBe(true);
  });
});
