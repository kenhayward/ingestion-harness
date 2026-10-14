/**
 * Fakes for a drop's DataTransfer with the File and Directory Entries API
 * (`webkitGetAsEntry`), which jsdom lacks. A folder is [name, children]; a child is a File or a
 * nested folder.
 */
export type FakeTree = [string, (File | FakeTree)[]];

interface FakeEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (ok: (f: File) => void, fail?: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (es: FakeEntry[]) => void) => void };
}

const FOLDER = Symbol('folder');
export type FakeFolder = { [FOLDER]: true; tree: FakeTree; batch: number };

/** A dropped folder; `batch`: entries per readEntries call (Chrome hands over 100 at a time). */
export function droppedFolder(
  name: string,
  children: (File | FakeTree)[],
  batch = 100,
): FakeFolder {
  return { [FOLDER]: true, tree: [name, children], batch };
}

function entryOf(item: File | FakeTree, parent: string, batch: number): FakeEntry {
  if (item instanceof File) {
    return {
      isFile: true,
      isDirectory: false,
      name: item.name,
      fullPath: `${parent}/${item.name}`,
      file: (ok) => ok(item),
    };
  }
  const [name, children] = item;
  const fullPath = `${parent}/${name}`;
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath,
    createReader: () => {
      let next = 0;
      return {
        readEntries: (ok) => {
          const slice = children.slice(next, next + batch);
          next += batch;
          ok(slice.map((c) => entryOf(c, fullPath, batch)));
        },
      };
    },
  };
}

/** A drop of loose files and folders, as `e.dataTransfer`. */
export function droppedItems(dropped: (File | FakeFolder)[]): DataTransfer {
  const items = dropped.map((d) => {
    const entry = d instanceof File ? entryOf(d, '', 100) : entryOf(d.tree, '', d.batch);
    return {
      kind: 'file',
      getAsFile: () => (d instanceof File ? d : new File([], d.tree[0])),
      webkitGetAsEntry: () => entry,
    };
  });
  // A dropped folder also shows in `files`, as an empty, typeless "file" named after it.
  const files = items.map((i) => i.getAsFile());
  return { items, files, types: ['Files'] } as unknown as DataTransfer;
}
