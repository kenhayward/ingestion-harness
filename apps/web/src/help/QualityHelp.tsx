/** Help topic `quality`: how the recipe performs in production, per version and per step. */
export function QualityHelp() {
  return (
    <>
      <p>
        How each version of the recipe has done on real documents, to see whether a change helped
        and which step to work on next.
      </p>

      <h3>Metrics by version</h3>
      <ul>
        <li>
          <strong>Documents</strong> and <strong>Test runs</strong>: production jobs and test runs
          that used the version.
        </li>
        <li>
          <strong>Review rate</strong>: the share of documents that stopped for a person to check.
        </li>
        <li>
          <strong>Edits / reviewed</strong>: how many values reviewers changed per reviewed
          document. Lower means the model got more right first time.
        </li>
        <li>
          <strong>Avg processing</strong>: the time from start to finish of a job.
        </li>
      </ul>

      <h3>Metrics by step</h3>
      <ul>
        <li>
          <strong>Runs</strong>, <strong>Re-runs</strong> (by reviewers) and{' '}
          <strong>Failures</strong>.
        </li>
        <li>
          <strong>Avg attempts</strong>: above about 1.5, the model often gets the step wrong the
          first time; clearer instructions or descriptions usually help.
        </li>
        <li>
          <strong>Avg output tokens</strong> and <strong>Avg duration</strong>: long replies are
          slow and costly; splitting a table step by pages can help.
        </li>
      </ul>
      <p>Most corrected lists the outputs reviewers change most: the first places to improve.</p>

      <h3>Changes</h3>
      <p>Compares this version with another, setting by setting.</p>
    </>
  );
}
