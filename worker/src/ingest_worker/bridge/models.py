"""The delivery bridge's contract, as the worker speaks it: hand-written Pydantic models mirroring
packages/bridge-contract's Zod schemas field for field (camelCase on the wire, unknown fields
refused). The shared fixtures in packages/bridge-contract/test/fixtures keep the two sides equal:
both parse every fixture and re-serialise it unchanged."""

from __future__ import annotations

import hashlib
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from ingest_worker.decompose.model import DecomposedDocument

Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
ErrorClass = Literal["needs_user", "retryable"]
DeliveryStatus = Literal[
    "queued", "running", "waiting", "succeeded", "skipped", "needs_user", "failed"
]


class Wire(BaseModel):
    """camelCase on the wire, snake_case here; unknown fields are refused."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, alias_generator=to_camel)


class ActingUser(Wire):
    id: str = Field(min_length=1)
    name: str
    email: str | None


class Provenance(Wire):
    source_sha256: Sha256
    source_filename: str
    job_id: str
    recipe_id: str
    recipe_version: int = Field(gt=0)
    approver: ActingUser | None
    extracted_at: str | None
    published_at: str


class DecompositionProvenance(Wire):
    """Where a decomposed document came from (contract version 2)."""

    kind: Literal["decomposition"]
    source_sha256: Sha256
    source_filename: str
    source_key: str = Field(min_length=1)
    batch_id: str | None
    decomposer_version: int = Field(gt=0)
    started_by: ActingUser
    decomposed_at: str
    published_at: str


class PackageFile(Wire):
    output: str = Field(min_length=1)
    format: str
    content_type: str
    #: The path relative to the target; a file sink adds the target's prefix.
    name: str = Field(min_length=1)
    #: The bytes, base64.
    content: str


class DataField(Wire):
    id: str
    title: str | None
    type: str
    value: Any
    unit: str | None


class DataColumn(Wire):
    id: str
    title: str | None
    type: str


class DataTable(Wire):
    id: str
    title: str | None
    columns: list[DataColumn]
    rows: list[dict[str, Any]]


class PackageData(Wire):
    fields: list[DataField]
    tables: list[DataTable]


class PackageRdf(Wire):
    graph_name: str
    version: int = Field(gt=0)
    turtle: str


class Paragraph(Wire):
    type: Literal["paragraph"]
    text: str


class ListBlock(Wire):
    type: Literal["list"]
    ordered: bool
    items: list[str]


class TableRef(Wire):
    type: Literal["table"]
    table_id: str


class Figure(Wire):
    type: Literal["figure"]
    image_id: str
    caption: str | None


NarrativeBlock = Annotated[Paragraph | ListBlock | TableRef | Figure, Field(discriminator="type")]


class PackageImage(Wire):
    id: str
    content_type: str
    content: str


class Producer(Wire):
    name: str
    deployment: str


class BridgePackage(Wire):
    """One document's publication (or one graph), the same for every target."""

    kind: Literal["document", "graph"]
    contract_version: Literal[1, 2]
    producer: Producer
    idempotency_key: Sha256
    provenance: Provenance | DecompositionProvenance | None
    naming: dict[str, str]
    files: list[PackageFile]
    data: PackageData | None
    rdf: PackageRdf | None
    narrative: list[NarrativeBlock] | None
    images: list[PackageImage] | None
    #: Version 2: the decomposed document; its images' bytes travel in `images`. Absent in v1.
    document: DecomposedDocument | None = Field(default=None, exclude_if=lambda v: v is None)

    @model_validator(mode="after")
    def _consistent(self) -> BridgePackage:
        if self.kind == "document" and self.provenance is None:
            raise ValueError("provenance: a document needs provenance")
        names = [f.name for f in self.files]
        if len(names) != len(set(names)):
            raise ValueError("files: duplicate file name")
        decomposition = isinstance(self.provenance, DecompositionProvenance)
        if self.document is None:
            if decomposition:
                raise ValueError("provenance: decomposition provenance needs a document")
            return self
        if self.contract_version != 2:
            raise ValueError("document: a document needs contractVersion 2")
        if self.files:
            raise ValueError("files: a package with a document carries no files")
        if self.data is not None:
            raise ValueError("data: a package with a document carries no data")
        if self.rdf is not None:
            raise ValueError("rdf: a package with a document carries no rdf")
        if self.narrative is not None:
            raise ValueError("narrative: a package with a document carries no narrative")
        if not decomposition:
            raise ValueError("provenance: a document needs decomposition provenance")
        carried = {i.id for i in self.images or []}
        referenced = {i.id for i in self.document.images}
        if referenced - carried:
            raise ValueError("document.images: an image of the document is not in images")
        if carried - referenced:
            raise ValueError("images: an image not in the document")
        return self


class ComponentVersion(Wire):
    """One component of a document in the target, at the version the target holds."""

    kind: str
    id: str
    version: str
    element: str | None


class Update(Wire):
    """Version 2: replace the document `persistent_id` only if the target still holds every
    component at its `expected` version."""

    persistent_id: str = Field(min_length=1)
    expected: list[ComponentVersion] = Field(min_length=1)


class CreateDeliveriesRequest(Wire):
    """`POST /v1/deliveries`: one package to one or more targets, as one user."""

    targets: list[Annotated[str, Field(min_length=1)]] = Field(min_length=1)
    acting_user: ActingUser | None
    #: Per target id, per destination field id: the reviewer's overrides (literal values).
    overrides: dict[str, dict[str, str]] = Field(default_factory=dict)
    #: Per target id, per pattern field id: the recipe's name patterns (the bridge resolves
    #: them against the package's naming).
    patterns: dict[str, dict[str, str]] = Field(default_factory=dict)
    package: BridgePackage
    #: Version 2: a conditional update of a document already in the target (one target only).
    update: Update | None = Field(default=None, exclude_if=lambda v: v is None)

    @model_validator(mode="after")
    def _update_has_one_target(self) -> CreateDeliveriesRequest:
        if self.update is not None and len(self.targets) != 1:
            raise ValueError("update: an update goes to exactly one target")
        return self


class DeliveryRef(Wire):
    target_id: str
    delivery_id: str


class CreateDeliveriesResult(Wire):
    package_id: str
    deliveries: list[DeliveryRef]


class BridgeError(Wire):
    """The one error shape of the producer and sink APIs."""

    class_: ErrorClass = Field(alias="class")
    code: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    message: str = Field(min_length=1)
    details: dict[str, Any] | None = Field(default=None, exclude_if=lambda v: v is None)


class ReceiptEntry(Wire):
    kind: str
    id: str
    label: str | None
    url: str | None


class ReadBack(Wire):
    ok: bool
    at: str | None
    detail: str | None


class DocumentReceipt(Wire):
    """Version 2, a delivered document: its persistent id, its components and the read-back."""

    persistent_id: str = Field(min_length=1)
    components: list[ComponentVersion]
    read_back: ReadBack


class Receipt(Wire):
    written: list[ReceiptEntry]
    document: DocumentReceipt | None = Field(default=None, exclude_if=lambda v: v is None)


class DeliveryView(Wire):
    id: str
    package_id: str
    target_id: str
    status: DeliveryStatus
    attempts: int
    error: BridgeError | None
    receipt: Receipt | None
    skipped_for: str | None
    created_at: str
    updated_at: str


class BridgeEvent(Wire):
    """What the bridge posts to CT Studio on every status change of a delivery."""

    event_id: str
    delivery_id: str
    sequence: int = Field(gt=0)
    status: DeliveryStatus
    error: BridgeError | None
    receipt: Receipt | None
    at: str


class TargetTestResult(Wire):
    ok: bool
    step: Literal["connect", "write", "read", "delete"] | None
    message: str


def idempotency_key(source_sha256: str, recipe_id: str, recipe_version: int) -> str:
    """What a delivery is about: one source document under one recipe version (as TypeScript's
    idempotencyKey), so a sink can replace what it wrote before."""
    return hashlib.sha256(f"{source_sha256}\n{recipe_id}\n{recipe_version}".encode()).hexdigest()


def graph_idempotency_key(graph_name: str, version: int) -> str:
    """What a graph package is about: one graph name at one version (as TypeScript's
    graphIdempotencyKey)."""
    return hashlib.sha256(f"graph\n{graph_name}\n{version}".encode()).hexdigest()


def decomposition_idempotency_key(
    source_sha256: str,
    persistent_id: str | None,
    decomposer_version: int,
    force_batch_id: str | None,
) -> str:
    """What a decomposition delivery is about (as TypeScript's decompositionIdempotencyKey): one
    source, the document it replaces (None: a new one), the decomposer version, and the run's
    token (None: none), which `decompose.deliver._run_token` picks (spec §9). The parameter
    keeps its first name, `force_batch_id`."""
    parts = ["decomposition", source_sha256, persistent_id or "", str(decomposer_version)]
    parts.append(force_batch_id or "")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def package_archive_keys(prefix: str, package: BridgePackage) -> list[tuple[str, str]]:
    """Every key a package-layout (archive) target writes for `package`, in write order with
    `package.json` last, each with the output id it is recorded under (as TypeScript's
    packageArchiveKeys): a file's own output id, else `package:data`, `package:graph`,
    `package:document`, `package:image:<id>` and `package:manifest`."""
    root = f"{prefix}packages/{package.idempotency_key}/"
    keys = [(f.output, f"{root}files/{f.name}") for f in package.files]
    if package.data is not None:
        keys.append(("package:data", f"{root}data.json"))
    if package.rdf is not None:
        keys.append(("package:graph", f"{root}graph.ttl"))
    if package.document is not None:
        keys.append(("package:document", f"{root}document.json"))
    keys += [(f"package:image:{i.id}", f"{root}images/{i.id}") for i in package.images or []]
    keys.append(("package:manifest", f"{root}package.json"))
    return keys


# --- Watched folders (contract version 4) ---

SourceFolder = Literal["", "processing", "delivered", "failed"]
SourceName = Annotated[str, Field(min_length=1, max_length=255)]


class SourceFile(Wire):
    """A listed file. Any non-empty name, so one odd file never invalidates the answer; the
    requests keep `SourceName`, so a producer skips (and reports) a name it could not send back."""

    name: str = Field(min_length=1)
    size: int = Field(ge=0)
    modified_at: str
    etag: str | None


class SourceListAnswer(Wire):
    files: list[SourceFile]


class SourcePlace(Wire):
    folder: SourceFolder
    name: SourceName


class _ProducerWhere(Wire):
    source: dict[str, str]
    acting_user: ActingUser | None


class ProducerSourceList(_ProducerWhere):
    """What the worker sends the bridge (it fills in the instance and credential)."""

    folder: SourceFolder


class ProducerSourceRead(_ProducerWhere):
    folder: SourceFolder
    name: SourceName


class ProducerSourceMove(_ProducerWhere):
    from_: SourcePlace = Field(alias="from")
    to: SourcePlace


class ProducerSourcePut(_ProducerWhere):
    folder: SourceFolder
    name: SourceName
    content: str = Field(max_length=65_536)


class _SinkWhere(_ProducerWhere):
    instance_id: str
    credential: dict[str, str]


class SourceListRequest(_SinkWhere):
    """What the bridge sends a sink; the worker never sends these, the fixtures pin them."""

    folder: SourceFolder


class SourceMoveRequest(_SinkWhere):
    from_: SourcePlace = Field(alias="from")
    to: SourcePlace


class SourcePutRequest(_SinkWhere):
    folder: SourceFolder
    name: SourceName
    content: str = Field(max_length=65_536)
