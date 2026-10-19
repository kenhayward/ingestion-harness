"""The worker's client of the delivery bridge: every request signed with BRIDGE_CLIENT_KEY over
the exact JSON bytes it sends. A refusal that needs a person (`needs_user`) is a DocumentError, so
the job goes to review with the bridge's message; anything else (the bridge down, a timeout, a
5xx) is a plain error, so the job queue retries it."""

from __future__ import annotations

import base64
import json
from typing import Any, Protocol

import httpx
from pydantic import ValidationError

from ..errors import DocumentError
from .models import BridgeError, CreateDeliveriesRequest, CreateDeliveriesResult
from .signing import sign_request


class BridgeUnavailable(Exception):
    """The bridge could not take the request now (connection refused, timeout, 5xx, a retryable
    error, or a signature it refused): retried with the job."""


class BridgeRefused(DocumentError):
    """The bridge refused the request for a reason a person must fix (a missing target or
    connection, content it cannot take): the job goes to review with the bridge's message."""

    def __init__(self, error: BridgeError) -> None:
        super().__init__(error.message)
        self.error = error


class BridgeClient(Protocol):
    def deliver(self, request: CreateDeliveriesRequest) -> CreateDeliveriesResult: ...

    def read_object(self, target_id: str, bucket: str, key: str) -> bytes | None: ...

    def put_object(
        self, target_id: str, bucket: str, key: str, body: bytes, content_type: str
    ) -> None: ...

    def delete_objects(self, target_id: str, objects: list[tuple[str, str]]) -> int: ...


def _error_of(response: httpx.Response) -> BridgeError | None:
    try:
        return BridgeError.model_validate(response.json())
    except (ValueError, ValidationError):
        return None


def _code_of(response: httpx.Response) -> str | None:
    error = _error_of(response)
    return error.code if error else None


class HttpBridgeClient:
    """BridgeClient over HTTP (`BRIDGE_URL`, e.g. http://bridge:3100)."""

    def __init__(
        self,
        base_url: str,
        key: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 60.0,
    ) -> None:
        self._key = key
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"), transport=transport, timeout=timeout
        )

    def _post(self, path: str, payload: Any) -> httpx.Response:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        url = self._http.build_request("POST", path).url
        headers = {
            **sign_request(self._key, "POST", url.raw_path.decode("ascii"), body),
            "content-type": "application/json",
        }
        try:
            response = self._http.post(path, content=body, headers=headers)
        except httpx.HTTPError as exc:
            raise BridgeUnavailable(f"the bridge could not be reached: {exc}") from exc
        return response

    def _raise_for(self, response: httpx.Response, what: str) -> None:
        if response.is_success:
            return
        error = _error_of(response)
        # 401 is this deployment's key, not the document: retried until someone fixes it. A
        # target the bridge lacks is one CT Studio's registry has (the worker resolved it there
        # first) and the API has not mirrored yet, after an upgrade or a restore: retried too.
        if (
            400 <= response.status_code < 500
            and response.status_code != 401
            and error is not None
            and error.class_ == "needs_user"
            and error.code != "target_missing"
        ):
            raise BridgeRefused(error)
        detail = error.message if error else response.text[:200]
        raise BridgeUnavailable(f"the bridge answered {response.status_code} to {what}: {detail}")

    def deliver(self, request: CreateDeliveriesRequest) -> CreateDeliveriesResult:
        response = self._post("/v1/deliveries", request.model_dump(by_alias=True, mode="json"))
        self._raise_for(response, "a delivery")
        return CreateDeliveriesResult.model_validate(response.json())

    def read_object(self, target_id: str, bucket: str, key: str) -> bytes | None:
        response = self._post(
            f"/v1/targets/{target_id}/objects:read", {"bucket": bucket, "key": key}
        )
        if response.status_code == 404 and _code_of(response) != "target_missing":
            return None
        self._raise_for(response, "an object read")
        return base64.b64decode(response.json()["content"])

    def put_object(
        self, target_id: str, bucket: str, key: str, body: bytes, content_type: str
    ) -> None:
        response = self._post(
            f"/v1/targets/{target_id}/objects:put",
            {
                "bucket": bucket,
                "key": key,
                "contentType": content_type,
                "content": base64.b64encode(body).decode("ascii"),
            },
        )
        self._raise_for(response, "an object write")

    def delete_objects(self, target_id: str, objects: list[tuple[str, str]]) -> int:
        if not objects:
            return 0
        response = self._post(
            f"/v1/targets/{target_id}/objects:delete",
            {"objects": [{"bucket": b, "key": k} for b, k in objects]},
        )
        self._raise_for(response, "an object delete")
        return int(response.json()["deleted"])
