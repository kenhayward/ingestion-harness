"""The decomposition CLI (scripts/decompose.py): its outputs, exit codes and file names."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest

from ingest_worker.convert import ConverterUnavailable
from ingest_worker.decompose import decompose_docx
from ingest_worker.decompose.render import RenderFragment
from tests.decompose.docx import build_docx
from tests.decompose.fakes import FakeRenderer
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
    assert [f["code"] for f in report] == ["image_converted", "heading_empty"]

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
