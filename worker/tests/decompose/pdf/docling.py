"""Docling-shaped dicts for tests: the parts of `export_to_dict` that `parse_docling` reads.

Pages are 1-based as in Docling; page boxes are Docling's bottom-left `(left, top, right,
bottom)`, with `top` above `bottom` (so `top > bottom`).
"""

from __future__ import annotations

from typing import Any

Box = tuple[float, float, float, float]


def _prov(page: int, bbox: Box) -> list[dict[str, Any]]:
    left, top, right, bottom = bbox
    box = {"l": left, "t": top, "r": right, "b": bottom, "coord_origin": "BOTTOMLEFT"}
    return [{"page_no": page, "bbox": box, "charspan": [0, 0]}]


def text(
    label: str, page: int, bbox: Box, level: int | None = None, *, furniture: bool = False
) -> dict[str, Any]:
    node: dict[str, Any] = {
        "_kind": "texts",
        "label": label,
        "content_layer": "furniture" if furniture else "body",
        "prov": _prov(page, bbox),
        "text": label,
    }
    if level is not None:
        node["level"] = level
    return node


def table(
    page: int, bbox: Box, cells: list[tuple[int, int]], *, rows: int, cols: int
) -> dict[str, Any]:
    """`cells` are `(row, col)` pairs; their boxes are top-left, as Docling's cell boxes are."""
    data = [
        {
            "bbox": {
                "l": 10.0 * c,
                "t": 10.0 * r,
                "r": 10.0 * c + 9,
                "b": 10.0 * r + 9,
                "coord_origin": "TOPLEFT",
            },
            "row_span": 1,
            "col_span": 1,
            "start_row_offset_idx": r,
            "start_col_offset_idx": c,
            "column_header": r == 0,
            "row_header": False,
            "text": f"R{r}C{c}",
        }
        for r, c in cells
    ]
    return {
        "_kind": "tables",
        "label": "table",
        "content_layer": "body",
        "prov": _prov(page, bbox),
        "captions": [],
        "data": {"num_rows": rows, "num_cols": cols, "table_cells": data},
    }


def picture(page: int, bbox: Box) -> dict[str, Any]:
    return {
        "_kind": "pictures",
        "label": "picture",
        "content_layer": "body",
        "prov": _prov(page, bbox),
        "captions": [],
    }


def group(children: list[dict[str, Any]]) -> dict[str, Any]:
    return {"_kind": "groups", "label": "list", "_children": children}


def doc(pages: list[tuple[float, float]], items: list[dict[str, Any]]) -> dict[str, Any]:
    """A document whose body lists `items` in order (groups hold their children)."""
    out: dict[str, Any] = {
        "body": {"self_ref": "#/body", "children": []},
        "furniture": {"self_ref": "#/furniture", "children": []},
        "groups": [],
        "texts": [],
        "tables": [],
        "pictures": [],
        "pages": {
            str(n): {"page_no": n, "size": {"width": w, "height": h}}
            for n, (w, h) in enumerate(pages, start=1)
        },
    }

    def add(node: dict[str, Any]) -> dict[str, str]:
        kind = node["_kind"]
        entry = {k: v for k, v in node.items() if not k.startswith("_")}
        out[kind].append(entry)
        ref = f"#/{kind}/{len(out[kind]) - 1}"
        entry["self_ref"] = ref
        entry["children"] = [add(child) for child in node.get("_children", [])]
        return {"$ref": ref}

    out["body"]["children"] = [add(item) for item in items]
    return out
