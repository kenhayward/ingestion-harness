/** Help topic `connections`: personal connections, what they are and where they are managed. */
export function ConnectionsHelp() {
  return (
    <>
      <p>
        A <strong>connection</strong> is a login to a system CT Studio delivers to. Some systems
        record who delivered each item, so they need a real person: deliveries to them are made with
        the login of the person who approved the document (or uploaded it, when it was published
        without review). Those logins are <strong>personal connections</strong>.
      </p>

      <h3>Where they are kept</h3>
      <p>
        Connections are kept by the delivery bridge, not by CT Studio.{' '}
        <strong>Manage connections</strong> opens the bridge&apos;s connections page in a new tab.
        You add, test, rename, update and delete your connections there. CT Studio never sees what
        you enter for them: Profile shows only each connection&apos;s name, system, instance, status
        and when a delivery last used it.
      </p>

      <h3>One per instance</h3>
      <p>
        A system can have several <strong>instances</strong>, for example a sandbox and production.
        You hold one connection for each instance, so a delivery always knows which login to use. To
        change it, update that connection rather than adding another.
      </p>

      <h3>Status</h3>
      <p>
        A connection is <strong>OK</strong> once a test or a delivery succeeded with it. It{' '}
        <strong>needs attention</strong> when a delivery or a test was refused, for example after a
        password change: update it on the connections page. <strong>Untested</strong> means it was
        saved without a passing test.
      </p>

      <h3>When someone leaves</h3>
      <p>
        When an admin disables a user, that user&apos;s connections are deleted. Enabling the user
        again does not bring them back: they add their connections again. Shared connections, which
        admins manage for systems that do not need a person, are not affected.
      </p>
    </>
  );
}
