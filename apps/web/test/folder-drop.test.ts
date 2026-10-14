import { describe, expect, it } from 'vitest';
import { readDrop } from '../src/jobs/folder-drop.js';
import { droppedFolder, droppedItems } from './drop-fakes.js';

const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });
const word = (name: string) => new File(['PK'], name); // browsers often send no type for .docx
const text = (name: string) => new File(['x'], name, { type: 'text/plain' });

describe('readDrop', () => {
  it('takes loose files as dropped, unfiltered (the strip marks the others skipped)', async () => {
    const { files, folders } = await readDrop(droppedItems([pdf('a.pdf'), text('notes.txt')]));
    expect(files.map((f) => f.name)).toEqual(['a.pdf', 'notes.txt']);
    expect(folders).toEqual([]);
  });

  it("takes a folder's PDF and Word files, subfolders included, in path order", async () => {
    const folder = droppedFolder('Invoices', [
      pdf('b.pdf'),
      text('readme.txt'),
      word('a.docx'),
      ['2025', [pdf('old.PDF'), text('scan.jpg')]],
    ]);
    const { files, folders } = await readDrop(droppedItems([folder]));
    expect(files).toEqual([]);
    expect(folders).toHaveLength(1);
    expect(folders[0]!.name).toBe('Invoices');
    expect(folders[0]!.files.map((f) => f.name)).toEqual(['old.PDF', 'a.docx', 'b.pdf']);
    expect(folders[0]!.skipped).toBe(2);
  });

  it('leaves out Office lock files and hidden files and folders', async () => {
    const folder = droppedFolder('Batch', [
      word('report.docx'),
      word('~$report.docx'), // Word's lock file while report.docx is open
      pdf('.hidden.pdf'),
      ['.git', [pdf('objects.pdf')]],
    ]);
    const [scan] = (await readDrop(droppedItems([folder]))).folders;
    expect(scan!.files.map((f) => f.name)).toEqual(['report.docx']);
    expect(scan!.skipped).toBe(2); // the lock file and the hidden file; hidden folders are not read
  });

  it('reads a large folder in full (browsers hand entries over in batches)', async () => {
    const many = Array.from({ length: 250 }, (_, i) => pdf(`f${String(i).padStart(3, '0')}.pdf`));
    const [scan] = (await readDrop(droppedItems([droppedFolder('Big', many, 100)]))).folders;
    expect(scan!.files).toHaveLength(250);
  });

  it('mixes loose files and several folders', async () => {
    const dt = droppedItems([
      pdf('loose.pdf'),
      droppedFolder('A', [pdf('a.pdf')]),
      droppedFolder('B', [text('b.txt')]),
    ]);
    const { files, folders } = await readDrop(dt);
    expect(files.map((f) => f.name)).toEqual(['loose.pdf']);
    expect(folders.map((f) => [f.name, f.files.length, f.skipped])).toEqual([
      ['A', 1, 0],
      ['B', 0, 1],
    ]);
  });

  it('falls back to the plain file list where the browser has no entries API', async () => {
    const files = [pdf('a.pdf')];
    const dt = { files, items: undefined } as unknown as DataTransfer;
    expect(await readDrop(dt)).toEqual({ files, folders: [] });
  });
});
