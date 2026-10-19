import {
  bridgeError,
  type BrowseResult,
  type ConnectionTestResult,
  type ErrorCode,
  type SinkDeliverRequest,
  type SinkDeliverResult,
  type SinkDescribe,
  type SinkJobStatus,
} from '@ih/bridge-contract';
import { SinkError, type SinkPort } from './port.js';

export type DeliverStep =
  'succeed' | 'pending' | { error: ErrorCode } | { throw: string } | { delayMs: number };
export type StatusStep = 'pending' | 'succeed' | { error: ErrorCode };

const DESCRIBE: SinkDescribe = {
  name: 'Fake sink',
  contractVersion: 1,
  connectionKind: 'shared',
  instances: [],
  credentialFields: [],
  destinationFields: [
    {
      id: 'bucket',
      label: 'Bucket',
      kind: 'fixed',
      required: true,
      overridable: false,
      browse: false,
    },
  ],
  capabilities: {
    browse: false,
    replace: true,
    withdraw: false,
    readBack: false,
    accepts: ['files'],
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A scriptable sink for tests: answers in the order it was told, then succeeds. */
export class FakeSink implements SinkPort {
  readonly delivered: SinkDeliverRequest[] = [];
  private readonly steps: DeliverStep[] = [];
  private readonly statusSteps: StatusStep[] = [];
  private jobs = 0;

  constructor(private readonly overrides: Partial<SinkDescribe> = {}) {}

  script(...steps: DeliverStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  scriptStatus(...steps: StatusStep[]): this {
    this.statusSteps.push(...steps);
    return this;
  }

  async describe(): Promise<SinkDescribe> {
    return { ...DESCRIBE, ...this.overrides };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, identity: 'fake' };
  }

  async browse(): Promise<BrowseResult> {
    return { nodes: [], nextCursor: null };
  }

  async deliver(req: SinkDeliverRequest): Promise<SinkDeliverResult> {
    this.delivered.push(req);
    let step = this.steps.shift() ?? 'succeed';
    while (typeof step === 'object' && 'delayMs' in step) {
      await sleep(step.delayMs);
      step = this.steps.shift() ?? 'succeed';
    }
    if (step === 'pending') return { status: 'pending', sinkJobId: `fake-${++this.jobs}` };
    if (step === 'succeed') return { status: 'succeeded', receipt: { written: [] } };
    if ('error' in step) throw new SinkError(bridgeError(step.error, `scripted ${step.error}`));
    throw new Error(step.throw);
  }

  async deliveryStatus(_sinkJobId: string): Promise<SinkJobStatus> {
    const step = this.statusSteps.shift() ?? 'succeed';
    if (step === 'pending') return { status: 'pending' };
    if (step === 'succeed') return { status: 'succeeded', receipt: { written: [] } };
    return { status: 'failed', error: bridgeError(step.error, `scripted ${step.error}`) };
  }
}
