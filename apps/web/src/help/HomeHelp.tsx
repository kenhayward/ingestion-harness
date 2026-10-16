/** Help topic `home`: the Home screen, for operators uploading and following documents. */
export function HomeHelp() {
  return (
    <>
      <p>Home is where you send documents in and follow the latest one through to its results.</p>

      <h3>Uploading documents</h3>
      <ul>
        <li>
          Drop PDF or Word (.docx) files, or a whole folder, onto the upload box, or click{' '}
          <strong>browse</strong>. Upload starts straight away, and each file becomes its own job.
          From a folder, only PDF and Word files are taken; anything else is left out and counted.
        </li>
        <li>
          <strong>Document type</strong>: which kind of document these are. It decides which recipe
          reads them, so pick it before dropping the files.
        </li>
        <li>
          <strong>Model</strong>: leave it on the document type's model unless you have been asked
          to use another. CT Studio remembers your choice in this browser.
        </li>
      </ul>

      <h3>Latest job</h3>
      <p>
        Below the upload box is your most recent job (or the newest one if you have none), updating
        live while it runs:
      </p>
      <ul>
        <li>
          <strong>Progress</strong>: reading the text (and OCR for scanned pages), finding the
          sections, extracting each step, then review and publishing, with how long each took.
        </li>
        <li>
          <strong>Status and actions</strong>: what happens next and the button for it.
        </li>
        <li>
          <strong>Details</strong>: the file, document type, model and who queued it.
        </li>
      </ul>

      <h3>What the statuses mean</h3>
      <ul>
        <li>
          <strong>Queued</strong> and <strong>Running</strong>: waiting for, or being processed by,
          a worker.
        </li>
        <li>
          <strong>Awaiting review</strong>: the values are extracted and a person needs to check
          them. Open <strong>Review</strong>, correct anything wrong, then approve to publish or
          reject.
        </li>
        <li>
          <strong>Succeeded</strong>: published; the outputs are on the Results page.
        </li>
        <li>
          <strong>Needs review</strong>: processing stopped on a problem with the document or its
          set-up (for example a required part of the document was not found). The reason says what;
          fix it, then Retry from the Jobs page.
        </li>
        <li>
          <strong>Failed</strong>: something went wrong several times in a row (often a service
          being unavailable). Retry once it is back.
        </li>
      </ul>

      <h3>Notifications</h3>
      <p>
        Turn on the bell at the top to get a notification when one of your jobs finishes or needs
        you, while CT Studio is in the background.
      </p>
    </>
  );
}
