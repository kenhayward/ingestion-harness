# Ontology URL Import and Graph View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rollout step 2 of ADR 0011 (spec: `docs/design/rdf-publishing.md`, *Ontology library*).

- **Import by URL:** admins import an ontology from an allowlisted HTTPS URL.
- **`owl:imports`:** the worker resolves them against the library first, then from allowed
  hosts, down to depth 3. Imported terms are indexed with the version, marked with the
  ontology they come from.
- **Graph view:** everyone can view a term's neighbourhood as an interactive graph.

**Architecture:**
- **API:** creates a URL version with no bytes yet, plus an `ontology` job whose params carry
  `sourceUrl`.
- **Worker:** fetches through an `ontology_fetch` module, which enforces HTTPS, the allowlist,
  public addresses only, a re-check on every redirect, and a byte cap. It records the source,
  then resolves each import:
  1. a library version, found by ontology or version IRI;
  2. else a fetch, which creates a new library ontology tagged `imported-by:<root>`.

  It then indexes the version's own graph together with the graphs of its import closure.
- **Neighbourhood:** a pure builder in the API expands from the focus term over bounded
  queries.
- **Web:** loads Cytoscape.js lazily through an injectable renderer, and lists the same nodes
  and links as text for keyboard and screen-reader users.

**Tech Stack:** Postgres 17, Python 3.13 (rdflib, httpx, psycopg 3), Fastify/TS (Zod, pg),
React + Cytoscape.js (`cytoscape`, `cytoscape-fcose`).

**Spec:** `docs/design/rdf-publishing.md` (*Ontology library*: Import steps 1–5, Browsing),
`docs/adr/0011-rdf-publishing-and-ontologies.md`.

## Global Constraints

- **URL rules:**
  - Only `https`.
  - The host must be on `ONTOLOGY_FETCH_ALLOW`, comma-separated. An entry is an exact host
    (`w3id.org`), or a leading-dot suffix (`.example.org`) that matches the domain and its
    subdomains. An empty list means URL imports are off.
  - Each redirect (at most 5) is checked again.
  - Every address the host resolves to must be public (`ipaddress…is_global`).
  - The body is capped at `ONTOLOGY_MAX_BYTES`, default 104857600 (100 MiB). The timeout is
    60 s.
- **Shared host rule:** the same rule is in TS (`ontologyUrlProblem`) and Python (`host_allowed`), held in step by `packages/shared/test/fixtures/ontology-url.json`.
- **Imports:**
  - Resolution depth is at most 3. Each IRI is resolved once per job, and cycles are guarded.
  - An import that cannot be resolved is listed with a reason. It never fails the job.
- **Imported terms:** they carry `definedIn = "<ontologyId>@<version>"`. The version's own
  terms carry `null`. `stats` counts own terms, and `stats.imported` counts the others.
- **Imported ontologies:**
  - They are created as library ontologies: `source_kind = 'import'`, tag
    `imported-by:<rootId>`, version 1, ready.
  - Each id is a slug of its IRI, made unique with `-2`, `-3`, and so on.
- **DNS rebinding:** a residual risk, because the vetted address is not pinned. Only
  allowlisted hosts are fetched. Document this in the design doc.
- **Unchanged from step 1:** the same TDD rules, admin enforcement (`403 admins only` first),
  OpenAPI for every route, and commit attribution.

## Review Focus

1. **Redirect off the allowlist:** a URL that redirects to a non-allowlisted or private host
   must be refused at that hop. Covered in Task 2.
2. **Import cycles:** an import cycle (A imports B, B imports A) and an ontology importing
   itself must terminate, and each ontology must be created at most once. Covered in Task 4.
3. **URL versions without bytes:** a URL version whose fetch fails ends `failed` with the
   reason, and its source download is a 404 (it has no bytes). Covered in Tasks 4 and 5.
4. **Rows from step 1:** they have no `sourceKind`, `reason`, `definedIn` or `stats.imported`.
   The API must read them with defaults. Covered in Task 5's Pg test.
5. **Neighbourhood of a hub:** a term with thousands of neighbours returns at most 150 nodes
   with `truncated: true`. Covered in Task 6.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `db/migrations/0033_ontology_imports.sql` | `source_kind`, `source_url`; `sha256`/`bytes` nullable; `ontology_terms.defined_in` |
| `packages/shared/src/ontologies.ts` | new fields; `OntologyImport` entries; neighbourhood + fetch-policy schemas; `ontologyUrlProblem`, `hostAllowed` |
| `packages/shared/src/storage-keys.ts` | (unchanged keys; Python gains `ontology_source_key`) |
| `packages/shared/test/fixtures/ontology-url.json` | host-rule cases shared with Python |
| `worker/src/ingest_worker/ontology_fetch.py` | `FetchPolicy`, `host_allowed`, `fetch_rdf`, `Fetched` |
| `worker/src/ingest_worker/ontology.py` | `read_graph`, `index_graph`, `Term.defined_in`, `ParsedOntology.title`; job: URL source + import resolution; store protocol additions |
| `worker/src/ingest_worker/{pipeline,main,config,storage}.py` | `ontology_fetch` dep; settings; `ontology_source_key` |
| `worker/tests/test_ontology_fetch.py`, `test_ontology.py`, `test_ontology_job.py`, `fakes.py` | tests; `MemoryOntologyStore` additions |
| `apps/api/src/ontologies/repo.ts` | URL versions, new columns, `neighbours` |
| `apps/api/src/ontologies/neighbourhood.ts` | pure `buildNeighbourhood` |
| `apps/api/src/routes/ontologies.ts` | `POST /ontologies/from-url`, `GET /ontology-settings`, `GET …/neighbourhood` |
| `apps/api/src/{app,server,config}.ts`, `test/helpers.ts` | `ontologyFetch` dep from `ONTOLOGY_FETCH_ALLOW`/`ONTOLOGY_MAX_BYTES` |
| `apps/web/src/api/client.ts`, `test/fake-api.ts` | `importOntologyFromUrl`, `getOntologySettings`, `getNeighbourhood` |
| `apps/web/src/ontologies/ImportOntologyDialog.tsx` | file / URL modes |
| `apps/web/src/ontologies/OntologyPage.tsx` | imports panel with resolutions; source shown for URL versions |
| `apps/web/src/ontologies/TermGraph.tsx`, `TermBrowser.tsx`, `graphRenderer.ts` | graph view (lazy Cytoscape), list fallback, Details/Graph toggle |
| docs, `.env.example`, compose | contracts, step-2 notes, settings |

---

### Task 1: Migration 0033 and shared contracts

**Files:**
- Create: `db/migrations/0033_ontology_imports.sql`, `packages/shared/test/fixtures/ontology-url.json`
- Modify: `packages/shared/src/ontologies.ts`
- Test: `packages/shared/test/ontologies.test.ts` (append)

**Interfaces — Produces:**
- `OntologyVersionView` gains `sourceKind: 'upload'|'url'|'import'` and
  `sourceUrl: string|null`. `sha256` and `bytes` become nullable.
- `OntologyImportSchema`: `{ iri, resolution: 'unresolved'|'library'|'fetched', ontologyId: string|null, version: number|null, reason: string|null }`.
- `OntologyStatsSchema` gains `imported: number`.
- `OntologyTerm` gains `definedIn: string|null`.
- Fetch policy: `OntologySettingsSchema = { fetchHosts: string[]; maxBytes: number }` and
  `OntologyFromUrlBodySchema = { id, label?, description?, tags?, localOnly?, url }` (strict).
- Neighbourhood:
  - `NeighbourhoodSchema = { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }`
  - `GraphNode = { iri, label, kind: OntologyTermKind | 'external', focus: boolean }`
  - `GraphEdge = { source, target, kind: 'subClassOf'|'subPropertyOf'|'broader'|'inScheme'|'domain'|'range'|'targets' }`
  - `NeighbourhoodQuerySchema = { iri, depth: 1|2 (default 1) }`
- URL helpers:
  - `hostAllowed(host, hosts): boolean`
  - `ontologyUrlProblem(url, hosts): string | null`, which returns one of:
    - `'URL imports are off: set ONTOLOGY_FETCH_ALLOW'`
    - `'not a URL'`
    - `'only https URLs can be imported'`
    - `` `${host} is not on ONTOLOGY_FETCH_ALLOW` ``
  - `ontologyFileNameFromUrl(url): string`: the last path segment, else the host.

- [ ] **Step 1: Write the failing tests** (append to `packages/shared/test/ontologies.test.ts`)

```ts
import fixture from './fixtures/ontology-url.json' with { type: 'json' };
import {
  NeighbourhoodQuerySchema,
  OntologyFromUrlBodySchema,
  hostAllowed,
  ontologyFileNameFromUrl,
  ontologyUrlProblem,
} from '../src/index.js';

describe('ontology URL rules (shared with the worker)', () => {
  it.each(fixture.hosts.map((c) => [c.host, c.allow.join(','), c.allowed] as const))(
    '%s against %s → %s',
    (host, allow, allowed) => {
      expect(hostAllowed(host, allow ? allow.split(',') : [])).toBe(allowed);
    },
  );

  it.each([
    ['https://w3id.org/idmp/o', ['w3id.org'], null],
    ['https://w3id.org/idmp/o', [], 'URL imports are off: set ONTOLOGY_FETCH_ALLOW'],
    ['not a url', ['w3id.org'], 'not a URL'],
    ['http://w3id.org/x', ['w3id.org'], 'only https URLs can be imported'],
    ['https://evil.org/x', ['w3id.org'], 'evil.org is not on ONTOLOGY_FETCH_ALLOW'],
  ])('%s', (url, hosts, problem) => {
    expect(ontologyUrlProblem(url, hosts)).toBe(problem);
  });

  it('names a fetched file after its path', () => {
    expect(ontologyFileNameFromUrl('https://w3id.org/idmp/core.ttl?x=1')).toBe('core.ttl');
    expect(ontologyFileNameFromUrl('https://w3id.org/')).toBe('w3id.org');
  });

  it('parses the URL import body and the neighbourhood query', () => {
    expect(OntologyFromUrlBodySchema.safeParse({ id: 'pv', url: 'https://x.org/a' }).success).toBe(true);
    expect(OntologyFromUrlBodySchema.safeParse({ id: 'pv', url: 'https://x.org/a', x: 1 }).success).toBe(false);
    expect(NeighbourhoodQuerySchema.parse({ iri: 'https://x.org/A' })).toEqual({ iri: 'https://x.org/A', depth: 1 });
    expect(NeighbourhoodQuerySchema.safeParse({ iri: 'x', depth: '3' }).success).toBe(false);
  });
});
```

`packages/shared/test/fixtures/ontology-url.json`:

```json
{
  "hosts": [
    { "host": "w3id.org", "allow": ["w3id.org"], "allowed": true },
    { "host": "W3ID.org.", "allow": ["w3id.org"], "allowed": true },
    { "host": "sub.w3id.org", "allow": ["w3id.org"], "allowed": false },
    { "host": "sub.w3id.org", "allow": [".w3id.org"], "allowed": true },
    { "host": "w3id.org", "allow": [".w3id.org"], "allowed": true },
    { "host": "evilw3id.org", "allow": [".w3id.org"], "allowed": false },
    { "host": "w3id.org", "allow": [], "allowed": false },
    { "host": "w3id.org", "allow": [" ", "w3id.org "], "allowed": true }
  ]
}
```

- [ ] **Step 2: Run** `npx vitest run packages/shared/test/ontologies.test.ts` — Expected: FAIL (imports missing).

- [ ] **Step 3: Implement** in `packages/shared/src/ontologies.ts`:
  - `ONTOLOGY_SOURCE_KINDS = ['upload', 'url', 'import'] as const`.
  - Extend `OntologyVersionViewSchema`:
    - add `sourceKind: z.enum(ONTOLOGY_SOURCE_KINDS)` and `sourceUrl: z.string().nullable()`;
    - change `sha256: z.string().nullable()` and `bytes: z.number().int().nullable()`;
    - replace `imports` with `z.array(OntologyImportSchema)`.
  - `OntologyStatsSchema` gains `imported: z.number().int()`.
  - `OntologyTermSchema` gains `definedIn: z.string().nullable()` with the doc comment
    `/** "<ontologyId>@<version>" for a term indexed from an import; null for the version's own. */`.

  Then add:

```ts
export const OntologyImportSchema = z.object({
  iri: z.string(),
  /** library: an existing ready version; fetched: imported now into the library. */
  resolution: z.enum(['unresolved', 'library', 'fetched']),
  ontologyId: z.string().nullable(),
  version: z.number().int().nullable(),
  /** Why an import is unresolved. */
  reason: z.string().nullable(),
});
export type OntologyImport = z.infer<typeof OntologyImportSchema>;

/** A host on the allowlist: exact, or `.example.org` for the domain and its subdomains. */
export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return hosts.some((raw) => {
    const e = raw.trim().toLowerCase();
    if (!e) return false;
    return e.startsWith('.') ? h === e.slice(1) || h.endsWith(e) : h === e;
  });
}

/** Why a URL cannot be imported, or null. Mirrors `ontology_fetch` in the worker. */
export function ontologyUrlProblem(url: string, hosts: readonly string[]): string | null {
  if (!hosts.some((h) => h.trim())) return 'URL imports are off: set ONTOLOGY_FETCH_ALLOW';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (parsed.protocol !== 'https:') return 'only https URLs can be imported';
  return hostAllowed(parsed.hostname, hosts) ? null : `${parsed.hostname} is not on ONTOLOGY_FETCH_ALLOW`;
}

export function ontologyFileNameFromUrl(url: string): string {
  const u = new URL(url);
  const last = u.pathname.split('/').filter(Boolean).pop();
  return last ? decodeURIComponent(last) : u.hostname;
}

export const OntologySettingsSchema = z.object({
  fetchHosts: z.array(z.string()),
  maxBytes: z.number().int(),
});
export type OntologySettings = z.infer<typeof OntologySettingsSchema>;

export const OntologyFromUrlBodySchema = z
  .object({
    id: z.string().regex(ONTOLOGY_ID_RE),
    label: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().regex(TAG_RE)).max(20).optional(),
    localOnly: z.boolean().optional(),
    url: z.string().min(1).max(2000),
  })
  .strict();
export type OntologyFromUrlBody = z.infer<typeof OntologyFromUrlBodySchema>;

export const GRAPH_EDGE_KINDS = ['subClassOf', 'subPropertyOf', 'broader', 'inScheme', 'domain', 'range', 'targets'] as const;
export const GraphNodeSchema = z.object({
  iri: z.string(),
  label: z.string(),
  kind: z.union([OntologyTermKindSchema, z.literal('external')]),
  focus: z.boolean(),
});
export const GraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: z.enum(GRAPH_EDGE_KINDS),
});
export const NeighbourhoodSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  truncated: z.boolean(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type Neighbourhood = z.infer<typeof NeighbourhoodSchema>;
export const NeighbourhoodQuerySchema = z.object({
  iri: z.string().min(1).max(2000),
  depth: z.coerce.number().int().min(1).max(2).default(1),
});
/** Nodes in one neighbourhood at most; past it `truncated` is true. */
export const NEIGHBOURHOOD_LIMIT = 150;
```

Write `db/migrations/0033_ontology_imports.sql`:

```sql
-- Ontology library, rollout step 2 (ADR 0011): versions imported by URL or pulled in by
-- owl:imports, and terms indexed from a version's imports.
ALTER TABLE ontology_versions
  ADD COLUMN source_kind text NOT NULL DEFAULT 'upload'
    CHECK (source_kind IN ('upload', 'url', 'import')),
  ADD COLUMN source_url text,
  -- A URL version has no bytes until the worker fetches them.
  ALTER COLUMN sha256 DROP NOT NULL,
  ALTER COLUMN bytes DROP NOT NULL;

-- "<ontologyId>@<version>" for a term indexed from an import; NULL for the version's own.
ALTER TABLE ontology_terms ADD COLUMN defined_in text;
```

- [ ] **Step 4: Run** the shared test and `npm run build -w @ih/shared`. Expected: PASS. Then
  run `npm run typecheck` and fix every place that builds an `OntologyVersionView` or an
  `OntologyTerm`: the memory repo, the fixtures, `toVersion` and `toTerm`. Use these
  defaults:
  - `sourceKind: 'upload'`, `sourceUrl: null`;
  - `definedIn: null`, `stats.imported: 0`;
  - each import entry: `ontologyId`, `version` and `reason` as `null`.

  Task 5 owns the Postgres mapping. Here make it compile only, with these defaults.

- [ ] **Step 5: Commit** — `Ontology library step 2: migration 0033 and shared contracts`.

---

### Task 2: Worker fetch module (`ontology_fetch`)

**Files:** Create `worker/src/ingest_worker/ontology_fetch.py`, `worker/tests/test_ontology_fetch.py`.

**Interfaces — Produces:**
- `FetchPolicy(hosts: tuple[str, ...], max_bytes: int = 100 MiB, timeout_s: float = 60.0, max_redirects: int = 5)`.
- `host_allowed(host, hosts) -> bool`.
- `Fetched(data: bytes, media_type: str, url: str, file_name: str)`.
- `fetch_rdf(url, policy, *, client: httpx.Client, resolve: Resolver = system_resolver) -> Fetched`.
  - A refused or unreadable URL raises `DocumentError`.
  - A transport error or a 5xx raises `OntologySourceUnavailable(Exception)`, which is
    retried.
- `Resolver = Callable[[str], list[str]]` and `system_resolver`.

- [ ] **Step 1: Write the failing tests**

```python
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from ingest_worker.ontology_fetch import (
    FetchPolicy,
    OntologySourceUnavailable,
    fetch_rdf,
    host_allowed,
)
from ingest_worker.pipeline import DocumentError

FIXTURE = Path(__file__).resolve().parents[2] / "packages/shared/test/fixtures/ontology-url.json"
TTL = b"@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://w3id.org/a#A> a owl:Class .\n"
POLICY = FetchPolicy(hosts=("w3id.org", ".example.org"), max_bytes=1000)


@pytest.mark.parametrize("case", json.loads(FIXTURE.read_text(encoding="utf-8"))["hosts"])
def test_host_rule_matches_the_shared_fixture(case: dict[str, object]) -> None:
    assert host_allowed(str(case["host"]), list(case["allow"])) is case["allowed"]  # type: ignore[arg-type]


def public(_host: str) -> list[str]:
    return ["93.184.216.34"]


def client(handler: httpx.MockTransport) -> httpx.Client:
    return httpx.Client(transport=handler)


def test_fetches_an_allowed_https_url() -> None:
    seen: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["accept"])
        return httpx.Response(200, content=TTL, headers={"content-type": "text/turtle; charset=utf-8"})

    got = fetch_rdf("https://w3id.org/a/core.ttl", POLICY, client=client(httpx.MockTransport(handle)), resolve=public)
    assert (got.data, got.media_type, got.file_name) == (TTL, "text/turtle", "core.ttl")
    assert "text/turtle" in seen[0] and "application/rdf+xml" in seen[0]


@pytest.mark.parametrize(
    ("url", "message"),
    [
        ("http://w3id.org/a", "only https"),
        ("https://evil.org/a", "evil.org is not on ONTOLOGY_FETCH_ALLOW"),
        ("ftp://w3id.org/a", "only https"),
    ],
)
def test_refuses_urls_outside_the_policy(url: str, message: str) -> None:
    never = httpx.MockTransport(lambda r: pytest.fail("no request expected"))
    with pytest.raises(DocumentError, match=message):
        fetch_rdf(url, POLICY, client=client(never), resolve=public)


def test_url_imports_are_off_without_hosts() -> None:
    never = httpx.MockTransport(lambda r: pytest.fail("no request expected"))
    with pytest.raises(DocumentError, match="URL imports are off"):
        fetch_rdf("https://w3id.org/a", FetchPolicy(hosts=()), client=client(never), resolve=public)


@pytest.mark.parametrize("address", ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::1", "192.168.0.9"])
def test_refuses_hosts_resolving_to_private_addresses(address: str) -> None:
    never = httpx.MockTransport(lambda r: pytest.fail("no request expected"))
    with pytest.raises(DocumentError, match="private or local address"):
        fetch_rdf("https://w3id.org/a", POLICY, client=client(never), resolve=lambda _h: ["93.184.216.34", address])


def test_each_redirect_is_checked_again() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.host == "w3id.org":
            return httpx.Response(302, headers={"location": "https://evil.org/x"})
        pytest.fail("the disallowed host was requested")

    with pytest.raises(DocumentError, match="evil.org is not on ONTOLOGY_FETCH_ALLOW"):
        fetch_rdf("https://w3id.org/a", POLICY, client=client(httpx.MockTransport(handle)), resolve=public)


def test_follows_a_redirect_to_an_allowed_host() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.host == "w3id.org":
            return httpx.Response(303, headers={"location": "https://docs.example.org/onto.owl"})
        return httpx.Response(200, content=TTL, headers={"content-type": "text/turtle"})

    got = fetch_rdf("https://w3id.org/a", POLICY, client=client(httpx.MockTransport(handle)), resolve=public)
    assert got.url == "https://docs.example.org/onto.owl" and got.file_name == "onto.owl"


def test_too_many_redirects() -> None:
    loop = httpx.MockTransport(lambda r: httpx.Response(302, headers={"location": "https://w3id.org/again"}))
    with pytest.raises(DocumentError, match="too many redirects"):
        fetch_rdf("https://w3id.org/a", POLICY, client=client(loop), resolve=public)


@pytest.mark.parametrize("headers", [{"content-length": "5000"}, {}])
def test_bodies_over_the_cap_are_refused(headers: dict[str, str]) -> None:
    big = httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * 5000, headers=headers))
    with pytest.raises(DocumentError, match="over the 1000-byte limit"):
        fetch_rdf("https://w3id.org/a", POLICY, client=client(big), resolve=public)


def test_client_errors_are_final_and_server_errors_retried() -> None:
    with pytest.raises(DocumentError, match="answered 404"):
        fetch_rdf("https://w3id.org/a", POLICY, client=client(httpx.MockTransport(lambda r: httpx.Response(404))), resolve=public)
    with pytest.raises(OntologySourceUnavailable, match="503"):
        fetch_rdf("https://w3id.org/a", POLICY, client=client(httpx.MockTransport(lambda r: httpx.Response(503))), resolve=public)


def test_unresolvable_hosts_are_final() -> None:
    def nowhere(_host: str) -> list[str]:
        raise OSError("Name or service not known")

    never = httpx.MockTransport(lambda r: pytest.fail("no request expected"))
    with pytest.raises(DocumentError, match="cannot resolve w3id.org"):
        fetch_rdf("https://w3id.org/a", POLICY, client=client(never), resolve=nowhere)
```

- [ ] **Step 2: Run** `cd worker && uv run pytest tests/test_ontology_fetch.py -q` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `worker/src/ingest_worker/ontology_fetch.py`:

```python
"""Fetching ontologies by URL (ADR 0011, rollout step 2).

Only `https`, only hosts on ONTOLOGY_FETCH_ALLOW, only public addresses, each redirect checked
again, a byte cap and a timeout. The vetted address is not pinned for the request, so DNS
rebinding remains possible for an allowlisted host; the allowlist is what bounds it.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from urllib.parse import unquote

import httpx

from .pipeline import DocumentError

ACCEPT = (
    "text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.8, "
    "application/n-triples;q=0.8, text/n3;q=0.7, */*;q=0.1"
)
Resolver = Callable[[str], list[str]]


class OntologySourceUnavailable(Exception):
    """The host could not answer now (transport error, 5xx): the job is retried."""


@dataclass(frozen=True)
class FetchPolicy:
    hosts: tuple[str, ...]
    max_bytes: int = 100 * 1024 * 1024
    timeout_s: float = 60.0
    max_redirects: int = 5


@dataclass(frozen=True)
class Fetched:
    data: bytes
    media_type: str
    url: str
    file_name: str


def host_allowed(host: str, hosts: Sequence[str]) -> bool:
    """Exact hosts, or `.example.org` for the domain and its subdomains (as hostAllowed in TS)."""
    h = host.lower().rstrip(".")
    for raw in hosts:
        e = raw.strip().lower()
        if not e:
            continue
        if e.startswith("."):
            if h == e[1:] or h.endswith(e):
                return True
        elif h == e:
            return True
    return False


def system_resolver(host: str) -> list[str]:
    return sorted({str(info[4][0]) for info in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})


def file_name_from(url: str) -> str:
    parsed = httpx.URL(url)
    last = [p for p in parsed.path.split("/") if p]
    return unquote(last[-1]) if last else parsed.host


def _check(url: str, policy: FetchPolicy, resolve: Resolver) -> None:
    if not any(h.strip() for h in policy.hosts):
        raise DocumentError("URL imports are off: set ONTOLOGY_FETCH_ALLOW")
    try:
        parsed = httpx.URL(url)
    except httpx.InvalidURL as exc:
        raise DocumentError(f"not a URL: {url}") from exc
    if parsed.scheme != "https":
        raise DocumentError(f"only https URLs can be imported: {url}")
    if not host_allowed(parsed.host, policy.hosts):
        raise DocumentError(f"{parsed.host} is not on ONTOLOGY_FETCH_ALLOW")
    try:
        addresses = resolve(parsed.host)
    except OSError as exc:
        raise DocumentError(f"cannot resolve {parsed.host}: {exc}") from exc
    if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
        raise DocumentError(f"{parsed.host} resolves to a private or local address")


def fetch_rdf(
    url: str, policy: FetchPolicy, *, client: httpx.Client, resolve: Resolver = system_resolver
) -> Fetched:
    current = url
    for _ in range(policy.max_redirects + 1):
        _check(current, policy, resolve)
        try:
            with client.stream(
                "GET", current, headers={"Accept": ACCEPT}, follow_redirects=False, timeout=policy.timeout_s
            ) as resp:
                if resp.is_redirect:
                    location = resp.headers.get("location")
                    if not location:
                        raise DocumentError(f"{current} redirected without a location")
                    current = str(resp.url.join(location))
                    continue
                if resp.status_code >= 500:
                    raise OntologySourceUnavailable(f"{current} answered {resp.status_code}")
                if resp.status_code >= 400:
                    raise DocumentError(f"{current} answered {resp.status_code}")
                limit = policy.max_bytes
                length = resp.headers.get("content-length")
                if length is not None and length.isdigit() and int(length) > limit:
                    raise DocumentError(f"{current} is over the {limit}-byte limit")
                body = bytearray()
                for chunk in resp.iter_bytes():
                    body += chunk
                    if len(body) > limit:
                        raise DocumentError(f"{current} is over the {limit}-byte limit")
                media = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                return Fetched(bytes(body), media, current, file_name_from(current))
        except httpx.TransportError as exc:
            raise OntologySourceUnavailable(f"{current}: {exc}") from exc
    raise DocumentError(f"too many redirects from {url}")
```

- [ ] **Step 4: Run** the tests, then ruff and mypy. Expected: PASS.

- [ ] **Step 5: Commit** — `Worker: fetch ontologies by allowlisted HTTPS URL`.

---

### Task 3: Worker indexing over an import closure

**Files:** Modify `worker/src/ingest_worker/ontology.py`; Test: `worker/tests/test_ontology.py` (append).

**Interfaces — Produces:**
- `read_graph(data, media_type, file_name, *, max_triples) -> Graph`: refuse unsafe input,
  parse, cap.
- `index_graph(graph, *, imports: Sequence[tuple[Graph, str]] = (), max_triples) -> ParsedOntology`.
- `parse_ontology(data, media_type, file_name, *, max_triples=…, imports=())`: unchanged for
  callers.
- `Term.defined_in: str | None = None`.
- `ParsedOntology.title: str | None`, from the header's `rdfs:label`, `dcterms:title` or
  `dc:title`.
- `stats()` counts own terms only and adds `imported`.

- [ ] **Step 1: Write the failing tests** (append)

```python
from rdflib import Graph

from ingest_worker.ontology import index_graph, read_graph

BASE_TTL = (
    PREFIXES
    + """
<https://example.org/base> a owl:Ontology ; rdfs:label "Base ontology" .
<https://example.org/base#Thing> a owl:Class ; rdfs:label "Thing" .
<https://example.org/base#Item> a owl:Class ; rdfs:subClassOf <https://example.org/base#Thing> .
"""
)


def test_imported_terms_are_indexed_with_their_origin() -> None:
    base = read_graph(BASE_TTL.encode(), "text/turtle", "base.ttl", max_triples=1000)
    own = read_graph(OWL_TTL.encode(), "text/turtle", "pv.ttl", max_triples=1000)
    parsed = index_graph(own, imports=[(base, "base@1")], max_triples=1000)
    thing = term(parsed, "https://example.org/base#Thing")
    assert (thing.defined_in, thing.label, thing.root) == ("base@1", "Thing", True)
    # Batch's parent is now indexed (from the import), so Batch is no longer a root.
    batch = term(parsed, "https://example.org/pv#Batch")
    assert batch.defined_in is None and not batch.root
    assert thing.child_count == 2  # Item and Batch
    stats = parsed.stats()
    assert stats["classes"] == 4 and stats["imported"] == 2
    # Only the version's own triples are kept as its normalized form and header.
    assert b"base#Thing> <http://www.w3.org/2000/01/rdf-schema#label>" not in parsed.normalized
    assert parsed.ontology_iri == "https://example.org/pv"


def test_the_triple_cap_covers_imports() -> None:
    base = read_graph(BASE_TTL.encode(), "text/turtle", "base.ttl", max_triples=1000)
    own = read_graph(OWL_TTL.encode(), "text/turtle", "pv.ttl", max_triples=1000)
    with pytest.raises(DocumentError, match="too large"):
        index_graph(own, imports=[(base, "base@1")], max_triples=len(own) + 1)


def test_reads_the_ontology_title() -> None:
    parsed = parse_ontology(BASE_TTL.encode(), "text/turtle", "base.ttl")
    assert parsed.title == "Base ontology"
    assert owl().title is None
```

- [ ] **Step 2: Run** `uv run pytest tests/test_ontology.py -q -k "imported or cap_covers or title"` — Expected: FAIL (import errors).

- [ ] **Step 3: Implement.** Refactor `parse_ontology` into `read_graph` (the existing
  unsafe-input refusal, parse and per-file cap) and `index_graph`:
  - `combined = Graph()`, then add the own graph's triples and each import graph's triples
    (`for t in g: combined.add(t)`).
  - Check `len(combined) > max_triples`. The error keeps the existing
    `ontology too large (N triples, limit M)` wording.
  - Header, imports and `normalized` come from the own graph only.
  - Read `title` from the header: the first `_pick` of `rdfs:label`, `dcterms:title`,
    `dc:title` on the ontology subject.
  - Take kinds from `_kinds_of(combined)` and build terms with `_term(combined, …)`.
  - `defined_in`: `None` when `(iri, RDF.type, None) in own_graph`; otherwise the label of the
    first import graph that has `(iri, RDF.type, None)`.
  - `_mark_roots` runs over all terms.
  - `kinds` comes from the own terms (`defined_in is None`) plus the header, as before.
  - `stats()` counts only own terms (`defined_in is None`) and adds `"imported"`, the count of
    the others.
  - `PgOntologyStore.save` writes `defined_in` as a 15th `COPY` column (`text`).
  - `MemoryOntologyStore` needs no change.

- [ ] **Step 4: Run** the full `tests/test_ontology.py` and `tests/test_ontology_job.py`, plus lint. Expected: PASS. Update the SHACL stats test's expected dict with `"imported": 0`; this is a deliberate contract extension, not a weakening.

- [ ] **Step 5: Commit** — `Worker: index an ontology together with its imports (defined_in)`.

---

### Task 4: Worker job — URL sources and import resolution

**Files:**
- Modify: `worker/src/ingest_worker/ontology.py`, `pipeline.py`, `main.py`, `config.py`,
  `storage.py` (add `ontology_source_key`) and `tests/fakes.py`.
- Test: `worker/tests/test_ontology_job.py` (append).

**Interfaces:**
- Consumes:
  - `fetch_rdf` and `Fetched` (Task 2);
  - `read_graph`, `index_graph` and `ParsedOntology.title` (Task 3);
  - the API's URL job params `{ontologyId, version, sourceUrl, fileName, mediaType: ''}` (Task 5).
- Produces:
  - `PipelineDeps.ontology_fetch: Callable[[str], Fetched] | None = None`, where `None` means
    URL imports are off.
  - `OntologyJobParams`: `source_key` and `source_url` are both optional, and exactly one must
    be set. `media_type` defaults to `""`.
  - `OntologyStore` gains:
    - `set_source(oid, v, *, file_name, media_type, sha256, size) -> None`, which raises
      `DuplicateSource(version)`;
    - `find_ready(iri) -> tuple[str, int] | None`;
    - `version_imports(oid, v) -> list[dict[str, Any]]`;
    - `create_imported(*, iri, title, file_name, media_type, sha256, size, source_url, parsed, root_id) -> tuple[str, int]`.
  - `storage.ontology_source_key(ontology_id, sha256, ext) -> str`, which mirrors the TS key.
  - `MAX_IMPORT_DEPTH = 3`.

- [ ] **Step 1: Write the failing tests** (append; reuse `make`, `ontology_job` from step 1)

```python
from ingest_worker.ontology_fetch import Fetched
from ingest_worker.pipeline import DocumentError
from ingest_worker.storage import ontology_source_key

ROOT = b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://w3id.org/pv> a owl:Ontology ; owl:imports <https://w3id.org/base> , <https://w3id.org/lib> , <https://nope.org/x> .
<https://w3id.org/pv#Batch> a owl:Class ; rdfs:subClassOf <https://w3id.org/base#Thing> .
"""
BASE = b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://w3id.org/base> a owl:Ontology ; rdfs:label "Base" ; owl:imports <https://w3id.org/pv> .
<https://w3id.org/base#Thing> a owl:Class .
"""
LIB = b"<https://w3id.org/lib#Unit> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .\n"


def web(pages: dict[str, bytes]) -> Callable[[str], Fetched]:
    def fetch(url: str) -> Fetched:
        if url not in pages:
            raise DocumentError(f"{httpx.URL(url).host} is not on ONTOLOGY_FETCH_ALLOW")
        return Fetched(pages[url], "text/turtle", url, url.rsplit("/", 1)[-1] + ".ttl")
    return fetch


def test_imports_by_url_resolving_imports_from_the_library_and_the_web(fixture_specs_dir: Path) -> None:
    deps, store, ontologies = make(fixture_specs_dir, source=None)
    ontologies.library["https://w3id.org/lib"] = ("lib", 4)
    store.put("runs", ontology_normalized_key("lib", 4), LIB, "application/n-triples")
    deps.ontology_fetch = web({"https://w3id.org/pv": ROOT, "https://w3id.org/base": BASE})
    job = ontology_job(sourceKey=None, sourceUrl="https://w3id.org/pv", fileName="pv", mediaType="")
    run_once(FakeQueue(jobs=[job]), deps, "w1")

    assert ontologies.status[("pv", 1)] == "ready"
    sha = ontologies.sources[("pv", 1)]["sha256"]
    assert ("runs", ontology_source_key("pv", sha, "ttl")) in store.objects
    imports = {e["iri"]: e for e in ontologies.saved_imports[("pv", 1)]}
    assert imports["https://w3id.org/lib"] == {"iri": "https://w3id.org/lib", "resolution": "library", "ontologyId": "lib", "version": 4, "reason": None}
    assert imports["https://w3id.org/base"]["resolution"] == "fetched"
    assert imports["https://nope.org/x"]["resolution"] == "unresolved"
    assert "not on ONTOLOGY_FETCH_ALLOW" in imports["https://nope.org/x"]["reason"]
    # Base was created once, as a library ontology tagged with its importer; its import of pv
    # (a cycle back to the root) did not recurse.
    [(created_id, created)] = ontologies.created.items()
    assert created["title"] == "Base" and created["root_id"] == "pv"
    terms = {t.iri: t for t in ontologies.saved[("pv", 1)].terms}
    assert terms["https://w3id.org/base#Thing"].defined_in == f"{created_id}@1"
    assert terms["https://w3id.org/lib#Unit"].defined_in == "lib@4"
    assert not terms["https://w3id.org/pv#Batch"].root


def test_url_imports_off_fails_the_version(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=None)
    queue = FakeQueue(jobs=[ontology_job(sourceKey=None, sourceUrl="https://w3id.org/pv")])
    run_once(queue, deps, "w1")
    assert "URL imports are off" in queue.reviewed[0][1]
    assert ontologies.status[("pv", 1)] == "failed"


def test_the_same_bytes_as_another_version_fail_the_version(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=None)
    ontologies.duplicate_of = 2
    deps.ontology_fetch = web({"https://w3id.org/pv": ROOT})
    queue = FakeQueue(jobs=[ontology_job(sourceKey=None, sourceUrl="https://w3id.org/pv")])
    run_once(queue, deps, "w1")
    assert "same file as version 2" in queue.reviewed[0][1]


def test_an_unreachable_host_is_retried(fixture_specs_dir: Path) -> None:
    deps, _, ontologies = make(fixture_specs_dir, source=None)

    def down(url: str) -> Fetched:
        raise OntologySourceUnavailable(f"{url} answered 503")

    deps.ontology_fetch = down
    queue = FakeQueue(jobs=[ontology_job(sourceKey=None, sourceUrl="https://w3id.org/pv")])
    run_once(queue, deps, "w1")
    assert queue.failed and not queue.reviewed
    assert ontologies.status[("pv", 1)] == "parsing"


def test_params_need_exactly_one_source(fixture_specs_dir: Path) -> None:
    deps, _, _ = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[ontology_job(sourceUrl="https://w3id.org/pv")])  # both set
    run_once(queue, deps, "w1")
    assert "invalid ontology import parameters" in queue.reviewed[0][1]
```

(`Callable`, `httpx` and `OntologySourceUnavailable` are imported at the top of the test
module.)

Extend `MemoryOntologyStore` in `tests/fakes.py`:

```python
    library: dict[str, tuple[str, int]] = field(default_factory=dict)  # iri -> (id, version)
    imports_of: dict[tuple[str, int], list[dict[str, Any]]] = field(default_factory=dict)
    sources: dict[tuple[str, int], dict[str, Any]] = field(default_factory=dict)
    saved_imports: dict[tuple[str, int], list[dict[str, Any]]] = field(default_factory=dict)
    created: dict[str, dict[str, Any]] = field(default_factory=dict)
    duplicate_of: int | None = None

    def set_source(self, ontology_id: str, version: int, *, file_name: str, media_type: str, sha256: str, size: int) -> None:
        if self.duplicate_of is not None:
            raise DuplicateSource(self.duplicate_of)
        self.sources[(ontology_id, version)] = {"file_name": file_name, "media_type": media_type, "sha256": sha256, "size": size}

    def find_ready(self, iri: str) -> tuple[str, int] | None:
        return self.library.get(iri)

    def version_imports(self, ontology_id: str, version: int) -> list[dict[str, Any]]:
        return self.imports_of.get((ontology_id, version), [])

    def create_imported(self, *, iri: str, title: str | None, file_name: str, media_type: str, sha256: str, size: int, source_url: str, parsed: ParsedOntology, root_id: str) -> tuple[str, int]:
        oid = f"import-{len(self.created) + 1}"
        self.created[oid] = {"iri": iri, "title": title, "root_id": root_id, "parsed": parsed}
        self.library[iri] = (oid, 1)
        return oid, 1
```

`save` also records `self.saved_imports[(oid, v)] = parsed.import_entries`. Task 4 adds
`ParsedOntology.import_entries: list[dict[str, Any]]`, which defaults to the step 1 shape for
unresolved imports.

- [ ] **Step 2: Run** — Expected: FAIL (missing names/params).

- [ ] **Step 3: Implement** in `ontology.py`:
  - **`OntologyJobParams`:**
    - `source_key: str | None = Field(None, alias="sourceKey")` and
      `source_url: str | None = Field(None, alias="sourceUrl")`;
    - a `model_validator(mode="after")` requiring exactly one;
    - `media_type: str = Field("", alias="mediaType")`.
  - **`DuplicateSource(Exception)`** with a `version: int` attribute.
  - **`ParsedOntology.import_entries`:** a list of import dicts, set by the job. `save` writes
    `Jsonb(parsed.import_entries)`. When it is empty and `imports` is not, `save` writes the
    unresolved shape with `reason` "not resolved".
  - **`run_ontology_import`**, after validating params and `store.start`:
    1. **Get the bytes.**
       - With `source_url`: `deps.ontology_fetch` must be set, else raise
         `DocumentError("URL imports are off: set ONTOLOGY_FETCH_ALLOW")`. Fetch, then
         compute `sha256`.
       - `ext = ontologyFormat`-like: take it from the fetched file name if it has a known
         extension, else from the media type (`text/turtle`→`ttl`,
         `application/rdf+xml`→`rdf`, `application/ld+json`→`jsonld`,
         `application/n-triples`→`nt`, `text/n3`→`n3`), else `ttl`.
       - Write the source object at `ontology_source_key(oid, sha, ext)`.
       - Call `store.set_source(...)`. Turn `DuplicateSource(v)` into
         `DocumentError(f"same file as version {v} of {oid}")`.
       - With `source_key`: read the object as before.
    2. **Read the own graph:** `own = read_graph(data, media_type, file_name, max_triples=…)`.
       Collect its `owl:imports` IRIs; reuse `_header` to get them.
    3. **Resolve the imports:** `entries, graphs = _resolve_imports(direct_iris, …)`, a
       depth-first walk with `memo: dict[str, tuple[entry, list[(Graph, label)]]]`:
       - `on_stack` holds the IRIs on the current path, seeded with the root's ontology IRI.
       - An IRI on the stack is skipped: no entry, no graphs.
       - **Library:** `store.find_ready(iri)` gives `(id, v)`. Load the graph from
         `ontology_normalized_key(id, v)` as `nt`. Then follow `store.version_imports(id, v)`
         entries that are `library` or `fetched`, recursing with depth + 1 while depth is
         under `MAX_IMPORT_DEPTH`. The closure is that version's graph plus its children's.
       - **Fetch:** when `deps.ontology_fetch` is set, call it. A `DocumentError` (refused, or
         unreadable after `read_graph`) becomes an unresolved entry with
         `reason = str(exc)`. `OntologySourceUnavailable` also becomes unresolved, with
         reason `f"unavailable: {exc}"`; an import never fails the job. Then:
         1. read its graph and resolve its own imports (depth + 1);
         2. `parsed = index_graph(graph, imports=child_graphs, max_triples=…)`, setting
            `parsed.import_entries` to the children's entries;
         3. `store.create_imported(...)`, which saves it ready as version 1 of a new id;
         4. write its source object and normalized object under that id;
         5. record the entry as `fetched`.
       - **Neither, with fetching off:** unresolved, with reason
         `"not in the library, and URL imports are off"`.
       - **Past `MAX_IMPORT_DEPTH`:** unresolved, with reason
         `f"deeper than {MAX_IMPORT_DEPTH} imports"`.
    4. **Index and save:** `parsed = index_graph(own, imports=graphs, …)`,
       `parsed.import_entries = entries`, then write the normalized object, `store.save` and
       the event, as in step 1.
  - **Exceptions:** `OntologySourceUnavailable` falls into the existing transient branch,
    which fails the version only on the last attempt.

  `PgOntologyStore` additions, all on the injected connection:
  - **`set_source`:**
    `UPDATE ontology_versions SET file_name=%s, media_type=%s, sha256=%s, bytes=%s WHERE ontology_id=%s AND version=%s AND status <> 'ready'`.
    On `psycopg.errors.UniqueViolation`, `SELECT version … WHERE ontology_id=%s AND sha256=%s`
    and raise `DuplicateSource`.
  - **`find_ready`:**
    `SELECT ontology_id, version FROM ontology_versions WHERE status='ready' AND (ontology_iri=%s OR version_iri=%s) ORDER BY imported_at DESC, version DESC LIMIT 1`.
  - **`version_imports`:** `SELECT imports FROM ontology_versions WHERE …` (it is a list).
  - **`create_imported`**, in one transaction:
    - id = slugify of the IRI: lowercase, drop the scheme, non-`[a-z0-9]` to `-`, trimmed,
      `[:58]`. Make it unique by suffixing `-2`, `-3`, … while
      `SELECT 1 FROM ontologies WHERE id=%s` finds one.
    - `INSERT INTO ontologies (id, label, tags, created_by) VALUES (%s, %s, %s, %s)`, with
      label = `title or iri`, tags = `['imported-by:' + root_id]` and created_by =
      `f"import of {root_id}"`.
    - `INSERT INTO ontology_versions (ontology_id, version, file_name, media_type, sha256, bytes, source_kind, source_url, imported_by) VALUES (…, 1, …, 'import', iri, …)`.
    - Then call `self.save(id, 1, parsed)`. `save` opens a nested transaction, which psycopg
      supports as a savepoint.

  `pipeline.PipelineDeps` gains `ontology_fetch: Callable[[str], Fetched] | None = None`, with
  a `TYPE_CHECKING` import.

  `config.Settings` gains:
  - `ontology_fetch_allow: tuple[str, ...] = ()` from `ONTOLOGY_FETCH_ALLOW`, split on
    commas and stripped, empties dropped;
  - `ontology_max_bytes: int = 104857600`.

  `main()` builds the fetcher only when there are hosts:

```python
        ontology_fetch=(
            functools.partial(
                fetch_rdf,
                policy=FetchPolicy(settings.ontology_fetch_allow, settings.ontology_max_bytes),
                client=httpx.Client(),
            )
            if settings.ontology_fetch_allow
            else None
        ),
```

  `storage.py`:
  `def ontology_source_key(ontology_id: str, sha256: str, ext: str) -> str: return f"ontologies/{ontology_id}/sources/{sha256}.{ext}"`.

  Integration: extend the Pg test in `test_ontology_job.py` with
  `PgOntologyStore.create_imported` + `find_ready` + `set_source` duplicate. Insert a second
  version with the same sha and expect `DuplicateSource(1)`.

- [ ] **Step 4: Run** the job tests, the full worker suite, lint and the Pg integration test
  on a throwaway database with migrations applied. Apply them by running the API's
  `ontology-pg` test from Task 5 first, or apply 0032 and 0033 with `psql`. Expected: PASS.

- [ ] **Step 5: Commit** — `Worker: import ontologies by URL and resolve owl:imports`.

---

### Task 5: API — URL versions, settings, new fields

**Files:**
- Modify:
  - `apps/api/src/ontologies/repo.ts`, `routes/ontologies.ts`
  - `config.ts` (`ONTOLOGY_FETCH_ALLOW`: a string, default ''; `ONTOLOGY_MAX_BYTES`: a number,
    default 104857600)
  - `app.ts` (`ontologyFetch: { hosts: string[]; maxBytes: number }`), `server.ts`,
    `test/helpers.ts` (default `{ hosts: ['w3id.org'], maxBytes: 104857600 }`)
- Test: `apps/api/test/ontologies.test.ts`, `ontology-repo.test.ts`, `integration/ontology-pg.test.ts` (append)

**Interfaces — Produces:**
- `NewOntologyVersion` becomes
  `{ ontologyId, meta, fileName, mediaType, source: { kind: 'upload'; sourceKey: string; sha256: string; bytes: number } | { kind: 'url'; url: string }, by }`.
- URL job params: `{ ontologyId, version, sourceUrl, fileName, mediaType: '' }`.
- Routes:
  - `POST /api/ontologies/from-url` (admin, JSON `OntologyFromUrlBody`): 202 with a version,
    400 or 409 for a duplicate URL while one is importing.
  - `GET /api/ontology-settings`: `OntologySettings`, for any user.

- [ ] **Step 1: Write the failing tests**

`ontology-repo.test.ts`: update `input()` to the new `source` shape, then add:

```ts
it('creates a URL version without bytes and a job that fetches it', async () => {
  const repo = new MemoryOntologyRepo();
  const created = await repo.createVersion({
    ontologyId: 'pv', meta: { label: 'PV', description: '', tags: [], localOnly: false },
    fileName: 'pv', mediaType: '', source: { kind: 'url', url: 'https://w3id.org/pv' }, by: 'Ken',
  });
  expect(created).toMatchObject({ ok: true, version: { sourceKind: 'url', sourceUrl: 'https://w3id.org/pv', sha256: null, bytes: null } });
  expect(repo.jobs[0]!.params).toEqual({ ontologyId: 'pv', version: 1, sourceUrl: 'https://w3id.org/pv', fileName: 'pv', mediaType: '' });
});
```

`ontologies.test.ts`:

```ts
describe('importing by URL', () => {
  const post = (app: Awaited<ReturnType<typeof setup>>['app'], payload: object) =>
    app.inject({ method: 'POST', url: '/api/ontologies/from-url', payload });

  it('queues a fetch for an allowed https URL', async () => {
    const { app, ontologies, store } = await setup();
    const res = await post(app, { id: 'idmp-o', label: 'IDMP-O', url: 'https://w3id.org/idmp/core.ttl', tags: ['industry:pharma'] });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ sourceKind: 'url', sourceUrl: 'https://w3id.org/idmp/core.ttl', fileName: 'core.ttl', sha256: null });
    expect(ontologies.jobs[0]!.params).toMatchObject({ sourceUrl: 'https://w3id.org/idmp/core.ttl' });
    expect(store.objects.size).toBe(0);
  });

  it.each([
    [{ id: 'x1', label: 'X', url: 'http://w3id.org/a' }, 'only https URLs can be imported'],
    [{ id: 'x1', label: 'X', url: 'https://evil.org/a' }, 'evil.org is not on ONTOLOGY_FETCH_ALLOW'],
    [{ id: 'x1', url: 'https://w3id.org/a' }, 'name is required for a new ontology'],
  ])('refuses %j', async (payload, error) => {
    const { app } = await setup();
    const res = await post(app, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
  });

  it('is off without allowed hosts, and tells everyone the policy', async () => {
    const ontologies = new MemoryOntologyRepo();
    const { app } = await testApp({ ontologies, ontologyFetch: { hosts: [], maxBytes: 5 } });
    expect((await post(app, { id: 'x1', label: 'X', url: 'https://w3id.org/a' })).json().error).toBe('URL imports are off: set ONTOLOGY_FETCH_ALLOW');
    expect((await app.inject({ url: '/api/ontology-settings' })).json()).toEqual({ fetchHosts: [], maxBytes: 5 });
  });

  it('is admin-only, and a URL version has no source to download yet', async () => {
    const { app, userCookie, adminCookie } = await accessApp();
    const send = (cookie: string) => app.inject({ method: 'POST', url: '/api/ontologies/from-url', headers: { cookie }, payload: { id: 'x1', label: 'X', url: 'https://w3id.org/a' } });
    expect((await send(userCookie)).statusCode).toBe(403);
    expect((await send(adminCookie)).statusCode).toBe(202);
    const dl = await app.inject({ url: '/api/ontologies/x1/versions/1/source', headers: { cookie: adminCookie } });
    expect(dl.statusCode).toBe(404);
  });
});
```

`integration/ontology-pg.test.ts`:

```ts
it('reads rows from before step 2 with defaults, and URL versions without bytes', async () => {
  await pool.query(`DELETE FROM ontologies WHERE id = 'pv-legacy'`);
  await pool.query(`INSERT INTO ontologies (id, label) VALUES ('pv-legacy', 'Legacy')`);
  await pool.query(
    `INSERT INTO ontology_versions (ontology_id, version, status, file_name, media_type, sha256, bytes, stats, imports)
     VALUES ('pv-legacy', 1, 'ready', 'pv.ttl', 'text/turtle', 'abc', 10,
             '{"triples":1,"classes":1,"properties":0,"concepts":0,"schemes":0,"shapes":0}',
             '[{"iri":"https://x.org/base","resolution":"unresolved"}]')`,
  );
  const legacy = (await repo.get('pv-legacy'))!.versions[0]!;
  expect(legacy).toMatchObject({ sourceKind: 'upload', sourceUrl: null, stats: { imported: 0 },
    imports: [{ iri: 'https://x.org/base', resolution: 'unresolved', ontologyId: null, version: null, reason: null }] });
  const url = await repo.createVersion({ ontologyId: 'pv-legacy', meta: null, fileName: 'core.ttl', mediaType: '', source: { kind: 'url', url: 'https://w3id.org/core.ttl' }, by: 'Ken' });
  expect(url).toMatchObject({ ok: true, version: { version: 2, sha256: null, bytes: null, sourceKind: 'url' } });
  await pool.query(`DELETE FROM ontologies WHERE id = 'pv-legacy'`);
});
```

- [ ] **Step 2: Run** — Expected: FAIL (types, 404 routes).

- [ ] **Step 3: Implement.**
  - **Repo:**
    - Add `v.source_kind, v.source_url` to `VERSION_COLS` and `RAW_VERSION_COLS`, and
      `defined_in` to `TERM_COLS`.
    - `toVersion`: `bytes === null ? null : Number(bytes)`; `stats`, when not null, becomes
      `{ ...stats, imported: stats.imported ?? 0 }`; every import entry is normalised to
      `{ iri, resolution, ontologyId: e.ontologyId ?? null, version: e.version ?? null, reason: e.reason ?? null }`.
    - `toTerm` maps `definedIn`.
    - `createVersion` skips the duplicate check when there is no sha. The INSERT adds
      `source_kind` and `source_url`. `jobParams` becomes a source-dependent object.
    - Memory mirrors all of this.
  - **Routes:**
    - The multipart route builds `source: { kind: 'upload', … }`.
    - `from-url` runs `adminOnly`, then `OntologyFromUrlBodySchema.safeParse` (400 with the
      issues), then `ontologyUrlProblem(url, deps.ontologyFetch.hosts)` (400 with the
      problem), then the new-name check (400). It calls `createVersion` with
      `fileName: ontologyFileNameFromUrl(url)` and `mediaType: ''`, and replies 202.
    - `ontology-settings` (tag Ontologies) returns `{ fetchHosts: hosts, maxBytes }`.
    - The source download returns 404 when `sha256` is null.
    - Delete-version skips the source key when there is no sha. Change
      `DeleteVersionResult.sha256` to `string | null`.
  - **OpenAPI:** document both routes, with every status listed.
  - **Config:** read `ONTOLOGY_FETCH_ALLOW` as a comma-separated list, trimmed with empties
    dropped. Wire `ontologyFetch` in `server.ts`.
  - **Repo callers:** update the step 1 repo tests to the new `source` shape. This is a
    mechanical change; the assertions stay as they are.

- [ ] **Step 4: Run** the API project, the Pg integration test and `npm run openapi`. Expected: PASS.

- [ ] **Step 5: Commit** — `API: import ontologies by URL; version sources, imports and definedIn`.

---

### Task 6: API — neighbourhood

**Files:**
- Create: `apps/api/src/ontologies/neighbourhood.ts`
- Modify: `repo.ts` (`neighbours`), `routes/ontologies.ts`
- Test: `apps/api/test/neighbourhood.test.ts`, `ontologies.test.ts`, `integration/ontology-pg.test.ts`

**Interfaces — Produces:**
- `OntologyRepo.neighbours(id, version, iris: string[], limit: number): Promise<OntologyTerm[] | null>`
  returns the rows whose iri is in `iris`, or whose parents, domains or ranges overlap them,
  or whose scheme is in them. It returns at most `limit` rows, ordered by `lower(label), iri`.
- `buildNeighbourhood(focus: string, depth: number, load: (iris: string[]) => Promise<OntologyTerm[]>, cap = NEIGHBOURHOOD_LIMIT): Promise<Neighbourhood>`.
- `GET /api/ontologies/:id/versions/:version/neighbourhood?iri=&depth=`

**Edges** (pure; a term with kind K relating to IRI x):
- class → each parent: `subClassOf`
- property → each parent: `subPropertyOf`, each domain: `domain`, each range: `range`
- concept → each broader parent: `broader`. When a concept's parent is its scheme, the edge
  is `inScheme`.
- shape → each domain: `targets`

**Expansion:**
- Each hop loads the frontier.
- A relation (t → x) is kept when `t.iri` or `x` is in the frontier. Both endpoints become
  nodes; an IRI with no row is `external`, labelled with its local name.
- The next frontier is the newly added nodes.
- Stop at `cap` nodes, setting `truncated`.

- [ ] **Step 1: Write the failing tests** `apps/api/test/neighbourhood.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { OntologyTerm } from '@ih/shared';
import { buildNeighbourhood } from '../src/ontologies/neighbourhood.js';

const C = 'https://x.org/#';
const t = (iri: string, kind: OntologyTerm['kind'], extra: Partial<OntologyTerm> = {}): OntologyTerm => ({
  iri: C + iri, kind, label: iri, altLabels: [], definition: '', parents: [], domain: [], range: [],
  scheme: null, deprecated: false, childCount: 0, definedIn: null, ...extra,
});
const ALL = [
  t('Thing', 'class'),
  t('Batch', 'class', { parents: [C + 'Thing'] }),
  t('Protocol', 'class', { parents: [C + 'Thing'] }),
  t('hasBatch', 'object_property', { domain: [C + 'Protocol'], range: [C + 'Batch'] }),
  t('BatchShape', 'shape', { domain: [C + 'Batch'] }),
  t('Lot', 'class', { parents: [C + 'Batch', 'https://other.org/Item'] }),
];
const related = (rows: OntologyTerm[], iris: string[]) =>
  rows.filter((r) => iris.includes(r.iri) || [...r.parents, ...r.domain, ...r.range].some((x) => iris.includes(x)) || (r.scheme !== null && iris.includes(r.scheme)));
const load = async (iris: string[]) => related(ALL, iris);

describe('buildNeighbourhood', () => {
  it('collects a class, its parents, children, properties and shapes', async () => {
    const n = await buildNeighbourhood(C + 'Batch', 1, load);
    expect(n.nodes.find((x) => x.focus)).toMatchObject({ iri: C + 'Batch', label: 'Batch' });
    expect(n.nodes.map((x) => x.label).sort()).toEqual(['Batch', 'BatchShape', 'Lot', 'Thing', 'hasBatch']);
    expect(n.edges).toContainEqual({ source: C + 'Batch', target: C + 'Thing', kind: 'subClassOf' });
    expect(n.edges).toContainEqual({ source: C + 'Lot', target: C + 'Batch', kind: 'subClassOf' });
    expect(n.edges).toContainEqual({ source: C + 'hasBatch', target: C + 'Batch', kind: 'range' });
    expect(n.edges).toContainEqual({ source: C + 'BatchShape', target: C + 'Batch', kind: 'targets' });
    expect(n.truncated).toBe(false);
  });

  it('goes a second hop and shows IRIs outside the version as external', async () => {
    const n = await buildNeighbourhood(C + 'Batch', 2, load);
    expect(n.nodes.find((x) => x.iri === 'https://other.org/Item')).toMatchObject({ kind: 'external', label: 'Item' });
    expect(n.nodes.some((x) => x.iri === C + 'Protocol')).toBe(true);
  });

  it('stops at the cap', async () => {
    const hub = [t('Hub', 'class'), ...Array.from({ length: 300 }, (_, i) => t(`K${i}`, 'class', { parents: [C + 'Hub'] }))];
    const n = await buildNeighbourhood(C + 'Hub', 1, async (iris) => related(hub, iris), 150);
    expect(n.nodes).toHaveLength(150);
    expect(n.truncated).toBe(true);
    expect(n.edges.every((e) => n.nodes.some((x) => x.iri === e.source) && n.nodes.some((x) => x.iri === e.target))).toBe(true);
  });

  it('returns only the focus for an unknown term', async () => {
    const n = await buildNeighbourhood(C + 'Nope', 1, load);
    expect(n).toEqual({ nodes: [], edges: [], truncated: false });
  });
});
```

Route test, appended to `ontologies.test.ts` in the `browsing terms` block:

```ts
  it('returns a term neighbourhood', async () => {
    const { app } = await ready();
    const res = await app.inject({ url: `/api/ontologies/pv/versions/1/neighbourhood?iri=${encodeURIComponent(`${C}Protocol`)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().edges).toContainEqual({ source: `${C}Protocol`, target: `${C}Document`, kind: 'subClassOf' });
    expect((await app.inject({ url: '/api/ontologies/pv/versions/1/neighbourhood' })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/ontologies/pv/versions/9/neighbourhood?iri=x` })).statusCode).toBe(404);
  });
```

Pg: `neighbours` returns rows for an IRI set via `&&`, bounded by `limit`. Reuse the 1,000-concept hub: `neighbours(['…Stages'], 300)` returns at most 300 rows.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { NEIGHBOURHOOD_LIMIT, type GraphEdge, type GraphNode, type Neighbourhood, type OntologyTerm } from '@ih/shared';

const localName = (iri: string) => iri.replace(/[/#]+$/, '').split(/[#/:]/).pop() || iri;

function relations(t: OntologyTerm): { target: string; kind: GraphEdge['kind'] }[] {
  if (t.kind === 'class') return t.parents.map((target) => ({ target, kind: 'subClassOf' }));
  if (t.kind === 'concept') return t.parents.map((target) => ({ target, kind: target === t.scheme ? 'inScheme' : 'broader' }));
  if (t.kind === 'shape') return t.domain.map((target) => ({ target, kind: 'targets' }));
  if (t.kind === 'scheme') return [];
  return [
    ...t.parents.map((target) => ({ target, kind: 'subPropertyOf' as const })),
    ...t.domain.map((target) => ({ target, kind: 'domain' as const })),
    ...t.range.map((target) => ({ target, kind: 'range' as const })),
  ];
}

/** A term and what it is directly related to, up to `depth` hops, at most `cap` nodes. */
export async function buildNeighbourhood(
  focus: string,
  depth: number,
  load: (iris: string[]) => Promise<OntologyTerm[]>,
  cap = NEIGHBOURHOOD_LIMIT,
): Promise<Neighbourhood> {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const known = new Map<string, OntologyTerm>();
  let truncated = false;
  const add = (iri: string): boolean => {
    if (nodes.has(iri)) return true;
    if (nodes.size >= cap) {
      truncated = true;
      return false;
    }
    const term = known.get(iri);
    nodes.set(iri, { iri, label: term?.label ?? localName(iri), kind: term?.kind ?? 'external', focus: iri === focus });
    return true;
  };
  let frontier = new Set([focus]);
  for (let hop = 0; hop < depth && frontier.size > 0 && !truncated; hop++) {
    const rows = await load([...frontier]);
    for (const r of rows) if (!known.has(r.iri)) known.set(r.iri, r);
    if (hop === 0 && !known.has(focus)) return { nodes: [], edges: [], truncated: false };
    if (hop === 0) add(focus);
    const next = new Set<string>();
    for (const r of rows) {
      for (const rel of relations(r)) {
        if (!frontier.has(r.iri) && !frontier.has(rel.target)) continue;
        const fresh = [r.iri, rel.target].filter((i) => !nodes.has(i));
        if (!add(r.iri) || !add(rel.target)) continue;
        edges.set(`${r.iri}|${rel.kind}|${rel.target}`, { source: r.iri, target: rel.target, kind: rel.kind });
        for (const f of fresh) next.add(f);
      }
    }
    frontier = next;
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}
```

Repo `neighbours`:
- Memory: filter the terms (as in the test's `related`), sort by label, slice to `limit`.
- Pg:
  `SELECT ${TERM_COLS} FROM ontology_terms WHERE ontology_id=$1 AND version=$2 AND (iri = ANY($3) OR parents && $3 OR domains && $3 OR ranges && $3 OR scheme = ANY($3)) ORDER BY lower(label), iri LIMIT $4`.
  Return `null` for an unknown version.

The route uses `NeighbourhoodQuerySchema` (400 on failure), calls `repo.neighbours(…, 500)`
(404 for a null version), then `buildNeighbourhood(iri, depth, load)` with that loader. It
returns 200 with a `NeighbourhoodSchema` response. Document it.

- [ ] **Step 4: Run** the API project, Pg integration and `npm run openapi`. Expected: PASS.

- [ ] **Step 5: Commit** — `API: ontology term neighbourhood`.

---

### Task 7: Web — URL import and imports panel

**Files:**
- Modify: `apps/web/src/api/client.ts`, `test/fake-api.ts`, `ontologies/ImportOntologyDialog.tsx`, `ontologies/OntologyPage.tsx`, `ontologies/OntologiesPage.tsx`
- Test: `test/client.test.ts`, `test/OntologiesPage.test.tsx`, `test/OntologyPage.test.tsx` (append)

**Interfaces — Produces:**
- `Api` methods:
  - `importOntologyFromUrl(body: OntologyFromUrlBody): Promise<OntologyVersionView>`
  - `getOntologySettings(): Promise<OntologySettings>`
  - `getNeighbourhood(id, version, iri, depth?: 1 | 2): Promise<Neighbourhood>`
- Fakes:
  - `getOntologySettings` returns `{ fetchHosts: ['w3id.org'], maxBytes: 104857600 }`;
  - the others throw "not stubbed";
  - fixture versions gain `sourceKind: 'upload'` and `sourceUrl: null`, and terms gain
    `definedIn: null`.

- [ ] **Step 1: Write the failing tests**

Client test, in the `http api: ontologies` block:

```ts
  it('posts a URL import as JSON', async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await createHttpApi('/api').importOntologyFromUrl({ id: 'pv', label: 'PV', url: 'https://w3id.org/pv' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/ontologies/from-url');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ id: 'pv', label: 'PV', url: 'https://w3id.org/pv' });
  });
```

Dialog test, appended to `OntologiesPage.test.tsx`:

```tsx
  it('imports from a URL on an allowed host', async () => {
    const api = page([], 'admin', { importOntologyFromUrl: vi.fn(async () => ontologyVersion({ sourceKind: 'url' })) });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'From a URL' }));
    expect(await within(dialog).findByText('Allowed hosts: w3id.org')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('URL'), 'https://w3id.org/idmp/core.ttl');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'IDMP');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importOntologyFromUrl).toHaveBeenCalledWith({ id: 'idmp', label: 'IDMP', tags: [], localOnly: false, url: 'https://w3id.org/idmp/core.ttl' }),
    );
  });

  it('says why a URL cannot be imported before sending it', async () => {
    page([], 'admin', { getOntologySettings: vi.fn(async () => ({ fetchHosts: [], maxBytes: 1 })) });
    await userEvent.click(await screen.findByRole('button', { name: 'Import ontology' }));
    const dialog = screen.getByRole('dialog', { name: 'Import ontology' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'From a URL' }));
    expect(await within(dialog).findByText(/URL imports are off/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
  });
```

Imports panel test, appended to `OntologyPage.test.tsx`:

```tsx
  it('shows how each import was resolved', async () => {
    view('user', {
      getOntology: vi.fn(async () => ontologyDetail({ versions: [ontologyVersion({
        sourceKind: 'url', sourceUrl: 'https://w3id.org/pv',
        imports: [
          { iri: 'https://w3id.org/lib', resolution: 'library', ontologyId: 'lib', version: 4, reason: null },
          { iri: 'https://w3id.org/base', resolution: 'fetched', ontologyId: 'w3id-org-base', version: 1, reason: null },
          { iri: 'https://nope.org/x', resolution: 'unresolved', ontologyId: null, version: null, reason: 'nope.org is not on ONTOLOGY_FETCH_ALLOW' },
        ],
      })] })),
    });
    expect(await screen.findByText('Imports: 2 resolved, 1 not')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'lib v4' })).toHaveAttribute('href', '#/ontologies/lib');
    expect(screen.getByText(/fetched into the library/)).toBeInTheDocument();
    expect(screen.getByText('nope.org is not on ONTOLOGY_FETCH_ALLOW')).toBeInTheDocument();
    expect(screen.getByText('https://w3id.org/pv')).toBeInTheDocument(); // source URL
  });
```

The old `'1 imported ontology is not in the library'` test is replaced: the summary changes to
the resolved/not counts. This is a deliberate copy change and is noted in the ledger.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Client:**
    - `importOntologyFromUrl: (body) => post<OntologyVersionView>(\`${base}/ontologies/from-url\`, body)`;
    - `getOntologySettings` → `GET ${base}/ontology-settings`;
    - `getNeighbourhood` → `${base}/ontologies/${id}/versions/${v}/neighbourhood?iri=…&depth=…`.
  - **Dialog:**
    - a `Segmented` labelled "Source", with *From a file* and *From a URL*;
    - URL mode loads `getOntologySettings` once and shows `Allowed hosts: …`, or the problem
      when `ontologyUrlProblem` returns one;
    - it fills the id from the name as before;
    - `ready` requires `ontologyUrlProblem(url, hosts) === null`, and the problem shows under
      the field;
    - it submits `{ id, label, tags, localOnly, url }`, or `{ id, url }` when the ontology
      exists.
  - **Page:**
    - the meta list shows *Source*: the URL for `url` and `import` versions, *Uploaded file*
      otherwise;
    - the imports panel `<details>` summary reads `Imports: n resolved, m not`;
    - each item:
      - library: `<a href="#/ontologies/{id}">{id} v{version}</a>` + " in the library";
      - fetched: the same link + " fetched into the library";
      - unresolved: the IRI + reason.
    - Download is hidden when `sha256` is null.
  - **Detail panel:** a term with `definedIn` shows a tag `From {definedIn}`.

- [ ] **Step 4: Run** the web project and typecheck. Expected: PASS.

- [ ] **Step 5: Commit** — `Web: import ontologies by URL; show how imports resolved`.

---

### Task 8: Web — graph view

**Files:**
- Create:
  - `apps/web/src/ontologies/TermGraph.tsx`
  - `apps/web/src/ontologies/graphRenderer.ts`
  - `apps/web/src/types/cytoscape-fcose.d.ts` (`declare module 'cytoscape-fcose';`)
- Modify: `apps/web/package.json` (`cytoscape`, `cytoscape-fcose`), `TermBrowser.tsx`, `styles.css`
- Test: `apps/web/test/TermGraph.test.tsx`

**Interfaces — Produces:**
- `type GraphRenderer = (el: HTMLElement, data: Neighbourhood, onSelect: (iri: string) => void) => () => void`
- `cytoscapeRenderer: GraphRenderer`, which lazy-imports `cytoscape` and `cytoscape-fcose`.
- `TermGraph({ api, ontologyId, version, iri, onSelect, renderer = cytoscapeRenderer })`.
- `TermBrowser` gains `renderer?: GraphRenderer`. Its detail pane shows a `Segmented`
  labelled "View": *Details* and *Graph*.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Neighbourhood } from '@ih/shared';
import type { GraphRenderer } from '../src/ontologies/graphRenderer.js';
import { TermGraph } from '../src/ontologies/TermGraph.js';
import { fakeApi } from './fake-api.js';

const C = 'https://x.org/#';
const data: Neighbourhood = {
  nodes: [
    { iri: C + 'Batch', label: 'Batch', kind: 'class', focus: true },
    { iri: C + 'Thing', label: 'Thing', kind: 'class', focus: false },
    { iri: 'https://o.org/Item', label: 'Item', kind: 'external', focus: false },
  ],
  edges: [{ source: C + 'Batch', target: C + 'Thing', kind: 'subClassOf' }],
  truncated: true,
};

describe('TermGraph', () => {
  it('draws the neighbourhood and lists it for keyboard users', async () => {
    const cleanup = vi.fn();
    const renderer: GraphRenderer = vi.fn(() => cleanup);
    const api = fakeApi({ getNeighbourhood: vi.fn(async () => data) });
    const onSelect = vi.fn();
    const { unmount } = render(<TermGraph api={api} ontologyId="pv" version={1} iri={C + 'Batch'} onSelect={onSelect} renderer={renderer} />);
    await waitFor(() => expect(renderer).toHaveBeenCalledWith(expect.any(HTMLElement), data, onSelect));
    expect(api.getNeighbourhood).toHaveBeenCalledWith('pv', 1, C + 'Batch', 1);
    expect(screen.getByText(/Showing the first 3 terms/)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Links' });
    expect(within(list).getByText(/Batch.*is a subclass of.*Thing/)).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Thing' }));
    expect(onSelect).toHaveBeenCalledWith(C + 'Thing');
    unmount();
    expect(cleanup).toHaveBeenCalled();
  });

  it('goes two hops on request', async () => {
    const api = fakeApi({ getNeighbourhood: vi.fn(async () => data) });
    render(<TermGraph api={api} ontologyId="pv" version={1} iri={C + 'Batch'} onSelect={vi.fn()} renderer={() => () => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: '2 hops' }));
    await waitFor(() => expect(api.getNeighbourhood).toHaveBeenLastCalledWith('pv', 1, C + 'Batch', 2));
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **Dependencies:** `npm i -w @ih/web cytoscape cytoscape-fcose`, then commit the lockfile.
    `cytoscape` ships its own types. Add
    `apps/web/src/types/cytoscape-fcose.d.ts` (`declare module 'cytoscape-fcose';`) and
    confirm the web tsconfig `include` covers `src/types`.
  - **`graphRenderer.ts`:**

```ts
import type { Neighbourhood } from '@ih/shared';

export type GraphRenderer = (el: HTMLElement, data: Neighbourhood, onSelect: (iri: string) => void) => () => void;

const EDGE_LABEL: Record<string, string> = {
  subClassOf: 'subclass of', subPropertyOf: 'subproperty of', broader: 'broader', inScheme: 'in scheme',
  domain: 'domain', range: 'range', targets: 'targets',
};
let registered = false;

/** Cytoscape.js with the fcose layout, loaded only when a graph is first shown. */
export const cytoscapeRenderer: GraphRenderer = (el, data, onSelect) => {
  let gone = false;
  let destroy = () => {};
  void Promise.all([import('cytoscape'), import('cytoscape-fcose')]).then(([cyMod, fcoseMod]) => {
    if (gone) return;
    const cytoscape = cyMod.default;
    if (!registered) {
      cytoscape.use(fcoseMod.default);
      registered = true;
    }
    const css = getComputedStyle(el);
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const cy = cytoscape({
      container: el,
      elements: [
        ...data.nodes.map((n) => ({ data: { id: n.iri, label: n.label, kind: n.kind, focus: n.focus ? 1 : 0 } })),
        ...data.edges.map((e) => ({ data: { id: `${e.source}|${e.kind}|${e.target}`, source: e.source, target: e.target, label: EDGE_LABEL[e.kind] } })),
      ],
      style: [
        { selector: 'node', style: { label: 'data(label)', 'font-size': 11, color: token('--ih-text', '#222'), 'background-color': token('--ih-info-bg', '#dbeafe'), 'border-width': 1, 'border-color': token('--ih-border-strong', '#999'), 'text-valign': 'center', 'text-halign': 'center', width: 'label', height: 24, padding: '6px', shape: 'round-rectangle' } },
        { selector: 'node[kind = "external"]', style: { 'background-color': token('--ih-surface2', '#eee'), 'border-style': 'dashed' } },
        { selector: 'node[?focus]', style: { 'background-color': token('--ih-accent', '#2563eb'), color: token('--ih-accent-text', '#fff') } },
        { selector: 'edge', style: { label: 'data(label)', 'font-size': 9, color: token('--ih-muted', '#666'), width: 1, 'line-color': token('--ih-border-strong', '#999'), 'target-arrow-shape': 'triangle', 'target-arrow-color': token('--ih-border-strong', '#999'), 'curve-style': 'bezier' } },
      ],
      layout: { name: 'fcose', animate: false },
    });
    cy.on('tap', 'node', (ev) => onSelect(ev.target.id()));
    destroy = () => cy.destroy();
  });
  return () => {
    gone = true;
    destroy();
  };
};
```

  - **`TermGraph.tsx`:**
    - It loads the neighbourhood for `(iri, depth)`, with a `Segmented` labelled "Depth"
      offering *1 hop* and *2 hops*.
    - It renders `<div className="term-graph" ref={…} aria-hidden="true" />` and calls the
      renderer in an effect that depends on the data. The cleanup runs on change and on
      unmount.
    - When `truncated`, it shows *Showing the first {n} terms.*
    - Below the canvas, `<ul aria-label="Links">` lists one item per edge:
      `<button class="link">{source label}</button> {phrase} <button>{target label}</button>`.
      The phrases are: subClassOf "is a subclass of", subPropertyOf "is a subproperty of",
      broader "is narrower than", inScheme "is in", domain "has domain", range "has range",
      targets "targets".
    - External nodes are plain text, not buttons.
  - **`TermBrowser`:**
    - Above the detail pane, a `Segmented` labelled "View" with *Details* and *Graph*.
    - *Graph* renders `TermGraph` for the selected term, with the renderer prop passed
      through.
  - **`styles.css`:** `.term-graph { height: 420px; border-radius: var(--ih-radius-md); background: var(--ih-surface); }` and `.term-graph-links` (small text, list reset).

- [ ] **Step 4: Run** the web project, typecheck and `npm run build -w @ih/web`. The build
  confirms the lazy chunks bundle. Expected: PASS.

- [ ] **Step 5: Commit** — `Web: term neighbourhood graph (Cytoscape, lazy) with a link list`.

---

### Task 9: Docs, config and full check

- `CLAUDE.md`, in the ontology library contracts row:
  - the host rule and its fixture;
  - `sourceKind`/`sourceUrl`, `definedIn`, the import entries and `stats.imported`;
  - the neighbourhood;
  - the Python side: `ontology_fetch`, `ontology_source_key`, and `OntologyStore` additions.
- `docs/design/rdf-publishing.md`: step 2 implemented, with notes on:
  - `POST /api/ontologies/from-url` and `GET /api/ontology-settings`;
  - the residual DNS-rebinding risk;
  - imported versions are indexed with their own import closure;
  - depth 3.
- `deploy/.env.example`: `ONTOLOGY_FETCH_ALLOW=` (empty = off, example `w3id.org,.pistoiaalliance.org`) and `ONTOLOGY_MAX_BYTES=104857600`. Pass both to the `api` and `worker` services in `deploy/docker-compose.yml`.
- Run `npm run check`, `npm run worker:test`, `npm run worker:lint` and both Pg
  integration tests. Commit `Docs: ontology URL import, imports and graph view`, then push
  and open the PR (`Ontology library: URL import, owl:imports and graph view (ADR 0011, step 2)`).
