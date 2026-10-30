"""Paragraph-level structure from styles.xml and numbering.xml: outline level and list membership."""

from __future__ import annotations

import re
from collections.abc import Sequence
from itertools import pairwise
from xml.etree.ElementTree import Element

from .inline import W

_BODY_LEVEL = 9
_GENERATED_ID = re.compile(r"TOC[1-9]|TableofFigures")
_GENERATED_NAME = re.compile(r"toc [1-9]|table of figures")
#: Word's own style for a table of contents' title.
_TITLE_ID = re.compile(r"TOCHeading")
_TITLE_NAME = re.compile(r"toc heading")
#: The text of a generated list's title, compared case-insensitively without a trailing colon.
_TITLE_TEXT = re.compile(
    r"(table of )?contents|list of (tables|figures|tables and figures|figures and tables)",
    re.IGNORECASE,
)
_UNORDERED = {"bullet", "none"}
_BUILT_IN_HEADING = re.compile(r"heading ([1-9])")


def _val(el: Element | None) -> str | None:
    return None if el is None else el.get(f"{W}val")


def _outline_lvl(ppr: Element | None) -> int | None:
    """The `w:outlineLvl` a `pPr` sets, if it sets a usable one."""
    raw = _val(ppr.find(f"{W}outlineLvl") if ppr is not None else None)
    try:
        level = int(raw) if raw is not None else None
    except ValueError:
        return None
    return level if level is not None and level >= 0 else None


class Styles:
    """Outline levels and list numbering of paragraphs, from direct properties then style chains."""

    def __init__(self, styles: Element | None = None, numbering: Element | None = None) -> None:
        self._ppr: dict[str, Element | None] = {}
        self._names: dict[str, str] = {}
        self._based_on: dict[str, str] = {}
        self._default: str | None = None
        if styles is not None:
            for style in styles.findall(f"{W}style"):
                sid = style.get(f"{W}styleId")
                if sid is None or style.get(f"{W}type", "paragraph") != "paragraph":
                    continue
                self._ppr[sid] = style.find(f"{W}pPr")
                self._names[sid] = (_val(style.find(f"{W}name")) or "").casefold()
                if style.get(f"{W}default", "0").lower() in ("1", "true", "on"):
                    self._default = sid
                if parent := _val(style.find(f"{W}basedOn")):
                    self._based_on[sid] = parent
        self._num_abstract: dict[str, str] = {}
        self._num_levels: dict[str, dict[str, Element]] = {}
        self._abstract_levels: dict[str, dict[str, Element]] = {}
        if numbering is not None:
            for abstract in numbering.findall(f"{W}abstractNum"):
                aid = abstract.get(f"{W}abstractNumId")
                if aid is not None:
                    self._abstract_levels[aid] = {
                        lvl.get(f"{W}ilvl", "0"): lvl for lvl in abstract.findall(f"{W}lvl")
                    }
            for num in numbering.findall(f"{W}num"):
                nid = num.get(f"{W}numId")
                aid = _val(num.find(f"{W}abstractNumId"))
                if nid is None or aid is None:
                    continue
                self._num_abstract[nid] = aid
                self._num_levels[nid] = {
                    o.get(f"{W}ilvl", "0"): lvl
                    for o in num.findall(f"{W}lvlOverride")
                    if (lvl := o.find(f"{W}lvl")) is not None
                }

    def _style_chain(self, p: Element) -> list[str]:
        """The paragraph's style id and its ancestors', nearest first."""
        ppr = p.find(f"{W}pPr")
        style_id = _val(ppr.find(f"{W}pStyle") if ppr is not None else None) or self._default
        chain: list[str] = []
        while style_id is not None and style_id in self._ppr and style_id not in chain:
            chain.append(style_id)
            style_id = self._based_on.get(style_id)
        return chain

    def _layers(self, p: Element) -> list[Element]:
        """The paragraph's own `pPr`, then its style's and its ancestors', nearest first."""
        layers: list[Element] = []
        ppr = p.find(f"{W}pPr")
        if ppr is not None:
            layers.append(ppr)
        for style_id in self._style_chain(p):
            if (style_ppr := self._ppr[style_id]) is not None:
                layers.append(style_ppr)
        return layers

    def is_caption(self, p: Element) -> bool:
        """Whether the paragraph's style is Word's caption style, or is based on it."""
        return any(
            sid == "Caption" or self._names.get(sid) == "caption" for sid in self._style_chain(p)
        )

    def is_generated_list(self, p: Element) -> bool:
        """Whether the paragraph is an entry of a table of contents or a list of tables or
        figures, by its style (`TOC 1`-`TOC 9`, `Table of Figures`) or one it is based on."""
        return any(
            _GENERATED_ID.fullmatch(sid) or _GENERATED_NAME.fullmatch(self._names.get(sid, ""))
            for sid in self._style_chain(p)
        )

    def generated_list_titles(self, elements: Sequence[Element]) -> list[Element]:
        """The paragraphs of a flow that title the generated list straight after them: body
        text, not a list entry itself, in Word's `TOC Heading` style or reading as such a
        title (`Contents`, `List of Tables`, ...). The list is dropped, so its title goes too.
        """
        return [
            el
            for el, following in pairwise(elements)
            if el.tag == f"{W}p"
            and following.tag == f"{W}p"
            and self.is_generated_list(following)
            and not self.is_generated_list(el)
            and self.outline_level(el) is None
            and self._is_list_title(el)
        ]

    def _is_list_title(self, p: Element) -> bool:
        if any(
            _TITLE_ID.fullmatch(sid) or _TITLE_NAME.fullmatch(self._names.get(sid, ""))
            for sid in self._style_chain(p)
        ):
            return True
        text = "".join(t.text or "" for t in p.iter(f"{W}t"))
        return _TITLE_TEXT.fullmatch(text.strip().removesuffix(":").strip()) is not None

    def outline_level(self, p: Element) -> int | None:
        """0-based outline level (from `w:outlineLvl`, then the style chain); None for body text.

        A built-in `heading N` style that sets no `w:outlineLvl` has level N-1, as Word gives it."""
        ppr = p.find(f"{W}pPr")
        if (level := _outline_lvl(ppr)) is not None:
            return level if level < _BODY_LEVEL else None
        for style_id in self._style_chain(p):
            level = _outline_lvl(self._ppr[style_id])
            if level is None and (m := _BUILT_IN_HEADING.fullmatch(self._names[style_id])):
                level = int(m.group(1)) - 1
            if level is not None:
                return level if level < _BODY_LEVEL else None
        return None

    def list_info(self, p: Element) -> tuple[str, int, bool] | None:
        """`(numId, ilvl, ordered)` if the paragraph is numbered, else None."""
        num_id: str | None = None
        ilvl: str | None = None
        for ppr in self._layers(p):
            num_pr = ppr.find(f"{W}numPr")
            if num_pr is None:
                continue
            if num_id is None:
                num_id = _val(num_pr.find(f"{W}numId"))
            if ilvl is None:
                ilvl = _val(num_pr.find(f"{W}ilvl"))
        if num_id is None or num_id == "0":
            return None
        try:
            level = int(ilvl) if ilvl is not None else 0
        except ValueError:
            level = 0
        return num_id, level, self._is_ordered(num_id, level)

    def _is_ordered(self, num_id: str, ilvl: int) -> bool:
        key = str(ilvl)
        lvl = self._num_levels.get(num_id, {}).get(key)
        if lvl is None:
            lvl = self._abstract_levels.get(self._num_abstract.get(num_id, ""), {}).get(key)
        fmt = _val(lvl.find(f"{W}numFmt") if lvl is not None else None)
        return fmt not in _UNORDERED
