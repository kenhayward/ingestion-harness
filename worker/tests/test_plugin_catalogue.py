"""The plugin catalogue (docs/design/recipe-plugins.md, slice 3b): what the worker publishes about
its plugins at start, which the API reads to check recipes and the editor to offer plugins."""

from __future__ import annotations

import json
import os
from typing import Any

import pytest

from ingest_worker.config import REPO_ROOT
from ingest_worker.plugin_catalogue import (
    MemoryPluginCatalogue,
    PgPluginCatalogue,
    catalogue_rows,
)
from ingest_worker.plugins import PLUGINS

FIXTURE: dict[str, Any] = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "plugin-catalogue.json").read_text(
        encoding="utf-8"
    )
)


def test_the_catalogue_is_what_the_shared_fixture_pins() -> None:
    """The API checks recipes against these rows: a change to a plugin's settings model is a
    change to the fixture, made on purpose, and to the API's expectations with it."""
    assert catalogue_rows(PLUGINS) == FIXTURE["plugins"]


def test_publishing_replaces_the_catalogue_with_this_workers_plugins() -> None:
    catalogue = MemoryPluginCatalogue()
    stale = {**FIXTURE["plugins"][0], "ref": "acme.gone@1", "id": "acme.gone"}
    catalogue.publish([stale, *FIXTURE["plugins"]], "old")
    catalogue.publish(FIXTURE["plugins"], "2026.10.19.1")
    assert catalogue.rows == FIXTURE["plugins"]
    assert catalogue.version == "2026.10.19.1"


@pytest.mark.integration
def test_pg_catalogue_replaces_and_keeps_the_schema_as_json() -> None:
    """Needs IH_TEST_DATABASE_URL on a throwaway database with db/migrations applied."""
    import psycopg

    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set (a throwaway database)")
    with psycopg.connect(url, autocommit=True) as conn:
        catalogue = PgPluginCatalogue(conn)
        stale = {**FIXTURE["plugins"][0], "ref": "acme.gone@1", "id": "acme.gone"}
        catalogue.publish([stale, *FIXTURE["plugins"]], "old")
        catalogue.publish(FIXTURE["plugins"], "2026.10.19.1")
        rows = conn.execute(
            "SELECT ref, plugin_id, major, summary, egress, settings_schema, worker_version "
            "FROM plugin_catalogue ORDER BY ref"
        ).fetchall()
    [(ref, plugin_id, major, summary, egress, schema, version)] = rows
    expected = FIXTURE["plugins"][0]
    assert (ref, plugin_id, major, summary, egress) == (
        expected["ref"], expected["id"], expected["major"], expected["summary"], expected["egress"],
    )  # fmt: skip
    assert schema == expected["settingsSchema"] and version == "2026.10.19.1"
