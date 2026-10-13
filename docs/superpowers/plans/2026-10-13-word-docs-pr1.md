# Word documents PR 1: the converter service and worker support

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The worker can process a `.docx` inbox object by converting it to PDF through a local
Gotenberg service, with the converted PDF cached by the source's sha256. The change ships
dormant, since the API still accepts only PDFs until PR 2.

**Architecture:**
- **`convert.py`** holds the `DocumentConverter` port, `is_docx`, and `GotenbergConverter`
  (httpx).
- **`load_source`** in `pipeline.py` replaces the two direct inbox reads (`prepare_document`,
  `prepare_sample`). It returns the source's bytes and sha256, plus the PDF the pipeline runs
  on.
- **The OCR cache** is keyed by the source sha256 instead of the PDF's.
- **The `converter` compose service** sits on an internal network that only the worker shares.

**Tech Stack:** Python 3.13, httpx (already installed through openai; now declared), Gotenberg
`8.37.0-libreoffice`, docker compose.

**Spec:** [docs/design/word-documents.md](../../design/word-documents.md)

## Global Constraints

- **Gotenberg image:** `gotenberg/gotenberg:8.37.0-libreoffice`, the exact tag (LibreOffice
  only, no Chromium).
- **Flags:** `--api-timeout=60s --api-disable-download-from --webhook-disable
  --libreoffice-deny-private-ips --libreoffice-deny-public-ips --prometheus-disable-collect`.
- **Network:** compose network `converter` with `internal: true`. The converter is only on it;
  the worker is on `default` and `converter`. No published ports in the production compose.
- **Endpoint:** `CONVERTER_URL`, set on the worker only. Empty means no converter: a `.docx`
  document then goes to `needs_review` with `Word documents need the converter: set
  CONVERTER_URL`.
- **Cache key:** `converted/{source_sha256}/{fingerprint}.pdf` in the runs bucket. The
  fingerprint is `gotenberg-{version}-c{CONVERT_VERSION}`, with `CONVERT_VERSION = 1`.
- **Errors:**
  - A 4xx, a 500 whose body starts `LibreOffice failed to convert`, or a 200 that is not a PDF
    → `DocumentError` (`needs_review`): `could not convert the Word document: …`.
  - A transport error, timeout or any other 5xx → `ConverterUnavailable` → `fail()` (retried).
- **No regression for PDFs:** anything that is not a `.docx` is passed through as today (tests
  use stub PDFs like `b"%PDF"`).

## Review Focus

1. A garbage file named `.docx` must never reach Gotenberg. LibreOffice "converts" plain bytes
   to a text PDF (verified against 8.37.0), so `is_docx` must check the content types, not the
   name.
2. A `.docm` (macro-enabled) or `.dotx` in the inbox is not a `.docx`: it is passed through as a
   "PDF" and fails in pypdf. PR 2's API never stores one; the worker never converts it.
3. A converter outage must not send documents to `needs_review`: they are retried.
4. A cached PDF that is corrupt (not `%PDF-`) is re-converted and overwritten, not trusted.
5. Prepared text and the OCR cache must be keyed by the source sha256. Otherwise the API, which
   reads `prepared/{sample.sha256}/`, never finds a Word sample's text.

---

### Task 1: `convert.py`: `is_docx`, the port and `GotenbergConverter`

**Files:**
- Create: `worker/src/ingest_worker/convert.py`
- Create: `worker/tests/test_convert.py`
- Modify: `worker/pyproject.toml` (add `httpx>=0.28`), `worker/uv.lock`

**Interfaces (produced):**
```python
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
CONVERT_VERSION = 1
def is_docx(data: bytes) -> bool
class ConversionRejected(Exception)      # the converter refused this document (needs_review)
class ConverterUnavailable(Exception)    # outage / timeout / busy (retried)
class DocumentConverter(Protocol):
    def to_pdf(self, docx: bytes) -> bytes: ...
    def fingerprint(self) -> str: ...
class GotenbergConverter:  # __init__(self, base_url: str, client: httpx.Client | None = None, timeout_s: float = 70.0)
```

- [ ] **Step 1:** Write table-driven tests:
  - `is_docx` is true for a minimal `.docx` built in the test with `zipfile` (content types
    declaring `…wordprocessingml.document.main+xml`).
  - It is false for: a `.docm` (`application/vnd.ms-word.document.macroEnabled.main+xml`), a
    `.dotx` (`…wordprocessingml.template.main+xml`), a ZIP without content types, a truncated
    `PK\x03\x04…`, `%PDF-1.7`, `b""`, random bytes, and a ZIP whose `[Content_Types].xml` is
    larger than 1 MiB.
  - `GotenbergConverter` is tested over `httpx.MockTransport`:
    - It POSTs `/forms/libreoffice/convert` with one multipart part named `files`, file name
      `document.docx`, content type `DOCX_MIME`.
    - A 200 `%PDF-` body is returned as is.
    - These raise `ConversionRejected`: a 200 non-PDF, a 400, and a 500 starting
      `LibreOffice failed to convert`.
    - These raise `ConverterUnavailable`: a 503, a 500 with any other body,
      `httpx.ConnectError` and `httpx.ReadTimeout`.
    - `fingerprint()` GETs `/version` once (cached) and returns `gotenberg-8.37.0-c1`. A
      failing `/version` raises `ConverterUnavailable`.
- [ ] **Step 2:** Run `cd worker && uv run pytest tests/test_convert.py` and expect an
  ImportError.
- [ ] **Step 3:** Implement:
  - `is_docx` reads the ZIP's `[Content_Types].xml`, at most 1 MiB, and looks for the Override
    of `/word/document.xml` with the main content type. Any `zipfile.BadZipFile`, `KeyError`,
    `OSError`, `ValueError` or oversize means false.
  - `GotenbergConverter` holds its own `httpx.Client(timeout=timeout_s)` unless one is given,
    `base_url.rstrip('/')`, and the fingerprint cached on the instance.
- [ ] **Step 4:** Run the tests and expect them to pass. Then run `uv run ruff check`, `ruff
  format --check` and `mypy --strict`.
- [ ] **Step 5:** Commit `feat(worker): DocumentConverter port and Gotenberg adapter`.

### Task 2: `load_source` and source-sha256 keys

**Files:**
- Modify:
  - `worker/src/ingest_worker/pipeline.py`: `PipelineDeps.converter`, `Source`,
    `load_source`, `prepare_document`, `ocr_pages(…, sha256=…)`, `_ocr_cache_keyer`.
  - `worker/src/ingest_worker/workbench.py` (`prepare_sample`).
  - `worker/src/ingest_worker/storage.py` (`converted_key`).
- Test: `worker/tests/test_convert.py` (`load_source`), `worker/tests/test_workbench.py`,
  `worker/tests/test_pipeline.py`.

**Interfaces:**
- Consumes: Task 1.
- Produces:
```python
# storage.py
def converted_key(source_sha256: str, fingerprint: str) -> str  # "converted/{sha}/{fp}.pdf"
# pipeline.py
@dataclass(frozen=True)
class Source:
    data: bytes      # the inbox object as uploaded
    sha256: str      # of data
    kind: Literal["pdf", "docx"]
    pdf: bytes       # what the pipeline runs on (data itself for a PDF)
def load_source(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Source
PipelineDeps.converter: DocumentConverter | None = None
def ocr_pages(job, deps, queue, pdf, pages, mode, *, sha256: str) -> list[str]
```

- [ ] **Step 1:** Write the tests, using `FakeConverter` (counts calls, returns
  `b"%PDF-converted"`, fingerprint `fake-1`) in `tests/fakes.py`:
  - **Passthrough:** a PDF is returned without calling the converter.
  - **Conversion:** a `.docx` miss converts, stores the result at `converted_key(sha,
    'fake-1')` and emits a `converted` event with `cached: False`. A second load is a hit: no
    call, `cached: True`.
  - **Corrupt cache:** a corrupt cached entry (`b"junk"`) is re-converted and overwritten.
  - **Fingerprint:** a different fingerprint converts again.
  - **No converter:** `converter=None` with a `.docx` raises `DocumentError` (`set
    CONVERTER_URL`).
  - **Error routing:** `ConversionRejected` becomes `DocumentError(could not convert the Word
    document: …)`, and `ConverterUnavailable` propagates unchanged. Through `run_once`, the
    first goes to `needs_review` and the second to `failed`.
  - **Workbench:** a prepare job on a `.docx` writes `prepared/{sha256(docx)}/text.json` and
    `triage.json`.
  - **OCR cache:** a process job on a `.docx` with OCR writes `ocr-cache/{sha256(docx)}/…`.
- [ ] **Step 2:** Run the tests and expect them to fail.
- [ ] **Step 3:** Implement `load_source` and switch `prepare_document` and `prepare_sample` to
  it. Pass `sha256=source.sha256` to `ocr_pages`; `_ocr_cache_keyer(sha256, model_ref,
  settings)` no longer hashes the PDF.
- [ ] **Step 4:** Run the whole worker suite and expect it to pass (existing tests keep their
  stub PDFs). Run lint and mypy.
- [ ] **Step 5:** Commit `feat(worker): convert .docx sources to PDF (cached by source sha256)`.

### Task 3: wiring, compose, docs

**Files:**
- Modify: `worker/src/ingest_worker/config.py` (`converter_url`), `worker/src/ingest_worker/main.py`.
- Modify: `deploy/docker-compose.yml`, `deploy/docker-compose.dev.yml`, `deploy/.env.example`,
  `deploy/README.md`.
- Create: `docs/adr/0009-word-documents.md`.
- Create: `worker/tests/test_convert_integration.py`, marked `integration` and skipped unless
  `CONVERTER_URL` is set.
- Modify: `CLAUDE.md` (Word documents rule; contracts table row "Source kinds"), `docs/architecture.md`
  (converter service), the design status line.

- [ ] **Step 1:** Write the tests:
  - `Settings.from_env` reads `CONVERTER_URL`, with empty meaning `None`.
  - The integration test converts a minimal `.docx` with a page break through the real service,
    then `extract_pages` gives 2 pages with the expected text.
- [ ] **Step 2:** Implement:
  - `main.py` builds `GotenbergConverter(settings.converter_url)` when it is set and logs
    `converter=<url|disabled>`.
  - **Production compose:**
    - The `converter` service runs the pinned image with the flags above.
    - `networks: [converter]`, a healthcheck
      `curl -fsS http://127.0.0.1:3000/health`, `mem_limit: 2g` and `restart: unless-stopped`.
    - The worker gets `CONVERTER_URL: ${CONVERTER_URL:-http://converter:3000}`,
      `networks: [default, converter]` and `depends_on: converter (service_healthy)`.
    - `networks.converter.internal: true`.
  - **Dev overlay:** the converter is also on `default`, with `127.0.0.1:3010:3000`. An
    internal-only container cannot publish ports, and the `--libreoffice-deny-*` flags still
    block fetches.
- [ ] **Step 3:** Run `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml
  config` to check the files are valid. Bring up the converter with dev-infra, then run the
  integration test with `CONVERTER_URL=http://localhost:3010`.
- [ ] **Step 4:** Docs and checks:
  - Write ADR 0009 and the `CLAUDE.md` rule.
  - Run `npm run check`.
  - Commit, push, open the PR, and turn on auto-fix and auto-merge.
