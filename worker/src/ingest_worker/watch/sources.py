"""Whether a file picked up from a watched folder is a source we accept: a port of the API's
`checkSource` (apps/api/src/uploads.ts), with the same messages."""

from __future__ import annotations

import re
import zipfile
import zlib

from ingest_worker.convert import is_docx
from ingest_worker.decompose import source_kind

NOT_A_SOURCE = "file is not a PDF or Word document (.docx)"
TRACKED_CHANGES = (
    "the Word document has tracked changes: accept or reject them in Word, then upload again"
)
TOO_LARGE_TO_CHECK = "the Word document is too large to check (over 64 MiB unpacked)"
OVER_LIMIT = "file is larger than the upload limit"

MAX_INFLATED = 64 * 1024 * 1024
MAX_ENTRIES = 10_000
_CHUNK = 64 * 1024
#: Parts whose text reaches the PDF: a tracked change in any of them would show as markup.
_TEXT_PART = re.compile(r"^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$")
#: Insertions, deletions and moves (not w:insideH, w:delText, w:moveFromRangeStart, ...).
_REVISION = re.compile(rb"<w:(ins|del|moveFrom|moveTo)[\s/>]")


class _TooLarge(Exception):
    pass


def _has_tracked_changes(data: bytes, max_inflated: int) -> bool | None:
    """Whether a text part holds tracked changes; None when `word/document.xml` is missing.
    The budget counts every inspected part, `[Content_Types].xml` included, as the API's does."""
    import io

    inflated = 0
    found = False
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = z.infolist()
        if len(infos) > MAX_ENTRIES:
            raise zipfile.BadZipFile("too many entries")
        if not any(i.filename == "word/document.xml" for i in infos):
            return None
        for info in infos:
            if info.filename != "[Content_Types].xml" and not _TEXT_PART.match(info.filename):
                continue
            tail = b""
            with z.open(info) as part:
                while chunk := part.read(_CHUNK):
                    inflated += len(chunk)
                    if inflated > max_inflated:
                        raise _TooLarge
                    if _REVISION.search(tail + chunk):
                        found = found or info.filename != "[Content_Types].xml"
                    tail = chunk[-16:]
    return found


def source_problem(
    data: bytes, filename: str, max_bytes: int, *, max_inflated: int = MAX_INFLATED
) -> str | None:
    """Why `data` cannot be converted, or None. Judged by the bytes, never by `filename`."""
    if len(data) > max_bytes:
        return OVER_LIMIT
    if data.startswith(b"%PDF-"):
        return None
    # Stricter than the API's checkSource, on purpose: the decomposer reads anything with
    # "%PDF-" in its first KiB as a PDF, so such a Word file would be decomposed wrongly.
    if not is_docx(data) or source_kind(data) != "docx":
        return NOT_A_SOURCE
    try:
        tracked = _has_tracked_changes(data, max_inflated)
    except _TooLarge:
        return TOO_LARGE_TO_CHECK
    except (zipfile.BadZipFile, OSError, EOFError, ValueError, NotImplementedError):
        return NOT_A_SOURCE
    except (zlib.error, RuntimeError):  # a corrupt deflate stream, an encrypted entry
        return NOT_A_SOURCE
    if tracked is None:
        return NOT_A_SOURCE
    return TRACKED_CHANGES if tracked else None
