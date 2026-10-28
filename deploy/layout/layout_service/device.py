"""The device the models run on. The GPU image (`TORCH_INDEX` naming CUDA wheels) runs them on a
GPU when the container is given one; the CPU image, or the GPU image without a GPU, on the CPU.
Takes torch as an argument, so the tests run without it."""

from __future__ import annotations

from typing import Any

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


def is_device_error(error: BaseException) -> bool:
    """Whether `error`, or anything it was raised from, is the GPU failing (out of memory, a
    driver error): the document should be read again on another service, not refused."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if type(current).__name__ == "OutOfMemoryError":
            return True
        message = str(current).lower()
        if any(word in message for word in _DEVICE_WORDS):
            return True
        current = current.__cause__ or current.__context__
    return False
