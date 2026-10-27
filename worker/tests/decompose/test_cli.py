"""The decomposition CLI (scripts/decompose.py): its outputs, exit codes and file names."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from ingest_worker.convert import ConverterUnavailable
from ingest_worker.decompose import decompose_docx
from ingest_worker.decompose.pdf import decompose_pdf
from ingest_worker.decompose.pdf.layout import LayoutUnavailable
from ingest_worker.decompose.pdf.transcript import Transcript
from ingest_worker.decompose.render import RenderFragment
from tests.decompose.docx import build_docx
from tests.decompose.fakes import FakeRenderer
from tests.decompose.pdf import docling
from tests.decompose.pdf.fakes import FakeLayout
from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf
from tests.decompose.test_media import EMF, PNG, picture

SCRIPT = Path(__file__).parents[2] / "scripts" / "decompose.py"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("decompose_cli", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cli = _load()


def heading(title: str) -> str:
    return f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>{title}</w:t></w:r></w:p>'


def pictures_docx() -> bytes:
    body = (
        heading("Plots")
        + f"<w:p><w:r>{picture('rIdPng', descr='A plot')}</w:r></w:p>"
        + f"<w:p><w:r>{picture('rIdEmf', descr='A drawing')}</w:r></w:p>"
        + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:p>'
    )
    return build_docx(
        body,
        media={"image1.png": PNG, "image2.emf": EMF},
        rels=[("rIdPng", "image", "media/image1.png"), ("rIdEmf", "image", "media/image2.emf")],
    )


def test_writes_outputs_and_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    source = tmp_path / "in.docx"
    source.write_bytes(pictures_docx())
    out = tmp_path / "out"

    assert cli.main([str(source), str(out)], renderer=FakeRenderer()) == 0

    expected = decompose_docx(pictures_docx(), renderer=FakeRenderer())
    document = json.loads((out / "document.json").read_text(encoding="utf-8"))
    assert document == expected.document.model_dump(mode="json", by_alias=True)
    text = (out / "document.json").read_text(encoding="utf-8")
    assert text == json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    report = json.loads((out / "report.json").read_text(encoding="utf-8"))
    assert [f["code"] for f in report] == ["heading_empty", "image_converted"]  # sorted by place

    png, emf = expected.document.images
    names = sorted(p.name for p in (out / "images").iterdir())
    assert names == sorted(
        [
            f"{cli.file_name(png.id)}.png",
            f"{cli.file_name(emf.id)}.png",
            f"{cli.file_name(emf.id)}.orig.emf",
        ]
    )
    assert (out / "images" / f"{cli.file_name(png.id)}.png").read_bytes() == PNG
    assert (out / "images" / f"{cli.file_name(emf.id)}.orig.emf").read_bytes() == EMF
    capsys.readouterr()

    failed_out = tmp_path / "failed"
    code = cli.main([str(source), str(failed_out)], renderer=FakeRenderer(fails=True))
    assert code == 2
    err = capsys.readouterr().err
    assert "could not" in err and emf.id.split("#img")[0] in err
    assert not failed_out.exists()

    no_converter = tmp_path / "no-converter"
    assert cli.main([str(source), str(no_converter)]) == 2
    assert "rendering needs --converter-url" in capsys.readouterr().err
    assert not no_converter.exists()

    junk = tmp_path / "junk.docx"
    junk.write_bytes(b"not a package")
    assert cli.main([str(junk), str(tmp_path / "junk-out")], renderer=FakeRenderer()) == 3
    assert not (tmp_path / "junk-out").exists()


def test_refuses_non_empty_out_dir(tmp_path: Path) -> None:
    source = tmp_path / "in.docx"
    source.write_bytes(pictures_docx())
    out = tmp_path / "out"
    out.mkdir()
    (out / "keep.txt").write_text("mine")

    assert cli.main([str(source), str(out)], renderer=FakeRenderer()) == 1
    assert [p.name for p in out.iterdir()] == ["keep.txt"]

    empty = tmp_path / "empty"
    empty.mkdir()
    assert cli.main([str(source), str(empty)], renderer=FakeRenderer()) == 0
    assert (empty / "document.json").exists()


class _UnreachableRenderer:
    def render(self, fragment: RenderFragment) -> bytes | None:
        raise ConverterUnavailable("converter unreachable: connection refused")


def test_converter_unavailable_exits_4(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    source = tmp_path / "in.docx"
    source.write_bytes(pictures_docx())
    out = tmp_path / "out"
    assert cli.main([str(source), str(out)], renderer=_UnreachableRenderer()) == 4
    assert "converter unavailable: converter unreachable" in capsys.readouterr().err
    assert not out.exists()


def test_file_names_are_sanitised_ids_that_never_collide() -> None:
    assert cli.file_name("s-results/s-sub#p-3#img-1") == "s-results-s-sub-p-3-img-1"
    names = cli.file_names(["s-a#img-1", "s-a/img-1", "s-b#img-1"])
    assert names["s-b#img-1"] == "s-b-img-1"
    assert names["s-a#img-1"] != names["s-a/img-1"]
    assert names["s-a#img-1"].startswith("s-a-img-1-")
    assert names == cli.file_names(["s-a/img-1", "s-b#img-1", "s-a#img-1"])
    for name in names.values():
        assert set(name) <= set("abcdefghijklmnopqrstuvwxyz0123456789._~-")


def pdf_source() -> tuple[bytes, FakeLayout]:
    data = make_pdf([Page(runs=[Run("Hello there, this is a short note.", 72, 80)])])
    items = [docling.text("text", 1, (60, 842 - 68, 400, 842 - 84))]
    return data, FakeLayout(lambda first, last: docling.doc([(595.0, 842.0)], items))


def test_pdf_is_decomposed(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    data, layout = pdf_source()
    source = tmp_path / "in.pdf"  # the bytes decide, not the name
    source.write_bytes(data)
    out = tmp_path / "out"

    assert cli.main([str(source), str(out)], layout=layout) == 0

    expected = decompose_pdf(data, layout=layout)
    document = json.loads((out / "document.json").read_text(encoding="utf-8"))
    assert document == expected.document.model_dump(mode="json", by_alias=True)
    assert (out / "report.json").exists()
    assert (out / "images").is_dir()
    assert "top-level sections" in capsys.readouterr().out


def test_pdf_without_layout_url_exits_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    data, _ = pdf_source()
    source = tmp_path / "in.docx"  # a PDF under a .docx name is still a PDF
    source.write_bytes(data)
    out = tmp_path / "out"

    assert cli.main([str(source), str(out)]) == 2
    assert "a PDF needs --layout-url" in capsys.readouterr().err
    assert not out.exists()


def test_layout_unavailable_exits_4(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    data, _ = pdf_source()
    source = tmp_path / "in.pdf"
    source.write_bytes(data)
    out = tmp_path / "out"

    def down(first: int, last: int) -> dict[str, Any]:
        raise LayoutUnavailable("layout service unreachable: connection refused")

    assert cli.main([str(source), str(out)], layout=FakeLayout(down)) == 4
    assert "layout unavailable: layout service unreachable" in capsys.readouterr().err
    assert not out.exists()


def test_scanned_pdf_reads_through_the_ocr_model(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    data = make_pdf([Page(images=[Img(0, 0, 595, 842)])])
    source = tmp_path / "scan.pdf"
    source.write_bytes(data)
    layout = FakeLayout(lambda first, last: docling.doc([(595.0, 842.0)], []))

    class Transcriber:
        def transcribe(self, pages: Any) -> dict[int, Transcript]:
            return {p: Transcript("Scanned text.") for p in pages}

    assert (
        cli.main([str(source), str(tmp_path / "out")], layout=layout, transcriber=Transcriber())
        == 0
    )
    report = json.loads((tmp_path / "out" / "report.json").read_text(encoding="utf-8"))
    assert [f["code"] for f in report] == ["page_recognised"]


def test_scanned_pdf_without_ocr_exits_2(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "scan.pdf"
    source.write_bytes(make_pdf([Page(images=[Img(0, 0, 595, 842)])]))
    layout = FakeLayout(lambda first, last: docling.doc([(595.0, 842.0)], []))

    assert cli.main([str(source), str(tmp_path / "out")], layout=layout) == 2
    assert "page 1 is scanned and this CT Studio has no OCR model" in capsys.readouterr().err
