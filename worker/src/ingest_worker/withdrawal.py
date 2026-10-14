"""Withdrawing what was delivered (ADR 0011 step 7): a job deletion or a retirement queues a
`withdraw` job naming the target objects and graphs to remove; unretiring queues `republish`,
which delivers the type's withdrawn jobs again."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, PositiveInt


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class TargetObject(_Strict):
    bucket: str = Field(min_length=1)
    key: str = Field(min_length=1)


class WithdrawnGraph(_Strict):
    sha256: str = Field(min_length=1)
    template_id: str = Field(alias="templateId", min_length=1)
    #: Set: drop the graph itself (else only the listed versions' copies go).
    graph_iri: str | None = Field(alias="graphIri", min_length=1)
    versions: list[PositiveInt]


class WithdrawParams(_Strict):
    """Mirrors `WithdrawParamsSchema` (packages/shared/src/jobs.ts)."""

    objects: list[TargetObject]
    graphs: list[WithdrawnGraph]


class RepublishParams(_Strict):
    template_id: str = Field(alias="templateId", min_length=1)
