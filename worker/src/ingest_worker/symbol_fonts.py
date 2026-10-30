"""Symbol and Wingdings characters in a PDF's text layer.

Word writes a character of the Symbol or Wingdings font as a private-use code point, U+F000 plus
the font's own code (`<w:sym w:font="Symbol" w:char="F0B0"/>` for a degree sign), and the PDF it
or LibreOffice makes keeps that code point in the font's ToUnicode map. The page shows `25 °C`
while its text reads `25 \\uf0b0C`, and a model drops the character it cannot read.

The same code point is a different glyph in each font (U+F0FC is a check mark in Wingdings and a
bracket piece in Symbol), so a code is translated only when the fonts of its page that produce it
all belong to one family whose table has it; anything else is left as it was.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping
from typing import Literal

Family = Literal["symbol", "wingdings"]

#: The Symbol font's codes 0x20-0xFE as Unicode (Adobe's Symbol encoding, with the Windows
#: font's euro at 0xA0). Glyph pieces Unicode has no character for (0x60, 0xBD, 0xBE, 0xF0) are
#: left out. 0x6D is the micro sign, as units are written (`µg`), not the Greek letter.
SYMBOL: Mapping[int, str] = {
    0x20: " ", 0x21: "!", 0x22: "∀", 0x23: "#", 0x24: "∃", 0x25: "%", 0x26: "&", 0x27: "∋",
    0x28: "(", 0x29: ")", 0x2A: "∗", 0x2B: "+", 0x2C: ",", 0x2D: "−", 0x2E: ".", 0x2F: "/",
    0x30: "0", 0x31: "1", 0x32: "2", 0x33: "3", 0x34: "4", 0x35: "5", 0x36: "6", 0x37: "7",
    0x38: "8", 0x39: "9", 0x3A: ":", 0x3B: ";", 0x3C: "<", 0x3D: "=", 0x3E: ">", 0x3F: "?",
    0x40: "≅", 0x41: "Α", 0x42: "Β", 0x43: "Χ", 0x44: "Δ", 0x45: "Ε", 0x46: "Φ", 0x47: "Γ",
    0x48: "Η", 0x49: "Ι", 0x4A: "ϑ", 0x4B: "Κ", 0x4C: "Λ", 0x4D: "Μ", 0x4E: "Ν", 0x4F: "Ο",
    0x50: "Π", 0x51: "Θ", 0x52: "Ρ", 0x53: "Σ", 0x54: "Τ", 0x55: "Υ", 0x56: "ς", 0x57: "Ω",
    0x58: "Ξ", 0x59: "Ψ", 0x5A: "Ζ", 0x5B: "[", 0x5C: "∴", 0x5D: "]", 0x5E: "⊥", 0x5F: "_",
    0x61: "α", 0x62: "β", 0x63: "χ", 0x64: "δ", 0x65: "ε", 0x66: "φ", 0x67: "γ",
    0x68: "η", 0x69: "ι", 0x6A: "ϕ", 0x6B: "κ", 0x6C: "λ", 0x6D: "µ", 0x6E: "ν", 0x6F: "ο",
    0x70: "π", 0x71: "θ", 0x72: "ρ", 0x73: "σ", 0x74: "τ", 0x75: "υ", 0x76: "ϖ", 0x77: "ω",
    0x78: "ξ", 0x79: "ψ", 0x7A: "ζ", 0x7B: "{", 0x7C: "|", 0x7D: "}", 0x7E: "∼",
    0xA0: "€", 0xA1: "ϒ", 0xA2: "′", 0xA3: "≤", 0xA4: "⁄", 0xA5: "∞", 0xA6: "ƒ", 0xA7: "♣",
    0xA8: "♦", 0xA9: "♥", 0xAA: "♠", 0xAB: "↔", 0xAC: "←", 0xAD: "↑", 0xAE: "→", 0xAF: "↓",
    0xB0: "°", 0xB1: "±", 0xB2: "″", 0xB3: "≥", 0xB4: "×", 0xB5: "∝", 0xB6: "∂", 0xB7: "•",
    0xB8: "÷", 0xB9: "≠", 0xBA: "≡", 0xBB: "≈", 0xBC: "…", 0xBF: "↵",
    0xC0: "ℵ", 0xC1: "ℑ", 0xC2: "ℜ", 0xC3: "℘", 0xC4: "⊗", 0xC5: "⊕", 0xC6: "∅", 0xC7: "∩",
    0xC8: "∪", 0xC9: "⊃", 0xCA: "⊇", 0xCB: "⊄", 0xCC: "⊂", 0xCD: "⊆", 0xCE: "∈", 0xCF: "∉",
    0xD0: "∠", 0xD1: "∇", 0xD2: "®", 0xD3: "©", 0xD4: "™", 0xD5: "∏", 0xD6: "√", 0xD7: "⋅",
    0xD8: "¬", 0xD9: "∧", 0xDA: "∨", 0xDB: "⇔", 0xDC: "⇐", 0xDD: "⇑", 0xDE: "⇒", 0xDF: "⇓",
    0xE0: "◊", 0xE1: "〈", 0xE2: "®", 0xE3: "©", 0xE4: "™", 0xE5: "∑", 0xE6: "⎛", 0xE7: "⎜",
    0xE8: "⎝", 0xE9: "⎡", 0xEA: "⎢", 0xEB: "⎣", 0xEC: "⎧", 0xED: "⎨", 0xEE: "⎩", 0xEF: "⎪",
    0xF1: "〉", 0xF2: "∫", 0xF3: "⌠", 0xF4: "⎮", 0xF5: "⌡", 0xF6: "⎞", 0xF7: "⎟",
    0xF8: "⎠", 0xF9: "⎤", 0xFA: "⎥", 0xFB: "⎦", 0xFC: "⎫", 0xFD: "⎬", 0xFE: "⎭",
}  # fmt: skip

#: The Wingdings codes documents use for bullets, check boxes and arrows; the rest stay as
#: they are. The arrows (0xDF-0xF8, as flow charts drawn in tables use them) are the common
#: arrows of their direction and fill, not the exact wide-headed and 3D shapes (U+1F868 and
#: on), which few fonts have: Wingdings orders each set left, right, up, down, then up-left,
#: up-right, down-left, down-right.
WINGDINGS: Mapping[int, str] = {
    0x6C: "●", 0x6E: "■", 0x6F: "□", 0x71: "❑", 0x75: "◆", 0x76: "❖", 0xA7: "▪", 0xA8: "◻",
    0xD8: "➢",
    0xDF: "⬅", 0xE0: "➡", 0xE1: "⬆", 0xE2: "⬇", 0xE3: "⬉", 0xE4: "⬈", 0xE5: "⬋", 0xE6: "⬊",
    0xE7: "⬅", 0xE8: "➡", 0xE9: "⬆", 0xEA: "⬇", 0xEB: "⬉", 0xEC: "⬈", 0xED: "⬋", 0xEE: "⬊",
    0xEF: "⇦", 0xF0: "⇨", 0xF1: "⇧", 0xF2: "⇩", 0xF3: "⬄", 0xF4: "⇳",
    0xF5: "⬀", 0xF6: "⬁", 0xF7: "⬃", 0xF8: "⬂",
    0xFB: "✗", 0xFC: "✓", 0xFD: "☒", 0xFE: "☑",
}  # fmt: skip

TABLES: Mapping[Family, Mapping[int, str]] = {"symbol": SYMBOL, "wingdings": WINGDINGS}

#: Font names (subset tag, spaces and punctuation gone, lower case) of each family. Wingdings 2
#: and 3 are other glyph sets; Segoe UI Symbol uses real Unicode.
_FAMILIES: Mapping[str, Family] = {
    "symbol": "symbol",
    "symbolmt": "symbol",
    "symbolregular": "symbol",
    "opensymbol": "symbol",
    "wingdings": "wingdings",
    "wingdingsregular": "wingdings",
}
_IDENTITY = re.compile(r"identity[hv]$")

FIRST, LAST = 0xF000, 0xF0FF
#: Larger ToUnicode streams are not read: a Symbol font's map is a few hundred bytes.
MAX_CMAP_BYTES = 1 << 20

_HEX = r"<([0-9A-Fa-f]+)>"
_PAIR = re.compile(rf"{_HEX}\s*{_HEX}".encode())
_RANGE = re.compile(rf"{_HEX}\s*{_HEX}\s*(?:{_HEX}|\[([^\]]*)\])".encode())
_ANY_HEX = re.compile(_HEX.encode())


def font_family(base_font: str) -> Family | None:
    """The family of a font's /BaseFont (`/ABCDEF+SymbolMT` is Symbol), else None."""
    name = base_font.lstrip("/").rsplit("+", 1)[-1]
    key = _IDENTITY.sub("", re.sub(r"[^a-z0-9]", "", name.lower()))
    return _FAMILIES.get(key)


def _code(hex_digits: bytes) -> int | None:
    """A destination's code point when it is one UTF-16 unit in the font range, else None."""
    if len(hex_digits) != 4:
        return None
    value = int(hex_digits, 16)
    return value if FIRST <= value <= LAST else None


def _blocks(cmap: bytes, name: bytes) -> Iterator[bytes]:
    """The bodies of a CMap's `begin<name>` … `end<name>` sections, in one pass (an uploaded
    PDF's stream: a lazy regex would rescan from every unmatched begin)."""
    begin, end = b"begin" + name, b"end" + name
    at = 0
    while (start := cmap.find(begin, at)) != -1:
        stop = cmap.find(end, start + len(begin))
        if stop == -1:
            return
        yield cmap[start + len(begin) : stop]
        at = stop + len(end)


def private_use_codes(cmap: bytes) -> set[int]:
    """The code points U+F000-U+F0FF a ToUnicode CMap maps its glyphs to (none for a stream
    over `MAX_CMAP_BYTES`)."""
    codes: set[int] = set()
    if len(cmap) > MAX_CMAP_BYTES:
        return codes
    for block in _blocks(cmap, b"bfchar"):
        for _src, dst in _PAIR.findall(block):
            if (code := _code(dst)) is not None:
                codes.add(code)
    for block in _blocks(cmap, b"bfrange"):
        for lo, hi, start, array in _RANGE.findall(block):
            if start:
                span = int(hi, 16) - int(lo, 16)
                if (code := _code(start)) is not None and span >= 0:
                    # Clamped first: a crafted range may span far more codes than the font has.
                    codes.update(range(code, min(code + span, LAST) + 1))
            else:
                codes.update(c for d in _ANY_HEX.findall(array) if (c := _code(d)) is not None)
    return codes


def translation(families: Mapping[Family | None, Iterable[int]]) -> dict[int, str]:
    """The `str.translate` table for one page, from the private-use codes each family of its
    fonts produces (None: fonts of no known family): a code only one family produces, in that
    family's table."""
    seen: dict[int, set[Family | None]] = {}
    for family, codes in families.items():
        for code in codes:
            seen.setdefault(code, set()).add(family)
    table: dict[int, str] = {}
    for code, owners in seen.items():
        if len(owners) != 1:
            continue
        (family,) = owners
        if family is not None and (char := TABLES[family].get(code - FIRST)) is not None:
            table[code] = char
    return table
