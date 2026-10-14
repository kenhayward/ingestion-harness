import { isSourceFile } from '../documents.js';

/** A dropped folder: its PDF and Word files (subfolders included) and how many others it held. */
export interface DroppedFolder {
  name: string;
  files: File[];
  skipped: number;
}

/** What a drop holds: loose files as dropped, and each dropped folder's documents. */
export interface Dropped {
  files: File[];
  folders: DroppedFolder[];
}

/** Hidden files and folders, and Office lock files (`~$report.docx` while report.docx is open). */
const ignored = (name: string) => name.startsWith('.') || name.startsWith('~$');

/**
 * Read a drop, folders included. Must be called during the drop event: the browser empties
 * `dataTransfer` once the handler returns, so the entries are taken first and the folders read
 * afterwards. Without a folder the answer is immediate (not a promise), so loose files are listed
 * at once. A browser without the entries API (`webkitGetAsEntry`) gets the plain file list, where
 * a folder shows as one typeless file.
 */
export function readDrop(dt: DataTransfer): Dropped | Promise<Dropped> {
  const items = [...(dt.items ?? [])].filter((item) => item.kind === 'file');
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null);
  if (!items.length || entries.every((e) => e === null)) {
    return { files: [...dt.files], folders: [] };
  }
  const files: File[] = [];
  const folders: FileSystemDirectoryEntry[] = [];
  items.forEach((item, i) => {
    const entry = entries[i];
    if (entry?.isDirectory) folders.push(entry as FileSystemDirectoryEntry);
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  });
  if (!folders.length) return { files, folders: [] };
  return Promise.all(folders.map(readFolder)).then((read) => ({ files, folders: read }));
}

async function readFolder(folder: FileSystemDirectoryEntry): Promise<DroppedFolder> {
  const found: { path: string; file: File }[] = [];
  let skipped = 0;
  const walk = async (dir: FileSystemDirectoryEntry): Promise<void> => {
    for (const entry of await allEntries(dir)) {
      if (entry.isDirectory) {
        if (!ignored(entry.name)) await walk(entry as FileSystemDirectoryEntry);
        continue;
      }
      const file = await fileOf(entry as FileSystemFileEntry);
      if (!ignored(entry.name) && isSourceFile(file)) found.push({ path: entry.fullPath, file });
      else skipped++;
    }
  };
  await walk(folder);
  // Entries come in no particular order: list them by path, as a file manager would.
  found.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { name: folder.name, files: found.map((f) => f.file), skipped };
}

/** Every entry of a folder: browsers hand them over in batches until an empty one. */
async function allEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) return all;
    all.push(...batch);
  }
}

const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));
