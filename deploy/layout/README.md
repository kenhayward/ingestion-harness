# layout

PDF layout analysis for the worker (PDF reader design, section 4.1). A small HTTP service around
[Docling](https://github.com/docling-project/docling): the worker posts a PDF and a page range and
gets Docling's document back. The worker never imports Docling.

It parses untrusted PDFs, so in `deploy/docker-compose.yml` it sits on the internal `layout`
network that only the worker shares (no route out, no published ports), with a read-only root,
`/tmp` as a 512 MB tmpfs, 6 GB of memory, at most 256 processes, no capabilities and no new
privileges.

## Running it

It is part of the stack (PDF reader design, section 14.7), in no compose profile, since the
Conversion tab takes PDFs: `deploy/scripts/deploy.sh` (and `.ps1`) build and start it with the
rest. The worker does not depend on it, so a stack started without it (CI's smoke test) still
extracts and converts Word files. The worker reaches it at `LAYOUT_URL` (default
`http://layout:8000`); with `LAYOUT_URL` empty a PDF item fails at once ("this CT Studio has no
layout service (LAYOUT_URL)"). A layout service that can't be reached is retried, as the converter
is; on the job's last attempt the item fails.

### On the GPU

`layout-gpu`, in the `gpu` compose profile, is this image built with `--build-arg
TORCH_INDEX=cu130` (CUDA torch, same versions and weights; about 21 GB) and given the host's
NVIDIA GPU (PDF reader design, section 16). On CUDA the service turns TF32 off before the models
load, so its output matches the CPU's. To use it, in `.env`:

```
COMPOSE_PROFILES=gpu
LAYOUT_URL=http://layout-gpu:8000
LAYOUT_FALLBACK_URL=http://layout:8000
```

`layout` keeps running: the worker reads a document on it whenever `layout-gpu` is down or its
GPU fails (503 below).

## API

| Request | Response |
|---|---|
| `POST /layout`, multipart `file` (the PDF) and form fields `first`, `last` (1-based, inclusive) | `200 {"pages": <page count of the whole PDF>, "document": <Docling export_to_dict>}` |
| `GET /health` | `{"status": "ok", "fingerprint": "docling 2.142.1; layout 8f39ad3c; tables fc0f2d45; cpu"}` (`cuda` on a GPU) |

Errors (see below): `400` when the body doesn't start with `%PDF-` (or can't be read as a PDF); `413` above
256 MiB or 500 pages; `422` for a bad range (`first` below 1, `last` below `first`, or `last` above
the page count).

Docling runs with OCR off, table structure on, TableFormer in ACCURATE mode and cell matching on.
The `fingerprint` is recorded with each run so a change of version or weights is visible.

## Pins

The same PDF must give the same output (design section 9), so the build is pinned end to end and
the weights are baked into the image; the container runs with `HF_HUB_OFFLINE=1` and downloads
nothing.

- **Python packages:** the image installs every package at the version in `uv.lock`, exported
  from the lock at build time (`uv export --extra docling`). Only torch and torchvision (and the
  CUDA packages they pull on Linux) are left out of that install: CPU torch `2.14.1` and
  torchvision `0.29.1` come from the PyTorch CPU index, and the build fails if the lock's torch
  versions differ from them. After changing dependencies, run `uv lock` in this folder.
- **Weights:** exact revisions, downloaded by the `Dockerfile`.

| Part | Pin | Licence |
|---|---|---|
| `docling` | `2.142.1` (`pyproject.toml`) | MIT |
| `docling-core`, `docling-ibm-models`, `docling-parse` | locked: `2.104.0`, `4.0.4`, `7.23.1` | MIT |
| `docling-project/docling-layout-heron` (layout) | revision `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8` | Apache-2.0 |
| `docling-project/docling-models` (TableFormer) | revision `fc0f2d45e2218ea24bce5045f58a389aed16dc23` | CDLA-Permissive-2.0 |

The weights' licences are the `license:` fields of the model cards at those revisions; the
Docling packages' are in their package metadata. Of the `docling-models` repository only
`model_artifacts/tableformer/accurate` is installed, the only mode the service uses.

To move to a new Docling or weights version, change the pins in `pyproject.toml`, `uv.lock`,
`Dockerfile` and `layout_service/docling_analyser.py` together, and expect different output.

## Errors

`422 {"error": "layout analysis failed: <reason>"}` is a PDF Docling cannot convert. It is not a
5xx on purpose: the worker retries server errors, and this PDF would fail again. Each request
has a time limit of 30 seconds a page in its range, at most 600 seconds (Docling's
`document_timeout`); one that runs over is `422 {"error": "layout analysis failed: timed out"}`.
A conversion that ends with any status but full success is a 422 too: a partial document is
never returned. A GPU failure (out of memory, a CUDA error) is `503 {"error": "layout device
unavailable: <reason>"}`: the PDF is not at fault, and the worker reads it on its fallback
service. Any other failure is a 500.

## Tests

The tests inject a fake analyser and never import Docling:

```sh
uv run --directory deploy/layout pytest -q
```

`layout_service/docling_analyser.py` is imported only by the `main` factory, so installing the
`docling` extra is needed only for the image.
