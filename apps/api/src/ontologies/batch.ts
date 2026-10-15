import { createHash } from 'node:crypto';
import { Unzip, UnzipInflate } from 'fflate';
import { ontologyFormat } from '@ih/shared';

/** Ontology imports from a folder or a zip (`POST /api/ontologies/batch`). */

export interface BatchFile {
  /** The path in the folder or zip, e.g. `idmp/core.ttl`. */
  path: string;
  body: Buffer;
}

/** Entries a zip may hold at most (directories and other files included). */
export const MAX_ZIP_ENTRIES = 10_000;
const CHUNK = 16 * 1024;

export class ZipRefused extends Error {}

const ZIP_MAGIC = Buffer.from('PK\x03\x04', 'latin1');

export const isZip = (body: Uint8Array): boolean =>
  Buffer.from(body.buffer, body.byteOffset, Math.min(body.length, 4)).equals(ZIP_MAGIC);

/** A path no import takes: a directory, a hidden file or folder, macOS metadata. */
export function leftOut(path: string): boolean {
  if (path.endsWith('/')) return true;
  return path
    .split(/[\\/]/)
    .some((segment) => segment.startsWith('.') || segment === '__MACOSX' || segment === '');
}

/**
 * The ontology files of a zip (by extension; others are skipped unread). Inflating stops once
 * `maxInflated` bytes have come out: sizes in the headers are never trusted.
 */
export function readOntologyZip(
  body: Uint8Array,
  opts: { maxInflated: number; maxEntries?: number },
): BatchFile[] {
  const maxEntries = opts.maxEntries ?? MAX_ZIP_ENTRIES;
  const files: BatchFile[] = [];
  let entries = 0;
  let inflated = 0;
  const unzip = new Unzip((file) => {
    if (++entries > maxEntries) throw new ZipRefused(`the zip has more than ${maxEntries} entries`);
    if (leftOut(file.name) || !ontologyFormat(file.name)) return;
    const chunks: Uint8Array[] = [];
    file.ondata = (err, data, final) => {
      if (err) throw err;
      inflated += data.length;
      if (inflated > opts.maxInflated) {
        throw new ZipRefused(`the zip unpacks to more than ${opts.maxInflated} bytes`);
      }
      chunks.push(data);
      if (final) files.push({ path: file.name, body: Buffer.concat(chunks) });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let at = 0; at < body.length; at += CHUNK) {
      unzip.push(body.subarray(at, at + CHUNK), false);
    }
    unzip.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof ZipRefused) throw err;
    throw new ZipRefused('not a valid zip');
  }
  return files;
}

export const sha256 = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex');

/**
 * A merged version's identity: the sha256 of its files' sha256s, sorted, so the same set of
 * files is the same version whatever their names or order.
 */
export const manifestSha = (shas: string[]): string =>
  sha256(Buffer.from([...shas].sort().join('\n')));

/** A merged version's name: the folder's top-level name, else `files`. */
export function folderName(paths: string[]): string {
  const tops = new Set(paths.map((p) => p.split(/[\\/]/)[0]!).filter(Boolean));
  const [top] = tops;
  return tops.size === 1 && paths.every((p) => /[\\/]/.test(p)) && top ? top : 'files';
}
