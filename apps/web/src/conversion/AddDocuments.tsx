import { useId, useState } from 'react';
import { sourceKeyProblem } from '@ih/shared';
import type { Api } from '../api/client.js';
import { SOURCE_ACCEPT, isSourceFile } from '../documents.js';
import { Icon } from '../ui/Icon.js';
import type { ActionResult } from './ItemActions.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Hidden files and Office lock files (`~$report.docx` while report.docx is open). */
const hiddenOrLock = (name: string) => name.startsWith('.') || name.startsWith('~$');

/**
 * Add Documents (owner's call 2026-10-30): files picked here join a started batch, each named by
 * its file name and queued at once with the batch's own settings. Files go one at a time, as a
 * new batch's do; a file the batch already holds, or one the API refuses, is named in the result
 * and the others still go.
 */
export function AddDocuments({
  api,
  batchId,
  sourceKeys,
  onAdded,
  onDone,
}: {
  api: Api;
  batchId: string;
  /** The source keys already in the batch. */
  sourceKeys: ReadonlySet<string>;
  /** After each file the batch takes, so the list shows it. */
  onAdded: () => void;
  onDone: (result: ActionResult) => void;
}) {
  const inputId = useId();
  const [progress, setProgress] = useState<{ at: number; of: number } | null>(null);

  async function add(picked: File[]) {
    const files = picked.filter((f) => isSourceFile(f) && !hiddenOrLock(f.name));
    const leftOut = picked.length - files.length;
    if (!files.length) {
      onDone({ message: 'No Word document or PDF was picked.', failed: true });
      return;
    }
    const seen = new Set(sourceKeys);
    const refused: string[] = [];
    let added = 0;
    for (const [at, file] of files.entries()) {
      setProgress({ at, of: files.length });
      const sourceKey = file.name.normalize('NFC');
      const problem = sourceKeyProblem(sourceKey);
      if (problem || seen.has(sourceKey)) {
        refused.push(`${file.name}: ${problem ?? 'already in the batch'}`);
        continue;
      }
      try {
        await api.uploadConversionItem(batchId, file, sourceKey);
        seen.add(sourceKey);
        added++;
        onAdded();
      } catch (err) {
        refused.push(`${file.name}: ${(err as Error).message}`);
      }
    }
    setProgress(null);
    const parts = [
      added ? `Added ${plural(added, 'document')} to the batch.` : 'No document added.',
    ];
    if (refused.length) parts.push(`Not added: ${refused.join('; ')}.`);
    if (leftOut) parts.push(`${plural(leftOut, 'file')} left out: not a Word document or PDF.`);
    onDone({ message: parts.join(' '), failed: refused.length > 0 || !added });
  }

  const busy = progress !== null;
  return (
    <span className="batch-add">
      <input
        id={inputId}
        className="visually-hidden"
        type="file"
        accept={SOURCE_ACCEPT}
        multiple
        disabled={busy}
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = ''; // the same file can be picked again
          if (picked.length) void add(picked);
        }}
      />
      <label
        htmlFor={inputId}
        className="button batch-add-button"
        aria-disabled={busy || undefined}
        title="Add Word documents or PDFs to this batch; each is converted as it arrives"
      >
        <Icon name="upload" size={14} />{' '}
        {progress ? `Adding ${progress.at + 1} of ${progress.of}…` : 'Add Documents'}
      </label>
    </span>
  );
}
