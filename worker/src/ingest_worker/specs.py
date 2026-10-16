"""Document spec model. Mirrors packages/shared/src/spec.ts — keep the two in sync.

Both suites validate every spec under /specs (tests/test_specs.py here).
"""

from __future__ import annotations

import re
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
    #: Every match of `anchor` starts an occurrence (templates only; spec 2026-10-16).
    repeat: bool = False
    #: Regex naming an occurrence: the named group `key`, else group 1, else the whole match.
    key: str | None = Field(default=None, min_length=1)
    #: A repeating section whose latest preceding key an occurrence takes when `key` finds none;
    #: the occurrences are also checked against its keys (segment.key_issues).
    key_from: Id | None = Field(default=None, alias="keyFrom")

    @model_validator(mode="after")
    def _repeat_keys(self) -> Section:
        if self.key is not None and not self.repeat:
            raise ValueError(f"section {self.id!r}: key needs repeat")
        if self.key_from is not None and not self.repeat:
            raise ValueError(f"section {self.id!r}: keyFrom needs repeat")
        if self.key is not None:
            try:
                compiled = re.compile(self.key, re.MULTILINE)
            except re.error:
                return self  # like an anchor: reported where it is used (preview, drafting)
            if compiled.groups > 1 and "key" not in compiled.groupindex:
                raise ValueError(
                    f"section {self.id!r}: key must have at most one group, or a group named key"
                )
        return self


def key_from_errors(sections: list[Section]) -> list[str]:
    """`keyFrom` must name a repeating section with a key and no keyFrom of its own."""
    by_id = {s.id: s for s in sections}
    errors = []
    for s in sections:
        if s.key_from is None:
            continue
        target = by_id.get(s.key_from)
        if target is None or not target.repeat or target.key is None or target.key_from is not None:
            errors.append(
                f"section {s.id!r}: keyFrom {s.key_from!r} must be a repeating section with a key "
                "and no keyFrom"
            )
    return errors


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
    max_tokens: int = Field(default=64000, ge=256, le=128000, alias="maxTokens")
    #: Run once per N pages of the (single) section and concatenate `merge_path` arrays.
    chunk_pages: int | None = Field(default=None, ge=1, alias="chunkPages")
    #: Top-level array property of the schema merged across chunks.
    merge_path: str | None = Field(default=None, min_length=1, alias="mergePath")
    #: Extra variables for the prompt template (set when compiled from a document template).
    prompt_context: dict[str, Any] | None = Field(default=None, alias="promptContext")


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


class Check(_Model):
    """Deterministic consistency check between extractions (see ingest_worker.checks)."""

    id: Id
    description: str | None = None
    #: Values to classify, e.g. "test_results.results[*].batch_number".
    values: str = Field(min_length=1)
    #: Reference values, e.g. "batches.batches[*].batch_number".
    reference: str = Field(min_length=1)
    #: Per-reference alternative spellings, sharing the reference's list prefix.
    aliases: str | None = None
    #: Max edit distance for a "near" match (OCR misreads).
    max_distance: int = Field(default=2, ge=0, alias="maxDistance")


def _path_root(path: str) -> str:
    return path.split(".", 1)[0].split("[", 1)[0]


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

    @model_validator(mode="after")
    def _key_from(self) -> DocumentLayout:
        if errors := key_from_errors(self.sections):
            raise ValueError("; ".join(errors))
        return self


class DocumentSpec(_Model):
    id: Id
    version: int = Field(gt=0)
    title: str = Field(min_length=1)
    description: str | None = None
    document: DocumentLayout
    extractions: list[Extraction] = Field(min_length=1)
    outputs: list[Output] = Field(min_length=1)
    checks: list[Check] = Field(default_factory=list)

    @model_validator(mode="after")
    def _cross_references(self) -> DocumentSpec:
        errors: list[str] = []
        for label, ids in (
            ("section", [s.id for s in self.document.sections]),
            ("extraction", [e.id for e in self.extractions]),
            ("output", [o.id for o in self.outputs]),
            ("extraction/check", [e.id for e in self.extractions] + [c.id for c in self.checks]),
        ):
            errors += [
                f"duplicate {label} id {i!r}" for i in sorted({i for i in ids if ids.count(i) > 1})
            ]

        errors += [
            f"section {s.id!r}: repeat is supported in recipes only"
            for s in self.document.sections
            if s.repeat
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
        for c in self.checks:
            for label, path in (
                ("values", c.values),
                ("reference", c.reference),
                ("aliases", c.aliases),
            ):
                if path is not None and _path_root(path) not in extraction_ids:
                    errors.append(
                        f"check {c.id!r}: unknown extraction {_path_root(path)!r} in {label}"
                    )
            if c.aliases:
                cut = c.reference.rfind("[*]")
                prefix = c.reference[: cut + 3] if cut >= 0 else _path_root(c.reference)
                if not c.aliases.startswith(prefix + "."):
                    errors.append(f"check {c.id!r}: aliases must start with {prefix!r}")
        sources = extraction_ids | {c.id for c in self.checks}
        for o in self.outputs:
            if o.from_ != "*" and o.from_ not in sources:
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


class LoadedTemplate:
    """A validated document template (ingest_worker.template) and its directory."""

    def __init__(self, template: Any, directory: Path | None) -> None:
        from .template import Template

        assert isinstance(template, Template)
        self.template: Template = template
        #: None for templates stored in the database (built-in prompts only).
        self.directory = directory


Loaded = LoadedSpec | LoadedTemplate


class SpecRegistry:
    def __init__(self, specs: list[LoadedSpec] | list[Loaded]) -> None:
        self._by_key: dict[tuple[str, int], Loaded] = {}
        for s in specs:
            item = s.spec if isinstance(s, LoadedSpec) else s.template
            self._by_key[(item.id, item.version)] = s

    def get(self, spec_id: str, version: int) -> Any:
        """LoadedSpec (legacy spec.yaml) or LoadedTemplate (template.yaml)."""
        try:
            return self._by_key[(spec_id, version)]
        except KeyError:
            raise KeyError(f"spec {spec_id} v{version} not found") from None

    def __len__(self) -> int:
        return len(self._by_key)


def _check_prompt(directory: Path, prompt: str, owner: str, file: Path, errors: list[str]) -> None:
    if not prompt.startswith("builtin/") and not (directory / prompt).is_file():
        errors.append(f"{file}: {owner} prompt not found: {prompt}")


def load_specs(root: Path) -> SpecRegistry:
    """Load specs/<id>/v<N>/spec.yaml (legacy) and template.yaml (document templates), failing
    on any invalid file, id/version that disagrees with its directory, or missing prompt."""
    from .template import Template

    errors: list[str] = []
    loaded: list[Loaded] = []
    files = sorted(root.glob("*/v*/spec.yaml")) + sorted(root.glob("*/v*/template.yaml"))
    for file in files:
        directory = file.parent
        raw = yaml.safe_load(file.read_text(encoding="utf-8"))
        try:
            if file.name == "template.yaml":
                template = Template.model_validate(raw)
                ident: tuple[str, int] = (template.id, template.version)
                for step in template.extract_steps():
                    if step.prompt:
                        _check_prompt(directory, step.prompt, f"step {step.id!r}", file, errors)
                loaded.append(LoadedTemplate(template, directory))
            else:
                spec = DocumentSpec.model_validate(raw)
                ident = (spec.id, spec.version)
                for e in spec.extractions:
                    _check_prompt(directory, e.prompt, f"extraction {e.id!r}", file, errors)
                loaded.append(LoadedSpec(spec, directory))
        except ValidationError as exc:
            errors.append(f"{file}: {exc}")
            continue
        if ident[0] != directory.parent.name or f"v{ident[1]}" != directory.name:
            errors.append(f"{file}: id/version ({ident[0]} v{ident[1]}) does not match directory")
    if errors:
        raise ValueError("invalid document specs:\n  " + "\n  ".join(errors))
    return SpecRegistry(loaded)
