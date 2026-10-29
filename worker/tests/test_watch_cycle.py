"""The watch cycle (watch/cycle.py) over a memory store, the fake bridge's folders and a memory
object store, with a frozen clock: a file's journey from the folder root to `processing/` and on
to `delivered/` or `failed/`, crash safety at each step, admission and the watch's health."""

from __future__ import annotations

import io
import uuid
import zipfile
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from ingest_worker.bridge.client import BridgeRefused, BridgeUnavailable
from ingest_worker.bridge.models import ActingUser, BridgeError
from ingest_worker.convert import DOCX_MAIN_TYPE
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.watch.cycle import CycleResult, WatchDeps, run_cycle
from ingest_worker.watch.runner import MemoryWatchLocks, WatchRunner

from .fakes import FakeBridge, MemoryWatchStore

TARGET = "docs"
SOURCE = {"folder": "Plant A/Intake"}
PATH = "Plant A/Intake"
T0 = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)
USER = ActingUser(id=str(uuid.uuid4()), name="Ada", email="ada@example.com")
NOT_A_SOURCE = "file is not a PDF or Word document (.docx)"


def pdf(text: str = "hello") -> bytes:
    return b"%PDF-1.7\n" + text.encode() + b"\n%%EOF"


def docx(text: str = "x") -> bytes:
    types = (
        f'<Types><Override PartName="/word/document.xml" ContentType="{DOCX_MAIN_TYPE}"/></Types>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("word/document.xml", f"<w:document><w:body>{text}</w:body></w:document>")
    return buf.getvalue()


class World:
    def __init__(self, **settings: Any) -> None:
        self.store = MemoryWatchStore()
        self.watch_id = self.store.add_watch(
            target_id=TARGET,
            source=SOURCE,
            source_path=PATH,
            run_as=USER,
            state=settings.pop("state", "running"),
            **settings,
        )
        self.bridge = FakeBridge(sinks={TARGET})
        self.objects = MemoryObjectStore()
        self.deps = WatchDeps(
            store=self.store,
            bridge=self.bridge,
            objects=self.objects,
            runs_bucket="runs",
            max_bytes=10**6,
            app_url="https://ct.example",
        )

    def drop(self, name: str, data: bytes, modified: str | None = None) -> None:
        key = FakeBridge.source_key(TARGET, SOURCE, "", name)
        self.bridge.sources[key] = data
        if modified is not None:
            self.bridge.modified[key] = modified

    def files(self, folder: str) -> dict[str, bytes]:
        return {
            k[3]: v
            for k, v in self.bridge.sources.items()
            if k[:3] == (TARGET, tuple(sorted(SOURCE.items())), folder)
        }

    def cycle(self, at: datetime) -> CycleResult:
        watch = self.store.watch(self.watch_id)
        assert watch is not None
        return run_cycle(watch, self.deps, at)

    def admitted(self, name: str, data: bytes, at: datetime = T0) -> str:
        """Drop `name` and run the two looks that admit it; its item id."""
        before = set(self.store.items)
        self.drop(name, data)
        self.cycle(at)
        assert self.cycle(at + timedelta(seconds=10)).admitted == 1
        (item_id,) = set(self.store.items) - before
        return item_id


def test_a_settled_file_is_picked_up() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    first = w.cycle(T0)
    assert first == CycleResult(admitted=0, finished=0, next_look_at=T0 + timedelta(seconds=10))
    assert set(w.files("")) == {"a.pdf"} and w.files("processing") == {}

    second = w.cycle(T0 + timedelta(seconds=10))
    assert second.admitted == 1 and second.next_look_at == T0 + timedelta(seconds=10)
    assert w.files("") == {} and w.files("processing") == {"a.pdf": pdf()}
    (item,) = w.store.items.values()
    assert item["source_key"] == "Plant A/Intake/a.pdf"
    assert item["filename"] == "a.pdf" and item["watched"] is True
    assert item["outcome"] == "queued"
    batch = w.store.batches[item["batch_id"]]
    assert batch["state"] == "started" and batch["watch_id"] == w.watch_id
    assert batch["created_by"] == {"id": USER.id, "name": "Ada"}
    assert batch["auto_approve"] is True and batch["force"] is False
    (job,) = w.store.jobs
    assert job["task"] == "decompose" and job["priority"] == 0 and job["max_attempts"] == 3
    assert job["created_by"] == "Ada" and job["created_by_user"] == USER.id
    assert job["params"] == {
        "batchId": item["batch_id"],
        "itemId": item["id"],
        "targetId": TARGET,
        "sourceKey": "Plant A/Intake/a.pdf",
        "force": False,
        "autoApprove": True,
    }
    assert item["job_id"] == job["id"]
    assert w.objects.get("runs", item["object_key"]) == pdf()
    assert item["object_key"] == f"decompositions/{item['batch_id']}/{item['id']}.pdf"
    watch = w.store.watch(w.watch_id)
    assert watch is not None and watch.batch_id == item["batch_id"]


def test_a_watch_without_auto_approve_leaves_it_out_of_the_job() -> None:
    w = World(auto_approve=False, force=True)
    w.admitted("a.pdf", pdf())
    (job,) = w.store.jobs
    assert "autoApprove" not in job["params"] and job["params"]["force"] is True


def test_a_growing_file_is_not_admitted() -> None:
    w = World()
    w.drop("a.pdf", pdf("part"))
    w.cycle(T0)
    w.drop("a.pdf", pdf("partly uploaded"))
    grew = w.cycle(T0 + timedelta(seconds=10))
    assert grew.admitted == 0 and grew.next_look_at == T0 + timedelta(seconds=20)
    assert set(w.files("")) == {"a.pdf"}
    assert w.cycle(T0 + timedelta(seconds=20)).admitted == 1
    assert w.files("processing") == {"a.pdf": pdf("partly uploaded")}


def test_a_file_whose_modified_time_moves_is_not_admitted() -> None:
    w = World()
    w.drop("a.pdf", pdf(), modified="2026-10-29T11:00:00.000Z")
    w.cycle(T0)
    w.drop("a.pdf", pdf(), modified="2026-10-29T11:00:05.000Z")
    assert w.cycle(T0 + timedelta(seconds=10)).admitted == 0
    assert w.cycle(T0 + timedelta(seconds=20)).admitted == 1


@pytest.mark.parametrize("outcome", ["created", "updated", "already_loaded"])
def test_a_delivered_document_moves_to_delivered(outcome: str) -> None:
    w = World()
    item_id = w.admitted("a.pdf", pdf())
    w.store.set_outcome(item_id, outcome)
    done = w.cycle(T0 + timedelta(seconds=40))
    assert done.finished == 1 and done.next_look_at == T0 + timedelta(seconds=40)
    assert w.files("processing") == {} and w.files("delivered") == {"a.pdf": pdf()}
    assert w.files("failed") == {}
    assert w.store.finishes == [(w.watch_id, True, T0 + timedelta(seconds=40))]
    watch = w.store.watched[w.watch_id]
    assert (watch["total_delivered"], watch["total_failed"]) == (1, 0)


@pytest.mark.parametrize(
    ("outcome", "label"),
    [
        ("duplicate", "duplicate"),
        ("changed_in_target", "changed in target"),
        ("read_back_mismatch", "read-back mismatch"),
        ("unresolved", "unresolved"),
        ("failed", "failed"),
        ("rejected", "rejected"),
    ],
)
def test_a_document_not_loaded_moves_to_failed_with_its_reason(outcome: str, label: str) -> None:
    w = World()
    item_id = w.admitted("a.pdf", pdf())
    w.store.set_outcome(item_id, outcome, detail="the same document is loaded as D-1")
    assert w.cycle(T0 + timedelta(seconds=40)).finished == 1
    failed = w.files("failed")
    assert failed["a.pdf"] == pdf()
    reason = failed["a.pdf.md"].decode()
    assert f"**Result:** {label}" in reason
    assert "the same document is loaded as D-1" in reason
    batch_id = w.store.items[item_id]["batch_id"]
    assert f"https://ct.example/#/conversion/{batch_id}" in reason
    assert w.store.finishes == [(w.watch_id, False, T0 + timedelta(seconds=40))]


@pytest.mark.parametrize("outcome", ["delivering", "awaiting_review", "waiting_to_deliver"])
def test_a_document_still_on_its_way_stays_in_processing(outcome: str) -> None:
    w = World()
    item_id = w.admitted("a.pdf", pdf())
    w.store.set_outcome(item_id, outcome)
    assert w.cycle(T0 + timedelta(seconds=40)).finished == 0
    assert set(w.files("processing")) == {"a.pdf"}


def test_reason_files_off_writes_none() -> None:
    w = World(reason_files=False)
    item_id = w.admitted("a.pdf", pdf())
    w.store.set_outcome(item_id, "duplicate")
    w.cycle(T0 + timedelta(seconds=40))
    assert set(w.files("failed")) == {"a.pdf"}


def test_a_reason_file_that_cannot_be_written_is_an_event_and_never_holds_the_file() -> None:
    w = World()
    item_id = w.admitted("a.pdf", pdf())
    w.store.set_outcome(item_id, "duplicate")
    w.bridge.fail_next["put"] = BridgeUnavailable("the sink is down")
    assert w.cycle(T0 + timedelta(seconds=40)).finished == 1
    assert set(w.files("failed")) == {"a.pdf"}
    assert any(e["level"] == "warn" and "reason file" in e["message"] for e in w.store.events)


def test_a_second_upload_of_a_name_in_progress_waits_then_updates() -> None:
    w = World()
    first = w.admitted("report.docx", docx("first"))
    w.drop("report.docx", docx("edited, longer"))
    w.cycle(T0 + timedelta(seconds=20))
    waits = w.cycle(T0 + timedelta(seconds=30))
    assert waits.admitted == 0 and set(w.files("")) == {"report.docx"}

    w.store.set_outcome(first, "created")
    after = w.cycle(T0 + timedelta(seconds=40))
    assert after.finished == 1 and after.admitted == 1
    assert w.files("delivered") == {"report.docx": docx("first")}
    assert w.files("processing") == {"report_1.docx": docx("edited, longer")}
    second = next(i for i in w.store.items.values() if i["id"] != first)
    assert second["filename"] == "report_1.docx"
    assert (
        second["source_key"] == w.store.items[first]["source_key"] == "Plant A/Intake/report.docx"
    )
    assert second["batch_id"] == w.store.items[first]["batch_id"]


def test_a_pickup_interrupted_after_storing_resumes_once() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    w.bridge.fail_next["move"] = BridgeUnavailable("the sink is down")
    assert w.cycle(T0 + timedelta(seconds=10)).admitted == 0
    assert set(w.files("")) == {"a.pdf"} and len(w.objects.objects) == 1
    (pickup,) = w.store.pickups(w.watch_id)
    assert pickup.step == "stored"

    resumed = w.cycle(T0 + timedelta(seconds=20))
    assert resumed.admitted == 1
    assert w.files("") == {} and set(w.files("processing")) == {"a.pdf"}
    assert len(w.store.items) == 1 and len(w.store.jobs) == 1 and len(w.objects.objects) == 1


def test_a_pickup_interrupted_between_moving_and_recording_it_resumes_once() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    w.store.fail_next["advance:moved"] = RuntimeError("the worker stopped")
    with pytest.raises(RuntimeError):
        w.cycle(T0 + timedelta(seconds=10))
    assert w.files("") == {} and set(w.files("processing")) == {"a.pdf"}
    assert w.store.pickups(w.watch_id)[0].step == "stored"

    assert w.cycle(T0 + timedelta(seconds=20)).admitted == 1
    assert set(w.files("processing")) == {"a.pdf"}
    assert len(w.store.items) == 1 and len(w.store.jobs) == 1 and len(w.objects.objects) == 1


def test_a_pickup_interrupted_after_moving_resumes_once() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    w.store.fail_next["admit"] = RuntimeError("the database is down")
    with pytest.raises(RuntimeError):
        w.cycle(T0 + timedelta(seconds=10))
    assert w.store.pickups(w.watch_id)[0].step == "moved"
    assert w.store.items == {} and w.store.jobs == []

    assert w.cycle(T0 + timedelta(seconds=20)).admitted == 1
    assert len(w.store.items) == 1 and len(w.store.jobs) == 1 and len(w.objects.objects) == 1
    (item,) = w.store.items.values()
    assert item["content_sha256"] and item["size_bytes"] == len(pdf())


def test_a_stored_file_gone_from_the_root_is_abandoned() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    w.bridge.fail_next["move"] = BridgeUnavailable("the sink is down")
    w.cycle(T0 + timedelta(seconds=10))
    w.bridge.sources.clear()  # someone deleted it meanwhile
    w.cycle(T0 + timedelta(seconds=20))
    assert w.store.pickups(w.watch_id) == []
    assert w.objects.objects == {} and w.store.items == {}


def test_admit_caps_unfinished_items() -> None:
    w = World()
    for n in range(15):
        w.drop(f"f{n:02}.pdf", pdf(str(n)))
    w.cycle(T0)
    assert w.cycle(T0 + timedelta(seconds=10)).admitted == 10
    assert len(w.files("")) == 5 and len(w.files("processing")) == 10
    full = w.cycle(T0 + timedelta(seconds=11))
    assert full.admitted == 0 and full.next_look_at == T0 + timedelta(seconds=41)

    for item_id in list(w.store.items)[:3]:
        w.store.set_outcome(item_id, "created")
    freed = w.cycle(T0 + timedelta(seconds=12))
    assert freed.finished == 3 and freed.admitted == 3
    assert len(w.files("")) == 2 and len(w.files("processing")) == 10


def test_admits_the_oldest_modified_first() -> None:
    w = World(admit=1)
    w.drop("b.pdf", pdf("b"), modified="2026-10-29T09:00:00.000Z")
    w.drop("a.pdf", pdf("a"), modified="2026-10-29T10:00:00.000Z")
    w.cycle(T0)
    w.cycle(T0 + timedelta(seconds=10))
    assert set(w.files("processing")) == {"b.pdf"}


def test_an_invalid_file_goes_straight_to_failed() -> None:
    w = World()
    w.drop("x.pdf", b"random bytes, not a document")
    w.cycle(T0)
    done = w.cycle(T0 + timedelta(seconds=10))
    assert done.admitted == 0 and done.finished == 1
    assert w.files("") == {} and w.files("processing") == {}
    failed = w.files("failed")
    assert failed["x.pdf"] == b"random bytes, not a document"
    assert NOT_A_SOURCE in failed["x.pdf.md"].decode()
    (item,) = w.store.items.values()
    assert item["outcome"] == "failed" and item["detail"] == NOT_A_SOURCE
    assert item["object_key"] is None and item["watched"] is True
    assert w.store.jobs == [] and w.objects.objects == {}
    assert w.store.finishes == [(w.watch_id, False, T0 + timedelta(seconds=10))]
    assert w.store.pickups(w.watch_id) == []


def test_a_file_over_the_limit_goes_to_failed_unread() -> None:
    w = World()
    w.deps = WatchDeps(
        store=w.store,
        bridge=w.bridge,
        objects=w.objects,
        runs_bucket="runs",
        max_bytes=10,
        app_url=None,
    )
    w.drop("big.pdf", pdf("much more than ten bytes"))
    w.cycle(T0)
    w.bridge.fail_next["read"] = AssertionError("an oversized file is never read")
    w.cycle(T0 + timedelta(seconds=10))
    reason = w.files("failed")["big.pdf.md"].decode()
    assert "file is larger than the upload limit" in reason
    assert "conversion/" not in reason  # no link without APP_PUBLIC_URL
    (item,) = w.store.items.values()
    assert item["outcome"] == "failed" and item["object_key"] is None


def test_a_missing_connection_makes_the_watch_a_problem() -> None:
    w = World(sleep_seconds=60)
    message = "Ada has no connection for docs: add one on the connections page"
    w.bridge.fail_next["list"] = BridgeRefused(
        BridgeError.model_validate(
            {"class": "needs_user", "code": "connection_missing", "message": message}
        )
    )
    down = w.cycle(T0)
    assert down == CycleResult(admitted=0, finished=0, next_look_at=T0 + timedelta(seconds=60))
    watch = w.store.watch(w.watch_id)
    assert watch is not None and watch.problem == message
    assert [e["level"] for e in w.store.events] == ["error"]

    w.drop("a.pdf", pdf())
    w.cycle(T0 + timedelta(seconds=60))
    watch = w.store.watch(w.watch_id)
    assert watch is not None and watch.problem is None
    assert w.store.watched[w.watch_id]["root_waiting"] == 1


def test_an_unchanged_problem_is_reported_once() -> None:
    w = World()
    for n in range(2):
        w.bridge.fail_next["list"] = BridgeUnavailable("the bridge is down")
        w.cycle(T0 + timedelta(minutes=n))
    assert [e["level"] for e in w.store.events] == ["error"]


def test_draining_stops_once_the_last_item_finishes() -> None:
    w = World()
    item_id = w.admitted("a.pdf", pdf())
    w.store.set_state(w.watch_id, "draining")
    w.drop("b.pdf", pdf("b"))
    w.cycle(T0 + timedelta(seconds=20))
    w.cycle(T0 + timedelta(seconds=30))
    assert set(w.files("")) == {"b.pdf"}
    assert w.store.watched[w.watch_id]["state"] == "draining"

    w.store.set_outcome(item_id, "created")
    w.cycle(T0 + timedelta(seconds=40))
    assert set(w.files("delivered")) == {"a.pdf"} and set(w.files("")) == {"b.pdf"}
    assert w.store.watched[w.watch_id]["state"] == "stopped"
    assert len(w.store.items) == 1


def test_a_stopped_watch_is_never_looked_at() -> None:
    w = World(state="stopped")
    w.drop("a.pdf", pdf())
    w.bridge.fail_next["list"] = AssertionError("a stopped watch is never listed")
    assert w.store.due(T0 + timedelta(hours=1)) == []
    runner = WatchRunner(w.deps, MemoryWatchLocks(), clock=lambda: T0 + timedelta(hours=1))
    assert runner.tick() == 0
    assert w.cycle(T0).admitted == 0
    assert "list" in w.bridge.fail_next


def test_names_the_bridge_cannot_address_are_reported_once_and_left_alone() -> None:
    w = World()
    w.drop("a" * 300 + ".pdf", pdf())
    w.cycle(T0)
    w.cycle(T0 + timedelta(seconds=10))
    assert len(w.files("")) == 1 and w.store.items == {}
    assert len([e for e in w.store.events if e["level"] == "warn"]) == 1


def test_the_runner_runs_due_watches_and_schedules_them() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    now = [T0]
    runner = WatchRunner(w.deps, MemoryWatchLocks(), clock=lambda: now[0])
    assert runner.tick() == 1
    assert w.store.watched[w.watch_id]["next_look_at"] == T0 + timedelta(seconds=10)
    assert runner.tick() == 0  # not due yet
    now[0] = T0 + timedelta(seconds=10)
    assert runner.tick() == 1
    assert set(w.files("processing")) == {"a.pdf"}


def test_the_runner_skips_a_watch_another_runner_holds() -> None:
    w = World()
    locks = MemoryWatchLocks()
    runner = WatchRunner(w.deps, locks, clock=lambda: T0)
    with locks.hold(w.watch_id) as held:
        assert held
        assert runner.tick() == 0


def test_a_cycle_that_fails_is_logged_and_looked_at_after_its_sleep() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    w.store.fail_next["see"] = RuntimeError("boom")
    runner = WatchRunner(w.deps, MemoryWatchLocks(), clock=lambda: T0)
    assert runner.tick() == 0
    assert w.store.watched[w.watch_id]["next_look_at"] == T0 + timedelta(seconds=30)
    assert any(e["level"] == "error" for e in w.store.events)


# --- fix round 1 ------------------------------------------------------------------------------


def refused(code: str, message: str = "refused") -> BridgeRefused:
    return BridgeRefused(
        BridgeError.model_validate({"class": "needs_user", "code": code, "message": message})
    )


def put(w: World, folder: str, name: str, data: bytes) -> None:
    w.bridge.sources[FakeBridge.source_key(TARGET, SOURCE, folder, name)] = data


def test_a_working_name_taken_meanwhile_is_replaced_by_the_next_free_one() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    arrived: list[bool] = []

    def arrive(src: tuple[str, str], dst: tuple[str, str]) -> None:
        if dst == ("processing", "a.pdf") and not arrived:
            arrived.append(True)
            put(w, "processing", "a.pdf", b"another person's longer file")

    w.bridge.on_move = arrive
    assert w.cycle(T0 + timedelta(seconds=10)).admitted == 1
    assert w.files("processing") == {
        "a.pdf": b"another person's longer file",
        "a_1.pdf": pdf(),
    }
    (item,) = w.store.items.values()
    assert item["filename"] == "a_1.pdf"
    assert item["source_key"] == "Plant A/Intake/a.pdf"


def test_a_stored_pickup_whose_working_name_was_taken_resumes_under_a_new_one() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    w.bridge.fail_next["move"] = BridgeUnavailable("the sink is down")
    w.cycle(T0 + timedelta(seconds=10))
    put(w, "processing", "a.pdf", b"another file of another size")
    assert w.cycle(T0 + timedelta(seconds=20)).admitted == 1
    assert w.files("processing")["a_1.pdf"] == pdf()
    (item,) = w.store.items.values()
    assert item["filename"] == "a_1.pdf"


def test_a_stored_pickup_whose_root_file_was_replaced_is_abandoned() -> None:
    w = World()
    w.drop("a.pdf", pdf("first"))
    w.cycle(T0)
    w.bridge.fail_next["move"] = BridgeUnavailable("the sink is down")
    w.cycle(T0 + timedelta(seconds=10))
    w.drop("a.pdf", pdf("an edited copy, longer"))  # uploaded again before the move
    w.cycle(T0 + timedelta(seconds=20))
    assert w.files("processing") == {} and w.store.items == {}
    assert w.objects.objects == {}  # the stale copy is gone
    assert any("changed" in e["message"] for e in w.store.events)
    (fresh,) = w.store.pickups(w.watch_id)
    assert fresh.step == "seen" and fresh.size == len(pdf("an edited copy, longer"))
    assert w.cycle(T0 + timedelta(seconds=30)).admitted == 1
    assert w.files("processing") == {"a.pdf": pdf("an edited copy, longer")}


def test_a_refusal_is_recorded_before_the_file_moves() -> None:
    w = World()
    w.drop("x.pdf", b"not a document")
    w.cycle(T0)
    w.store.fail_next["refuse"] = RuntimeError("the database is down")
    with pytest.raises(RuntimeError):
        w.cycle(T0 + timedelta(seconds=10))
    assert set(w.files("")) == {"x.pdf"} and w.files("failed") == {}

    w.cycle(T0 + timedelta(seconds=20))
    assert set(w.files("failed")) == {"x.pdf", "x.pdf.md"}
    assert len(w.store.items) == 1 and len(w.store.finishes) == 1


def test_a_refusal_whose_move_failed_is_completed_once() -> None:
    w = World()
    w.drop("x.pdf", b"not a document")
    w.cycle(T0)
    w.bridge.fail_next["move"] = BridgeUnavailable("the sink is down")
    w.cycle(T0 + timedelta(seconds=10))
    (pickup,) = w.store.pickups(w.watch_id)
    assert pickup.step == "refusing" and pickup.working_name == "x.pdf"
    assert set(w.files("")) == {"x.pdf"} and w.store.finishes == []
    (item,) = w.store.items.values()
    assert item["outcome"] == "failed"

    w.cycle(T0 + timedelta(seconds=20))
    assert set(w.files("failed")) == {"x.pdf", "x.pdf.md"}
    assert NOT_A_SOURCE in w.files("failed")["x.pdf.md"].decode()
    assert len(w.store.items) == 1 and len(w.store.finishes) == 1
    assert w.store.pickups(w.watch_id) == []


def test_a_moved_pickup_whose_copy_is_gone_is_filed_as_failed_and_never_blocks_the_rest() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    w.store.fail_next["admit"] = RuntimeError("the database is down")
    with pytest.raises(RuntimeError):
        w.cycle(T0 + timedelta(seconds=10))
    w.objects.objects.clear()  # the stored copy is lost
    w.drop("b.pdf", pdf("b"))
    w.cycle(T0 + timedelta(seconds=20))
    nxt = w.cycle(T0 + timedelta(seconds=30))
    assert nxt.admitted == 1
    assert set(w.files("processing")) == {"b.pdf"}
    failed = w.files("failed")
    assert failed["a.pdf"] == pdf()
    assert "copy" in failed["a.pdf.md"].decode()
    assert [p.original_name for p in w.store.pickups(w.watch_id)] == ["b.pdf"]


def test_a_resume_refused_by_the_bridge_never_stops_the_look() -> None:
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    w.bridge.fail_next["move"] = BridgeUnavailable("the sink is down")
    w.cycle(T0 + timedelta(seconds=10))
    w.drop("b.pdf", pdf("b"))
    w.bridge.fail_next["move"] = refused("forbidden", "no access to processing/")
    w.cycle(T0 + timedelta(seconds=20))
    assert any(p.original_name == "b.pdf" for p in w.store.pickups(w.watch_id))
    assert w.cycle(T0 + timedelta(seconds=30)).admitted == 2
    assert set(w.files("processing")) == {"a.pdf", "b.pdf"}


def test_a_final_move_refused_five_times_stops_and_shows_a_problem() -> None:
    w = World()
    item_id = w.admitted("a.pdf", pdf())
    w.store.set_outcome(item_id, "created")
    for n in range(5):
        w.bridge.fail_next["move"] = refused("forbidden", "no access to delivered/")
        w.cycle(T0 + timedelta(minutes=n + 1))
    assert [e["level"] for e in w.store.events if "delivered/" in e["message"]] == [
        "warn",
        "warn",
        "warn",
        "warn",
        "error",
    ]
    w.bridge.fail_next["move"] = AssertionError("a stuck pickup is not tried again")
    w.cycle(T0 + timedelta(minutes=10))
    assert "move" in w.bridge.fail_next
    watch = w.store.watch(w.watch_id)
    assert watch is not None and watch.problem is not None and "processing/" in watch.problem
    assert set(w.files("processing")) == {"a.pdf"}


def test_an_unavailable_bridge_does_not_count_as_a_refused_final_move() -> None:
    w = World()
    item_id = w.admitted("a.pdf", pdf())
    w.store.set_outcome(item_id, "created")
    for n in range(6):
        w.bridge.fail_next["move"] = BridgeUnavailable("the sink is down")
        w.cycle(T0 + timedelta(minutes=n + 1))
    w.cycle(T0 + timedelta(minutes=10))
    assert set(w.files("delivered")) == {"a.pdf"}


def test_every_outcome_is_classified_once() -> None:
    from typing import get_args

    from ingest_worker.decompose.items import ItemOutcome
    from ingest_worker.watch.cycle import DELIVERED_OUTCOMES, FAILED_OUTCOMES, STILL_RUNNING

    groups = [STILL_RUNNING, DELIVERED_OUTCOMES, FAILED_OUTCOMES]
    assert set().union(*groups) == set(get_args(ItemOutcome))
    assert sum(len(g) for g in groups) == len(get_args(ItemOutcome))
    assert "in_flight" in FAILED_OUTCOMES and "awaiting_review" in STILL_RUNNING


def test_an_unknown_outcome_stays_in_processing_with_one_warning() -> None:
    w = World()
    item_id = w.admitted("a.pdf", pdf())
    w.store.set_outcome(item_id, "teleported")
    w.cycle(T0 + timedelta(seconds=40))
    w.cycle(T0 + timedelta(seconds=80))
    assert set(w.files("processing")) == {"a.pdf"} and w.files("failed") == {}
    assert len([e for e in w.store.events if "teleported" in e["message"]]) == 1


class CountingObjects(MemoryObjectStore):
    def __init__(self) -> None:
        super().__init__()
        self.reads = 0

    def get(self, bucket: str, key: str) -> bytes:
        self.reads += 1
        return super().get(bucket, key)

    def get_optional(self, bucket: str, key: str) -> bytes | None:
        self.reads += 1
        return super().get_optional(bucket, key)


def test_an_admitted_file_is_not_read_back() -> None:
    w = World()
    objects = CountingObjects()
    w.objects = objects
    w.deps.objects = objects
    w.admitted("a.pdf", pdf())
    assert objects.reads == 0


def test_admit_and_refuse_leave_a_queued_pickup_alone() -> None:
    w = World()
    w.admitted("a.pdf", pdf())
    (p,) = w.store.pickups(w.watch_id)
    watch = w.store.watch(w.watch_id)
    assert watch is not None and p.item_id and p.object_key and p.working_name
    assert not w.store.admit(
        watch, p, p.item_id, p.object_key, p.working_name, "x", "Plant A/Intake/a.pdf", T0
    )
    assert w.store.refuse(watch, p, "a.pdf", "no", "x", "Plant A/Intake/a.pdf", T0) == p.item_id
    assert len(w.store.items) == 1 and len(w.store.jobs) == 1


# --- fix round 2 ------------------------------------------------------------------------------


def test_working_names_of_open_pickups_are_reserved() -> None:
    w = World()
    put(w, "processing", "a.pdf", b"another person's file")
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    w.bridge.fail_next["move"] = BridgeUnavailable("the sink is down")
    w.cycle(T0 + timedelta(seconds=10))
    (stored,) = w.store.pickups(w.watch_id)
    assert stored.step == "stored" and stored.working_name == "a_1.pdf"

    w.drop("a_1.pdf", pdf())  # named like the stored pickup's working name, same size
    for n in (2, 3):  # the stored pickup's move keeps failing; the new file is admitted
        w.bridge.fail_next["move"] = BridgeUnavailable("the sink is down")
        w.cycle(T0 + timedelta(seconds=10 * n))
    (other,) = w.store.items.values()
    assert other["source_key"].endswith("/a_1.pdf") and other["filename"] == "a_1_1.pdf"
    assert set(w.files("processing")) == {"a.pdf", "a_1_1.pdf"}
    assert w.cycle(T0 + timedelta(seconds=40)).admitted == 1  # the stored pickup, as a_1.pdf
    assert w.files("processing")["a_1.pdf"] == pdf()


def test_a_move_that_stamps_a_new_modified_time_is_still_recovered() -> None:
    """A real sink's move is read, upload and delete: the file in `processing/` gets a new
    modified time. A stop between the move and its record is still recovered (by name and size:
    open pickups' working names are reserved, so no other pickup holds that name there)."""
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    w.store.fail_next["advance:moved"] = RuntimeError("the worker stopped")
    with pytest.raises(RuntimeError):
        w.cycle(T0 + timedelta(seconds=10))
    key = FakeBridge.source_key(TARGET, SOURCE, "processing", "a.pdf")
    w.bridge.modified[key] = "2026-10-29T12:00:10.000Z"  # stamped by the move
    assert w.cycle(T0 + timedelta(seconds=20)).admitted == 1
    assert set(w.files("processing")) == {"a.pdf"}
    assert len(w.store.items) == 1 and len(w.store.jobs) == 1


def test_a_refusal_the_store_left_alone_moves_nothing() -> None:
    w = World()
    w.drop("x.pdf", b"not a document")
    w.cycle(T0)
    original = w.store.refuse

    def taken_meanwhile(watch: Any, pickup: Any, *args: Any) -> str:
        w.store.advance(pickup.id, "abandoned")  # another runner, or stop now
        return original(watch, pickup, *args)

    w.store.refuse = taken_meanwhile  # type: ignore[method-assign]
    w.cycle(T0 + timedelta(seconds=10))
    assert set(w.files("")) == {"x.pdf"} and w.files("failed") == {}
    assert w.store.items == {} and w.store.finishes == []


def test_a_draining_watch_shows_its_stuck_pickups() -> None:
    w = World()
    item_id = w.admitted("a.pdf", pdf())
    w.store.set_outcome(item_id, "created")
    w.store.set_state(w.watch_id, "draining")
    for n in range(5):
        w.bridge.fail_next["move"] = refused("forbidden", "no access to delivered/")
        w.cycle(T0 + timedelta(minutes=n + 1))
    w.cycle(T0 + timedelta(minutes=10))
    watch = w.store.watch(w.watch_id)
    assert watch is not None and watch.problem is not None and "processing/" in watch.problem


@pytest.mark.parametrize("state", ["stopped", "draining"])
def test_a_cycle_running_while_the_watch_stops_admits_nothing(state: str) -> None:
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)  # the file is seen
    running = w.store.watch(w.watch_id)  # the cycle that is already under way
    assert running is not None and running.state == "running"
    w.store.set_state(w.watch_id, state)  # type: ignore[arg-type]
    done = run_cycle(running, w.deps, T0 + timedelta(seconds=10))
    assert done.admitted == 0
    assert w.store.items == {} and w.store.jobs == []
    # Nothing waits for a Start that will not take it: the pickup is let go.
    assert w.store.pickups(w.watch_id) == []


@pytest.mark.parametrize("state", ["stopped", "draining"])
def test_a_refusal_is_not_recorded_while_the_watch_is_not_running(state: str) -> None:
    w = World()
    w.drop("x.pdf", b"random bytes, not a document")
    w.cycle(T0)
    running = w.store.watch(w.watch_id)
    assert running is not None
    w.store.set_state(w.watch_id, state)  # type: ignore[arg-type]
    done = run_cycle(running, w.deps, T0 + timedelta(seconds=10))
    assert done.finished == 0
    # No item, no finish; the file stays in the folder root.
    assert w.store.items == {} and w.store.finishes == []
    assert set(w.files("")) == {"x.pdf"} and w.files("failed") == {}


def _interrupted_before_admit() -> World:
    """A file moved to processing/ whose admit never ran (the pickup is `moved`)."""
    w = World()
    w.drop("a.pdf", pdf())
    w.cycle(T0)
    w.store.fail_next["admit"] = RuntimeError("the database is down")
    with pytest.raises(RuntimeError):
        w.cycle(T0 + timedelta(seconds=10))
    assert w.store.pickups(w.watch_id)[0].step == "moved"
    return w


def test_a_draining_watch_still_admits_a_pickup_taken_before_the_drain() -> None:
    w = _interrupted_before_admit()
    w.store.set_state(w.watch_id, "draining")
    assert w.cycle(T0 + timedelta(seconds=20)).admitted == 1
    assert len(w.store.items) == 1 and len(w.store.jobs) == 1


def test_a_stopped_watch_lets_a_pickup_taken_before_the_stop_go() -> None:
    w = _interrupted_before_admit()
    under_way = w.store.watch(w.watch_id)  # a cycle that began while running
    assert under_way is not None
    w.store.set_state(w.watch_id, "stopped")
    assert run_cycle(under_way, w.deps, T0 + timedelta(seconds=20)).admitted == 0
    assert w.store.items == {} and w.store.jobs == []
    assert w.store.pickups(w.watch_id) == []
    assert set(w.files("processing")) == {"a.pdf"}  # left where it is


@pytest.mark.parametrize("state", ["stopped", "draining"])
def test_refuse_answers_for_a_pickup_already_refusing_whatever_the_state(state: str) -> None:
    w = World()
    w.drop("x.pdf", b"not a document")
    w.cycle(T0)
    w.bridge.fail_next["move"] = BridgeUnavailable("the sink is down")
    w.cycle(T0 + timedelta(seconds=10))
    (pickup,) = w.store.pickups(w.watch_id)
    assert pickup.step == "refusing" and pickup.item_id
    watch = w.store.watch(w.watch_id)
    assert watch is not None
    w.store.set_state(w.watch_id, state)  # type: ignore[arg-type]
    again = w.store.refuse(watch, pickup, "x.pdf", "r", "sha", "k", T0)
    assert again == pickup.item_id and len(w.store.items) == 1


def test_a_finished_document_wakes_its_sleeping_watch() -> None:
    """Spec §3: a watch looks again at once when a document of its own finishes (the trigger of
    migration 202610291400, which the memory store follows in `set_outcome`)."""
    w = World(sleep_seconds=3600)
    now = [T0]
    runner = WatchRunner(w.deps, MemoryWatchLocks(), clock=lambda: now[0])
    w.drop("a.pdf", pdf())
    runner.tick()
    now[0] = T0 + timedelta(seconds=10)
    runner.tick()  # admitted: looks again at once
    runner.tick()  # nothing to do: asleep for an hour
    assert w.store.watched[w.watch_id]["next_look_at"] == now[0] + timedelta(hours=1)
    (item_id,) = w.store.items

    w.store.now = T0 + timedelta(seconds=15)
    w.store.set_outcome(item_id, "created")
    now[0] = T0 + timedelta(seconds=16)
    assert runner.tick() == 1
    assert set(w.files("delivered")) == {"a.pdf"}


def test_a_document_finishing_during_a_look_is_filed_by_the_next_one() -> None:
    """A wake written while a cycle runs is kept when the cycle schedules its next look."""
    w = World(sleep_seconds=3600)
    now = [T0]
    runner = WatchRunner(w.deps, MemoryWatchLocks(), clock=lambda: now[0])
    item_id = w.admitted("a.pdf", pdf())
    runner.tick()
    assert w.store.watched[w.watch_id]["next_look_at"] == T0 + timedelta(hours=1)

    now[0] = T0 + timedelta(hours=1)
    lists = w.bridge.list_source

    def finishing_meanwhile(*args: Any, **kwargs: Any) -> Any:
        w.bridge.list_source = lists  # type: ignore[method-assign]
        w.store.now = now[0] + timedelta(seconds=1)
        w.store.set_outcome(item_id, "created")  # after this cycle's finish step
        return lists(*args, **kwargs)

    w.bridge.list_source = finishing_meanwhile  # type: ignore[method-assign]
    runner.tick()
    assert w.store.watched[w.watch_id]["next_look_at"] == now[0] + timedelta(seconds=1)
    now[0] += timedelta(seconds=1)
    assert runner.tick() == 1
    assert set(w.files("delivered")) == {"a.pdf"}


def test_a_still_running_outcome_wakes_nothing() -> None:
    w = World(sleep_seconds=3600)
    item_id = w.admitted("a.pdf", pdf())
    w.store.watched[w.watch_id]["next_look_at"] = T0 + timedelta(hours=1)
    w.store.now = T0 + timedelta(seconds=20)
    w.store.set_outcome(item_id, "delivering")
    assert w.store.watched[w.watch_id]["next_look_at"] == T0 + timedelta(hours=1)


def refusal_with(code: str, message: str, **details: Any) -> BridgeRefused:
    return BridgeRefused(
        BridgeError.model_validate(
            {"class": "needs_user", "code": code, "message": message, "details": details or None}
        )
    )


@pytest.mark.parametrize(
    ("refusal", "reason"),
    [
        (
            refusal_with("content_rejected", "source file too large", reason="too_large"),
            "larger than",
        ),
        (refusal_with("forbidden", "you may not read old.pdf"), "you may not read old.pdf"),
    ],
)
def test_a_file_the_bridge_refuses_to_read_goes_to_failed_and_the_next_is_admitted(
    refusal: BridgeRefused, reason: str
) -> None:
    w = World()
    w.drop("old.pdf", pdf("old"), modified="2026-10-28T00:00:00.000Z")
    w.drop("new.pdf", pdf("new"), modified="2026-10-29T00:00:00.000Z")
    w.cycle(T0)
    w.bridge.fail_next["read"] = refusal  # the oldest is read first
    done = w.cycle(T0 + timedelta(seconds=10))
    assert done.admitted == 1 and done.finished == 1
    assert set(w.files("failed")) == {"old.pdf", "old.pdf.md"}
    assert reason in w.files("failed")["old.pdf.md"].decode()
    assert set(w.files("processing")) == {"new.pdf"}
    old = next(i for i in w.store.items.values() if i["filename"] == "old.pdf")
    assert old["outcome"] == "failed" and old["object_key"] is None
    assert old["content_sha256"] == "unread"
    assert w.store.watched[w.watch_id]["total_failed"] == 1


def test_an_unavailable_bridge_while_reading_ends_the_admission() -> None:
    w = World()
    w.drop("old.pdf", pdf("old"), modified="2026-10-28T00:00:00.000Z")
    w.drop("new.pdf", pdf("new"), modified="2026-10-29T00:00:00.000Z")
    w.cycle(T0)
    w.bridge.fail_next["read"] = BridgeUnavailable("the bridge is down")
    done = w.cycle(T0 + timedelta(seconds=10))
    assert done.admitted == 0 and done.finished == 0
    assert set(w.files("")) == {"old.pdf", "new.pdf"}
    assert w.store.items == {}


def test_a_move_the_sink_refuses_while_admitting_is_counted_and_the_next_is_admitted() -> None:
    w = World()
    w.drop("old.pdf", pdf("old"), modified="2026-10-28T00:00:00.000Z")
    w.drop("new.pdf", pdf("new"), modified="2026-10-29T00:00:00.000Z")
    w.cycle(T0)
    w.bridge.fail_next["move"] = refused("forbidden", "you may not move old.pdf")
    done = w.cycle(T0 + timedelta(seconds=10))
    assert done.admitted == 1
    assert set(w.files("processing")) == {"new.pdf"}
    (stored,) = [p for p in w.store.pickups(w.watch_id) if p.original_name == "old.pdf"]
    assert stored.step == "stored" and stored.move_failures == 1
