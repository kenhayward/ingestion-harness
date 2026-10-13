"""LLM endpoints, curated models and aliases in the database (ADR 0010).

`config/llm-providers.yaml` (with its `${VAR}` values) and `LLM_ENDPOINTS` are the defaults:
the worker seeds them into `llm_endpoints`, `llm_models.curated` and `llm_aliases` on start
(`seed_from_config` -> `LlmConfigStore.seed`) and builds its registry from what is stored
(`LiveModels`), rebuilding it whenever the stored config's version moves. A row an admin edited
(`edited_at`) or added (`source = 'ui'`) is never changed by seeding: the UI wins.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from .registry import (
    DEFAULT_FACTORIES,
    ENDPOINT_KEYS_ENV,
    LLMConfig,
    ModelRegistry,
    OcrConfig,
    ProviderConfig,
    ProviderFactory,
    build_registry,
)

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger(__name__)

#: More endpoints from .env: `name=baseUrl|model1,model2[|local|external[|kind]]`, `;`-separated.
ENDPOINTS_ENV = "LLM_ENDPOINTS"
_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_KINDS = ("anthropic", "openai-chat", "openai-responses")


@dataclass(frozen=True)
class Seed:
    """Endpoints (each with its curated models) and aliases: what .env asks for, or what the
    database holds."""

    endpoints: list[ProviderConfig]
    aliases: dict[str, str] = field(default_factory=dict)


def parse_endpoints(
    value: str, options: Mapping[str, dict[str, Any]] | None = None
) -> list[ProviderConfig]:
    """`LLM_ENDPOINTS` entries. `options` maps `kind/location` to the request options an
    endpoint of that sort starts with (those of the shipped provider of the same sort)."""
    out: list[ProviderConfig] = []
    seen: set[str] = set()
    for raw in value.split(";"):
        entry = raw.strip()
        if not entry:
            continue
        name, sep, rest = entry.partition("=")
        name = name.strip()
        if not sep:
            raise ValueError(
                f"{ENDPOINTS_ENV}: {name}: expected name=baseUrl|models[|location[|kind]]"
            )
        if not _NAME.match(name):
            raise ValueError(
                f"{ENDPOINTS_ENV}: {name!r}: names are lower-case letters, digits, - and _"
            )
        if name in seen:
            raise ValueError(f"{ENDPOINTS_ENV}: {name}: listed twice")
        seen.add(name)
        parts = [p.strip() for p in rest.split("|")]
        base_url = parts[0]
        models = parts[1] if len(parts) > 1 else ""
        location = parts[2] if len(parts) > 2 and parts[2] else "local"
        kind = parts[3] if len(parts) > 3 and parts[3] else "openai-chat"
        if not base_url:
            raise ValueError(f"{ENDPOINTS_ENV}: {name}: a base URL is required")
        if location not in ("local", "external"):
            raise ValueError(f"{ENDPOINTS_ENV}: {name}: location must be local or external")
        if kind not in _KINDS:
            raise ValueError(f"{ENDPOINTS_ENV}: {name}: kind must be one of {', '.join(_KINDS)}")
        out.append(
            ProviderConfig.model_validate(
                {
                    "name": name,
                    "kind": kind,
                    "baseUrl": base_url,
                    "location": location,
                    "apiKeyEnv": ENDPOINT_KEYS_ENV,
                    "apiKeyRequired": False,
                    "models": [models],
                    "options": dict((options or {}).get(f"{kind}/{location}", {})),
                }
            )
        )
    return out


def seed_from_config(config: LLMConfig, env: Mapping[str, str] = os.environ) -> Seed:
    """The defaults: the config file's providers, then `LLM_ENDPOINTS`; its aliases plus `ocr`
    (the OCR model)."""
    templates: dict[str, dict[str, Any]] = {}
    for p in config.providers:
        templates.setdefault(f"{p.kind}/{p.location}", p.options)
    endpoints = list(config.providers)
    shipped = {p.name for p in endpoints}
    for extra in parse_endpoints(env.get(ENDPOINTS_ENV) or "", templates):
        if extra.name in shipped:
            raise ValueError(
                f"{ENDPOINTS_ENV}: {extra.name}: already defined in config/llm-providers.yaml"
            )
        endpoints.append(extra)
    aliases = dict(config.aliases)
    if config.ocr is not None:
        aliases.setdefault("ocr", config.ocr.model)
    return Seed(endpoints, aliases)


def registry_from_seed(
    seed: Seed,
    ocr: OcrConfig | None,
    env: Mapping[str, str] = os.environ,
    factories: Mapping[str, ProviderFactory] = DEFAULT_FACTORIES,
) -> ModelRegistry:
    """Every stored endpoint is optional: one without its key (added in the UI, say) is skipped
    with a warning, never a crash. The `ocr` alias, when stored, picks the OCR model."""
    providers = [e.model_copy(update={"optional": True}) for e in seed.endpoints]
    ocr_cfg = None
    if ocr is not None:
        ocr_cfg = ocr.model_copy(update={"model": seed.aliases.get("ocr", ocr.model)})
    config = LLMConfig(providers=providers, aliases=dict(seed.aliases), ocr=ocr_cfg)
    return build_registry(config, env, factories)


class LlmConfigStore(Protocol):
    def seed(self, seed: Seed) -> None:
        """Write the .env defaults, leaving rows an admin edited or added alone."""
        ...

    def load(self) -> Seed:
        """Every stored endpoint (by name, with its curated models) and alias."""
        ...

    def version(self) -> int:
        """Moves whenever endpoints, aliases or curated models change."""
        ...


class LiveModels:
    """The registry built from the store, rebuilt when the stored config changes."""

    def __init__(
        self,
        store: LlmConfigStore,
        ocr: OcrConfig | None,
        env: Mapping[str, str] = os.environ,
        factories: Mapping[str, ProviderFactory] = DEFAULT_FACTORIES,
    ) -> None:
        self._store = store
        self._ocr = ocr
        self._env = env
        self._factories = factories
        self._version = store.version()
        self._build(store.load())

    def _build(self, seed: Seed) -> None:
        self.registry = registry_from_seed(seed, self._ocr, self._env, self._factories)
        self.ocr_model: str | None = (
            seed.aliases.get("ocr", self._ocr.model) if self._ocr is not None else None
        )

    def refresh(self) -> bool:
        """Rebuild when the stored config changed; True when it did."""
        version = self._store.version()  # read first: a change made meanwhile shows next time
        if version == self._version:
            return False
        self._version = version
        self._build(self._store.load())
        return True


_ENDPOINT_COLUMNS = (
    "kind, base_url, location, api_key_env, api_key_required, discover, model_filter, options,"
    " enabled"
)


class PgLlmConfigStore:
    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    def seed(self, seed: Seed) -> None:
        from psycopg.types.json import Jsonb

        names = [e.name for e in seed.endpoints]
        with self._conn.transaction():
            for e in seed.endpoints:
                # The IS DISTINCT FROM guard keeps an unchanged .env from moving the version.
                self._conn.execute(
                    f"""INSERT INTO llm_endpoints (name, {_ENDPOINT_COLUMNS}, source)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'env')
                        ON CONFLICT (name) DO UPDATE
                          SET ({_ENDPOINT_COLUMNS}, updated_at) = (
                                EXCLUDED.kind, EXCLUDED.base_url, EXCLUDED.location,
                                EXCLUDED.api_key_env, EXCLUDED.api_key_required, EXCLUDED.discover,
                                EXCLUDED.model_filter, EXCLUDED.options, EXCLUDED.enabled, now())
                        WHERE llm_endpoints.source = 'env' AND llm_endpoints.edited_at IS NULL
                          AND ({_qualified("llm_endpoints")}) IS DISTINCT FROM
                              ({_qualified("EXCLUDED")})""",
                    (
                        e.name,
                        e.kind,
                        e.base_url,
                        e.location,
                        e.api_key_env,
                        e.api_key_required,
                        e.discover,
                        e.model_filter,
                        Jsonb(e.options),
                        e.enabled,
                    ),
                )
            removed = [
                r[0]
                for r in self._conn.execute(
                    """DELETE FROM llm_endpoints
                        WHERE source = 'env' AND edited_at IS NULL AND NOT (name = ANY(%s))
                    RETURNING name""",
                    (names,),
                ).fetchall()
            ]
            # Curated models follow .env only on endpoints .env still owns (or just lost).
            owned = [
                r[0]
                for r in self._conn.execute(
                    """SELECT name FROM llm_endpoints
                        WHERE source = 'env' AND edited_at IS NULL AND name = ANY(%s)""",
                    (names,),
                ).fetchall()
            ]
            wanted: list[tuple[str, str]] = []
            for e in seed.endpoints:
                if e.name not in owned:
                    continue
                for model_id in e.models:
                    wanted.append((e.name, model_id))
                    self._conn.execute(
                        """INSERT INTO llm_models (provider, provider_kind, model_id, curated)
                           VALUES (%s, %s, %s, true)
                           ON CONFLICT (provider, model_id) DO UPDATE SET curated = true
                           WHERE llm_models.curated_edited_at IS NULL AND NOT llm_models.curated""",
                        (e.name, e.kind, model_id),
                    )
            self._conn.execute(
                """UPDATE llm_models SET curated = false
                    WHERE curated AND curated_edited_at IS NULL AND provider = ANY(%s)
                      AND NOT ((provider || '/' || model_id) = ANY(%s))""",
                ([*owned, *removed], [f"{p}/{m}" for p, m in wanted]),
            )
            for name, ref in seed.aliases.items():
                self._conn.execute(
                    """INSERT INTO llm_aliases (name, ref) VALUES (%s, %s)
                       ON CONFLICT (name) DO UPDATE SET ref = EXCLUDED.ref, updated_at = now()
                       WHERE llm_aliases.edited_at IS NULL
                         AND llm_aliases.ref IS DISTINCT FROM EXCLUDED.ref""",
                    (name, ref),
                )
            self._conn.execute(
                "DELETE FROM llm_aliases WHERE edited_at IS NULL AND NOT (name = ANY(%s))",
                (list(seed.aliases),),
            )

    def load(self) -> Seed:
        rows = self._conn.execute(
            f"""SELECT name, {_ENDPOINT_COLUMNS}, api_key_enc,
                       array(SELECT m.model_id FROM llm_models m
                              WHERE m.provider = e.name AND m.curated ORDER BY m.model_id)
                  FROM llm_endpoints e ORDER BY name"""
        ).fetchall()
        endpoints = [
            ProviderConfig.model_validate(
                {
                    "name": r[0],
                    "kind": r[1],
                    "baseUrl": r[2],
                    "location": r[3],
                    "apiKeyEnv": r[4],
                    "apiKeyRequired": r[5],
                    "discover": r[6],
                    "modelFilter": r[7],
                    "options": r[8] or {},
                    "enabled": r[9],
                    "apiKeyEnc": r[10],
                    "models": list(r[11]),
                    "optional": True,
                }
            )
            for r in rows
        ]
        aliases = dict(
            self._conn.execute("SELECT name, ref FROM llm_aliases ORDER BY name").fetchall()
        )
        return Seed(endpoints, aliases)

    def version(self) -> int:
        row = self._conn.execute("SELECT version FROM llm_config_state").fetchone()
        return int(row[0]) if row else 0


def _qualified(table: str) -> str:
    return ", ".join(f"{table}.{c.strip()}" for c in _ENDPOINT_COLUMNS.split(","))
