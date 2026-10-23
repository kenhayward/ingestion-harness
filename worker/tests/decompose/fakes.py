"""Test doubles for the decomposition pipeline."""

from __future__ import annotations

import io

from PIL import Image

from ingest_worker.decompose.render import RenderFragment


def _tiny_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (10, 10), "white").save(buf, format="PNG")
    return buf.getvalue()


class FakeRenderer:
    """A Renderer that returns a fixed 10x10 PNG and records the fragments it was given."""

    def __init__(self) -> None:
        self.fragments: list[RenderFragment] = []
        self._png = _tiny_png()

    def render(self, fragment: RenderFragment) -> bytes | None:
        self.fragments.append(fragment)
        return self._png
