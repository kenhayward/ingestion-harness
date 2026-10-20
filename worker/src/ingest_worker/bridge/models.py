"""The delivery bridge's contract, as the worker speaks it: hand-written Pydantic models mirroring
packages/bridge-contract's Zod schemas field for field (camelCase on the wire, unknown fields
refused). The shared fixtures in packages/bridge-contract/test/fixtures keep the two sides equal:
both parse every fixture and re-serialise it unchanged."""

from __future__ import annotations

import hashlib
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

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
    contract_version: Literal[1]
    producer: Producer
    idempotency_key: Sha256
    provenance: Provenance | None
    naming: dict[str, str]
    files: list[PackageFile]
    data: PackageData | None
    rdf: PackageRdf | None
    narrative: list[NarrativeBlock] | None
    images: list[PackageImage] | None

    @model_validator(mode="after")
    def _consistent(self) -> BridgePackage:
        if self.kind == "document" and self.provenance is None:
            raise ValueError("provenance: a document needs provenance")
        names = [f.name for f in self.files]
        if len(names) != len(set(names)):
            raise ValueError("files: duplicate file name")
        return self


class CreateDeliveriesRequest(Wire):
    """`POST /v1/deliveries`: one package to one or more targets, as one user."""

    targets: list[Annotated[str, Field(min_length=1)]] = Field(min_length=1)
    acting_user: ActingUser | None
    #: Per target id, per destination field id: the reviewer's overrides.
    overrides: dict[str, dict[str, str]] = Field(default_factory=dict)
    package: BridgePackage


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


class Receipt(Wire):
    written: list[ReceiptEntry]


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
