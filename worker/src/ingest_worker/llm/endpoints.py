"""LLM endpoints, curated models, model choices and pipeline settings in the database
(ADR 0010).

People pick a **model choice** by its label ("Main Production Model"); one choice is the
default (`settings.default_choice`), used by template steps that name none. The OCR model and
the drafting model are pipeline **settings**, never a model a step or a job can name.

`config/llm-providers.yaml` (with its `${VAR}` values), `LLM_ENDPOINTS` and `LLM_CHOICES` are
the defaults: the worker seeds them into `llm_endpoints`, `llm_models.curated`, `llm_choices`
and `llm_settings` on start
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
#: Model choices from .env: `id=Label|endpoint/model[|default]`, `;`-separated.
CHOICES_ENV = "LLM_CHOICES"
#: The embedding model setting's .env default (an `endpoint/model-id`; unset: lexical retrieval).
EMBEDDING_ENV = "EMBEDDING_MODEL"
_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_KINDS = ("anthropic", "openai-chat", "openai-responses")
#: Names the worker resolves itself: never a choice id.
RESERVED_CHOICE_IDS = frozenset({"default", "draft", "ocr"})
#: The pipeline settings: the default choice's id, and the OCR and drafting models' refs.
SETTINGS = ("default_choice", "drafting_model", "ocr_model", "embedding_model")


@dataclass(frozen=True)
class Choice:
    """A labelled model choice: what people pick ("Main Production Model"). Templates and jobs
    store its `id`, so the label can change."""

    id: str
    label: str
    ref: str
    description: str = ""


@dataclass(frozen=True)
class Seed:
    """Endpoints (each with its curated models), model choices and pipeline settings: what
    .env asks for, or what the database holds."""

    endpoints: list[ProviderConfig]
    choices: list[Choice] = field(default_factory=list)
    settings: dict[str, str] = field(default_factory=dict)

    @property
    def aliases(self) -> dict[str, str]:
        """The names the registry resolves: each choice's id, `default` (the default choice,
        for steps that name none) and `draft` (the drafting model). The OCR model is the OCR
        stage's alone, so it is not among them."""
        out = {c.id: c.ref for c in self.choices}
        if default := self.settings.get("default_choice"):
            out["default"] = default
        if drafting := self.settings.get("drafting_model"):
            out["draft"] = drafting
        return out


def _choice_entries(value: str) -> list[tuple[Choice, bool]]:
    out: list[tuple[Choice, bool]] = []
    seen: set[str] = set()
    for raw in value.split(";"):
        entry = raw.strip()
        if not entry:
            continue
        choice_id, sep, rest = entry.partition("=")
        choice_id = choice_id.strip()
        if not sep:
            raise ValueError(f"{CHOICES_ENV}: {choice_id}: expected id=Label|endpoint/model")
        if not _NAME.match(choice_id):
            raise ValueError(
                f"{CHOICES_ENV}: {choice_id!r}: ids are lower-case letters, digits, - and _"
            )
        if choice_id in RESERVED_CHOICE_IDS:
            raise ValueError(
                f"{CHOICES_ENV}: {choice_id}: reserved (default, draft and ocr are not choices)"
            )
        if choice_id in seen:
            raise ValueError(f"{CHOICES_ENV}: {choice_id}: listed twice")
        seen.add(choice_id)
        parts = [p.strip() for p in rest.split("|")]
        label = parts[0]
        ref = parts[1] if len(parts) > 1 else ""
        flag = parts[2] if len(parts) > 2 else ""
        if not label:
            raise ValueError(f"{CHOICES_ENV}: {choice_id}: a label is required")
        if "/" not in ref.strip("/"):
            raise ValueError(f"{CHOICES_ENV}: {choice_id}: the model must be endpoint/model-id")
        if flag not in ("", "default") or len(parts) > 3:
            raise ValueError(f"{CHOICES_ENV}: {choice_id}: only `default` may follow the model")
        out.append((Choice(choice_id, label, ref), flag == "default"))
    if sum(1 for _, is_default in out if is_default) > 1:
        raise ValueError(f"{CHOICES_ENV}: only one choice can be the default")
    return out


def parse_choices(value: str) -> list[Choice]:
    """`LLM_CHOICES` entries, in order."""
    return [c for c, _ in _choice_entries(value)]


def default_choice_of(value: str) -> str | None:
    """The choice `LLM_CHOICES` marks `default`, else its first."""
    entries = _choice_entries(value)
    marked = [c.id for c, is_default in entries if is_default]
    return marked[0] if marked else (entries[0][0].id if entries else None)


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
    """The defaults: the config file's providers, then `LLM_ENDPOINTS`; the choices of
    `LLM_CHOICES` (without it, for compatibility, `DEFAULT_MODEL` and `FAST_MODEL` as the choices
    "Default model" and "Fast model"); the settings: the default choice, the drafting model
    (`DRAFT_MODEL`) and the OCR model (`OCR_MODEL`)."""
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
    listed = (env.get(CHOICES_ENV) or "").strip()
    if listed:
        choices = parse_choices(listed)
        default = default_choice_of(listed)
    else:
        choices = []
        default = None
        if ref := config.aliases.get("default"):
            choices.append(Choice("main", "Default model", ref))
            default = "main"
        if ref := config.aliases.get("fast"):
            choices.append(Choice("fast", "Fast model", ref))
        for name, ref in config.aliases.items():
            if name not in ("default", "fast", *RESERVED_CHOICE_IDS) and _NAME.match(name):
                choices.append(Choice(name, name, ref))
    settings: dict[str, str] = {}
    if default:
        settings["default_choice"] = default
    if drafting := config.aliases.get("draft"):
        settings["drafting_model"] = drafting
    if config.ocr is not None:
        settings["ocr_model"] = config.ocr.model
    if embedding := (env.get(EMBEDDING_ENV) or "").strip():
        settings["embedding_model"] = embedding
    return Seed(endpoints, choices, settings)


def registry_from_seed(
    seed: Seed,
    ocr: OcrConfig | None,
    env: Mapping[str, str] = os.environ,
    factories: Mapping[str, ProviderFactory] = DEFAULT_FACTORIES,
) -> ModelRegistry:
    """Every stored endpoint is optional: one without its key (added in the UI, say) is skipped
    with a warning, never a crash. Only the models offered on an endpoint resolve (aliases and
    OCR included). The `ocr_model` setting, when stored, picks the OCR model."""
    providers = [e.model_copy(update={"optional": True}) for e in seed.endpoints]
    ocr_cfg = None
    if ocr is not None:
        ocr_cfg = ocr.model_copy(update={"model": seed.settings.get("ocr_model", ocr.model)})
    config = LLMConfig(providers=providers, aliases=dict(seed.aliases), ocr=ocr_cfg)
    return build_registry(config, env, factories, offered_only=True)


class LlmConfigStore(Protocol):
    def seed(self, seed: Seed) -> None:
        """Write the .env defaults, leaving rows an admin edited or added alone."""
        ...

    def load(self) -> Seed:
        """Every stored endpoint (by name, with its curated models), choice and setting."""
        ...

    def version(self) -> int:
        """Moves whenever endpoints, curated models, choices or settings change."""
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
            seed.settings.get("ocr_model", self._ocr.model) if self._ocr is not None else None
        )
        #: Term and output embeddings for the mapping stage (ADR 0011); None: lexical only.
        self.embedding_model: str | None = seed.settings.get("embedding_model")

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
    " enabled, tool_calls"
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
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'env')
                        ON CONFLICT (name) DO UPDATE
                          SET ({_ENDPOINT_COLUMNS}, updated_at) = (
                                EXCLUDED.kind, EXCLUDED.base_url, EXCLUDED.location,
                                EXCLUDED.api_key_env, EXCLUDED.api_key_required, EXCLUDED.discover,
                                EXCLUDED.model_filter, EXCLUDED.options, EXCLUDED.enabled,
                                EXCLUDED.tool_calls, now())
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
                        e.tool_calls,
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
            for c in seed.choices:
                self._conn.execute(
                    """INSERT INTO llm_choices (id, label, description, ref, source)
                       VALUES (%s, %s, %s, %s, 'env')
                       ON CONFLICT (id) DO UPDATE
                         SET (label, description, ref, updated_at) =
                             (EXCLUDED.label, EXCLUDED.description, EXCLUDED.ref, now())
                       WHERE llm_choices.source = 'env' AND llm_choices.edited_at IS NULL
                         AND (llm_choices.label, llm_choices.description, llm_choices.ref)
                             IS DISTINCT FROM (EXCLUDED.label, EXCLUDED.description, EXCLUDED.ref)""",
                    (c.id, c.label, c.description, c.ref),
                )
            self._conn.execute(
                """DELETE FROM llm_choices
                    WHERE source = 'env' AND edited_at IS NULL AND NOT (id = ANY(%s))""",
                ([c.id for c in seed.choices],),
            )
            for name, value in seed.settings.items():
                self._conn.execute(
                    """INSERT INTO llm_settings (name, value) VALUES (%s, %s)
                       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
                       WHERE llm_settings.edited_at IS NULL
                         AND llm_settings.value IS DISTINCT FROM EXCLUDED.value""",
                    (name, value),
                )
            self._conn.execute(
                "DELETE FROM llm_settings WHERE edited_at IS NULL AND NOT (name = ANY(%s))",
                (list(seed.settings),),
            )

    def load(self) -> Seed:
        rows = self._conn.execute(
            f"""SELECT name, {_ENDPOINT_COLUMNS}, api_key_enc,
                       array(SELECT m.model_id FROM llm_models m
                              WHERE m.provider = e.name AND m.curated AND m.enabled
                              ORDER BY m.model_id),
                       (SELECT json_object_agg(m.model_id, m.max_output_tokens) FROM llm_models m
                         WHERE m.provider = e.name AND m.curated AND m.enabled
                           AND m.max_output_tokens IS NOT NULL),
                       (SELECT json_object_agg(m.model_id, m.max_concurrent_calls)
                          FROM llm_models m
                         WHERE m.provider = e.name AND m.curated AND m.enabled
                           AND m.max_concurrent_calls IS NOT NULL)
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
                    "toolCalls": r[10],
                    "apiKeyEnc": r[11],
                    "models": list(r[12]),
                    "maxOutputTokens": r[13] or {},
                    "maxConcurrentCalls": r[14] or {},
                    "optional": True,
                }
            )
            for r in rows
        ]
        choices = [
            Choice(r[0], r[1], r[2], r[3])
            for r in self._conn.execute(
                "SELECT id, label, ref, description FROM llm_choices ORDER BY id"
            ).fetchall()
        ]
        settings = dict(
            self._conn.execute("SELECT name, value FROM llm_settings ORDER BY name").fetchall()
        )
        return Seed(endpoints, choices, settings)

    def version(self) -> int:
        row = self._conn.execute("SELECT version FROM llm_config_state").fetchone()
        return int(row[0]) if row else 0


def _qualified(table: str) -> str:
    return ", ".join(f"{table}.{c.strip()}" for c in _ENDPOINT_COLUMNS.split(","))
