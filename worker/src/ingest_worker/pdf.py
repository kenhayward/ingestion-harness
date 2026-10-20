from __future__ import annotations

import io
from collections.abc import Callable, Iterator

from pypdf import PageObject, PdfReader
from pypdf.generic import DictionaryObject, IndirectObject, StreamObject

from .symbol_fonts import Family, font_family, private_use_codes, translation

#: Turns PDF bytes into one text string per page. Injected so tests needn't build real PDFs.
TextExtractor = Callable[[bytes], list[str]]


def extract_pages(pdf: bytes) -> list[str]:
    """Text layer extraction. Scanned (image-only) PDFs yield empty pages — see docs/architecture.md.
    Symbol and Wingdings characters come out as the characters they show (`symbol_fonts`)."""
    reader = PdfReader(io.BytesIO(pdf))
    return [_page_text(page) for page in reader.pages]


def _page_text(page: PageObject) -> str:
    text = page.extract_text(extraction_mode="layout") or ""
    if not any(0xF000 <= ord(c) <= 0xF0FF for c in text):
        return text
    families: dict[Family | None, set[int]] = {}
    for font in _fonts(page.get("/Resources"), set()):
        cmap = font.get("/ToUnicode")
        base = font.get("/BaseFont")
        if cmap is None or base is None:
            continue
        cmap = cmap.get_object()
        if isinstance(cmap, StreamObject):
            families.setdefault(font_family(str(base)), set()).update(
                private_use_codes(cmap.get_data())
            )
    return text.translate(translation(families))


def _fonts(resources: object, seen: set[int]) -> Iterator[DictionaryObject]:
    """The font dictionaries of a resource dictionary and of the forms it draws, each once."""
    if isinstance(resources, IndirectObject):
        if resources.idnum in seen:
            return
        seen.add(resources.idnum)
        resources = resources.get_object()
    if not isinstance(resources, DictionaryObject):
        return
    fonts = resources.get("/Font")
    if fonts is not None and isinstance(fonts := fonts.get_object(), DictionaryObject):
        for font in fonts.values():
            if isinstance(font := font.get_object(), DictionaryObject):
                yield font
    forms = resources.get("/XObject")
    if forms is not None and isinstance(forms := forms.get_object(), DictionaryObject):
        for ref in forms.values():
            form = ref.get_object()
            if isinstance(form, StreamObject) and form.get("/Subtype") == "/Form":
                if isinstance(ref, IndirectObject):
                    if ref.idnum in seen:
                        continue
                    seen.add(ref.idnum)
                yield from _fonts(form.get("/Resources"), seen)
