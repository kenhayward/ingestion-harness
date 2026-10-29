"""One look at a watched folder (spec docs/superpowers/specs/2026-10-29-watched-folders-design.md
§3, §5-§7), in one place, `run_cycle`:

1. **Finish** each queued document whose item reached a final outcome: `processing/` to
   `delivered/` or `failed/` (with its reason file, when the watch writes them), counted.
2. **Resume** pickups a cycle left part-way: a stored copy is moved, a moved file admitted.
3. **Draining:** a draining watch with nothing unfinished stops; a draining watch never looks
   at or admits new files.
4. **Look** at the folder root: a PDF or Word file whose size and modified time are the same on
   two looks at least `SETTLE` apart is settled. A refused listing makes the watch a problem.
5. **Admit** settled files, oldest first, while fewer than `admit` are unfinished: a copy stored
   in the runs bucket, the file moved to `processing/` under its working name, then its item and
   `decompose` job queued (store.py `admit`). A file conversion would refuse goes straight to
   `failed/` with its reason.
6. **Schedule** the next look: at once after admitting or finishing, after `SETTLE` while a file
   is settling, else after the watch's sleep.

Every bridge call acts as the watch's run-as user."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from ingest_worker.bridge.client import BridgeClient, BridgeRefused, BridgeUnavailable
from ingest_worker.convert import DOCX_MIME
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
#: Final outcomes whose file goes to `delivered/`; every other final one goes to `failed/`.
DELIVERED_OUTCOMES = frozenset({"created", "updated", "already_loaded"})
#: Outcomes still on their way: the file stays in `processing/`.
NOT_FINAL = frozenset(
    {"queued", "decomposing", "delivering", "awaiting_review", "waiting_to_deliver"}
)
BridgeError = (BridgeRefused, BridgeUnavailable)
#: The Conversion page's words for an outcome (job.py `OUTCOME_LABELS`).
LABELS: dict[str, str] = {k: v for k, v in OUTCOME_LABELS.items()}


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
    #: (watch, name) pairs of files the bridge cannot address, reported once per process.
    noted: set[tuple[str, str]] = field(default_factory=set)


@dataclass(frozen=True)
class CycleResult:
    admitted: int
    finished: int
    next_look_at: datetime


def _when(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def _is_not_found(exc: Exception) -> bool:
    return isinstance(exc, BridgeRefused) and exc.error.code == "not_found"


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

    def _event(self, level: EventLevel, message: str, **details: object) -> None:
        self.store.event(self.w.id, level, message, dict(details) or None)

    def _link(self, batch_id: str) -> str | None:
        return f"{self.deps.app_url}/#/conversion/{batch_id}" if self.deps.app_url else None

    def _reason(
        self, pickup: Pickup, working: str, outcome: str, detail: str | None, batch_id: str
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
                link=self._link(batch_id),
            )
        )
        try:
            self.deps.bridge.put_source_text(
                self.w.target_id, self.w.source, FAILED, f"{working}.md", text, self.w.run_as
            )
        except BridgeError as exc:
            self._event("warn", f"could not write the reason file for {working}: {exc}")

    # --- 1. finish ---

    def finish(self) -> None:
        for p in self.store.pickups(self.w.id):
            if p.step != "queued" or p.item_id is None or p.working_name is None:
                continue
            state = self.store.item_state(p.item_id)
            if state is None:
                self.store.advance(p.id, "abandoned")
                self._event("warn", f"{p.working_name}: its conversion item is gone")
                continue
            if state.outcome in NOT_FINAL:
                continue
            delivered = state.outcome in DELIVERED_OUTCOMES
            folder = DELIVERED if delivered else FAILED
            try:
                self._move((PROCESSING, p.working_name), (folder, p.working_name))
            except BridgeError as exc:
                if not _is_not_found(exc):
                    self._event("warn", f"could not move {p.working_name} to {folder}/: {exc}")
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

    def resume(self) -> None:
        for p in self.store.pickups(self.w.id):
            if p.step == "stored":
                if not self._move_in(p):
                    continue
                p = replace(p, step="moved")
            if p.step == "moved":
                self._admit(p)

    def _move_in(self, p: Pickup) -> bool:
        """Root to `processing/` and the step `moved`; False when the move must wait."""
        assert p.working_name is not None
        try:
            self._move(("", p.original_name), (PROCESSING, p.working_name))
        except BridgeError as exc:
            if _is_not_found(exc):  # the file left the root before it was moved: forget it
                if p.object_key is not None:
                    self.deps.objects.delete(self.deps.runs_bucket, p.object_key)
                self.store.advance(p.id, "abandoned")
                self._event("warn", f"{p.original_name} left the folder before it was picked up")
            else:
                self._event("warn", f"could not move {p.original_name} to {PROCESSING}/: {exc}")
            return False
        self.store.advance(p.id, "moved")
        return True

    def _admit(self, p: Pickup) -> None:
        assert p.item_id and p.object_key and p.working_name
        data = self.deps.objects.get(self.deps.runs_bucket, p.object_key)
        self.store.admit(
            self.w,
            p,
            p.item_id,
            p.object_key,
            p.working_name,
            sha256_of(data),
            source_key(self.w.source_path, p.original_name),
            self.now,
        )
        self.admitted += 1
        self._event("info", f"picked up {p.original_name} as {p.working_name}")

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
        if self.w.problem is not None:
            self._event("info", "the folder can be read again")
        self.store.set_health(self.w.id, None, len(candidates), self.now)
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
            taken = {
                f.name for folder in (PROCESSING, DELIVERED, FAILED) for f in self._list(folder)
            }
        except BridgeError as exc:
            self._event("warn", f"could not list the folder's subfolders: {exc}")
            return
        batch_id = self.store.batch_of(self.w)
        for f, p in waiting[:room]:
            working = working_name(f.name, taken)
            taken.add(working)
            try:
                self._take(f, p, working, batch_id)
            except BridgeError as exc:
                self._event("warn", f"could not pick up {f.name}: {exc}")
                return  # the sink is likely down: the next look tries again

    def _take(self, f: SourceFile, p: Pickup, working: str, batch_id: str) -> None:
        if f.size > self.deps.max_bytes:
            self._refuse(p, working, OVER_LIMIT, UNREAD, batch_id)
            return
        data = self.deps.bridge.read_source(
            self.w.target_id, self.w.source, "", f.name, self.w.run_as
        )
        problem = source_problem(data, f.name, self.deps.max_bytes)
        if problem is not None:
            self._refuse(p, working, problem, sha256_of(data), batch_id)
            return
        item_id = str(uuid.uuid4())
        pdf = data.startswith(b"%PDF-")
        key = decomposition_source_key(batch_id, item_id, "pdf" if pdf else "docx")
        self.deps.objects.put(
            self.deps.runs_bucket, key, data, "application/pdf" if pdf else DOCX_MIME
        )
        self.store.advance(p.id, "stored", working_name=working, item_id=item_id, object_key=key)
        self._move(("", f.name), (PROCESSING, working))
        self.store.advance(p.id, "moved")
        self._admit(replace(p, step="moved", working_name=working, item_id=item_id, object_key=key))

    def _refuse(self, p: Pickup, working: str, reason: str, sha: str, batch_id: str) -> None:
        """Straight to `failed/` with its reason: a `failed` item, never stored or queued."""
        self._move(("", p.original_name), (FAILED, working))
        item_id = self.store.refuse(
            self.w,
            p,
            working,
            reason,
            sha,
            source_key(self.w.source_path, p.original_name),
            self.now,
        )
        self.finished += 1
        self._event("warn", f"{p.original_name} refused: {reason}", name=working, item=item_id)
        self._reason(p, working, "failed", reason, batch_id)


def run_cycle(w: Watch, deps: WatchDeps, now: datetime) -> CycleResult:
    """One look at watch `w` (see the module's docstring); when to look again."""
    if w.state == "stopped":
        return CycleResult(0, 0, now + timedelta(seconds=w.sleep_seconds))
    c = _Cycle(w, deps, now)
    c.finish()
    c.resume()
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
