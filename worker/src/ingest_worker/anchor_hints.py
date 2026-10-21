"""Anchor fixes for the Sections tab (handoff SC2).

When a required section's anchor misses a sample, the sample often names the same part another
way: a synonym ("Vendor" for "Supplier"), another case ("SUPPLIER"), or an indented label. For
anchors simple enough to read (`^Label`, `^(A|B)\\b`, optionally `(?i)` and `\\s*`), look for such
a label at the start of a line and propose the anchor with it added. No suggestion is better than
a wrong one: anything cleverer is left alone, and a suggestion is only returned if it matches.

Any anchor, readable or not, may also miss only because the sample has a no-break space (or
another Unicode space) where the anchor has a plain one: PDFs often put U+00A0 between "Table"
and its number. Such an anchor gets its spaces widened (`\\s`, or U+00A0 added to a class).
Pure; runs inside the preview's time-capped child process with the grid (workbench.py)."""

from __future__ import annotations

import re
import unicodedata

#: Labels that name the same part of a business document (lower case, single spaces).
LABEL_VARIANTS: tuple[frozenset[str], ...] = (
    frozenset({"supplier", "vendor", "seller", "from", "sold by", "issued by"}),
    frozenset({"customer", "client", "buyer", "bill to", "sold to", "invoice to"}),
    frozenset({"ship to", "deliver to", "delivery address"}),
    frozenset({"invoice", "tax invoice"}),
    frozenset({"invoice no", "invoice number", "inv no"}),
    frozenset({"date", "dated", "invoice date", "issue date"}),
    frozenset({"due date", "payment due", "pay by"}),
    frozenset({"total", "grand total", "total due", "amount due", "balance due"}),
    frozenset({"sub total", "subtotal", "net total"}),
    frozenset({"payment", "payment terms", "remit to", "bank details"}),
    frozenset({"description", "items", "details"}),
    frozenset({"reference", "ref", "your ref", "our ref", "purchase order"}),
)

_HEAD = re.compile(r"(\(\?i\))?\^(\\s\*)?")
_TAIL = re.compile(r"(\\b|:)$")
_WILDCARD = re.compile(r"(?<!\\)\.")
_GROUP = re.compile(r"\((?:\?:)?([^()]*)\)")
_SPACE = re.compile(r"\\s\+?|\\ ")  # `\s*` and `\s?` are left in place, so they are refused
_ESCAPED = re.compile(r"\\([#&'./-])")
_PLAIN = re.compile(r"[A-Za-z0-9 #&'./-]+")


def _parse(anchor: str) -> tuple[bool, bool, list[str], str] | None:
    """(case-insensitive, indented, labels, tail) with tail one of `\\b`, `:` or "" (none)."""
    head = _HEAD.match(anchor)
    if head is None:
        return None
    rest = anchor[head.end() :]
    found_tail = _TAIL.search(rest)
    tail = found_tail.group(1) if found_tail else ""
    body = rest[: len(rest) - len(tail)]
    group = _GROUP.fullmatch(body)
    alternatives = group.group(1).split("|") if group else [body]
    labels: list[str] = []
    for alternative in alternatives:
        if _WILDCARD.search(alternative):
            return None  # an unescaped dot matches anything: not a label
        text = _ESCAPED.sub(r"\1", _SPACE.sub(" ", alternative))
        if "\\" in text or not text.strip() or not _PLAIN.fullmatch(text):
            return None
        labels.append(" ".join(text.split()))
    return head.group(1) is not None, head.group(2) is not None, labels, tail


def anchor_labels(anchor: str) -> tuple[bool, bool, list[str]] | None:
    """(case-insensitive, indented, labels) of an anchor shaped like `^Label`, `^(A|B)\\b` or
    `(?i)^\\s*(?:A|B):`; None for any other regex."""
    parsed = _parse(anchor)
    return None if parsed is None else parsed[:3]


#: Never proposed as a synonym: too often something else at the start of a line (a mail header).
_NOT_PROPOSED = frozenset({"from"})
#: After a synonym: a colon, the end of the line, or a gap of two or more spaces.
_LABEL_END = r"(?=[ \t]*:|[ \t]*$|[ \t]{2})"


def _pattern(label: str) -> str:
    return r"\s+".join(re.escape(word) for word in label.split())


_VERBOSE = re.compile(r"\(\?[aiLmsux]*x")
#: Whitespace a literal space matches or that never sits inside a line; any other is "odd".
_PLAIN_SPACES = frozenset(" \t\n\r\f\v")
_SHOWN = 80
_ANY_SPACE = r"\s"
_ESCAPED_SPACE = "\\ "
_NBSP = r"\u00a0"


def _spaces_widened(anchor: str) -> str | None:
    """The anchor with every literal space outside a class (or `\\ `) as `\\s` and `\\u00a0` added
    after every space inside one; None for a verbose pattern, whose spaces are not literal."""
    if _VERBOSE.search(anchor):
        return None
    out: list[str] = []
    in_class = False
    class_start = 0  # where a class's first character is: a `]` there is literal
    i = 0
    while i < len(anchor):
        char = anchor[i]
        if char == "\\" and i + 1 < len(anchor):
            pair = anchor[i : i + 2]
            if pair != _ESCAPED_SPACE:
                out.append(pair)
            else:
                out.append(pair + _NBSP if in_class else _ANY_SPACE)
            i += 2
            continue
        if in_class:
            if char == "]" and i > class_start:
                in_class = False
            out.append(" " + _NBSP if char == " " else char)
        elif char == "[":
            in_class = True
            class_start = i + (2 if anchor[i + 1 : i + 2] == "^" else 1)
            out.append(char)
        else:
            out.append(_ANY_SPACE if char == " " else char)
        i += 1
    return "".join(out)


def _space_fix(anchor: str, text: str) -> tuple[str, str] | None:
    """(widened anchor, reason) when the anchor misses `text` only because of an odd space."""
    widened = _spaces_widened(anchor)
    if widened is None or widened == anchor or re.search(anchor, text, re.MULTILINE):
        return None
    found = re.search(widened, text, re.MULTILINE)
    if found is None:
        return None
    odd = next((c for c in found.group(0) if c.isspace() and c not in _PLAIN_SPACES), None)
    if odd is None:
        return None
    # The line the match starts on (`\s` may begin it on the line above), odd spaces shown plain.
    at = found.start() + len(found.group(0)) - len(found.group(0).lstrip())
    end = text.find("\n", at)
    line = text[at : end if end != -1 else len(text)].strip()
    shown = "".join(" " if c.isspace() else c for c in line)[:_SHOWN]
    name = unicodedata.name(odd, "space").lower()
    reason = (
        f'This sample writes "{shown}" with a {name} (U+{ord(odd):04X}) '
        "where the anchor has a plain space."
    )
    return widened, reason


def suggest_anchor(anchor: str, text: str) -> tuple[str, str] | None:
    """(new anchor, reason) when `text` writes the anchor's spaces as no-break spaces, or starts
    a line with another way of writing the anchor's label; None otherwise."""
    if (fixed := _space_fix(anchor, text)) is not None:
        return fixed
    parsed = _parse(anchor)
    if parsed is None:
        return None
    insensitive, indented, labels, tail = parsed
    known = {label.lower() for label in labels}
    synonyms = {v for group in LABEL_VARIANTS if known & group for v in group} - known
    synonyms -= _NOT_PROPOSED
    # Longest first, so "tax invoice" is tried before "invoice"; the anchor's own labels lead.
    candidates = [(label, False) for label in labels]
    candidates += [(label, True) for label in sorted(synonyms, key=lambda v: (-len(v), v))]
    for label, synonym in candidates:
        end_check = _LABEL_END if synonym else ""
        found = re.search(
            rf"^([ \t]*)({_pattern(label)})(?!\w){end_check}", text, re.MULTILINE | re.IGNORECASE
        )
        if found is None:
            continue
        written = " ".join(found.group(2).split())
        same = written in labels or (insensitive and written.lower() in known)
        alternatives = labels if same else [*labels, written]
        parts = [_pattern(a) for a in alternatives]
        group = parts[0] if len(parts) == 1 else "(" + "|".join(parts) + ")"
        prefix = ("(?i)" if insensitive else "") + "^"
        if indented or found.group(1):
            prefix += r"\s*"
        suggestion = prefix + group + tail
        if suggestion == anchor or re.search(suggestion, text, re.MULTILINE) is None:
            continue
        end = found.end(2)
        shown = text[found.start(2) : end + (1 if text[end : end + 1] == ":" else 0)]
        if same:
            reason = (
                f'This sample indents "{shown}"; the anchor expects it at the start of the line.'
            )
        elif written.lower() in known:
            reason = f'This sample writes it "{shown}" in another case.'
            if found.group(1):
                reason = f'This sample writes it "{shown}" in another case and indents it.'
        else:
            reason = f'This sample labels it "{shown}"; the anchor has no alternative for that.'
        return suggestion, reason
    return None
