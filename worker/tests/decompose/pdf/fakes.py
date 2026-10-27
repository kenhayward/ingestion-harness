"""Fakes for tests: a layout analyser answering each page range from a function, and a cropper."""

from __future__ import annotations

import io
from collections.abc import Callable
from typing import Any

from PIL import Image


class FakeLayout:
    def __init__(
        self, responses: Callable[[int, int], dict[str, Any]], fingerprint: str = "fake"
    ) -> None:
        self._responses = responses
        self._fingerprint = fingerprint
        self.calls: list[tuple[int, int]] = []

    def analyse(self, pdf: bytes, first: int, last: int) -> dict[str, Any]:
        self.calls.append((first, last))
        return self._responses(first, last)

    def fingerprint(self) -> str:
        return self._fingerprint


class FakeCropper:
    """A cropper for tests: every region is a blank 10x10 PNG; the calls are recorded."""

    def __init__(self) -> None:
        self.calls: list[tuple[int, tuple[float, float, float, float]]] = []

    def crop(self, page: int, bbox: tuple[float, float, float, float]) -> bytes:
        self.calls.append((page, bbox))
        out = io.BytesIO()
        Image.new("RGB", (10, 10), "white").save(out, format="PNG")
        return out.getvalue()
