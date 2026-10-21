"""Anchor fixes for required sections that miss a sample (handoff SC2)."""

from __future__ import annotations

import pytest

from ingest_worker.anchor_hints import LABEL_VARIANTS, anchor_labels, suggest_anchor

SYNONYM = "; the anchor has no alternative for that."
CASE = " in another case."
INDENT = "; the anchor expects it at the start of the line."


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
            (r"^(From|Supplier|Vendor)\b", 'This sample labels it "Vendor:"' + SYNONYM),
        ),
        (
            "another case",
            r"^Supplier\b",
            "SUPPLIER: Acme Ltd\n",
            (r"^(Supplier|SUPPLIER)\b", 'This sample writes it "SUPPLIER:"' + CASE),
        ),
        (
            "an indented label",
            r"^Total\b",
            "Sub total 10.00\n   Total  12.00\n",
            (r"^\s*Total\b", 'This sample indents "Total"' + INDENT),
        ),
        (
            "a two-word synonym",
            r"^Payment terms",
            "Remit to: Bank of Example\n",
            (r"^(Payment\s+terms|Remit\s+to)", 'This sample labels it "Remit to:"' + SYNONYM),
        ),
        (
            "a case-insensitive anchor keeps its flag",
            r"(?i)^vendor\b",
            "  Vendor: Globex\n",
            (r"(?i)^\s*vendor\b", 'This sample indents "Vendor:"' + INDENT),
        ),
        (
            "a colon tail is kept, not loosened to a word boundary",
            r"^Supplier:",
            "Vendor: Globex\n",
            (r"^(Supplier|Vendor):", 'This sample labels it "Vendor:"' + SYNONYM),
        ),
        (
            "no tail stays no tail",
            r"^Total",
            "  Total: 12.00\n",
            (r"^\s*Total", 'This sample indents "Total:"' + INDENT),
        ),
        (
            "bill is the customer label, not a second name for invoice",
            r"^Invoice\b",
            "ACME\nBill to: Globex\n",
            None,
        ),
        (
            "the full synonym wins over a prefix of another label",
            r"^Invoice\b",
            "ACME\nBill to: Globex\nTAX INVOICE\n",
            (r"^(Invoice|TAX\s+INVOICE)\b", 'This sample labels it "TAX INVOICE"' + SYNONYM),
        ),
        ("po is not a label in PO Box", r"^Reference\b", "PO Box 12, Leeds\n", None),
        ("terms is not payment terms", r"^Payment terms", "Terms and conditions apply\n", None),
        (
            "a From: line is mail, not the supplier",
            r"^Supplier\b",
            "From: alice@example.com\n",
            None,
        ),
        (
            "a synonym inside a sentence is not a label",
            r"^Supplier\b",
            "Vendor of record is Globex\n",
            None,
        ),
        (
            "a synonym after 2+ spaces is a label",
            r"^Supplier\b",
            "Vendor   Globex\n",
            (r"^(Supplier|Vendor)\b", 'This sample labels it "Vendor"' + SYNONYM),
        ),
        (
            "an optional space is unreadable: it would be rewritten",
            r"^Total\s*:",
            "  Total: 5\n",
            None,
        ),
        ("an optional space inside a word", r"^Sub\s*total\b", "  Subtotal 5\n", None),
        ("a zero-or-one space", r"^Sub\s?total\b", "  Sub total\n", None),
        (
            "a label ending in punctuation needs no word boundary after it",
            r"^Invoice No\.",
            "  Invoice No. 12\n",
            (r"^\s*Invoice\s+No\.", 'This sample indents "Invoice No."' + INDENT),
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


NBSP = " (U+00A0) where the anchor has a plain space."


@pytest.mark.parametrize(
    ("name", "anchor", "text", "expected"),
    [
        (
            "a numbered heading with a no-break space after the word",
            r"^Table \d+:[ \t]{2,}",
            "Contents\nTable\xa013:      Study-201581 - Batch 95021\nrows\n",
            (
                r"^Table\s\d+:[ \u00a0\t]{2,}",
                'This sample writes "Table 13:      Study-201581 - Batch 95021" with a no-break space'
                + NBSP,
            ),
        ),
        (
            "the gap in a character class is the no-break one",
            r"^Table\s+\d+:[ \t]{2,}Study",
            "Table 1:\xa0\xa0Study A\n",
            (
                r"^Table\s+\d+:[ \u00a0\t]{2,}Study",
                'This sample writes "Table 1:  Study A" with a no-break space' + NBSP,
            ),
        ),
        (
            "an escaped space",
            r"^Total\ due",
            "Total\xa0due: 5.00\n",
            (
                r"^Total\sdue",
                'This sample writes "Total due: 5.00" with a no-break space' + NBSP,
            ),
        ),
        (
            "a narrow no-break space is named",
            r"^Total due",
            "Total\u202fdue: 5.00\n",
            (
                r"^Total\sdue",
                'This sample writes "Total due: 5.00" with a narrow no-break space (U+202F) where '
                "the anchor has a plain space.",
            ),
        ),
        (
            "a readable label anchor is not reported as indented",
            r"^Invoice No\b",
            "Invoice\xa0No 12\n",
            (
                r"^Invoice\sNo\b",
                'This sample writes "Invoice No 12" with a no-break space' + NBSP,
            ),
        ),
        (
            "a space escaped inside a class stays one character",
            r"^A[\ \t]B",
            "A\xa0B\n",
            (r"^A[\ \u00a0\t]B", 'This sample writes "A B" with a no-break space' + NBSP),
        ),
        ("a class with backslash-s already takes any space", r"^A[\s-]B", "A\xa0B\n", None),
        ("no-break spaces are not why it misses", r"^Table \d+: Study", "Table\xa01: Data\n", None),
        ("an anchor that already matches", r"^Table \d+", "Table 1\nTable\xa02\n", None),
        ("verbose patterns ignore spaces", r"(?x)^Table \d+", "Table\xa01\n", None),
        ("an anchor without a space", r"^Table\d+", "Table\xa01\n", None),
    ],
)
def test_suggest_anchor_for_unicode_spaces(
    name: str, anchor: str, text: str, expected: tuple[str, str] | None
) -> None:
    assert suggest_anchor(anchor, text) == expected
