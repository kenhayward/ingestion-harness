"""A call in a child process with a time limit: what runs a recipe author's patterns in a
preview (a runaway regular expression is killed, never left to stall the worker)."""

from __future__ import annotations

import multiprocessing
from collections.abc import Callable, Sequence
from multiprocessing.connection import Connection
from typing import Any


class CallTimedOut(Exception):
    def __init__(self, timeout_s: float) -> None:
        super().__init__(f"did not finish within {timeout_s:g}s")
        self.timeout_s = timeout_s


class CallFailed(Exception):
    """The call raised in the child (the message names the exception), or the child died."""


def _child(conn: Connection, func: Callable[..., Any], args: Sequence[Any]) -> None:
    try:
        conn.send(("ok", func(*args)))
    except BaseException as exc:  # reported to the parent, whatever it was
        conn.send(("error", f"{type(exc).__name__}: {exc}"))
    finally:
        conn.close()


def capped_call(func: Callable[..., Any], args: Sequence[Any], timeout_s: float) -> Any:
    """`func(*args)` in a child process (`func` and `args` must pickle); CallTimedOut after
    `timeout_s`, when the child is killed."""
    method = "fork" if "fork" in multiprocessing.get_all_start_methods() else "spawn"
    ctx: Any = multiprocessing.get_context(method)  # typeshed: BaseContext has no Process
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_child, args=(child, func, list(args)), daemon=True)
    try:
        proc.start()
        child.close()
        if not parent.poll(timeout_s):
            raise CallTimedOut(timeout_s)
        try:
            status, value = parent.recv()
        except EOFError as exc:
            raise CallFailed("the child process ended without an answer") from exc
        if status == "error":
            raise CallFailed(value)
        return value
    finally:
        if proc.is_alive():
            proc.terminate()
            proc.join(5)
            if proc.is_alive():
                proc.kill()
        if proc.pid is not None:
            proc.join()
        child.close()
        parent.close()
