# Watched folders: design

Status: draft for review, 2026-10-29.

Marks: **[owner]** = decided by the owner; **[call]** = the author's call, open to change.

## 1. Intent

Today a person converts Word and PDF files by starting a batch on the Conversion page and uploading
the files. Some teams instead want to drop files into a folder of an object store that their own
platform already gives them, and have them converted and loaded without opening CT Studio at all.

A **watched folder** is a folder on a sink's own storage that CT Studio checks on a schedule. A PDF
or Word file that appears in its **root** is picked up, converted with the existing decomposition
pipeline, delivered to a configured target, and moved to a subfolder that says how it ended. It runs
with nobody in the loop; people only act on failures.

Why the root folder **[owner]**: the storage removes a subfolder once its last file is deleted, so
the root is the one folder that is always there. Uploaders would otherwise have to recreate a drop
folder each time.

This design is generic: any sink that offers the capability in §4 can be watched. Nothing here names
a particular platform.

## 2. Goals, non-goals, anti-goals

Goals

- Admins set up, monitor, reconfigure, stop, start and remove watches in CT Studio. **[owner]**
- A watch runs on its own: pickup, conversion, delivery and the final move need no person.
  Auto-approve is on by default. **[owner]**
- The bucket is the only way in and back in. A failure is fixed by correcting the document (or CT
  Studio) and uploading it to the root again. CT Studio never re-processes a watched file. **[owner]**
- People can see in CT Studio why a file failed; optionally a reason file sits beside it in the
  bucket. **[owner]**
- Watched folders and UI batches share each tenant's delivery capacity, which the sink declares.
  **[owner]**

Non-goals

- Watching subfolders, or recursing into them.
- File types other than what conversion takes today (PDF and `.docx`).
- Notifications by email or chat (health is shown in CT Studio; see §8).
- Watching storage that is not reached through a sink (for example plain S3 with CT Studio's own
  keys).

Anti-goals (would make this a failure even if it worked)

- A file processed twice, or two documents created in the target from one upload.
- A file lost: removed from the root without being in `processing/`, `delivered/` or `failed/`.
- A tenant sent more deliveries at once than its sink says it can take.
- A watch silently stuck, with nothing in CT Studio saying so.

## 3. The folder layout and a file's journey

Within the watched folder:

```
<watched folder>/
  report.docx              ← uploaded by anyone with access to the storage
  processing/report.docx   ← picked up, being converted and delivered
  delivered/report.docx    ← finished: created, updated or already loaded
  failed/report.docx       ← finished with any other outcome
  failed/report.docx.md    ← optional: why it failed
```

1. **Seen.** A poll lists the root. A file is a candidate when its name ends `.pdf` or `.docx`
   (any case) and it is *settled*: its size and modified time are the same on two looks at least
   10 seconds apart, so a half-uploaded file is never taken. Other files are left alone. **[call]**

   **When it polls** **[owner]**: a watch looks again at once whenever it has just admitted a file
   or a document of its own has just finished, so a backlog is worked through without waiting.
   When a look finds nothing new to admit, it sleeps for the watch's **sleep** (set per watch,
   default 30 s **[owner]**; 10 s to 1 h **[call]**) before looking again. A file seen for the
   first time is looked at again after 10 s rather than a full sleep, to confirm it has settled.
   **[call]**
2. **Named.** CT Studio picks the file's **working name**: its own name, unless that name is
   already taken in `processing/`, `failed/` or `delivered/`, in which case the first free
   `name_1.ext`, `name_2.ext`, … **[owner]** (the first free number is the **[call]**). The
   working name is used in the bucket's subfolders and in the conversion log (the item's file
   name).
3. **Downloaded and moved.** CT Studio reads the file, stores it as the item's source in the runs
   bucket (as an upload is stored today), then moves it from the root to `processing/<working
   name>`. **[owner]** (move), the order (store first, then move) **[call]**: the file is never out
   of the bucket before CT Studio holds a copy.
4. **Converted and delivered** as a conversion item of the watch's batch (§6), with the watch's
   force-load and auto-approve settings, acting as the watch's user (§5).
5. **Moved at the end.** When the item reaches a final outcome, the file moves from `processing/`
   to `delivered/` (`created`, `updated`, `already_loaded`) or to `failed/` (every other final
   outcome: `duplicate`, `changed_in_target`, `read_back_mismatch`, `unresolved`, `failed`,
   `rejected`). With the watch's reason-file setting on, `failed/<working name>.md` is written
   too (§7). **[call]** (the mapping)

Identity **[owner]**: the item's **source key** (what the register uses to decide create or
update) is the watched folder plus the file's **original** name in the root, never the working
name. An edited `report.docx` uploaded after an earlier one was delivered becomes `report_1.docx`
in the bucket and the log, but updates the document the first one created. The same name dropped
into two different watched folders, or uploaded through a UI batch, is a different document.
**[call]** The folder part is the folder as the sink identifies it (its `sourceFields` values,
written as a stable path), so renaming the watch keeps identity, while pointing a watch at another
folder starts new documents.

Details **[call]**:

- **Repeats in one batch.** A watch's batch holds the same source key more than once (the edited
  `report.docx` is a second item with the same original name). The batch items' uniqueness on
  `(batch_id, source_key)`, and the 409 for a repeat, stay for UI batches and are lifted for a
  watch's batch, where items are told apart by their working names.
- **Same name already in progress.** A root file whose original name has an unfinished item in the
  same watch is not picked up until that item finishes, so the register never sees two runs of one
  source at once (which would end `in_flight`).
- **Not a valid file.** A candidate that conversion refuses before any delivery (not really a PDF
  or Word file, tracked changes, over the size limit) is still moved, straight to `failed/`, with
  its reason, and appears in the batch as `failed`.
- **Held for review.** With auto-approve off, a PDF held for review stays in `processing/` until
  someone approves or rejects it on the Conversion page, then moves as above. Files waiting for a
  lane (§11) also stay in `processing/`.
- **Subfolders disappear when empty.** The sink creates `processing/`, `delivered/` and `failed/`
  on demand when a file is moved into one.
- **Crash safety.** Each pickup is recorded (watch, original name, size, modified time, working
  name, step reached) before the move. If a move or delete fails, the next poll finishes that
  pickup instead of picking the file up again, so a file is never converted twice and a root file
  is never orphaned.

## 4. What a sink must offer

A new optional capability in the sink contract, `watchedFolders`, in a new contract version (4,
like administration's 3: it changes no package). **[call]** A sink offers it only if it can list a
folder.

- `sourceFields`: the settings that name a watched folder (for example a storage and a folder
  path), described like destination fields, with `browse` so the setup dialog can offer a picker.
- Operations, each called through the bridge as the acting user, on one sink instance:
  - **list** a folder: its files only (name, size, modified time, and an etag where the storage has
    one), no recursion;
  - **read** a file's bytes;
  - **move** a file to another folder of the same watched folder, under a given name, creating the
    folder if needed; idempotent (a retried move whose source is gone and whose destination exists
    with the same size succeeds);
  - **put** a small text file (the reason file).
- A move is one operation so that a sink can do it natively, or as copy-then-delete, and so that a
  file too large to download can still be moved to `failed/`. **[call]**

**Lanes.** Every sink instance (tenant) may declare `lanes`: how many conversions with deliveries
it can take at once. **[owner]** A sink that declares none gets 1. **[call]** This is not tied to
watched folders; it applies to every conversion (§6). **[call]** `lanes` is an optional field of
each instance in the sink's describe (and in `SinkViewSchema.instances`), independent of the
contract version, so a sink of any version may declare it. The bridge enforces it for every
delivery it sends to that instance, recipe publications included (a per-instance queue in its
delivery runner), because the limit is the tenant's; CT Studio's own limit (§6) keeps conversions
from piling up in the bridge's queue.

The bridge relays these operations (signed, with `actingUser`, refused with `connection_missing`
when the acting user has no connection for a personal sink), checks every answer against the
contract, and keeps the contract's conformance suite covering them. CT Studio never holds the
storage's credentials. **[call]**

## 5. Who it acts as

The bucket and the target are reached through the same sink instance and the same account. **[owner]**

- A watch acts as the admin who set it up (the **run-as user**): every list, read, move, put and
  delivery uses that user's connection, as a batch acts as the user who started it. **[owner]**
- The watched folder and the delivery target belong to the same sink instance. **[call]** (the
  target picker offers only targets on the sink instance chosen for the folder)
- If the run-as user loses their connection (it is deleted, their account is disabled), the watch
  goes unhealthy (§8). Another admin may reconfigure it to run as themselves. **[call]**

## 6. Batches, lanes and taking turns

**One batch per watch.** **[owner]** Each watch has one long-lived batch on the Conversion page,
tagged with the watch's name; every pickup is an item in it. The batch never finishes while the
watch exists. Its creator is the run-as user.

Deleting the watch's batch **[owner]**: anyone allowed to delete a batch today may delete it, to
clear old records. Its documents' rows go; the watch's counters (§8) are held outside the batch and
keep counting. The next pickup starts a new batch for the watch, which reappears on the list with
only the new rows. **[call]**: rows still unfinished when the batch is deleted are kept, and the
batch stays on the list holding only them until they finish, so a delete never strands a file in
`processing/`. (Moving them to a new batch was rejected: an item's stored files are keyed by its
batch.)

What the watch's batch does not offer **[owner]** ("no re-processing from CT Studio"): *Re-run N
failed*, a row's Re-run, Force-load, Redeliver and *Load as a new document* are hidden for watched
items. **[call]**: Detach and Accept the target's state stay, since they only change the register
and send nothing; the next upload of the file then creates or updates. Review of a held PDF stays
(only when auto-approve is off).

**Lanes per tenant.** **[owner]** At most `lanes` deliveries run at once for one sink instance,
counting UI batches and watches together. (The worker count still bounds decomposition; since a
delivering document holds no worker (§11), it no longer caps deliveries.) **[owner]** A lane is held only while an
item is `delivering`; decomposition takes no lane, so the next document is decomposed while the
previous one is delivered (§11). **[call]** The limit is counted from item states, in one place,
not from job claims, since the decompose job finishes before the bridge settles the item. An item
`awaiting_review` holds no lane (it waits on a person, not the tenant). Tenants do not block each
other.

**Taking turns.** **[owner]** Watches and UI batches share a tenant's lanes. **[call]**: when a lane
frees, it goes to the next batch in turn among those with items waiting to deliver (round-robin over the batches with waiting items), and
within a batch to its oldest item, so a large drop into a watched folder cannot hold a UI batch
back until it is done.

**How much a watch admits.** **[call]** A watch moves at most `admit` files (default 10) into
`processing/` ahead of its lanes; the rest wait in the root. The bucket then shows truly what is
waiting, and a stop leaves few files in `processing/`.

## 7. The reason file

**[owner]** optional; **[call]** on by default, per watch.

`failed/<working name>.md`, written when the file is moved to `failed/`. Plain Markdown:

- the original name and the working name;
- when it was uploaded (as listed), picked up and finished;
- the outcome, in the Conversion page's words (`OUTCOME_LABELS`), and the reason or details the
  item carries (for example the changed components of a `changed_in_target` refusal, or the
  conversion error);
- what to do: "correct the document and upload it to the folder again" (or, for
  `changed_in_target`, that an admin must detach or accept it in CT Studio first);
- a link to the item in CT Studio.

A reason file that cannot be written is logged as a watch event and never holds the file back.

## 8. Watched folders page (admins only)

A new item in the main nav, **Watched folders**, visible to admins only, with its own help topic.
**[owner]** It is a ledger: one row per watch, opened into a detail panel.

Each row **[owner]** (contents), **[call]** (layout):

- name; the folder (as the sink describes it) and the target;
- the run-as user;
- **health**: *Running*, *Draining*, *Stopped*, or *Problem* with its reason (no connection, sign-in
  failing, folder not found, the sink does not offer watched folders any more, the sink
  unavailable); a watch is a problem after its last poll failed, and recovers on its own when a
  poll succeeds;
- **queue length**: files waiting in the root plus items queued or running;
- **throughput** **[owner]**: documents finished in the last 24 hours, and the total since the watch
  was created, each split delivered/failed; held outside the batch so deleting the batch keeps them;
- when it last picked a file up; a link to its batch on the Conversion page.

The nav item carries a badge counting watches with a problem. **[call]** No other alerting.

The detail panel shows the settings and the watch's recent events (polls that failed, pickups,
moves, reason files not written), newest first. **[call]**

Actions:

- **New watch** (the page's main button): name; sink instance and folder (`sourceFields`, with
  browse); target on that instance; force-load (off); auto-approve (on) **[owner]**; reason files
  (on); sleep when idle (default 30 s **[owner]**, §3) and `admit` **[call]**. It runs as the admin
  creating it. A test step lists the folder before saving. **[call]**
- **Reconfigure**: force-load, auto-approve, reason files, sleep and `admit` apply to the next
  pickups at any time; the folder, target or run-as user only while stopped. **[call]**
- **Stop** **[owner]**: pickups end at once, then the admin picks:
  - **Stop now**: queued items are cancelled and a running one stopped, as a cancel does today.
    Files stay wherever they are; cleaning up the bucket is up to the user;
  - **Drain**: admitted items run to the end and move as usual; nothing new is admitted. The watch
    shows *Draining* until the last one finishes, then *Stopped*.
- **Start**: picks up from the root again. **[call]** Files left in `processing/` by a stop now are
  never taken again.
- **Remove**: only once stopped. **[call]** The batch stays on the Conversion page as history; the
  counters and events go; nothing in the bucket is touched.

Ordinary users see a watch's batch on the Conversion page like any other; only this page and its
actions are admin-only. **[owner]**

## 9. Where the work runs (left to the builder, with constraints)

- Exactly one poller per watch at a time across every API and worker process (an advisory lock or
  a lease), so two processes never pick up the same file.
- The worker never serves HTTP and the API holds no conversion logic (CLAUDE.md); where the poller
  lives follows from that.
- The lane rule is enforced where conversion jobs are claimed, counting items by state (§6), and
  by the bridge for every delivery to the instance (§4).
- New routes are documented, admin-only for watches, and closed to operators except the Conversion
  page's existing batch routes.
- The usual contracts: TypeScript and Python sides together, the contract version bump, the bridge
  contract's fixtures and conformance suite, help topic in `HELP_INDEX`, release note.

## 10. Testing

- The file journey, naming, crash safety and admission as table-driven tests against a fake sink
  storage (list/read/move/put) with injected failures at each step.
- Lanes and turn-taking against a fake queue: two batches on one tenant, two tenants, lanes 1 and
  10, fewer workers than lanes; decomposing while another delivers; a waiting item whose register
  entry changed; a PDF approved into the wait; stop now and drain with items waiting.
- Stop now, drain, start, remove, batch delete while items are unfinished.
- The bridge relay and the contract against the fake sink, including a sink declaring no lanes and
  a sink without the capability.
- An end-to-end run like the conversion e2e (API, worker, bridge, fake sink) from a file in the
  root to `delivered/` and to `failed/` with its reason file.

## 11. Decomposing while delivering

**[owner]** In this work. A lane is held only while **delivering**: the next document is decomposed
while the previous one is delivered, so a one-lane tenant still receives one delivery at a time but
waits less between them. Decomposition is limited by the workers alone. This applies to every
conversion, UI batches included.

How **[call]**, built on the PDF review hold (decomposition spec §14), which already decomposes
now and delivers later:

- **A new item state, `waiting_to_deliver`**, between `decomposing` and `delivering`, counted as
  running (`RUNNING_OUTCOMES`), on both sides of the contract and on the Conversion page (label
  *Waiting to deliver*, its filters and counts).
- **The decomposed document is stored** beside the source, as a held PDF's is (the manifest and
  images, without the page images for a Word file), and the item records its sha-256. The decompose
  job then succeeds with the item waiting.
- **When a lane frees** (an item of that tenant settles, or a waiting item appears and a lane is
  free), the next item in turn (§6) is delivered from its stored copy by a job like an approved
  hold's: it re-decides through the register first, and if the entry changed since the
  decomposition it decides again from what is stored, never delivering a stale decision. The
  stored copy is deleted once the item has an outcome.
- **A PDF held for review** that is approved becomes `waiting_to_deliver`, so review and lanes
  compose.
- **Stop now** cancels waiting items (they have not reached the bridge) and deletes their stored
  copies; **drain** delivers them.
- Not chosen: handing packages to the bridge at once and letting its per-instance queue wait. The
  bridge cannot cancel a delivery it holds, so Stop now could take nothing back, and turns would go
  strictly in arrival order.

Assumption **[call]**: a tenant's limit is about deliveries only; decomposition never touches the
tenant.

## 12. Scope and order

**[owner]** The work includes the existing decomposed-document sink (its own repository, beside
this one) gaining `watchedFolders` and declaring `lanes` (1 per instance), not only the contract and
CT Studio.

Order **[call]**:

1. The contract: `lanes`, the `watchedFolders` capability and its operations, version 4, fixtures
   and the conformance suite (published first, since the sink depends on it).
2. CT Studio and the bridge, proven against the fake sink.
3. The existing sink, against the released contract.

Known risk: that sink's storage interface cannot list a storage's objects today (its delivery code
says so). Listing is the one operation the capability cannot do without, so the first task in that
repository is finding a supported way to list a folder; if there is none, the sink cannot offer the
capability and the plan stops at step 2 for it. **[call]** Other sinks add the capability in their
own work.
