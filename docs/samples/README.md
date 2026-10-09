# Sample documents

Publicly available examples of the **Process Validation Protocol** document type, used to
develop and test `specs/process-validation-protocol/`.

| File | Kind | In git | Notes |
| --- | --- | --- | --- |
| `TEXT process_validation_protocol.pdf` | Text layer, 5 pages | yes | gmpsop template TEM-290 (excerpt: pages 1, 4, 8, 14, 18 of 24). Placeholders, no executed results. |
| `IMAGE process validation protocol.pdf` | Scanned images, 60 pages, 31 MB | **no** (git-ignored) | Safetab Life Science PVP/23/003-01 "protocol cum report": pages 1–30 approved blank protocol, pages 31–60 executed copy with results and handwritten entries. |

Tests use `TEXT …pdf` directly and the recorded olmOCR output of the scanned sample in
`worker/tests/fixtures/samples/pvp-image-ocr.json`. To re-record it (≈5–15 min on the LM Studio
endpoint), place the scan here and run from `worker/`:

```bash
uv run python scripts/ocr_pdf.py "../docs/samples/IMAGE process validation protocol.pdf" --out tests/fixtures/samples/pvp-image-ocr.json
```

Note: olmOCR omits page headers/footers, so the scan's header box (protocol no., revision,
effective date) is not in the fixture; the spec reads it from a page image instead.
