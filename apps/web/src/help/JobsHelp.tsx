/** Help topic `jobs`: the Jobs page, for operators following and acting on jobs. */
export function JobsHelp() {
  return (
    <>
      <p>
        Every job in one list: find the ones that need you, act on them, and tidy up finished ones.
        The list refreshes by itself every few seconds.
      </p>

      <h3>Reading the list</h3>
      <ul>
        <li>
          One line a job: an icon for its status (hover it for the name; a spinner while it is under
          way), the file name, the document type, when it was created and how long it took. A job
          that needs you also says why after its name.
        </li>
        <li>
          The list fills the window and shows as many jobs as fit: <strong>‹ Newer</strong> and{' '}
          <strong>Older ›</strong> above it move between pages, newest first.
        </li>
        <li>
          From the keyboard: <kbd>↑</kbd> and <kbd>↓</kbd> move to the next job (onto the next page
          when needed), <kbd>Page Up</kbd> and <kbd>Page Down</kbd> change page, and{' '}
          <kbd>Enter</kbd> opens the selected job to review or view it.
        </li>
      </ul>

      <h3>Finding jobs</h3>
      <ul>
        <li>
          The status chips filter the list: <strong>In progress</strong> (queued or running),{' '}
          <strong>Needs attention</strong> (awaiting review, needs review or failed),{' '}
          <strong>Finished</strong>, or <strong>All</strong>. Each shows how many jobs it holds.
        </li>
        <li>
          <strong>My jobs</strong> shows only the jobs you queued; CT Studio remembers the setting.
        </li>
        <li>The search box at the top filters by file name, document type, model or status.</li>
        <li>A new filter or search starts on the first page.</li>
      </ul>

      <h3>A job's details</h3>
      <p>
        Click a file name to open the job in the panel at the side: its progress, status, the reason
        it stopped (if it did), and its details.
      </p>

      <h3>Acting on a job</h3>
      <ul>
        <li>
          Every action is in the panel and in the row's <strong>⋯</strong> menu, the one the job
          needs next first: <strong>Review</strong> when it awaits review, <strong>View</strong>{' '}
          once it is finished, <strong>Retry</strong> after a failure, <strong>Cancel</strong> while
          it waits or runs.
        </li>
        <li>
          Retry runs the document again from the start on the newest version of its recipe; you can
          pick another model in the dialog. <strong>Re-process</strong> does the same for a job that
          already succeeded, discarding earlier review edits.
        </li>
        <li>
          Then the rest: open the original document, Re-process, <strong>Copy link</strong> (a link
          to this job to send to a colleague), and Delete. Deleting a published job withdraws what
          it delivered.
        </li>
      </ul>

      <h3>Clean up</h3>
      <p>
        <strong>Clean up finished jobs…</strong> removes finished jobs older than a number of days.
        It first shows how many would go, and asks before deleting anything.
      </p>
    </>
  );
}
