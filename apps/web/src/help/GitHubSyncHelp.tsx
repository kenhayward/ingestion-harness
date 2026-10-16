/** Help topic `github-sync`: how recipe versions move between CT Studio and GitHub. */
export function GitHubSyncHelp() {
  return (
    <>
      <p>
        A document type can be linked to a GitHub repository so its recipe versions are kept there
        as YAML files. You can copy a version out to GitHub, and bring a version in, from this
        deployment or from another one.
      </p>

      <h3>Your own account</h3>
      <p>
        Every GitHub action uses your own linked account, never a shared one, so GitHub shows who
        did what. Link your account in Profile first. It needs permission to push to the repository
        to push, and to read it to pull or import.
      </p>

      <h3>Where files go</h3>
      <p>
        Files are stored as <code>{'ct-studio/<deployment>/<document type>/v<N>.yaml'}</code>. The
        folder (<code>ct-studio</code> by default) can be changed on the link. Each CT Studio
        deployment has its own folder, named in Administration &gt; Integration, so several
        deployments can share one repository without overwriting each other. A deployment's name is
        fixed once it has pushed.
      </p>

      <h3>What is pushed</h3>
      <ul>
        <li>
          Only <strong>published</strong> versions go to GitHub. Drafts stay in CT Studio.
        </li>
        <li>
          A push goes straight to the branch, or opens a pull request when the branch is protected
          or the document type is set to always use one.
        </li>
        <li>
          A document type can push each version as it is published. If that push fails or is
          skipped, it never blocks publishing: push the version later from Versions.
        </li>
        <li>
          A published version never changes. Pushing it again can only update its label and note.
        </li>
        <li>
          If a file was changed on GitHub since your last push, the push stops and asks you to pull
          first.
        </li>
      </ul>

      <h3>Pull and import</h3>
      <p>
        Pull and import always arrive as a <strong>draft</strong> to check and publish here. They
        never create a published version by themselves. Pull works on a document type already
        linked; import creates a document type from a file in a repository.
      </p>
      <ul>
        <li>
          <strong>Take GitHub's label</strong>: the recipe is the same, only the label or note
          differs, so this updates the label and note here.
        </li>
        <li>
          <strong>Use as draft</strong>: for a version this deployment lacks, or one written by
          another deployment. It becomes the open draft.
        </li>
        <li>
          A version whose recipe is different on both sides is shown for comparison, never applied.
        </li>
      </ul>

      <h3>What the tags in Versions mean</h3>
      <ul>
        <li>
          <strong>On GitHub</strong>: the file there is the same recipe, label and note.
        </li>
        <li>
          <strong>Label changed since push</strong>: the label or note was edited here after the
          last push. Push again to update GitHub.
        </li>
        <li>
          <strong>Not on GitHub</strong>: this published version has not been pushed.
        </li>
        <li>
          <strong>PR #n open</strong>: a pull request with this version is waiting to be merged.
        </li>
        <li>
          <strong>Different on GitHub</strong>: the file on GitHub holds a different recipe for this
          version number. Compare it with Pull.
        </li>
      </ul>

      <h3>Who can link</h3>
      <p>
        Only admins link a document type, change its link or remove it. Anyone with a linked GitHub
        account can push, pull and import.
      </p>
    </>
  );
}
