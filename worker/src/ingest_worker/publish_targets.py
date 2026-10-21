"""Publishing targets (S3 destinations of published outputs) read from the database.

The delivery bridge's registry is authoritative; `publish_targets` is CT Studio's cache of it,
written only by the API (apps/api/src/publish-targets/), which also seeds `default` and
`rdf-default`. The worker only reads the cache. The prefix rule and the delivery cases are held
in step with the API by packages/shared/test/fixtures/publish-targets.json.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol, TypeVar

from .errors import DocumentError

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger(__name__)

_T = TypeVar("_T")

DEFAULT_TARGET_ID = "default"
#: The triple store target (TRIPLE_STORE_TARGET_ID in TS).
TRIPLE_STORE_TARGET_ID = "rdf-default"
S3_SINK_ID = "s3"

TargetKind = Literal["internal", "external", "rdf", "sink"]


def normalise_prefix(prefix: str) -> str:
    """Trim, drop leading `/`, end in `/` when not empty (normalisePrefix in TS)."""
    p = prefix.strip().lstrip("/")
    return p if p == "" or p.endswith("/") else p + "/"


@dataclass(frozen=True)
class TargetRow:
    """A `publish_targets` row (the cache of a bridge target)."""

    id: str
    label: str
    kind: TargetKind
    sink_id: str
    #: The sink's destination: S3 {bucket, prefix, sse, kmsKeyId, storageClass, layout}
    #: (a blank layout means `files`); rdf {dataset}.
    destination: dict[str, str]
    #: A copy restore's dropped external target, kept for the foreign keys only.
    inert: bool = False
    #: When the cache last took the row from the bridge; None: not yet (the worker waits).
    synced_at: datetime | None = None


@dataclass(frozen=True)
class Target:
    """A publishing target as the worker knows it: an id the bridge delivers to, and where its
    files land (bucket, and the prefix of their keys) for the records. Its credentials live on
    the bridge."""

    id: str
    bucket: str
    prefix: str = ""
    #: `files`: the package's files at prefix + their names (today's keys). `package`: the whole
    #: package archived under prefix + `packages/<idempotency key>/` (package_archive_keys).
    layout: str = "files"


class PublishTargetStore(Protocol):
    def load(self) -> list[TargetRow]: ...

    def version(self) -> int:
        """Moves whenever a target is written."""
        ...


_COLUMNS = "id, label, kind, sink_id, destination, inert_at IS NOT NULL, synced_at"


class PgPublishTargetStore:
    """The targets on Postgres. With `reconnect`, a lost connection (a database restart) is
    replaced once per call, so a long-lived worker keeps reading its targets."""

    def __init__(
        self,
        conn: psycopg.Connection[Any],
        reconnect: Callable[[], psycopg.Connection[Any]] | None = None,
    ) -> None:
        self._conn = conn
        self._reconnect = reconnect

    @classmethod
    def connect(cls, database_url: str) -> PgPublishTargetStore:
        """Its own autocommit connection, re-opened when lost."""
        import psycopg

        def open_conn() -> psycopg.Connection[Any]:
            return psycopg.connect(database_url, autocommit=True)

        return cls(open_conn(), reconnect=open_conn)

    def close(self) -> None:
        self._conn.close()

    def _run(self, work: Callable[[psycopg.Connection[Any]], _T]) -> _T:
        import psycopg

        try:
            return work(self._conn)
        except psycopg.OperationalError:
            if self._reconnect is None:
                raise
            log.warning("publishing targets: the database connection was lost; reconnecting")
            with contextlib.suppress(Exception):  # already broken: nothing to close cleanly
                self._conn.close()
            self._conn = self._reconnect()
            return work(self._conn)

    def load(self) -> list[TargetRow]:
        def work(conn: psycopg.Connection[Any]) -> list[TargetRow]:
            rows = conn.execute(f"SELECT {_COLUMNS} FROM publish_targets ORDER BY id").fetchall()
            return [TargetRow(*r) for r in rows]

        return self._run(work)

    def version(self) -> int:
        def work(conn: psycopg.Connection[Any]) -> int:
            row = conn.execute("SELECT version FROM publish_targets_state").fetchone()
            return int(row[0]) if row else 0

        return self._run(work)


class TargetMissing(DocumentError):
    """A recipe names a publishing target that does not exist (never a fallback to default)."""

    def __init__(self, target_id: str) -> None:
        super().__init__(f"no publishing target {target_id}")
        self.target_id = target_id


class TargetNotSynced(Exception):
    """A target the cache has not yet taken from the bridge (the API syncs it shortly after it
    starts). Not a DocumentError: the job fails and is retried with backoff, like an unreachable
    bridge, instead of going to review."""

    def __init__(self, target_id: str) -> None:
        super().__init__(f"publishing target {target_id} is not synced from the bridge yet")
        self.target_id = target_id


class LiveTargets:
    """The publishing targets by id, reloaded when the stored targets change."""

    def __init__(self, store: PublishTargetStore, rdf_expected: bool = False) -> None:
        self._store = store
        #: The deployment has a triple store (`RDF_ENDPOINT` is set): until the API has synced
        #: `rdf-default`, a delivery waits for it rather than skip the load.
        self._rdf_expected = rdf_expected
        self._version = store.version()
        self._rows = {r.id: r for r in store.load()}

    def refresh(self) -> bool:
        """Reload when a target was written; True when it did."""
        version = self._store.version()  # read first: a change made meanwhile shows next time
        if version == self._version:
            return False
        self._version = version
        self._rows = {r.id: r for r in self._store.load()}
        return True

    def get(self, target_id: str) -> Target:
        """The S3 place of a target (s3PlaceOf in TS: a blank layout is `files`). TargetMissing
        for an unknown or inert id and for a sink that is not S3 (those record receipts, not
        keys); TargetNotSynced while the cache has not taken the row from the bridge."""
        self.refresh()
        row = self._rows.get(target_id)
        if row is None or row.inert or row.sink_id != S3_SINK_ID:
            raise TargetMissing(target_id)
        if row.synced_at is None:
            raise TargetNotSynced(target_id)
        d = row.destination
        layout = "package" if d.get("layout") == "package" else "files"
        return Target(row.id, d.get("bucket", ""), d.get("prefix", ""), layout)

    def rdf(self) -> Target | None:
        """The triple store target (its dataset as the bucket), or None without one.
        TargetNotSynced while it is expected (RDF_ENDPOINT is set) and the cache lacks the row,
        or holds it unsynced: delivering now would silently skip the load."""
        self.refresh()
        row = self._rows.get(TRIPLE_STORE_TARGET_ID)
        if row is None or row.inert:
            if self._rdf_expected:
                raise TargetNotSynced(TRIPLE_STORE_TARGET_ID)
            return None
        if row.kind != "rdf":
            return None
        if row.synced_at is None:
            raise TargetNotSynced(TRIPLE_STORE_TARGET_ID)
        return Target(row.id, row.destination.get("dataset", ""), "")
