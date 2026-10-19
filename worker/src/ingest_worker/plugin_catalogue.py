"""The plugin catalogue (docs/design/recipe-plugins.md, slice 3b): the worker publishes its
plugins when it starts, so the API can check a recipe's plugin steps before it is published and
the recipe editor can offer them. Rows are `PluginInfo` (packages/shared/src/plugins.ts), held in
step with the API by the shared fixture packages/shared/test/fixtures/plugin-catalogue.json."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    import psycopg

    from .plugins import Plugin


def catalogue_rows(plugins: Mapping[str, Plugin]) -> list[dict[str, Any]]:
    """One `PluginInfo` per plugin, by ref."""
    return [
        {
            "ref": ref,
            "id": p.spec.id,
            "major": p.spec.version,
            "summary": p.spec.summary,
            "egress": p.spec.egress,
            "settingsSchema": p.settings.model_json_schema(by_alias=True),
        }
        for ref, p in sorted(plugins.items())
    ]


class PluginCatalogue(Protocol):
    def publish(self, rows: list[dict[str, Any]], worker_version: str) -> None:
        """Replace the catalogue with `rows`: what this worker can run."""
        ...


class MemoryPluginCatalogue:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.version: str | None = None

    def publish(self, rows: list[dict[str, Any]], worker_version: str) -> None:
        self.rows, self.version = list(rows), worker_version


class PgPluginCatalogue:
    """`plugin_catalogue` (migration 202610191612), on an autocommit connection; one transaction
    replaces the set, so readers never see half of it."""

    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self.conn = conn

    def publish(self, rows: list[dict[str, Any]], worker_version: str) -> None:
        with self.conn.transaction():
            self.conn.execute(
                "DELETE FROM plugin_catalogue WHERE NOT (ref = ANY(%s))",
                ([r["ref"] for r in rows],),
            )
            for r in rows:
                self.conn.execute(
                    """INSERT INTO plugin_catalogue (ref, plugin_id, major, summary, egress,
                                                     settings_schema, worker_version)
                       VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)
                       ON CONFLICT (ref) DO UPDATE SET
                         plugin_id = EXCLUDED.plugin_id, major = EXCLUDED.major,
                         summary = EXCLUDED.summary, egress = EXCLUDED.egress,
                         settings_schema = EXCLUDED.settings_schema,
                         worker_version = EXCLUDED.worker_version, published_at = now()""",
                    (
                        r["ref"],
                        r["id"],
                        r["major"],
                        r["summary"],
                        r["egress"],
                        json.dumps(r["settingsSchema"]),
                        worker_version,
                    ),
                )
