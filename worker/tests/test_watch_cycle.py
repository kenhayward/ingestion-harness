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
