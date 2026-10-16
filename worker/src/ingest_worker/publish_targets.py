"""Publishing targets (S3 destinations of published outputs) read from the database.

The API owns the table (migration 0050, apps/api/src/publish-targets/); the worker only reads it,
and seeds the `default` row from `.env` when it is first to start. The seed rule, the prefix rule
and the delivery cases are held in step with the API by
packages/shared/test/fixtures/publish-targets.json.
"""

from __future__ import annotations

import contextlib
import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol, TypeVar

from .errors import DocumentError
from .llm.secrets import SecretError, decrypt_secret, secrets_keys
from .storage import ObjectStore, S3ObjectStore

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger(__name__)

_T = TypeVar("_T")

DEFAULT_TARGET_ID = "default"
DEFAULT_BUCKET = "ingest-published"

#: The only variables a target may read its keys from (the seeded default's), so a stored name can
#: never make the worker read another secret of its environment.
CREDENTIAL_ENV_NAMES = frozenset(
    {"TARGET_S3_ACCESS_KEY", "TARGET_S3_SECRET_KEY", "S3_ACCESS_KEY", "S3_SECRET_KEY"}
)

TargetKind = Literal["internal", "external"]
SeedOutcome = Literal["seeded", "kept", "differs"]


def normalise_prefix(prefix: str) -> str:
    """Trim, drop leading `/`, end in `/` when not empty (normalisePrefix in TS)."""
    p = prefix.strip().lstrip("/")
    return p if p == "" or p.endswith("/") else p + "/"


@dataclass(frozen=True)
class DefaultSeed:
    """The default target as `.env` describes it (DefaultSeed in TS)."""

    kind: TargetKind
    bucket: str
    prefix: str
    endpoint: str | None
    region: str | None
    access_key_env: str | None
    secret_key_env: str | None
    force_path_style: bool


def default_seed(env: Mapping[str, str]) -> DefaultSeed:
    """The `TARGET_S3_*` settings as a target (defaultSeed in TS). Internal when the target's
    endpoint and keys are blank or equal to `S3_*`; else external, reading its keys from the same
    variables as before (a blank target key falls back to `S3_*`)."""

    def value(name: str) -> str | None:
        return env.get(name) or None

    s3_endpoint, t_endpoint = value("S3_ENDPOINT"), value("TARGET_S3_ENDPOINT")
    t_access, t_secret = value("TARGET_S3_ACCESS_KEY"), value("TARGET_S3_SECRET_KEY")
    same_endpoint = t_endpoint is None or t_endpoint == s3_endpoint
    own_access = t_access is not None and t_access != value("S3_ACCESS_KEY")
    own_secret = t_secret is not None and t_secret != value("S3_SECRET_KEY")
    bucket = value("TARGET_S3_BUCKET") or DEFAULT_BUCKET
    # Verbatim, never normalised (as in TS): `ingest` has always meant keys like `ingestletter/…`.
    prefix = env.get("TARGET_S3_PREFIX", "")
    if same_endpoint and not own_access and not own_secret:
        return DefaultSeed("internal", bucket, prefix, None, None, None, None, True)
    return DefaultSeed(
        kind="external",
        bucket=bucket,
        prefix=prefix,
        endpoint=t_endpoint or s3_endpoint,
        region=value("TARGET_S3_REGION") or value("S3_REGION") or "us-east-1",
        access_key_env="TARGET_S3_ACCESS_KEY" if t_access else "S3_ACCESS_KEY",
        secret_key_env="TARGET_S3_SECRET_KEY" if t_secret else "S3_SECRET_KEY",
        force_path_style=True,
    )


@dataclass(frozen=True)
class TargetRow:
    """A `publish_targets` row."""

    id: str
    label: str
    kind: TargetKind
    bucket: str
    prefix: str
    endpoint: str | None
    region: str | None
    access_key_id: str | None
    secret_key_enc: str | None
    access_key_env: str | None
    secret_key_env: str | None
    path_style: bool
    sse: str
    kms_key_id: str | None
    storage_class: str | None
    seeded_at: datetime | None


def seed_differences(stored: TargetRow, seed: DefaultSeed) -> list[str]:
    """The fields of the stored default that differ from what `.env` now says."""
    pairs = [
        ("kind", stored.kind, seed.kind),
        ("endpoint", stored.endpoint, seed.endpoint),
        ("bucket", stored.bucket, seed.bucket),
        ("prefix", stored.prefix, seed.prefix),
    ]
    return [name for name, have, want in pairs if have != want]


@dataclass
class Target:
    """Final destination for published outputs (any S3 endpoint/bucket; keys get `prefix`)."""

    store: ObjectStore
    bucket: str
    prefix: str = ""
    id: str = DEFAULT_TARGET_ID


class PublishTargetStore(Protocol):
    def load(self) -> list[TargetRow]: ...

    def version(self) -> int:
        """Moves whenever a target is written."""
        ...

    def seed_default(self, seed: DefaultSeed) -> SeedOutcome:
        """Write `.env` into the default row, once: 'seeded', else 'kept' or 'differs'."""
        ...


_COLUMNS = (
    "id, label, kind, bucket, prefix, endpoint, region, access_key_id, secret_key_enc,"
    " access_key_env, secret_key_env, force_path_style, sse, kms_key_id, storage_class, seeded_at"
)


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

    def seed_default(self, seed: DefaultSeed) -> SeedOutcome:
        return self._run(lambda conn: self._seed(conn, seed))

    def _seed(self, conn: psycopg.Connection[Any], seed: DefaultSeed) -> SeedOutcome:
        with conn.transaction():
            row = conn.execute(
                f"SELECT {_COLUMNS} FROM publish_targets WHERE id = %s FOR UPDATE",
                (DEFAULT_TARGET_ID,),
            ).fetchone()
            if row is None:
                raise RuntimeError("the default publishing target row is missing")
            current = TargetRow(*row)
            if current.seeded_at is not None:
                return "differs" if seed_differences(current, seed) else "kept"
            conn.execute(
                """UPDATE publish_targets
                   SET kind = %s, bucket = %s, prefix = %s, endpoint = %s, region = %s,
                       access_key_env = %s, secret_key_env = %s, force_path_style = %s,
                       access_key_id = NULL, secret_key_enc = NULL, source = 'env',
                       seeded_at = now()
                   WHERE id = %s""",
                (
                    seed.kind,
                    seed.bucket,
                    seed.prefix,
                    seed.endpoint,
                    seed.region,
                    seed.access_key_env,
                    seed.secret_key_env,
                    seed.force_path_style,
                    DEFAULT_TARGET_ID,
                ),
            )
            return "seeded"


def seed_default_target(store: PublishTargetStore, env: Mapping[str, str]) -> list[str]:
    """Seed the default target from `.env` (first start only). Afterwards the database wins: the
    fields `.env` now disagrees on are logged as a warning and returned, nothing is changed."""
    seed = default_seed(env)
    if store.seed_default(seed) != "differs":
        return []
    stored = next(r for r in store.load() if r.id == DEFAULT_TARGET_ID)
    fields = seed_differences(stored, seed)
    log.warning(
        "the default publishing target differs from .env (TARGET_S3_*) in %s: the stored "
        "target is used; change it under Administration > Published outputs",
        ", ".join(fields),
    )
    return fields


@dataclass(frozen=True)
class S3Settings:
    """The worker's own object store connection (SeaweedFS), used by internal targets."""

    endpoint: str
    region: str
    access_key: str
    secret_key: str


class TargetMissing(DocumentError):
    """A recipe names a publishing target that does not exist (never a fallback to default)."""

    def __init__(self, target_id: str) -> None:
        super().__init__(f"no publishing target {target_id}")
        self.target_id = target_id


StoreFactory = Callable[..., ObjectStore]


class LiveTargets:
    """One object store per publishing target, rebuilt when the stored targets change."""

    def __init__(
        self,
        store: PublishTargetStore,
        internal: S3Settings,
        env: Mapping[str, str] = os.environ,
        make: StoreFactory = S3ObjectStore,
    ) -> None:
        self._store = store
        self._internal = internal
        self._env = env
        self._make = make
        self._version = store.version()
        self._rows = {r.id: r for r in store.load()}
        self._cache: dict[str, Target] = {}

    def refresh(self) -> bool:
        """Reload when a target was written; True when it did."""
        version = self._store.version()  # read first: a change made meanwhile shows next time
        if version == self._version:
            return False
        self._version = version
        self._rows = {r.id: r for r in self._store.load()}
        self._cache.clear()
        return True

    def get(self, target_id: str) -> Target:
        self.refresh()
        hit = self._cache.get(target_id)
        if hit is not None:
            return hit
        row = self._rows.get(target_id)
        if row is None:
            raise TargetMissing(target_id)
        target = Target(self._store_of(row), row.bucket, row.prefix, row.id)
        self._cache[target_id] = target
        return target

    def _store_of(self, t: TargetRow) -> ObjectStore:
        if t.kind == "internal":
            i = self._internal
            return self._make(
                i.endpoint,
                i.region,
                i.access_key,
                i.secret_key,
                path_style=True,
                sse="none",
                kms_key_id=None,
                storage_class=None,
            )
        for name in (t.access_key_env, t.secret_key_env):
            if name is not None and name not in CREDENTIAL_ENV_NAMES:
                raise DocumentError(f"{t.label} names an unsupported credential variable")
        region = t.region or self._internal.region
        access_key = t.access_key_id or (self._env.get(t.access_key_env or "") or None)
        secret_key: str | None = None
        if t.secret_key_enc:
            try:
                keys = secrets_keys(self._env)
                if not keys:
                    raise SecretError("no master key")
                secret_key = decrypt_secret(t.secret_key_enc, keys)
            except SecretError as exc:
                raise DocumentError(f"cannot decrypt the secret of {t.label}") from exc
        elif t.secret_key_env:
            secret_key = self._env.get(t.secret_key_env) or None
        if not access_key or not secret_key:
            raise DocumentError(f"{t.label} has no credentials")
        return self._make(
            t.endpoint or f"https://s3.{region}.amazonaws.com",
            region,
            access_key,
            secret_key,
            path_style=t.path_style,
            sse=t.sse,
            kms_key_id=t.kms_key_id,
            storage_class=t.storage_class,
        )
