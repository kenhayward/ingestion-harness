"""Mapping memory (docs/design/mapping-memory.md): the shared signature and answer contract, the
store, lookup and pre-selection."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.mapping_memory import (
    GENERIC_NAMES,
    TRAILING_UNITS,
    UNIT_SPELLINGS,
    MemoryEntry,
    OutputLook,
    Recall,
    Vote,
    answer_dict,
    defaults_key,
    parse_answer,
    preselect,
    recall,
    signature_of,
    trigram_similarity,
)
from ingest_worker.mapping_stage import MappingInputs, convert_mapping, remembered_change

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "packages" / "shared" / "test" / "fixtures"
SIGNATURES = json.loads((FIXTURES / "mapping-signature.json").read_text("utf-8"))
ANSWERS = json.loads((FIXTURES / "remembered-answers.json").read_text("utf-8"))


def test_the_word_lists_are_the_shared_ones() -> None:
    assert list(GENERIC_NAMES) == SIGNATURES["generic"]
    assert dict(UNIT_SPELLINGS) == SIGNATURES["units"]
    assert list(TRAILING_UNITS) == SIGNATURES["trailingUnits"]


@pytest.mark.parametrize("case", SIGNATURES["cases"], ids=lambda c: c["input"]["name"])
def test_signature_of_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    i = case["input"]
    s = signature_of(i["kind"], i["name"], i.get("description"), i.get("type"), i.get("table"))
    assert (s.key, s.unit, s.generic) == (case["key"], case["unit"], case["generic"])


def _every_answer() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    return [(c["definition"], a) for c in ANSWERS["cases"] for a in c["answers"]]


@pytest.mark.parametrize("definition,item", _every_answer(), ids=lambda x: str(x.get("path", "")))
def test_every_shared_answer_parses(definition: dict[str, Any], item: dict[str, Any]) -> None:
    assert answer_dict(parse_answer(item["answer"])) == item["answer"]


def test_remembered_answers_become_changes_the_stage_accepts() -> None:
    """Every answer of the fixture recipe, as the flat changes the model would give, passes
    convert_mapping (its terms allowed as remembered) and maps the outputs as remembered."""
    case = ANSWERS["cases"][0]
    draft = {k: v for k, v in case["definition"].items() if k != "semantics"}
    items = case["answers"]
    defaults = next(a["answer"] for a in items if a["path"] == "#valueNodes")
    changes = []
    for item in items:
        if item["path"] == "#valueNodes":
            continue
        change = remembered_change(parse_answer(item["answer"]), item["path"])
        if change is None:
            assert item["answer"] == {"form": "unmapped"}
            continue
        if change["op"] == "setDocumentMapping":
            change = {**change, **remembered_change(parse_answer(defaults), "#valueNodes")}
        changes.append(change)
    inputs = MappingInputs.model_validate(
        {"versions": [{"id": "exo", "version": 1, "localOnly": False, "label": "Exo"}]}
    )
    terms = {t for i in items for t in _terms(i["answer"])}
    from ingest_worker.retrieval import Candidate

    remembered = [
        Candidate(t, "class", t, "", [], [], [], 1.0, frozenset({"remembered"})) for t in terms
    ]
    body, errors = convert_mapping(
        {"notes": "", "changes": changes}, draft, inputs, {}, searched=remembered
    )
    assert errors == []
    ops = {(c["op"], c.get("field") or c.get("table") or "") for c in body["changes"]}
    assert ("putFieldMapping", "water") in ops
    assert ("putTableMapping", "results") in ops
    document = next(c for c in body["changes"] if c["op"] == "setDocumentMapping")
    prefix, _, local = document["valueNodes"]["unitProperty"].partition(":")
    assert document["prefixes"][prefix] + local == "https://ex.example/v#unit"


def _terms(answer: dict[str, Any]) -> list[str]:
    out = []
    for k, v in answer.items():
        if k in ("form", "iri", "label", "match", "unit"):
            continue
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, dict):
            out.extend(v.values())
    return out


# --- recall and pre-selection ---------------------------------------------------------------------


def entry(
    id_: str,
    answer: dict[str, Any],
    *,
    name: str = "Batch number",
    kind: str = "column",
    type_: str = "text",
    status: str = "learned",
    votes: tuple[tuple[str, str | None], ...] = (("r1", "Batches"),),
    refusals: int = 0,
) -> MemoryEntry:
    sig = signature_of(kind, name, "", type_, None)
    return MemoryEntry(
        id_, kind, sig.key, name, "", type_, sig.unit, answer, ("o",), status,
        tuple(Vote(t, "p", 1, name, "", table, False) for t, table in votes), refusals,
    )  # fmt: skip


LIT = {"form": "literal", "property": "x:batch"}
ENT = {"form": "entity", "property": "x:has", "class": "x:Batch", "iri": "batch/{value}"}


def look(
    name: str = "Batch number", table: str | None = "Assay", type_: str = "text"
) -> OutputLook:
    return OutputLook("t.c", "column", name, "", type_, table)


def recall_one(*entries: MemoryEntry, output: OutputLook | None = None) -> Recall:
    return recall(entries, [output or look()], usable=lambda _e: True, external=False).get(
        "t.c", Recall()
    )


def test_an_exact_signature_is_recalled_whatever_the_table() -> None:
    found = recall_one(entry("a", LIT))
    assert [h.entry.id for h in found.exact] == ["a"]


def test_an_answer_left_unmapped_is_never_preselected() -> None:
    assert (
        preselect(recall_one(entry("a", {"form": "unmapped"}, votes=(("r1", None), ("r2", None)))))
        is None
    )


@pytest.mark.parametrize(
    ("entries", "chosen", "confidence"),
    [
        # the confirmed answer wins a conflict, at high confidence
        ([("a", LIT, "learned", 3), ("b", ENT, "confirmed", 1)], "b", "high"),
        # unconfirmed conflict: most votes, medium
        ([("a", LIT, "learned", 3), ("b", ENT, "learned", 1)], "a", "medium"),
        # one answer, two recipes: high
        ([("a", LIT, "learned", 2)], "a", "high"),
    ],
)
def test_preselect_resolves_conflicts(
    entries: list[tuple[str, dict[str, Any], str, int]], chosen: str, confidence: str
) -> None:
    made = [
        entry(i, a, status=s, votes=tuple((f"{i}{n}", "Batches") for n in range(v)))
        for i, a, s, v in entries
    ]
    choice = preselect(recall_one(*made))
    assert choice is not None
    assert (choice.entry.id, choice.confidence) == (chosen, confidence)


def test_conflicting_answers_prefer_those_voted_from_a_table_of_the_same_name() -> None:
    a = entry("a", LIT, votes=(("r1", "Assay"),))
    b = entry("b", ENT, votes=(("r2", "Batches"), ("r3", "Batches")))
    found = recall_one(a, b, output=look(table="Assay"))
    assert [h.entry.id for h in found.exact] == ["a"]


def test_a_similar_name_or_embedding_is_a_fuzzy_hit() -> None:
    similar = entry("a", LIT, name="Batch numbers")
    other = entry("b", LIT, name="Expiry")
    found = recall(
        [similar, other], [look()], usable=lambda _e: True, external=False,
        output_vectors={"t.c": [1.0, 0.0]}, entry_vectors={"b": [0.99, 0.05]},
    )["t.c"]  # fmt: skip
    assert {h.entry.id for h in found.fuzzy} == {"a", "b"}
    assert found.exact == []


def test_unusable_and_unshareable_entries_are_left_out() -> None:
    e = entry("a", LIT)
    assert recall([e], [look()], usable=lambda _e: False, external=False) == {}
    assert recall([e], [look()], usable=lambda _e: True, external=True) == {}


def test_trigram_similarity_matches_pg_trgm_on_simple_words() -> None:
    assert trigram_similarity("lot number", "lot number") == 1.0
    assert trigram_similarity("lot number", "lot numbers") > 0.7
    assert trigram_similarity("lot number", "expiry") == 0.0


def test_defaults_are_keyed_by_the_pinned_ontologies() -> None:
    assert defaults_key(["obi", "afo", "afo"]) == "defaults|afo obi"


# --- the store contract (memory always; Postgres with IH_TEST_DATABASE_URL) -------------------------


def _memory_store(rows: list[dict[str, Any]]) -> Any:
    from ingest_worker.mapping_memory import MemoryMappingMemoryStore

    return MemoryMappingMemoryStore(
        MemoryEntry(
            r["id"],
            r["kind"],
            r["key"],
            r["name"],
            "",
            r.get("type", ""),
            "",
            r["answer"],
            tuple(r["ontologies"]),
            r.get("status", "learned"),
            tuple(Vote(t, p, 1, r["name"], "", None, x) for t, p, x in r.get("votes", [])),
            r.get("refusals", 0),
        )
        for r in rows
    )


def _pg_store(rows: list[dict[str, Any]]) -> Any:
    import os

    import psycopg

    from ingest_worker.mapping_memory import PgMappingMemoryStore

    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip(
            "IH_TEST_DATABASE_URL not set (a throwaway database: it empties mapping_memory)"
        )
    conn = psycopg.connect(url, autocommit=True)
    conn.execute("DELETE FROM mapping_memory")
    ids: dict[str, str] = {}
    for r in rows:
        (uid,) = conn.execute(
            """INSERT INTO mapping_memory (kind, signature_key, name, type, answer, answer_key,
                                           ontologies, status)
               VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s) RETURNING id::text""",
            (
                r["kind"],
                r["key"],
                r["name"],
                r.get("type", ""),
                json.dumps(r["answer"]),
                json.dumps(r["answer"], sort_keys=True),
                r["ontologies"],
                r.get("status", "learned"),
            ),
        ).fetchone()
        ids[r["id"]] = uid
        for t, p, x in r.get("votes", []):
            conn.execute(
                """INSERT INTO mapping_memory_votes (template_id, output_path, entry_id, version,
                                                     name, external)
                   VALUES (%s, %s, %s, 1, %s, %s)""",
                (t, p, uid, r["name"], x),
            )
        for n in range(r.get("refusals", 0)):
            conn.execute(
                """INSERT INTO mapping_memory_refusals (entry_id, template_id, output_path)
                   VALUES (%s, %s, 'p')""",
                (uid, f"refuser-{n}"),
            )
    store = PgMappingMemoryStore(conn)
    store.test_ids = ids  # type: ignore[attr-defined]
    return store


ROWS = [
    {
        "id": "a", "kind": "column", "key": "value|batch number|text|", "name": "Batch number",
        "type": "text", "answer": {"form": "literal", "property": "x:batch"},
        "ontologies": ["afo"], "votes": [("r1", "t.c", False), ("r2", "u.c", True)], "refusals": 1,
    },
    {
        "id": "b", "kind": "field", "key": "value|expiry|date|", "name": "Expiry",
        "answer": {"form": "literal", "property": "x:exp"}, "ontologies": ["obi"],
        "status": "confirmed",
    },
]  # fmt: skip


@pytest.fixture(params=["memory", "pg"])
def store_of(request: pytest.FixtureRequest) -> Any:
    return _memory_store if request.param == "memory" else _pg_store


def _id(store: Any, name: str) -> str:
    return getattr(store, "test_ids", {}).get(name, name)


def test_store_lists_entries_of_the_pinned_ontologies(store_of: Any) -> None:
    store = store_of(ROWS)
    got = store.entries(["afo"])
    assert [e.name for e in got] == ["Batch number"]
    [e] = got
    assert e.answer == {"form": "literal", "property": "x:batch"}
    assert sorted(v.template_id for v in e.votes) == ["r1", "r2"]
    assert e.refusals == 1
    assert e.shareable  # r2's project allows external models
    assert [e.status for e in store.entries(["obi", "other"])] == ["confirmed"]


def test_store_keeps_vectors_per_model(store_of: Any) -> None:
    store = store_of(ROWS)
    a, b = _id(store, "a"), _id(store, "b")
    store.store_vectors("m1", {a: [0.5, 0.25]})
    store.store_vectors("m1", {a: [1.0, 0.0], b: [0.0, 1.0]})
    store.store_vectors("m2", {a: [9.0]})
    assert store.vectors("m1", [a, b]) == {a: [1.0, 0.0], b: [0.0, 1.0]}
    assert store.vectors("m2", [a, b]) == {a: [9.0]}
    assert store.vectors("m3", [a]) == {}
