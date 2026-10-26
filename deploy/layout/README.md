# layout

PDF layout analysis for the worker (PDF reader design, section 4.1). A small HTTP service around
[Docling](https://github.com/docling-project/docling): the worker posts a PDF and a page range and
gets Docling's document back. The worker never imports Docling.

It parses untrusted PDFs, so in `deploy/docker-compose.yml` it sits on the internal `layout`
network that only the worker shares (no route out, no published ports), with a read-only root,
`/tmp` as a tmpfs and 6 GB of memory.

## Running it

It is opt-in (compose profile `pdf`): a plain `docker compose build` or `up` neither builds nor
starts it. Start it with `docker compose --profile pdf up -d --build layout`, or add `pdf` to
`COMPOSE_PROFILES` in `deploy/.env`. The worker does not wait for it; a missing layout service
is a retryable error there.

## API

| Request | Response |
|---|---|
| `POST /layout`, multipart `file` (the PDF) and form fields `first`, `last` (1-based, inclusive) | `200 {"pages": <page count of the whole PDF>, "document": <Docling export_to_dict>}` |
| `GET /health` | `{"status": "ok", "fingerprint": "docling 2.142.1; layout 8f39ad3c; tables fc0f2d45"}` |

Errors: `400` when the body doesn't start with `%PDF-` (or can't be read as a PDF); `413` above
256 MiB or 500 pages; `422` for a bad range (`first` below 1, `last` below `first`, or `last` above
the page count).

Docling runs with OCR off, table structure on, TableFormer in ACCURATE mode and cell matching on.
The `fingerprint` is recorded with each run so a change of version or weights is visible.

## Pins

Everything is pinned so the same PDF gives the same output (design section 9), and the weights are
baked into the image at build time; the container runs with `HF_HUB_OFFLINE=1` and downloads
nothing.

| Part | Pin | Licence |
|---|---|---|
| `docling` (and `docling-core`, `docling-ibm-models`, `docling-parse`) | `2.142.1` | MIT |
| `docling-project/docling-layout-heron` (layout) | revision `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8` | Apache-2.0 |
| `docling-project/docling-models` (TableFormer) | revision `fc0f2d45e2218ea24bce5045f58a389aed16dc23` | CDLA-Permissive-2.0 |

The weights' licences are the `license:` fields of the model cards at those revisions; the
Docling packages' are in their package metadata. Of the `docling-models` repository only
`model_artifacts/tableformer/accurate` is installed, the only mode the service uses.

To move to a new version, change the pins in `pyproject.toml`, `Dockerfile` and
`layout_service/docling_analyser.py` together, and expect different output.

## Tests

The tests inject a fake analyser and never import Docling:

```sh
uv run --project deploy/layout pytest -q
```

`layout_service/docling_analyser.py` is imported only by the `main` factory, so installing the
`docling` extra is needed only for the image.
