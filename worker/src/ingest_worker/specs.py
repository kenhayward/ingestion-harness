"""Document spec model. Mirrors packages/shared/src/spec.ts — keep the two in sync.

Both suites validate every spec under /specs (tests/test_specs.py here).
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

Id = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]*$")]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)


class Section(_Model):
    id: Id
    anchor: str = Field(min_length=1)
    required: bool = True
    description: str | None = None


class Extraction(_Model):
    id: Id
    sections: list[Id] = Field(min_length=1)
    prompt: str = Field(min_length=1)
    model: str = "default"
    schema_: dict[str, Any] = Field(alias="schema")
    max_attempts: int = Field(default=2, ge=1, le=5, alias="maxAttempts")
    #: 1-based PDF pages sent as images with the prompt (needs a vision-capable model).
    page_images: list[Annotated[int, Field(ge=1)]] = Field(default_factory=list, alias="pageImages")
    #: Output token budget per LLM call.
    max_tokens: int = Field(default=16000, ge=256, le=128000, alias="maxTokens")
    #: Run once per N pages of the (single) section and concatenate `merge_path` arrays.
    chunk_pages: int | None = Field(default=None, ge=1, alias="chunkPages")
    #: Top-level array property of the schema merged across chunks.
    merge_path: str | None = Field(default=None, min_length=1, alias="mergePath")


class CsvColumn(_Model):
    name: str = Field(min_length=1)
    path: str = Field(min_length=1)


class CsvOutput(_Model):
    id: Id
    format: Literal["csv"]
    from_: Id = Field(alias="from")
    rows_path: str = Field(default="", alias="rowsPath")
    columns: list[CsvColumn] = Field(min_length=1)


class JsonOutput(_Model):
    id: Id
    format: Literal["json"]
    from_: Id | Literal["*"] = Field(alias="from")


Output = Annotated[CsvOutput | JsonOutput, Field(discriminator="format")]


class PageRange(_Model):
    min: int = Field(gt=0)
    max: int = Field(gt=0)


OcrMode = Literal["auto", "always", "never"]


class CopySelection(_Model):
    """For PDFs holding several copies of the document (e.g. the approved blank protocol
    followed by the executed one): pages are split where `anchor` matches; one copy is kept."""

    anchor: str = Field(min_length=1)
    select: Literal["first", "last"] = "last"


class DocumentLayout(_Model):
    pages: PageRange | None = None
    #: auto: OCR pages with little/no text layer; always: every page; never: text layer only.
    ocr: OcrMode = "auto"
    copies: CopySelection | None = None
    sections: list[Section] = Field(min_length=1)


class DocumentSpec(_Model):
    id: Id
    version: int = Field(gt=0)
    title: str = Field(min_length=1)
    description: str | None = None
    document: DocumentLayout
    extractions: list[Extraction] = Field(min_length=1)
    outputs: list[Output] = Field(min_length=1)

    @model_validator(mode="after")
    def _cross_references(self) -> DocumentSpec:
        errors: list[str] = []
        for label, ids in (
            ("section", [s.id for s in self.document.sections]),
            ("extraction", [e.id for e in self.extractions]),
            ("output", [o.id for o in self.outputs]),
        ):
            errors += [
                f"duplicate {label} id {i!r}" for i in sorted({i for i in ids if ids.count(i) > 1})
            ]

        section_ids = {s.id for s in self.document.sections}
        extraction_ids = {e.id for e in self.extractions}
        for e in self.extractions:
            errors += [
                f"extraction {e.id!r}: unknown section {s!r}"
                for s in e.sections
                if s not in section_ids
            ]
        for e in self.extractions:
            if e.chunk_pages is None:
                continue
            if len(e.sections) != 1:
                errors.append(f"extraction {e.id!r}: chunkPages needs exactly one section")
            if not e.merge_path:
                errors.append(f"extraction {e.id!r}: chunkPages needs mergePath")
            elif e.schema_.get("properties", {}).get(e.merge_path, {}).get("type") != "array":
                errors.append(
                    f"extraction {e.id!r}: mergePath {e.merge_path!r} must be a top-level "
                    "array property of the schema"
                )
        for o in self.outputs:
            if o.from_ != "*" and o.from_ not in extraction_ids:
                errors.append(f"output {o.id!r}: unknown extraction {o.from_!r}")
        if self.document.pages and self.document.pages.min > self.document.pages.max:
            errors.append("document.pages: min > max")
        if errors:
            raise ValueError("; ".join(errors))
        return self


class LoadedSpec:
    """A validated spec plus the directory its prompt templates are relative to."""

    def __init__(self, spec: DocumentSpec, directory: Path) -> None:
        self.spec = spec
        self.directory = directory


class SpecRegistry:
    def __init__(self, specs: list[LoadedSpec]) -> None:
        self._by_key = {(s.spec.id, s.spec.version): s for s in specs}

    def get(self, spec_id: str, version: int) -> LoadedSpec:
        try:
            return self._by_key[(spec_id, version)]
        except KeyError:
            raise KeyError(f"spec {spec_id} v{version} not found") from None

    def __len__(self) -> int:
        return len(self._by_key)


def load_specs(root: Path) -> SpecRegistry:
    """Load specs/<id>/v<N>/spec.yaml, failing on any invalid spec or missing prompt."""
    errors: list[str] = []
    loaded: list[LoadedSpec] = []
    for file in sorted(root.glob("*/v*/spec.yaml")):
        directory = file.parent
        try:
            spec = DocumentSpec.model_validate(yaml.safe_load(file.read_text(encoding="utf-8")))
        except ValidationError as exc:
            errors.append(f"{file}: {exc}")
            continue
        if spec.id != directory.parent.name or f"v{spec.version}" != directory.name:
            errors.append(
                f"{file}: id/version ({spec.id} v{spec.version}) does not match directory"
            )
        errors += [
            f"{file}: extraction {e.id!r} prompt not found: {e.prompt}"
            for e in spec.extractions
            if not (directory / e.prompt).is_file()
        ]
        loaded.append(LoadedSpec(spec, directory))
    if errors:
        raise ValueError("invalid document specs:\n  " + "\n  ".join(errors))
    return SpecRegistry(loaded)
