"""`layout_service.device`: the GPU set up for output that matches the CPU's, without torch."""

from types import SimpleNamespace

import pytest

from layout_service.device import is_device_error, prepare


def fake_torch(cuda: bool) -> SimpleNamespace:
    precision: list[str] = []
    return SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: cuda),
        backends=SimpleNamespace(
            cuda=SimpleNamespace(matmul=SimpleNamespace(allow_tf32=True)),
            cudnn=SimpleNamespace(allow_tf32=True),
        ),
        set_float32_matmul_precision=precision.append,
        precision=precision,
    )


def test_on_a_gpu_tf32_is_turned_off() -> None:
    # TF32 split a table on a 102-page report that CPU reads whole (the pdf-reader design, 16).
    torch = fake_torch(cuda=True)
    assert prepare(torch) == "cuda"
    assert torch.backends.cuda.matmul.allow_tf32 is False
    assert torch.backends.cudnn.allow_tf32 is False
    assert torch.precision == ["highest"]


def test_without_a_gpu_nothing_changes() -> None:
    torch = fake_torch(cuda=False)
    assert prepare(torch) == "cpu"
    assert torch.backends.cudnn.allow_tf32 is True
    assert torch.precision == []


class OutOfMemoryError(RuntimeError):
    """Named like torch's."""


@pytest.mark.parametrize(
    "error",
    [
        OutOfMemoryError("CUDA out of memory. Tried to allocate 20.00 MiB"),
        RuntimeError("CUDA error: an illegal memory access was encountered"),
        RuntimeError("CUBLAS_STATUS_ALLOC_FAILED when calling `cublasCreate(handle)`"),
        RuntimeError("cuDNN error: CUDNN_STATUS_NOT_INITIALIZED"),
    ],
)
def test_gpu_errors_are_device_errors(error: Exception) -> None:
    assert is_device_error(error)


def test_a_device_error_is_found_through_its_cause() -> None:
    outer = ValueError("conversion failed")
    outer.__cause__ = RuntimeError("CUDA out of memory")
    assert is_device_error(outer)


@pytest.mark.parametrize(
    "error", [ValueError("Invalid page range"), RuntimeError("pdfium: could not load page 3")]
)
def test_other_errors_are_not(error: Exception) -> None:
    assert not is_device_error(error)
