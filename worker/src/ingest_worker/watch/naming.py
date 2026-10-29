"""File names in a watched folder: which are candidates, the name a file is kept under, and the
source key (held equal to the TypeScript side by packages/shared/test/fixtures/watch-naming.json).
"""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping, Sequence

#: The longest file name the bridge contract accepts (`MAX_SOURCE_NAME`).
MAX_NAME = 255
#: The longest source key a conversion item takes (TS `MAX_SOURCE_KEY`).
MAX_SOURCE_KEY = 1024
CANDIDATE_SUFFIXES = (".pdf", ".docx")


def name_problem(name: str) -> str | None:
    """Port of the bridge contract's `sourceNameProblem`: why `name` is not one file name."""
    length = len(name.encode("utf-16-le", "surrogatepass")) // 2  # UTF-16 units, as in JS
    if length < 1 or length > MAX_NAME:
        return f"a file name is 1 to {MAX_NAME} characters"
    if name in (".", ".."):
        return "a file name cannot be . or .."
    if any(ch in name for ch in ("/", "\\", "\0")):
        return "a file name is one path segment: no slash, backslash or NUL"
    return None


def is_candidate(name: str) -> bool:
    """A PDF or Word file the bridge can address; hidden files (a leading dot) and Office lock
    files (`~$`, present while someone has the document open) are skipped."""
    return (
        name_problem(name) is None
        and not name.startswith((".", "~$"))
        and name.lower().endswith(CANDIDATE_SUFFIXES)
    )


def _units(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def working_name(original: str, taken: set[str]) -> str:
    """The name a file is kept under: itself, else `stem_1.ext`, `stem_2.ext`, ... the first
    not in `taken`, the stem shortened so the name stays within `MAX_NAME`.

    `taken` is compared exactly (case-sensitively), because object keys are; a caller whose
    folder ignores case passes the lower-cased names and compares the same way."""
    if original not in taken:
        return original
    stem, dot, ext = original.rpartition(".")
    if not dot:
        stem = original
    suffix = f".{ext}" if dot else ""
    n = 1
    while True:
        tail = f"_{n}{suffix}"
        room = MAX_NAME - _units(tail)
        short = stem
        while _units(short) > room:
            short = short[:-1]
        if (name := f"{short}{tail}") not in taken:
            return name
        n += 1


def watch_source_path(field_ids: Sequence[str], source: Mapping[str, str]) -> str:
    """The folder path of a watch's source fields, in the order the sink declares them: values
    trimmed of spaces and stray slashes, empty ones left out (TS `watchSourcePath`)."""
    parts = [source.get(fid, "").strip().strip("/") for fid in field_ids]
    return "/".join(p for p in parts if p)


def source_key(path: str, original: str) -> str:
    return f"{path}/{original}"


def source_key_problem(key: str) -> str | None:
    """Port of TS `sourceKeyProblem` (packages/shared/src/conversions.ts): why `key` is not a
    source key a conversion item (and its `decompose` job's params) takes."""
    nfc = unicodedata.normalize("NFC", key)
    if not nfc:
        return "the source key is empty"
    if _units(nfc) > MAX_SOURCE_KEY:
        return f"the source key is longer than {MAX_SOURCE_KEY} characters"
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in nfc):
        return "the source key holds a control character"
    if "\\" in nfc:
        return "the source key holds a backslash: use / between folders"
    if nfc.startswith("/") or nfc.endswith("/"):
        return "the source key must not start or end with /"
    for part in nfc.split("/"):
        if not part:
            return "the source key has an empty part (//)"
        if part in (".", ".."):
            return f"the source key has a `{part}` part"
    return None
