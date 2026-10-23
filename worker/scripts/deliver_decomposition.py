"""Decompose one .docx and deliver it to one target through the register (a dev tool; plan
ruling R8).

    uv run --directory worker python scripts/deliver_decomposition.py <file.docx> \
        --target <id> [--source-key K] [--batch-id B] [--force]

It uses the worker's configuration (DATABASE_URL, BRIDGE_URL, BRIDGE_CLIENT_KEY and, for
documents that need rendering, CONVERTER_URL) and prints one JSON line: the outcome, the
delivery id, the register entry id and a detail. The entry's final state arrives later, from the
bridge's events, through the API.

Exit codes:
  0  created, updated or already loaded
  1  refused (duplicate, in flight, changed in target) or failed
  2  the configuration or the arguments are incomplete (argparse's usage errors too)
"""

from __future__ import annotations

import argparse
import getpass
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from ingest_worker.bridge.client import HttpBridgeClient
from ingest_worker.bridge.models import ActingUser
from ingest_worker.config import Settings
from ingest_worker.convert import ConverterUnavailable, GotenbergConverter
from ingest_worker.decompose import DecompositionFailed
from ingest_worker.decompose.deliver import DeliverDeps, DeliveryOutcome, deliver_decomposition
from ingest_worker.decompose.register import PgRegisterStore
from ingest_worker.decompose.render import ConverterRenderer, Renderer, RenderFragment
from ingest_worker.publish_targets import (
    LiveTargets,
    PgPublishTargetStore,
    TargetMissing,
    TargetNotSynced,
)

_SUCCESS = {"created", "updated", "already_loaded"}


class _NoConverter:
    """A renderer without CONVERTER_URL: any rendering need fails the document."""

    def render(self, fragment: RenderFragment) -> bytes | None:
        raise DecompositionFailed("rendering needs CONVERTER_URL")


def deps_from_settings(settings: Settings) -> DeliverDeps:
    """The worker's register, bridge, targets and converter."""
    targets = LiveTargets(PgPublishTargetStore.connect(settings.database_url))

    def target_lookup(target_id: str) -> tuple[str, str | None]:
        target = targets.get(target_id)
        return target.sink_id, target.instance_id

    renderer: Renderer = (
        ConverterRenderer(GotenbergConverter(settings.converter_url))
        if settings.converter_url
        else _NoConverter()
    )
    return DeliverDeps(
        renderer=renderer,
        register=PgRegisterStore.for_url(settings.database_url),
        bridge=HttpBridgeClient(settings.bridge_url, settings.bridge_client_key),
        target_lookup=target_lookup,
    )


def _print(outcome: DeliveryOutcome) -> None:
    print(
        json.dumps(
            {
                "outcome": outcome.outcome,
                "deliveryId": outcome.delivery_id,
                "entryId": outcome.entry_id,
                "detail": outcome.detail,
            },
            ensure_ascii=False,
        )
    )


def main(argv: Sequence[str] | None = None, *, deps: DeliverDeps | None = None) -> int:
    usage = __doc__ or ""
    parser = argparse.ArgumentParser(
        description=usage.splitlines()[0],
        epilog=usage[usage.index("Exit codes:") :] if "Exit codes:" in usage else None,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("docx", type=Path)
    parser.add_argument("--target", required=True, help="the publishing target's id")
    parser.add_argument("--source-key", help="the register's source key (default: file name)")
    parser.add_argument("--batch-id", help="the batch this delivery belongs to")
    parser.add_argument("--force", action="store_true", help="force-load (spec §8)")
    args = parser.parse_args(argv)

    try:
        data = args.docx.read_bytes()
    except OSError as exc:
        _print(DeliveryOutcome("failed", None, None, f"cannot read {args.docx}: {exc}"))
        return 1
    if deps is None:
        try:
            deps = deps_from_settings(Settings.from_env())
        except ValueError as exc:  # names the missing variables, never their values
            print(str(exc), file=sys.stderr)
            return 2
    user = getpass.getuser()
    try:
        outcome = deliver_decomposition(
            deps,
            data=data,
            source_key=args.source_key or args.docx.name,
            target_id=args.target,
            started_by=ActingUser(id=f"cli:{user}", name=user, email=None),
            batch_id=args.batch_id,
            force=args.force,
        )
    except ConverterUnavailable as exc:
        outcome = DeliveryOutcome("failed", None, None, f"converter unavailable: {exc}")
    except (TargetMissing, TargetNotSynced) as exc:
        outcome = DeliveryOutcome("failed", None, None, str(exc))
    _print(outcome)
    return 0 if outcome.outcome in _SUCCESS else 1


if __name__ == "__main__":
    sys.exit(main())
