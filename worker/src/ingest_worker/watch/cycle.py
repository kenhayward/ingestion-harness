"""One look at a watched folder (spec docs/superpowers/specs/2026-10-29-watched-folders-design.md
§3, §5-§7), in one place, `run_cycle`:

1. **Finish** each queued document whose item reached a final outcome: `processing/` to
   `delivered/` or `failed/` (with its reason file, when the watch writes them), counted.
2. **Resume** pickups a cycle left part-way, each on its own (one that fails is reported and
   left, never stopping the rest): a stored copy is moved (only while the root still holds that
   very file), a moved file admitted, a refused file filed in `failed/`.
3. **Draining:** a draining watch with nothing unfinished stops; a draining watch never looks
   at or admits new files.
4. **Look** at the folder root: a PDF or Word file whose size and modified time are the same on
   two looks at least `SETTLE` apart is settled. A refused listing makes the watch a problem.
5. **Admit** settled files, oldest first, while fewer than `admit` are unfinished: a copy stored
   in the runs bucket, the file moved to `processing/` under its working name, then its item and
   `decompose` job queued (store.py `admit`). A file conversion would refuse is recorded as a
   `failed` item first, then goes straight to `failed/` with its reason.
6. **Schedule** the next look: at once after admitting or finishing, after `SETTLE` while a file
   is settling, else after the watch's sleep.

A working name another file took meanwhile (`destination_exists`) is replaced by the next free
one. A move the sink refuses `MAX_MOVE_TRIES` times is not tried again: the watch shows a problem.

Every bridge call acts as the watch's run-as user."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, get_args

import psycopg

from ingest_worker.bridge.client import BridgeClient, BridgeRefused, BridgeUnavailable
from ingest_worker.convert import DOCX_MIME
from ingest_worker.decompose import items
from ingest_worker.decompose.job import OUTCOME_LABELS
from ingest_worker.storage import decomposition_source_key
from ingest_worker.watch.naming import is_candidate, name_problem, source_key, working_name
from ingest_worker.watch.reason import ReasonFacts, advice_for, reason_markdown
from ingest_worker.watch.sources import OVER_LIMIT, source_problem
from ingest_worker.watch.store import (
    IN_PROGRESS,
    UNREAD,
    EventLevel,
    Pickup,
    Watch,
    WatchStore,
    modified_of,
    sha256_of,
)

if TYPE_CHECKING:
    from ingest_worker.bridge.models import SourceFile
    from ingest_worker.storage import ObjectStore

log = logging.getLogger(__name__)

#: How long a file's size and modified time must hold before it is taken.
SETTLE = timedelta(seconds=10)
PROCESSING, DELIVERED, FAILED = "processing", "delivered", "failed"
SUBFOLDERS = (PROCESSING, DELIVERED, FAILED)
#: Moves the sink may refuse for one pickup before the worker stops trying it.
MAX_MOVE_TRIES = 5

ALL_OUTCOMES: frozenset[str] = frozenset(get_args(items.ItemOutcome))
#: Outcomes still on their way: the file stays in `processing/` (a held PDF waits on a person).
STILL_RUNNING: frozenset[str] = frozenset((*items.UNDECIDED, *items.NOT_FINAL, "awaiting_review"))
#: Final outcomes whose file goes to `delivered/` (spec §3).
DELIVERED_OUTCOMES: frozenset[str] = frozenset({"created", "updated", "already_loaded"})
#: Every other final outcome: the file goes to `failed/`.
FAILED_OUTCOMES: frozenset[str] = ALL_OUTCOMES - STILL_RUNNING - DELIVERED_OUTCOMES

BridgeError = (BridgeRefused, BridgeUnavailable)
#: The Conversion page's words for an outcome (job.py `OUTCOME_LABELS`).
LABELS: dict[str, str] = {k: v for k, v in OUTCOME_LABELS.items()}
#: The reason a moved file whose stored copy is gone is filed in `failed/`.
LOST_COPY = "CT Studio lost its copy of the file before converting it"


@dataclass
class WatchDeps:
    store: WatchStore
    bridge: BridgeClient
    objects: ObjectStore
    runs_bucket: str
    #: The largest file taken (the API's `MAX_UPLOAD_MB`).
    max_bytes: int
    #: `APP_PUBLIC_URL`: the reason file links the watch's batch when it is set.
    app_url: str | None
    #: Things reported once per process: (watch, file name) the bridge cannot address, and
    #: (watch, item id) whose outcome the worker does not know.
    noted: set[tuple[str, str]] = field(default_factory=set)


@dataclass(frozen=True)
class CycleResult:
    admitted: int
    finished: int
    next_look_at: datetime


def _when(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def _code(exc: Exception) -> str | None:
    return exc.error.code if isinstance(exc, BridgeRefused) else None


def stuck_problem(count: int) -> str:
    files = "1 document" if count == 1 else f"{count} documents"
    return (
        f"{files} could not be moved out of {PROCESSING}/ or the folder root after "
        f"{MAX_MOVE_TRIES} tries: see the watch's events"
    )


class _Cycle:
    def __init__(self, w: Watch, deps: WatchDeps, now: datetime) -> None:
        self.w, self.deps, self.now = w, deps, now
        self.store = deps.store
        self.admitted = 0
        self.finished = 0
        self.settling = False

    # --- the bridge, as the run-as user ---

    def _list(self, folder: str) -> list[SourceFile]:
        return self.deps.bridge.list_source(self.w.target_id, self.w.source, folder, self.w.run_as)

    def _move(self, src: tuple[str, str], dst: tuple[str, str]) -> None:
        self.deps.bridge.move_source(self.w.target_id, self.w.source, src, dst, self.w.run_as)

    def _taken(self) -> set[str]:
        """Names in use: every file in the three subfolders, and the working names of the open
        pickups, which may not be there yet (stored, refusing) or any more."""
        listed = {f.name for folder in SUBFOLDERS for f in self._list(folder)}
        reserved = {
            p.working_name
            for p in self.store.pickups(self.w.id)
            if p.step in IN_PROGRESS and p.working_name is not None
        }
        return listed | reserved

    def _event(self, level: EventLevel, message: str, **details: object) -> None:
        self.store.event(self.w.id, level, message, dict(details) or None)

    def _link(self, batch_id: str) -> str | None:
        return f"{self.deps.app_url}/#/conversion/{batch_id}" if self.deps.app_url else None

    def _reason(
        self, pickup: Pickup, working: str, outcome: str, detail: str | None, batch_id: str | None
    ) -> None:
        """`failed/<working>.md`, when the watch writes them; a failure is an event only."""
        if not self.w.reason_files:
            return
        text = reason_markdown(
            ReasonFacts(
                original_name=pickup.original_name,
                working_name=working,
                uploaded_at=_when(pickup.modified_at),
                picked_up_at=_when(pickup.first_seen_at),
                finished_at=_when(self.now),
                outcome_label=LABELS.get(outcome, outcome),
                detail=detail,
                advice=advice_for(outcome),
                link=self._link(batch_id) if batch_id else None,
            )
        )
        try:
            self.deps.bridge.put_source_text(
                self.w.target_id, self.w.source, FAILED, f"{working}.md", text, self.w.run_as
            )
        except BridgeError as exc:
            self._event("warn", f"could not write the reason file for {working}: {exc}")

    def _refused_move(self, p: Pickup, what: str, exc: Exception) -> None:
        """A move the sink refused (an outage is not counted): warn, and after `MAX_MOVE_TRIES`
        stop trying the pickup, with an error event (the watch then shows a problem)."""
        if not isinstance(exc, BridgeRefused):
            self._event("warn", f"could not move {what}: {exc}")
            return
        tries = self.store.move_failed(p.id)
        if tries >= MAX_MOVE_TRIES:
            self._event(
                "error",
                f"could not move {what} after {tries} tries, so it is no longer tried: {exc}",
                pickup=p.id,
            )
        else:
            self._event("warn", f"could not move {what}: {exc}")

    def _from_root(self, p: Pickup, folder: str) -> Pickup:
        """Move `p`'s file from the root to `folder` under its working name; when another file
        took that name meanwhile, under the next free one (recorded first). The pickup as moved."""
        assert p.working_name is not None
        try:
            self._move(("", p.original_name), (folder, p.working_name))
            return p
        except BridgeRefused as exc:
            if exc.error.code != "destination_exists":
                raise
        renamed = working_name(p.original_name, self._taken())
        self.store.advance(p.id, p.step, working_name=renamed)
        self._event("info", f"{p.working_name} was taken: {p.original_name} is kept as {renamed}")
        p = replace(p, working_name=renamed)
        self._move(("", p.original_name), (folder, renamed))
        return p

    # --- 1. finish ---

    def finish(self) -> None:
        for p in self.store.pickups(self.w.id):
            if p.step != "queued" or p.item_id is None or p.working_name is None:
                continue
            if p.move_failures >= MAX_MOVE_TRIES:
                continue  # stuck: shown as the watch's problem
            state = self.store.item_state(p.item_id)
            if state is None:
                self.store.advance(p.id, "abandoned")
                self._event("warn", f"{p.working_name}: its conversion item is gone")
                continue
            if state.outcome in STILL_RUNNING:
                continue
            if state.outcome not in ALL_OUTCOMES:
                if (self.w.id, p.item_id) not in self.deps.noted:
                    self.deps.noted.add((self.w.id, p.item_id))
                    self._event(
                        "warn",
                        f"{p.working_name}: unknown outcome {state.outcome}, left in {PROCESSING}/",
                    )
                continue
            delivered = state.outcome in DELIVERED_OUTCOMES
            folder = DELIVERED if delivered else FAILED
            try:
                self._move((PROCESSING, p.working_name), (folder, p.working_name))
            except BridgeError as exc:
                if _code(exc) != "not_found":
                    self._refused_move(p, f"{p.working_name} to {folder}/", exc)
                    continue
                self._event("warn", f"{p.working_name} was no longer in {PROCESSING}/")
            if not delivered:
                self._reason(p, p.working_name, state.outcome, state.detail, state.batch_id)
            self.store.finish(self.w.id, delivered, self.now, p.id)
            self.finished += 1
            self._event(
                "info",
                f"{p.working_name}: {LABELS.get(state.outcome, state.outcome)}",
                name=p.working_name,
                outcome=state.outcome,
            )

    # --- 2. resume ---

    def show_stuck(self) -> None:
        """The watch's problem while pickups are stuck (running or draining)."""
        stuck = sum(1 for p in self.store.pickups(self.w.id) if p.move_failures >= MAX_MOVE_TRIES)
        problem = stuck_problem(stuck) if stuck else None
        if problem != self.w.problem and (problem is not None or self.w.state == "draining"):
            self.store.set_health(self.w.id, problem, None, self.now)

    def resume(self) -> None:
        pending = [
            p
            for p in self.store.pickups(self.w.id)
            if p.step in ("stored", "moved", "refusing") and p.move_failures < MAX_MOVE_TRIES
        ]
        root: list[SourceFile] | None = None
        if any(p.step != "moved" for p in pending):
            try:
                root = self._list("")
            except BridgeError as exc:
                self._event("warn", f"could not list the folder to resume pickups: {exc}")
        for p in pending:
            if p.step != "moved" and root is None:
                continue
            try:
                if p.step == "moved":
                    self._admit_moved(p)
                elif p.step == "stored":
                    assert root is not None
                    self._resume_stored(p, root)
                else:
                    assert root is not None
                    self._resume_refusing(p, root)
            except BridgeError as exc:
                if isinstance(exc, BridgeRefused):
                    self._refused_move(p, f"{p.original_name} while resuming it", exc)
                else:
                    self._event("warn", f"could not resume {p.original_name}: {exc}")
            except psycopg.OperationalError:
                raise
            except Exception as exc:
                log.warning("watch %s: resuming %s failed", self.w.name, p.id, exc_info=True)
                self._event("error", f"could not resume {p.original_name}: {exc}")

    @staticmethod
    def _in_root(p: Pickup, root: list[SourceFile]) -> bool:
        """The root still holds the very file the pickup took (same size and modified time)."""
        return any(
            f.name == p.original_name and f.size == p.size and modified_of(f) == p.modified_at
            for f in root
        )

    def _in_folder(self, folder: str, p: Pickup, name: str) -> bool:
        """`folder` holds the pickup's own file under `name`: same size and modified time."""
        return any(
            f.name == name and f.size == p.size and modified_of(f) == p.modified_at
            for f in self._list(folder)
        )

    def _resume_stored(self, p: Pickup, root: list[SourceFile]) -> None:
        working = p.working_name
        assert working is not None
        if self._in_root(p, root):
            p = self._from_root(p, PROCESSING)
        elif not self._in_folder(PROCESSING, p, working):
            # Gone, or replaced by another upload: the copy is stale; the new file, if any, is a
            # fresh candidate.
            if p.object_key is not None:
                self.deps.objects.delete(self.deps.runs_bucket, p.object_key)
            self.store.advance(p.id, "abandoned")
            self._event(
                "warn",
                f"{p.original_name} left the folder or changed before it was picked up",
                name=p.original_name,
            )
            return
        # Moved (now, or before the worker stopped): record it, then queue it.
        self.store.advance(p.id, "moved")
        self._admit_moved(replace(p, step="moved"))

    def _admit_moved(self, p: Pickup) -> None:
        assert p.item_id and p.object_key and p.working_name
        data = self.deps.objects.get_optional(self.deps.runs_bucket, p.object_key)
        if data is None:
            self._lost_copy(p)
            return
        self._queue(p, sha256_of(data))

    def _lost_copy(self, p: Pickup) -> None:
        """A moved file whose stored copy is gone: filed in `failed/` with its reason and
        abandoned (the person uploads it again). Moving first makes a retry harmless."""
        assert p.working_name is not None
        try:
            self._move((PROCESSING, p.working_name), (FAILED, p.working_name))
        except BridgeRefused as exc:
            if exc.error.code != "not_found":
                raise
        self._reason(p, p.working_name, "failed", LOST_COPY, self.w.batch_id)
        self.store.advance(p.id, "abandoned")
        self._event("warn", f"{p.working_name}: {LOST_COPY}", name=p.working_name)

    def _resume_refusing(self, p: Pickup, root: list[SourceFile]) -> None:
        if self._in_root(p, root):
            p = self._from_root(p, FAILED)
        else:
            self._event(
                "warn",
                f"{p.original_name} was refused but left the folder root before it was filed",
            )
        self._file_refused(p)

    def _queue(self, p: Pickup, sha: str) -> None:
        assert p.item_id and p.object_key and p.working_name
        if self.store.admit(
            self.w,
            p,
            p.item_id,
            p.object_key,
            p.working_name,
            sha,
            source_key(self.w.source_path, p.original_name),
            self.now,
        ):
            self.admitted += 1
            self._event("info", f"picked up {p.original_name} as {p.working_name}")

    def _file_refused(self, p: Pickup) -> None:
        """A refused file in `failed/` (or gone): its reason file, then the finish."""
        assert p.item_id and p.working_name
        state = self.store.item_state(p.item_id)
        detail = state.detail if state else None
        self._reason(p, p.working_name, "failed", detail, state.batch_id if state else None)
        self.store.finish(self.w.id, False, self.now, p.id)
        self.finished += 1
        self._event(
            "warn", f"{p.original_name} refused: {detail}", name=p.working_name, item=p.item_id
        )

    # --- 4. look ---

    def look(self) -> list[tuple[SourceFile, Pickup]] | None:
        """The settled candidates and their pickups; None when the root could not be listed."""
        try:
            listed = self._list("")
        except BridgeError as exc:
            if self.w.problem != str(exc):
                self._event("error", str(exc))
            self.store.set_health(self.w.id, str(exc), None, self.now)
            return None
        candidates = []
        for f in listed:
            if is_candidate(f.name):
                candidates.append(f)
            elif (
                name_problem(f.name) is not None
                and f.name.lower().endswith((".pdf", ".docx"))
                and (self.w.id, f.name) not in self.deps.noted
            ):
                self.deps.noted.add((self.w.id, f.name))
                self._event("warn", f"left in the folder: {name_problem(f.name)}", name=f.name)
        stuck = sum(1 for p in self.store.pickups(self.w.id) if p.move_failures >= MAX_MOVE_TRIES)
        problem = stuck_problem(stuck) if stuck else None
        if self.w.problem is not None and problem is None:
            self._event("info", "the folder can be read again")
        self.store.set_health(self.w.id, problem, len(candidates), self.now)
        for f in candidates:
            self.store.see(self.w.id, f, self.now)
        pickups = {
            (p.original_name, p.size, p.modified_at): p for p in self.store.pickups(self.w.id)
        }
        settled: list[tuple[SourceFile, Pickup]] = []
        listed_ids: set[str] = set()
        for f in candidates:
            p = pickups.get((f.name, f.size, modified_of(f)))
            if p is None or p.step != "seen":
                continue  # on its way already (or a new copy of a name in progress)
            listed_ids.add(p.id)
            if p.first_seen_at <= self.now - SETTLE:
                settled.append((f, p))
            else:
                self.settling = True
        self.store.forget_unlisted(self.w.id, listed_ids)
        return settled

    # --- 5. admit ---

    def admit(self, settled: list[tuple[SourceFile, Pickup]]) -> None:
        in_progress = [p for p in self.store.pickups(self.w.id) if p.step in IN_PROGRESS]
        busy = {p.original_name for p in in_progress}
        room = self.w.admit - len(in_progress)
        waiting = sorted(
            (fp for fp in settled if fp[0].name not in busy),
            key=lambda fp: (fp[1].modified_at, fp[0].name),
        )
        if room <= 0 or not waiting:
            return
        try:
            taken = self._taken()
        except BridgeError as exc:
            self._event("warn", f"could not list the folder's subfolders: {exc}")
            return
        batch_id = self.store.batch_of(self.w)
        for f, p in waiting[:room]:
            working = working_name(f.name, taken)
            taken.add(working)
            try:
                p = self._take(f, p, working, batch_id)
            except BridgeError as exc:
                self._event("warn", f"could not pick up {f.name}: {exc}")
                return  # the sink is likely down: the next look tries again
            if p.working_name:
                taken.add(p.working_name)

    def _take(self, f: SourceFile, p: Pickup, working: str, batch_id: str) -> Pickup:
        if f.size > self.deps.max_bytes:
            return self._refuse(p, working, OVER_LIMIT, UNREAD)
        data = self.deps.bridge.read_source(
            self.w.target_id, self.w.source, "", f.name, self.w.run_as
        )
        problem = source_problem(data, f.name, self.deps.max_bytes)
        if problem is not None:
            return self._refuse(p, working, problem, sha256_of(data))
        item_id = str(uuid.uuid4())
        pdf = data.startswith(b"%PDF-")
        key = decomposition_source_key(batch_id, item_id, "pdf" if pdf else "docx")
        self.deps.objects.put(
            self.deps.runs_bucket, key, data, "application/pdf" if pdf else DOCX_MIME
        )
        self.store.advance(p.id, "stored", working_name=working, item_id=item_id, object_key=key)
        p = replace(p, step="stored", working_name=working, item_id=item_id, object_key=key)
        p = self._from_root(p, PROCESSING)
        self.store.advance(p.id, "moved")
        p = replace(p, step="moved")
        self._queue(p, sha256_of(data))  # the bytes in hand: no read back
        return p

    def _refuse(self, p: Pickup, working: str, reason: str, sha: str) -> Pickup:
        """Recorded first (a `failed` item, the pickup `refusing`), then moved straight to
        `failed/`, then its reason file and the finish: a stop anywhere is completed by resume."""
        item_id = self.store.refuse(
            self.w,
            p,
            working,
            reason,
            sha,
            source_key(self.w.source_path, p.original_name),
            self.now,
        )
        if not item_id:
            return p  # no longer `seen`: another runner, or a stop, has it
        p = replace(p, step="refusing", working_name=working, item_id=item_id)
        p = self._from_root(p, FAILED)
        self._file_refused(p)
        return p


def run_cycle(w: Watch, deps: WatchDeps, now: datetime) -> CycleResult:
    """One look at watch `w` (see the module's docstring); when to look again."""
    if w.state == "stopped":
        return CycleResult(0, 0, now + timedelta(seconds=w.sleep_seconds))
    c = _Cycle(w, deps, now)
    c.finish()
    c.resume()
    c.show_stuck()
    if w.state == "draining":
        if not any(p.step in IN_PROGRESS for p in deps.store.pickups(w.id)):
            deps.store.set_state(w.id, "stopped", expect="draining")
            deps.store.event(w.id, "info", "drained: every document has finished", None)
    else:
        settled = c.look()
        if settled is None:
            return CycleResult(0, c.finished, now + timedelta(seconds=w.sleep_seconds))
        c.admit(settled)
    if c.admitted or c.finished:
        nxt = now
    elif c.settling:
        nxt = now + SETTLE
    else:
        nxt = now + timedelta(seconds=w.sleep_seconds)
    return CycleResult(c.admitted, c.finished, nxt)
