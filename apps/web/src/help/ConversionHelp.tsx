/** Help topic `conversion`: the Conversion tab, Word documents converted in batches. */
export function ConversionHelp() {
  return (
    <>
      <p>
        The Conversion tab turns Word documents into documents in a target that takes them. Each
        file is converted and delivered as a document of its own. Everyone can use it: operators,
        designers and administrators.
      </p>

      <h3>Starting a batch</h3>
      <ul>
        <li>
          <strong>Target</strong> lists only the targets that take documents. If there is none, an
          administrator sets one up under Administration &gt; Publishing targets.
        </li>
        <li>
          <strong>Choose files</strong> or <strong>Choose folder</strong>, or drop files or a folder
          on the box. Only Word documents (<code>.docx</code>) are converted for now. Hidden files
          are skipped, and so are the lock files Word leaves beside an open document, such as{' '}
          <code>~$report.docx</code>.
        </li>
        <li>
          Each file is listed by the name that identifies its document: its file name, or for a
          folder, its path in the folder (<code>Policies/2025/leave.docx</code>). Running the same
          file or path again later updates the same document. A name that can't be used, such as one
          with a backslash, or one already in the list, is marked and left out. <strong>×</strong>{' '}
          removes a file from the list.
        </li>
        <li>
          <strong>Force-load</strong> delivers every file as an update, even one that is already
          loaded or a copy of another file. Changes someone made in the target are still never
          overwritten.
        </li>
      </ul>

      <h3>Start</h3>
      <p>
        <strong>Start</strong> sends the files one at a time, with a bar showing how far it has got,
        then starts the batch and opens it. A file that is refused, because it isn&apos;t a Word
        document, is damaged or has tracked changes, says why on its row, and the others carry on.
        The batch then starts without it, and <strong>Open the batch</strong> takes you there.
      </p>
      <p>
        <strong>Cancel</strong>, while the files are going up, throws the unfinished batch away.
        Once a batch has started it carries on without the page, so you can close it.
      </p>

      <h3>The batch</h3>
      <p>
        A batch shows one row per document, with its outcome, a line saying more, a link to the
        document in the target once it is there, and its <strong>Report</strong>: what converting
        the file noticed for someone to check, such as an empty heading or a table with no caption.
        While any document is still queued, decomposing or delivering, the rows refresh every few
        seconds. <strong>Needs attention</strong> shows only the documents someone should look at,
        and <strong>Done</strong> the ones that went through or were already loaded.
      </p>
      <ul>
        <li>
          <strong>Created</strong>, <strong>Updated</strong>: a new document in the target, or a new
          version of one delivered before.
        </li>
        <li>
          <strong>Already loaded</strong>: the same file, under the same name, was delivered before,
          so it was skipped. <strong>Duplicate</strong>: the same file was delivered under another
          name, so it was refused.
        </li>
        <li>
          <strong>Changed in target</strong>: someone edited the document in the target since it was
          delivered, so the update was refused rather than overwrite their edits.
        </li>
        <li>
          <strong>Read-back mismatch</strong>: the target wrote the document but what it read back
          differs; the line says where. <strong>Unresolved</strong>: an earlier delivery may have
          made the document, so it needs resolving in the target. <strong>In flight</strong>:
          another delivery of the document is under way.
        </li>
        <li>
          <strong>Failed</strong>: the file could not be converted or delivered; the line says why.
        </li>
      </ul>

      <h3>Acting on a document</h3>
      <ul>
        <li>
          <strong>Force-load</strong>, on a document already loaded or a duplicate, delivers it
          again as an update, or as a document of its own.
        </li>
        <li>
          <strong>Redeliver</strong> updates the document, from the stored file or a replacement you
          choose. The replacement keeps the original&apos;s name, so it updates the same document.
        </li>
        <li>Force-load and redeliver each start a new batch of one, which the row links to.</li>
        <li>
          For a document changed in the target, <strong>Detach</strong> forgets it: it stays in the
          target untouched, and the next run of the file creates a new document.{' '}
          <strong>Accept the target&apos;s state</strong> shows each changed part with its version
          then and now; once you confirm, the next run updates the document,{' '}
          <strong>overwriting the edits made in the target</strong>. Either is done once, and the
          row says which.
        </li>
      </ul>
      <p>
        Under a new batch, <strong>Earlier batches</strong> lists the batches started before, newest
        first.
      </p>
    </>
  );
}
