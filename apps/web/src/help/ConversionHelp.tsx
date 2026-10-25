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
          with a backslash, is marked and left out. <strong>×</strong> removes a file from the list.
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
    </>
  );
}
