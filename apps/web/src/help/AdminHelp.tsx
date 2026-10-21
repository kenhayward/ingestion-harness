/** Help topics for Administration (the account menu's Administration, admins only). */

export function AdministrationHelp() {
  return (
    <>
      <p>
        Administration is where administrators set up CT Studio for everyone. Open it from the
        account menu (your name at the top right); only administrators see it. Each tab saves on its
        own, and the dialog closes only with Close.
      </p>
      <ul>
        <li>
          <strong>Models</strong>: the model choices people pick, the models the pipeline uses
          itself, and the endpoints the requests go to.
        </li>
        <li>
          <strong>Linked data</strong>: who the published linked data belongs to, and the base its
          identifiers are made under.
        </li>
        <li>
          <strong>Published outputs</strong>: the places published results are delivered to.
        </li>
        <li>
          <strong>Users</strong>: who can sign in, what they can do, and recent sign-ins.
        </li>
        <li>
          <strong>Integration</strong>: how this deployment is named in GitHub, and S3 keys for the
          data lake.
        </li>
        <li>
          <strong>Maintenance</strong>: take CT Studio down for everyone but administrators while
          you work on it, with a message they see instead.
        </li>
        <li>
          <strong>Backup</strong>: make an encrypted backup of everything, download it, and restore
          one on this or another server.
        </li>
      </ul>
      <p>The topics below explain each tab in full; the ? on a tab opens its topic.</p>
    </>
  );
}

export function AdminModelsHelp() {
  return (
    <>
      <p>
        Which models CT Studio may use, and which one runs what. The settings start from the
        server's configuration (.env); anything you change here wins, and the workers pick it up
        within seconds.
      </p>
      <h3>Model choices</h3>
      <p>
        A <strong>model choice</strong> is what people pick, by its label: on uploads, retries,
        recipe steps and in the Workbench. Each points at one offered model, so you can move a
        choice to a better model without touching any recipe. One choice is the default: steps that
        name none use it. Use <strong>Add choice</strong> to make one; the ⋯ menu edits it, makes it
        the default or removes it. A choice still used by a recipe step or an unfinished job cannot
        be removed.
      </p>
      <h3>Pipeline models</h3>
      <p>
        The models CT Studio uses itself: the <strong>drafting model</strong> (Workbench drafting
        and dev reference runs), the <strong>OCR model</strong> (reading scanned pages) and the{' '}
        <strong>embedding model</strong> (matching ontology terms).
      </p>
      <h3>Endpoints</h3>
      <p>
        An <strong>endpoint</strong> is a server the worker sends requests to: a local one (for
        example LM Studio) or an external service. Open one to change its address, its key (stored
        encrypted, never shown again), or whether it is local or external. A project kept to local
        models never uses an external endpoint.
      </p>
      <ul>
        <li>
          <strong>Models offered</strong>: only the models listed here can run.{' '}
          <strong>Offer a model</strong> adds one; × stops offering it.
        </li>
        <li>
          <strong>Discover models</strong> asks the endpoint which models it has now; they appear as
          suggestions to offer.
        </li>
        <li>
          <strong>Max output</strong> beside a model caps how long its replies may be (16,000 tokens
          unless changed). Raise it when drafting replies are cut off.
        </li>
        <li>
          <strong>Parallel calls</strong> beside a model is how many requests a worker may send it
          at once (empty or 1: one at a time). They are the calls within one step of one document: a
          step's repeating sections or its chunks of pages, and the pages being OCR'd. The steps
          themselves still run one after another, since a step can read what earlier steps found.
          Set it no higher than the model's server handles at once (in LM Studio, its parallel
          requests setting); each worker replica sends its own calls, so they add up. Some servers
          answer slightly differently when they batch requests, so compare a test run before relying
          on a higher value.
        </li>
        <li>
          <strong>Tool calls</strong> (on by default) let Workbench drafting work things out as it
          goes: try section anchors on the dev samples, search the pinned ontologies and read more
          pages of a dev sample, before it proposes changes. Turn it off for a server that
          mishandles tools; drafting then asks for one reply at a time, as before.
        </li>
        <li>
          Disable an endpoint to stop using it for a while. Only endpoints added here can be
          removed; those from .env can only be disabled.
        </li>
      </ul>
    </>
  );
}

export function AdminLinkedDataHelp() {
  return (
    <>
      <p>
        Recipes that deliver RDF publish linked data: each document becomes a graph whose entities
        have identifiers (IRIs). The published data belongs to the customer, so its IRIs are made
        under the customer's base. There is one customer per deployment.
      </p>
      <h3>The customer</h3>
      <ul>
        <li>
          <strong>Customer name</strong>: who the data belongs to.
        </li>
        <li>
          <strong>Customer id</strong>: a short id (lower case letters, digits and -), filled from
          the name until you edit it.
        </li>
        <li>
          <strong>Base IRI</strong> (optional): the customer's own address for identifiers, such as
          https://data.example.com/. Leave it empty to use a base made from the customer id. Avoid
          words like test, dev or v2 in it: identifiers outlive environments and versions.
        </li>
      </ul>
      <p>
        The example IRIs show what identifiers will look like. No RDF is published until the
        customer is set.
      </p>
      <h3>Changing the base IRI</h3>
      <p>
        Changing it after RDF has been published changes the identifiers of everything published
        afterwards, so it asks first; the history table lists every change, by whom, and how much
        had been published before it.
      </p>
      <h3>Published</h3>
      <p>
        How many RDF outputs and graphs are published, and where graphs go: the triple store
        (Fuseki) and S3, or S3 alone when no triple store is configured. Consumers query the triple
        store at the endpoint shown, as the read-only user named there. IRIs are identifiers, not
        data: find things by their labels and properties, never by reading an IRI.
      </p>
      <p>
        Retiring a document type withdraws what it published; the panel shows withdrawals still
        running or failed.
      </p>
    </>
  );
}

export function AdminUsersHelp() {
  return (
    <>
      <p>
        People sign in with their email address and a password. Everyone is added here by an
        administrator; there is no self sign-up.
      </p>
      <h3>Adding someone</h3>
      <p>
        <strong>Add user</strong> asks for their name, email address and class. They get a{' '}
        <strong>one-time password</strong>, shown once: copy it and send it to them. It lasts 7
        days, and at their first sign-in they choose their own password. If it is lost or expires,{' '}
        <strong>Reissue</strong> one from their row (their current password then stops working).
      </p>
      <h3>User classes</h3>
      <ul>
        <li>
          <strong>Operator</strong>: uploads documents, follows and reviews jobs, reads results.
          Nothing else.
        </li>
        <li>
          <strong>Designer</strong>: everything an operator does, plus document types, the Workbench
          and ontologies. The usual class.
        </li>
        <li>
          <strong>Administrator</strong>: everything, including Administration.
        </li>
      </ul>
      <p>You cannot change your own class, disable yourself or reissue your own password.</p>
      <h3>Locked and disabled accounts</h3>
      <p>
        Ten wrong passwords in a row lock an account for 15 minutes, and longer after each further
        failure; twenty disable it. <strong>Unlock</strong> ends a lock early, and{' '}
        <strong>Enable</strong> brings a disabled account back. Disable someone who should no longer
        sign in: their account and their work stay.
      </p>
      <h3>The admin password</h3>
      <p>
        The built-in <code>admin</code> account signs in with the token the server prints in its log
        on every start; the old one stops working. Add yourself as an administrator for day-to-day
        use.
      </p>
      <h3>Recent sign-ins</h3>
      <p>
        Every sign-in attempt and password change of the last 90 days, for everyone or one person:
        useful when someone is locked out, or to spot guessing.
      </p>
    </>
  );
}

export function AdminMaintenanceHelp() {
  return (
    <>
      <p>
        Maintenance mode takes CT Studio down for everyone but administrators while you work on it:
        swapping models, running a deploy, or restoring a backup. Administrators carry on as normal
        and see a <strong>Maintenance mode is on</strong> strip above every page.
      </p>
      <h3>What everyone else sees</h3>
      <ul>
        <li>
          The sign-in page shows your message, and since when CT Studio has been under maintenance.
          Only administrators can sign in until it is over.
        </li>
        <li>
          Someone already signed in sees a maintenance page with <strong>Check again</strong> and{' '}
          <strong>Sign out</strong> instead of the app. They stay signed in, and carry on where they
          were once maintenance is off.
        </li>
      </ul>
      <h3>Switching it on and off</h3>
      <p>
        Tick <strong>Under maintenance</strong>, write a <strong>Message to users</strong> (up to
        1,000 characters; left blank, they see “CT Studio is down for maintenance. Please try again
        later.”), check the preview under <strong>What users see</strong>, and Save. It takes effect
        within a few seconds. Untick it and Save to end it; the message is kept for next time. The
        line under the switch says since when it has been on and who last changed it.
      </p>
      <p>
        Maintenance only stops people. Jobs that are queued or running keep going, and the workers
        are not touched. To stop jobs as well, pause the queue on the <strong>Backup</strong> tab.
      </p>
      <h3>During and after a restore</h3>
      <p>
        Restoring a backup turns maintenance on by itself, with the message “CT Studio is being
        restored from a backup.”, replacing any message you had written. The restore also pauses the
        job queue, and signs everyone out once the restored database is in place.
      </p>
      <p>
        Maintenance stays on when the restore finishes, and also when it fails, so you can look
        around before anyone else comes back. When you are satisfied:
      </p>
      <ol>
        <li>
          On the <strong>Backup</strong> tab, read the restore report and choose{' '}
          <strong>Resume queue</strong>, so jobs run again.
        </li>
        <li>
          Here, untick <strong>Under maintenance</strong> and Save, so everyone can sign in again.
        </li>
      </ol>
      <p>
        You can end maintenance before resuming the queue, or the other way round: they are separate
        switches. A restore copied onto another server (staging, say) brings the same rule: it stays
        under maintenance until you switch it off here.
      </p>
    </>
  );
}
