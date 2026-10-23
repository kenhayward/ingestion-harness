"""Safe, read-only access to an Office Open XML package (.docx) held in memory.

The source is untrusted: parts are read through a counted stream with size caps, XML is parsed
with DTDs and entities forbidden, and package paths are never written to disk.
"""

from __future__ import annotations

import io
import posixpath
import zipfile
import zlib
from dataclasses import dataclass
from xml.etree.ElementTree import Element, ParseError

from defusedxml import DefusedXmlException
from defusedxml.ElementTree import fromstring

MAX_PART_BYTES = 64 << 20
MAX_TOTAL_BYTES = 512 << 20
MAX_PARTS = 4000

_MAIN_PART = "word/document.xml"
_CHUNK = 1 << 16
_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class DecompositionRejected(Exception):
    """The source is unreadable or unsafe, so it is not decomposed."""


class DecompositionFailed(Exception):
    """A readable source could not be turned into a checked decomposed document."""

    def __init__(self, detail: str, at: str | None = None) -> None:
        super().__init__(f"{detail} (at {at})" if at else detail)
        self.detail = detail
        self.at = at


@dataclass(frozen=True)
class Rel:
    """One relationship from a part's `.rels` file."""

    id: str
    type: str
    target: str
    external: bool


def parse_xml(data: bytes) -> Element:
    """Parse XML with DTDs and entities forbidden; anything malformed or unsafe is rejected."""
    try:
        return fromstring(data, forbid_dtd=True)
    except (DefusedXmlException, ParseError, ValueError) as exc:
        raise DecompositionRejected(f"unreadable or unsafe XML: {exc}") from exc


class Package:
    """The parts of a package, read lazily and size-capped."""

    def __init__(self, zf: zipfile.ZipFile) -> None:
        self._zf = zf
        self._infos = {i.filename: i for i in zf.infolist() if not i.is_dir()}
        self._cache: dict[str, bytes] = {}
        self._read_total = 0

    def part(self, name: str) -> bytes | None:
        """The bytes of a part, or None if absent."""
        name = name.lstrip("/")
        if name in self._cache:
            return self._cache[name]
        info = self._infos.get(name)
        if info is None:
            return None
        if info.file_size > MAX_PART_BYTES:
            raise DecompositionRejected(f"part {name} is larger than {MAX_PART_BYTES} bytes")
        out = bytearray()
        try:
            with self._zf.open(info) as fh:
                while chunk := fh.read(_CHUNK):
                    out += chunk
                    if len(out) > MAX_PART_BYTES:
                        raise DecompositionRejected(
                            f"part {name} grew past {MAX_PART_BYTES} bytes while being read"
                        )
        except (
            zipfile.BadZipFile,
            zlib.error,
            EOFError,
            NotImplementedError,
            RuntimeError,
            OSError,
        ) as exc:
            raise DecompositionRejected(f"part {name} is unreadable: {exc}") from exc
        self._read_total += len(out)
        if self._read_total > MAX_TOTAL_BYTES:
            raise DecompositionRejected(f"package is larger than {MAX_TOTAL_BYTES} bytes")
        data = bytes(out)
        self._cache[name] = data
        return data

    def xml(self, name: str) -> Element | None:
        """A part parsed as XML, or None if absent."""
        data = self.part(name)
        return None if data is None else parse_xml(data)

    def rels(self, part: str) -> dict[str, Rel]:
        """The relationships of `part`, keyed by id (empty if it has none)."""
        directory, base = posixpath.split(part.lstrip("/"))
        root = self.xml(posixpath.join(directory, "_rels", f"{base}.rels"))
        found: dict[str, Rel] = {}
        if root is None:
            return found
        for el in root.iter(f"{_REL_NS}Relationship"):
            rid, target = el.get("Id"), el.get("Target")
            if rid is None or target is None:
                continue
            external = el.get("TargetMode") == "External"
            found[rid] = Rel(rid, el.get("Type") or "", target, external)
        return found

    def target(self, part: str, rel_id: str) -> str | None:
        """The package path an internal relationship of `part` points to, or None."""
        rel = self.rels(part).get(rel_id)
        if rel is None or rel.external:
            return None
        if rel.target.startswith("/"):
            resolved = posixpath.normpath(rel.target.lstrip("/"))
        else:
            resolved = posixpath.normpath(
                posixpath.join(posixpath.dirname(part.lstrip("/")), rel.target)
            )
        if resolved.startswith("..") or resolved == ".":
            return None
        return resolved


def open_package(data: bytes) -> Package:
    """Open `data` as a .docx package, rejecting anything that is not a safe one."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError) as exc:
        raise DecompositionRejected(f"not a zip package: {exc}") from exc
    infos = zf.infolist()
    if len(infos) > MAX_PARTS:
        raise DecompositionRejected(f"package has more than {MAX_PARTS} parts")
    if sum(i.file_size for i in infos) > MAX_TOTAL_BYTES:
        raise DecompositionRejected(f"package is larger than {MAX_TOTAL_BYTES} bytes")
    if _MAIN_PART not in {i.filename for i in infos}:
        raise DecompositionRejected(f"not a .docx: no {_MAIN_PART}")
    return Package(zf)
