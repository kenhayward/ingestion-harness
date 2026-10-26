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
      <p>A new batch is one card in three steps: the target, the Word files, and the options.</p>
      <ul>
        <li>
          <strong>1 Target</strong> lists only the targets that take documents. If there is none, an
          administrator sets one up under Administration &gt; Publishing targets.
        </li>
        <li>
          <strong>2 Word files</strong>: <strong>Choose files</strong> or{' '}
          <strong>Choose folder</strong>, or drop files or a folder on the box. Only Word documents
          (<code>.docx</code>) are converted for now. Hidden files are skipped, and so are the lock
          files Word leaves beside an open document, such as <code>~$report.docx</code>.
        </li>
        <li>
          Each file is listed by the name that identifies its document: its file name, or for a
          folder, its path in the folder (<code>Policies/2025/leave.docx</code>). Running the same
          file or path again later updates the same document. A name that can't be used, such as one
          with a backslash, or one already in the list, is marked and left out. <strong>×</strong>{' '}
          removes a file from the list, and <strong>Clear all</strong> empties it. The head of the
          list counts the files, how many are ready, and how many were skipped or left out.
        </li>
        <li>
          <strong>3 Options</strong>: the <strong>Force-load</strong> switch delivers every file as
          an update, even one that is already loaded or a copy of another file. Changes someone made
          in the target are still never overwritten.
        </li>
      </ul>

      <h3>Converting</h3>
      <p>
        <strong>Convert N documents</strong> sends the files one at a time, with a bar showing how
        far it has got, then starts the batch and opens it. A file that is refused, because it
        isn&apos;t a Word document, is damaged or has tracked changes, says why on its row, and the
        others carry on. The batch then starts without it, and <strong>Open the batch</strong> takes
        you there.
      </p>
      <p>
        <strong>Cancel</strong>, while the files are going up, throws the unfinished batch away.
        Once a batch has started it carries on without the page, so you can close it.
      </p>

      <h3>The batch</h3>
      <p>
        A batch opens with where it went, who started it, how long it took and whether it was
        force-loaded, then its totals: documents, created or updated, already loaded, needing
        attention and failed, with a bar of the outcomes. Below, each document is one line: its
        state, its path, its outcome, a line saying more, how long it took (or has run so far),{' '}
        <strong>Open</strong> for the document in the target once it is there, and a{' '}
        <strong>⋯</strong> menu. The lines are as many as fit the window, with{' '}
        <strong>‹ Prev</strong> and <strong>Next ›</strong> between pages. While any document is
        still queued, decomposing or delivering, the lines refresh every few seconds.
      </p>
      <p>
        Click a line to see the document beside the list: why it failed or needs attention, when it
        started and finished, its <strong>Report</strong> (what converting the file noticed for
        someone to check, such as an empty heading it left out or a table with no caption), the
        document in the target, and the actions that apply to it. At first the panel shows the first
        document needing attention. <strong>Find a document</strong> narrows the list by its path.{' '}
        <strong>Needs attention</strong> shows only the documents someone should look at,{' '}
        <strong>Failed</strong> the ones that failed, and <strong>Done</strong> the ones that went
        through, were already loaded, or were detached or had the target&apos;s state accepted. A
        refusal that a later run has moved on from is <strong>Superseded by a later run</strong>,
        and done too: act on the document from the later batch. A screen reader hears how many are
        done each time another settles.
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
          made the document, so it needs resolving in the target, or the target no longer has the
          document (it may have been deleted there), so no update can reach it.{' '}
          <strong>In flight</strong>: another batch is delivering the same document, so this row
          stays as it is; the outcome shows in that batch.
        </li>
        <li>
          <strong>Failed</strong>: the file could not be converted or delivered; the line says why.
        </li>
      </ul>

      <h3>Re-running failed documents</h3>
      <p>
        <strong>Re-run N failed</strong>, at the top of a batch with failed documents, lists them,
        each ticked, with why it failed. Untick any to leave out, and choose whether to{' '}
        <strong>Keep Force-load</strong> (it starts as the batch was started). They run again from
        the files uploaded with the batch, as one new batch to the same target, which opens; this
        batch keeps its record. <strong>Re-run this document</strong> on the panel, or{' '}
        <strong>Re-run</strong> in a line&apos;s <strong>⋯</strong> menu, does the same for one. A
        document whose earlier re-run is still under way can&apos;t be re-run until it finishes.
      </p>
      <p>
        <strong>Download original</strong>, on the panel and in the <strong>⋯</strong> menu, saves
        the Word file as it was uploaded.
      </p>

      <h3>Acting on a document</h3>
      <p>The panel and a line&apos;s menu offer these where they apply:</p>
      <ul>
        <li>
          <strong>Force-load</strong>, on a document already loaded or a duplicate, delivers it
          again as an update, or as a document of its own.
        </li>
        <li>
          <strong>Redeliver</strong> updates the document, from the stored file or a replacement you
          choose. The replacement keeps the original&apos;s name, so it updates the same document.
        </li>
        <li>
          <strong>Load as a new document</strong>, on a document the target no longer has (someone
          deleted it there, say), creates it again from the stored file, after you confirm. CT
          Studio forgets the old document and the new one is a document of its own, with a new
          identity in the target. Running the file again, or force-loading it, would only try to
          update the document that is gone, so it stays unresolved until you do this or detach it.
        </li>
        <li>
          Force-load, redeliver and load as a new document each start a new batch of one, which the
          notice links to.
        </li>
        <li>
          For a document changed in the target, <strong>Detach</strong> forgets it: it stays in the
          target untouched, and the next run of the file creates a new document.{' '}
          <strong>Accept the target&apos;s state</strong> shows each changed part with its version
          then and now; once you confirm, the next run updates the document,{' '}
          <strong>overwriting the edits made in the target</strong>. Either is done once, and the
          row says which. Only a document refused as changed in the target, or one it no longer has,
          can be detached, so a document delivered since is never detached from an old row.
        </li>
      </ul>
      <p>
        Under a new batch, <strong>Earlier batches</strong> lists the batches started before, newest
        first, ten a page: how each stands, when it started, its target, how many documents, what
        became of them, and who started it. Click a line to open the batch.
      </p>
    </>
  );
}
