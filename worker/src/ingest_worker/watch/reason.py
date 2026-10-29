"""The reason file written beside a document that could not be loaded: plain words for the
person who dropped it in the folder."""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_ADVICE = "Correct the document and upload it to the folder again."
ADVICE: dict[str, str] = {
    "changed_in_target": (
        "An administrator must detach or accept it in CT Studio before it can be loaded again."
    ),
}


def advice_for(outcome: str) -> str:
    return ADVICE.get(outcome, DEFAULT_ADVICE)


@dataclass(frozen=True)
class ReasonFacts:
    original_name: str
    working_name: str
    uploaded_at: str
    picked_up_at: str
    finished_at: str
    outcome_label: str
    detail: str | None
    advice: str
    link: str | None


def reason_markdown(r: ReasonFacts) -> str:
    out = [f"# {r.original_name} could not be loaded", "", f"**Result:** {r.outcome_label}", ""]
    if r.detail:
        out += [r.detail, ""]
    out += [f"**What to do:** {r.advice}", "", "| | |", "|---|---|"]
    out.append(f"| Original file name | {r.original_name} |")
    if r.working_name != r.original_name:
        out.append(f"| Kept as | {r.working_name} |")
    out += [
        f"| Uploaded | {r.uploaded_at} |",
        f"| Picked up | {r.picked_up_at} |",
        f"| Finished | {r.finished_at} |",
    ]
    if r.link:
        out += ["", f"[See the details in CT Studio]({r.link})"]
    return "\n".join(out) + "\n"
