"""Anchor fixes for required sections that miss a sample (handoff SC2)."""

from __future__ import annotations

import pytest

from ingest_worker.anchor_hints import LABEL_VARIANTS, anchor_labels, suggest_anchor

REASON = "; no alternative of the anchor matches that."


@pytest.mark.parametrize(
    ("anchor", "expected"),
    [
        (r"^(From|Supplier)\b", (False, False, ["From", "Supplier"])),
        (r"^Description\s+Qty", (False, False, ["Description Qty"])),
        (r"(?i)^\s*(?:Sub total|Subtotal):", (True, True, ["Sub total", "Subtotal"])),
        (r"^Invoice No\.", (False, False, ["Invoice No."])),
        (r"^(TAX )?INVOICE", None),
        (r"^Payment (terms|details)", None),
        (r"^\d+\.0 PURPOSE", None),
        (r"^Inv.", None),
        (r"\A", None),
    ],
)
def test_anchor_labels(anchor: str, expected: tuple[bool, bool, list[str]] | None) -> None:
    assert anchor_labels(anchor) == expected


@pytest.mark.parametrize(
    ("name", "anchor", "text", "expected"),
    [
        (
            "a synonym",
            r"^(From|Supplier)\b",
            "GLOBEX CORPORATION\nVendor: Globex Corporation\n",
            (r"^(From|Supplier|Vendor)\b", 'This sample labels it "Vendor:"' + REASON),
        ),
        (
            "another case",
            r"^Supplier\b",
            "SUPPLIER: Acme Ltd\n",
            (r"^(Supplier|SUPPLIER)\b", 'This sample labels it "SUPPLIER:"' + REASON),
        ),
        (
            "an indented label",
            r"^Total\b",
            "Sub total 10.00\n   Total  12.00\n",
            (r"^\s*Total\b", 'This sample labels it "Total"' + REASON),
        ),
        (
            "a two-word synonym",
            r"^Payment terms",
            "Remit to: Bank of Example\n",
            (r"^(Payment\s+terms|Remit\s+to)", 'This sample labels it "Remit to:"' + REASON),
        ),
        (
            "a case-insensitive anchor keeps its flag",
            r"(?i)^vendor\b",
            "  Vendor: Globex\n",
            (r"(?i)^\s*vendor\b", 'This sample labels it "Vendor:"' + REASON),
        ),
        (
            "a colon tail is kept, not loosened to a word boundary",
            r"^Supplier:",
            "Vendor: Globex\n",
            (r"^(Supplier|Vendor):", 'This sample labels it "Vendor:"' + REASON),
        ),
        (
            "no tail stays no tail",
            r"^Total",
            "  Total: 12.00\n",
            (r"^\s*Total", 'This sample labels it "Total:"' + REASON),
        ),
        ("an unescaped dot is a wildcard, not a label", r"^Inv.", "Invoice\n", None),
        ("an anchor too clever to rewrite", r"^(TAX )?INVOICE", "Invoice\n", None),
        ("no variant in the text", r"^Supplier\b", "Nothing like it here\n", None),
        ("a label only mid-line", r"^Supplier\b", "Bill to: X   Supplier: Y\n", None),
    ],
)
def test_suggest_anchor(
    name: str, anchor: str, text: str, expected: tuple[str, str] | None
) -> None:
    assert suggest_anchor(anchor, text) == expected


def test_label_variants_are_lower_case_single_spaced_and_unique() -> None:
    seen: set[str] = set()
    for group in LABEL_VARIANTS:
        for label in group:
            assert label == " ".join(label.lower().split())
            assert label not in seen, label
            seen.add(label)
