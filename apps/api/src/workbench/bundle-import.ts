import { createHash } from 'node:crypto';
import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Unzip, UnzipInflate } from 'fflate';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import type { BundleManifest } from '@ih/shared';
import { isPdf } from '../uploads.js';

/**
 * Reading and checking a drafting bundle for import (Workbench phase 6). The zip is inflated as
 * a stream: the metadata entries stay in memory, each sample PDF goes to a temporary file, and
 * everything else is inflated (it counts toward the limits) and dropped.
 */

/** A bundle the import refuses (400). */
export class BundleError extends Error {}

export interface BundleSampleFile {
  /** Temp file holding the inflated PDF (removed early when the PDF passes the upload limit). */
  path: string;
  /** Empty when the PDF passed the upload limit: its bytes were not all seen. */
  sha256: string;
  /** Inflated bytes; above the upload limit when the PDF passed it. */
  size: number;
  /** First bytes, for the %PDF check. */
  head: Buffer;
}

export interface ReadBundle {
  /** Temp dir to remove (always, in finally). */
  dir: string;
  /** manifest.json, brief.json, template.yaml, survey.json: the only entries kept in memory. */
  text: Map<string, Buffer>;
  /** samples/<sha>.pdf entries, by entry name. */
  samples: Map<string, BundleSampleFile>;
}

export interface ReadBundleOptions {
  /** Per sample PDF; past it the PDF stops being written. */
  maxUploadBytes: number;
  /** Bytes actually inflated across all entries. */
  maxInflated: number;
  maxEntries: number;
  /** Where the temp dir is made (default: the OS temp dir). */
  tmpRoot?: string;
}

const METADATA = new Set(['manifest.json', 'brief.json', 'template.yaml', 'survey.json']);
const SAMPLE = /^samples\/[^/]+\.pdf$/;
const HEAD_BYTES = 8;
/** Compressed bytes inflated per step: bounds the work done between two size checks. */
const UNZIP_CHUNK = 16 * 1024;

interface Sink {
  write(data: Uint8Array): void;
  end(): void;
  /** Releases what the sink holds open (after a failure). */
  abort(): void;
}

const NO_SINK: Sink = { write: () => {}, end: () => {}, abort: () => {} };

/**
 * Unzips `stream` with limits against zip bombs: the entry count, and the bytes actually
 * inflated across all entries. The sizes the headers claim are never trusted; inflating stops as
 * soon as the running total passes `maxInflated`. On a throw nothing is left on disk.
 */
export async function readBundle(stream: Readable, opts: ReadBundleOptions): Promise<ReadBundle> {
  const dir = await mkdtemp(join(opts.tmpRoot ?? tmpdir(), 'ih-import-'));
  try {
    return await unzipInto(dir, stream, opts);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function unzipInto(
  dir: string,
  stream: Readable,
  opts: ReadBundleOptions,
): Promise<ReadBundle> {
  const tooLarge = new BundleError('bundle is too large');
  const invalid = () => new BundleError('not a valid bundle (zip)');
  const text = new Map<string, Buffer>();
  const samples = new Map<string, BundleSampleFile>();
  const sinks = new Map<string, Sink>();
  const finished = new Set<string>();
  /** A file-system failure: rethrown as itself (a 500), never as a bad zip. */
  let ioError: unknown = null;
  const io = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      ioError = err;
      throw err;
    }
  };

  const metadataSink = (name: string): Sink => {
    const chunks: Uint8Array[] = [];
    return {
      write: (data) => chunks.push(data),
      end: () => text.set(name, Buffer.concat(chunks)),
      abort: () => {},
    };
  };

  const sampleSink = (name: string): Sink => {
    const path = join(dir, `${sinks.size}.pdf`);
    let fd: number | null = io(() => openSync(path, 'w'));
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const close = () => {
      if (fd === null) return;
      const open = fd;
      fd = null;
      io(() => closeSync(open));
    };
    return {
      write: (data) => {
        size += data.length;
        if (head.length < HEAD_BYTES) {
          head = Buffer.concat([head, data]).subarray(0, HEAD_BYTES);
        }
        if (fd === null) return;
        if (size > opts.maxUploadBytes) {
          // Past the upload limit: stop writing, and drop what was written.
          close();
          io(() => unlinkSync(path));
          return;
        }
        const open = fd;
        io(() => writeSync(open, data));
        hash.update(data);
      },
      end: () => {
        close();
        const sha256 = size > opts.maxUploadBytes ? '' : hash.digest('hex');
        samples.set(name, { path, sha256, size, head });
      },
      abort: () => {
        if (fd !== null) closeSync(fd);
        fd = null;
      },
    };
  };

  let total = 0;
  const unzip = new Unzip((file) => {
    if (sinks.size >= opts.maxEntries) throw tooLarge;
    if (sinks.has(file.name)) throw new Error(`duplicate entry ${file.name}`);
    const sink = METADATA.has(file.name)
      ? metadataSink(file.name)
      : SAMPLE.test(file.name)
        ? sampleSink(file.name)
        : NO_SINK;
    sinks.set(file.name, sink);
    file.ondata = (err, data, final) => {
      // UnzipInflate catches a throw from here and calls back with it as `err`: rethrow it.
      if (err) throw err;
      total += data.length;
      if (total > opts.maxInflated) throw tooLarge;
      sink.write(data);
      if (final) {
        sink.end();
        finished.add(file.name);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const push = (data: Uint8Array, final: boolean) => {
    try {
      unzip.push(data, final);
    } catch (err) {
      if (err instanceof BundleError || (ioError !== null && err === ioError)) throw err;
      throw invalid();
    }
  };

  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      for (let at = 0; at < bytes.length; at += UNZIP_CHUNK) {
        push(bytes.subarray(at, at + UNZIP_CHUNK), false);
      }
    }
    push(new Uint8Array(0), true);
  } catch (err) {
    for (const sink of sinks.values()) sink.abort();
    throw err;
  }
  if (!sinks.size || finished.size !== sinks.size) {
    for (const sink of sinks.values()) sink.abort();
    throw invalid();
  }
  return { dir, text, samples };
}

export const firstIssue = (err: z.ZodError) => {
  const issue = err.issues[0]!;
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
};

/** A JSON entry of the bundle checked against `schema`. */
export function jsonEntry<S extends z.ZodTypeAny>(
  text: Map<string, Buffer>,
  name: string,
  schema: S,
): { ok: true; value: z.output<S> } | { ok: false; error: string } {
  const entry = text.get(name);
  if (!entry) return { ok: false, error: `${name}: missing from the bundle` };
  let value: unknown;
  try {
    value = JSON.parse(entry.toString('utf8'));
  } catch {
    return { ok: false, error: `${name}: not valid JSON` };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: `${name}: ${firstIssue(parsed.error)}` };
}

/** The template mapping in `template.yaml`, or null when it is not one. */
export function templateEntry(text: Map<string, Buffer>): Record<string, unknown> | null {
  const entry = text.get('template.yaml');
  if (!entry) return null;
  let value: unknown;
  try {
    value = parseYaml(entry.toString('utf8'));
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Each manifest sample's PDF file, checked; a string is the first problem. */
export function sampleFiles(
  bundle: ReadBundle,
  manifest: BundleManifest,
  maxUploadBytes: number,
): { filename: string; path: string }[] | string {
  const seen = new Set<string>();
  const out: { filename: string; path: string }[] = [];
  for (const s of manifest.samples) {
    const problem = (reason: string) => `sample ${s.filename}: ${reason}`;
    const entry = bundle.samples.get(s.file);
    if (!entry) return problem(`${s.file} is missing from the bundle`);
    if (!isPdf(entry.head)) return problem('not a PDF');
    if (entry.size > maxUploadBytes) return problem('larger than the upload limit');
    if (entry.sha256 !== s.sha256) return problem('the file does not match its sha256');
    if (seen.has(s.sha256)) return problem('the same PDF as another sample');
    seen.add(s.sha256);
    out.push({ filename: s.filename, path: entry.path });
  }
  return out;
}
