/** Help topic `watchedFolders`: the admin-only Watched folders page. */
export function WatchedFoldersHelp() {
  return (
    <>
      <p>
        A watched folder is a folder in a target that CT Studio looks in for Word or PDF files. Each
        file it finds is converted and delivered as a document of its own, in one long-lived batch
        that belongs to the watch. Only administrators set watches up; everyone can see a watch's
        batch on the Conversion page, tagged <strong>Watched</strong> with the watch's name.
      </p>

      <h3>The ledger</h3>
      <p>
        Each row is a watch: its folder, target, and the administrator it runs as, then its health
        and its figures.
      </p>
      <ul>
        <li>
          <strong>Running</strong> looks in the folder; <strong>Draining</strong> takes nothing new
          and finishes what it admitted; <strong>Stopped</strong> does nothing. A running or
          draining watch with a <strong>Problem</strong> (no connection for the target, a folder
          that is gone) says why beneath it, and counts in the badge on the navigation item.
        </li>
        <li>
          <strong>Queue</strong> counts the files waiting at the folder's root and the documents
          under way. <strong>Last 24 h</strong> and <strong>Total</strong> count documents delivered
          and failed.
        </li>
        <li>
          <strong>Batch</strong> opens the watch's batch on the Conversion page. A row's name opens
          its settings and recent events: pickups, moves, and what could not be done.
        </li>
      </ul>

      <h3>New watch</h3>
      <p>
        Give the watch a name and pick the target; the target's folder fields appear, with{' '}
        <strong>Browse…</strong> where the target can be browsed. <strong>Test folder</strong> lists
        the folder's root as you, and <strong>Save</strong> stays off until the test has passed for
        the folder as it now stands. The watch runs as you.
      </p>
      <ul>
        <li>
          <strong>Force-load</strong> (off) delivers every file as an update, even one already
          loaded or a copy of another.
        </li>
        <li>
          <strong>Auto Approve</strong> (on) delivers converted PDFs without holding them for
          review.
        </li>
        <li>
          <strong>Reason files</strong> (on) writes a short note beside each file moved to the
          failed folder, saying why.
        </li>
        <li>
          <strong>Sleep when idle</strong> (30 seconds) is how long the watch waits before looking
          again when it found nothing new. <strong>Admit at a time</strong> (10) is the most files
          it moves out of the root for conversion at once.
        </li>
      </ul>

      <h3>Reconfigure, stop, start, remove</h3>
      <ul>
        <li>
          <strong>Reconfigure…</strong> changes the options at any time; they apply to the next
          pickups. The target, the folder and <strong>Run as me</strong> change only while the watch
          is stopped. Changing the target or folder lists the folder first, and the watch then runs
          as the administrator who saved it.
        </li>
        <li>
          <strong>Stop…</strong> offers <strong>Drain</strong> (the default: what was admitted runs
          to the end and moves as usual, then the watch shows Stopped) or <strong>Stop now</strong>{' '}
          (pickups end at once, queued documents are cancelled and a running one is stopped). Files
          stay where they are; cleaning up the folder is up to you.
        </li>
        <li>
          <strong>Start</strong> picks up from the root again and clears the watch's problem. It
          also retries moves the target refused earlier, so after clearing the folder, stop and
          start the watch to retry stuck moves. Files a Stop now left in the processing folder are
          not taken again.
        </li>
        <li>
          <strong>Remove…</strong> is for a stopped watch. Its counters and events go; its batch
          stays on the Conversion page as history, and nothing in the folder is touched.
        </li>
      </ul>

      <h3>Its documents on the Conversion page</h3>
      <p>
        A watched batch cannot be re-run, and its documents cannot be force-loaded, redelivered or
        loaded as a new document: to process a document again, upload it to the folder again. A
        document refused as changed in the target can still be detached or have the target's state
        accepted. A file that was refused before it was read has no stored original to download.
      </p>
    </>
  );
}
