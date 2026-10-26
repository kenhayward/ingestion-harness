"""A layout analyser for tests: answers each page range from a function and records the calls."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


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
