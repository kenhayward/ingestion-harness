"""The device the models run on. The GPU image (`TORCH_INDEX` naming CUDA wheels) runs them on a
GPU when the container is given one; the CPU image, or the GPU image without a GPU, on the CPU.
Takes torch as an argument, so the tests run without it."""

from __future__ import annotations

from typing import Any

from layout_service.app import AnalysisFailed, DeviceUnavailable

#: Words in a torch or CUDA error that say the GPU, not the PDF, failed.
_DEVICE_WORDS = ("cuda", "cublas", "cudnn", "nccl")


def prepare(torch: Any) -> str:
    """"cuda" or "cpu". On a GPU, TF32 is turned off: with it, the layout model split one table
    in two on a page the CPU reads whole (the pdf-reader design, section 16); in full precision
    the GPU's boxes are the CPU's to within 0.002 points."""
    if not torch.cuda.is_available():
        return "cpu"
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.set_float32_matmul_precision("highest")
    return "cuda"


def failure(device: str, error: BaseException | str) -> AnalysisFailed | DeviceUnavailable:
    """What a failed conversion on `device` is. On the CPU, the PDF's (422). On a GPU, the
    device's (503), whatever it says: Docling catches a stage's CUDA error and reports only a
    failed conversion, so the CPU service is left to refuse a PDF that is at fault. A CUDA error
    other than running out of memory is `fatal`: the GPU is lost to this process."""
    reason = error if isinstance(error, str) else _reason(error)
    if device != "cuda":
        return AnalysisFailed(reason)
    fatal = not isinstance(error, str) and is_device_error(error) and not _out_of_memory(error)
    return DeviceUnavailable(reason, fatal=fatal)


def _reason(error: BaseException) -> str:
    text = str(error).strip()
    return text.splitlines()[0][:200] if text else type(error).__name__


def _out_of_memory(error: BaseException) -> bool:
    return any(
        type(e).__name__ == "OutOfMemoryError" or "out of memory" in str(e).lower()
        for e in _chain(error)
    )


def _chain(error: BaseException) -> list[BaseException]:
    seen: list[BaseException] = []
    current: BaseException | None = error
    while current is not None and all(current is not e for e in seen):
        seen.append(current)
        current = current.__cause__ or current.__context__
    return seen


def is_device_error(error: BaseException) -> bool:
    """Whether `error`, or anything it was raised from, is the GPU failing (out of memory, a
    driver error): the document should be read again on another service, not refused."""
    return any(
        type(e).__name__ == "OutOfMemoryError" or any(w in str(e).lower() for w in _DEVICE_WORDS)
        for e in _chain(error)
    )
