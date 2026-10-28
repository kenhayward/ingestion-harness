import pytest
from fastapi.testclient import TestClient

from layout_service.app import AnalysisFailed, DeviceUnavailable, create_app, require_success


class FakeAnalyser:
    def __init__(self, pages: int = 3) -> None:
        self.pages = pages
        self.calls: list[tuple[int, int]] = []
        self.timeouts: list[float] = []

    def page_count(self, pdf: bytes) -> int:
        return self.pages

    def analyse(self, pdf: bytes, first: int, last: int, timeout: float) -> dict:
        self.calls.append((first, last))
        self.timeouts.append(timeout)
        return {"body": {}}

    def fingerprint(self) -> str:
        return "fake 1"


PDF = b"%PDF-1.7\n%fake\n"


def post(client: TestClient, body: bytes = PDF, first: int = 1, last: int = 2):
    return client.post(
        "/layout",
        files={"file": ("a.pdf", body, "application/pdf")},
        data={"first": str(first), "last": str(last)},
    )


def test_layout_returns_document_and_page_count() -> None:
    fake = FakeAnalyser(pages=3)
    res = post(TestClient(create_app(fake)), first=1, last=2)
    assert res.status_code == 200
    assert res.json() == {"pages": 3, "document": {"body": {}}}
    assert fake.calls == [(1, 2)]


def test_not_a_pdf_is_400() -> None:
    fake = FakeAnalyser()
    res = post(TestClient(create_app(fake)), body=b"PK\x03\x04 not a pdf")
    assert res.status_code == 400
    assert res.json()["detail"] == "not a PDF"
    assert fake.calls == []


def test_too_many_pages_is_413() -> None:
    fake = FakeAnalyser(pages=3)
    res = post(TestClient(create_app(fake, max_pages=2)))
    assert res.status_code == 413
    assert fake.calls == []


def test_too_many_bytes_is_413() -> None:
    fake = FakeAnalyser()
    res = post(TestClient(create_app(fake, max_bytes=8)))
    assert res.status_code == 413
    assert fake.calls == []


def test_bad_range_is_422() -> None:
    fake = FakeAnalyser(pages=3)
    client = TestClient(create_app(fake))
    assert post(client, first=3, last=2).status_code == 422
    assert post(client, first=1, last=4).status_code == 422
    assert post(client, first=0, last=2).status_code == 422
    assert fake.calls == []


def test_health_reports_fingerprint() -> None:
    res = TestClient(create_app(FakeAnalyser())).get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "fingerprint": "fake 1"}


def test_unreadable_pdf_is_400() -> None:
    class Unreadable(FakeAnalyser):
        def page_count(self, pdf: bytes) -> int:
            raise ValueError("Failed to load document")

    fake = Unreadable()
    res = post(TestClient(create_app(fake)))
    assert res.status_code == 400
    assert res.json()["detail"] == "not a readable PDF"
    assert fake.calls == []


def test_conversion_failure_is_422_not_a_server_error() -> None:
    class Failing(FakeAnalyser):
        def analyse(self, pdf: bytes, first: int, last: int, timeout: float) -> dict:
            raise AnalysisFailed("page 2 could not be parsed")

    res = post(TestClient(create_app(Failing())))
    assert res.status_code == 422
    assert res.json() == {"error": "layout analysis failed: page 2 could not be parsed"}


def test_other_analyser_errors_stay_500() -> None:
    class Broken(FakeAnalyser):
        def analyse(self, pdf: bytes, first: int, last: int, timeout: float) -> dict:
            raise RuntimeError("out of memory")

    client = TestClient(create_app(Broken()), raise_server_exceptions=False)
    assert post(client).status_code == 500


def test_each_request_has_a_time_limit_of_30_seconds_a_page_up_to_600() -> None:
    fake = FakeAnalyser(pages=40)
    client = TestClient(create_app(fake))
    assert post(client, first=1, last=2).status_code == 200
    assert post(client, first=5, last=5).status_code == 200
    assert post(client, first=1, last=40).status_code == 200
    assert fake.timeouts == [60.0, 30.0, 600.0]


def test_a_timed_out_conversion_is_422() -> None:
    class Slow(FakeAnalyser):
        def analyse(self, pdf: bytes, first: int, last: int, timeout: float) -> dict:
            require_success("partial_success", timed_out=True)
            return {"body": {}}

    res = post(TestClient(create_app(Slow())))
    assert res.status_code == 422
    assert res.json() == {"error": "layout analysis failed: timed out"}


@pytest.mark.parametrize("status", ["partial_success", "failure", "skipped", "pending"])
def test_any_status_but_success_is_a_failed_analysis(status: str) -> None:
    with pytest.raises(AnalysisFailed, match=f"the conversion ended {status}"):
        require_success(status, timed_out=False)


def test_a_successful_conversion_passes() -> None:
    require_success("success", timed_out=False)


def test_a_device_failure_is_503_so_the_worker_falls_back() -> None:
    class OutOfVram(FakeAnalyser):
        def analyse(self, pdf: bytes, first: int, last: int, timeout: float) -> dict:
            raise DeviceUnavailable("CUDA out of memory")

    res = post(TestClient(create_app(OutOfVram())))
    assert res.status_code == 503
    assert res.json() == {"error": "layout device unavailable: CUDA out of memory"}


def test_a_fatal_device_failure_ends_the_service_after_answering() -> None:
    ended: list[bool] = []

    class Lost(FakeAnalyser):
        def analyse(self, pdf: bytes, first: int, last: int, timeout: float) -> dict:
            raise DeviceUnavailable("CUDA error: an illegal memory access", fatal=True)

    res = post(TestClient(create_app(Lost(), on_fatal=lambda: ended.append(True))))
    assert res.status_code == 503
    assert ended == [True]


def test_out_of_memory_does_not_end_the_service() -> None:
    ended: list[bool] = []

    class OutOfVram(FakeAnalyser):
        def analyse(self, pdf: bytes, first: int, last: int, timeout: float) -> dict:
            raise DeviceUnavailable("CUDA out of memory")

    post(TestClient(create_app(OutOfVram(), on_fatal=lambda: ended.append(True))))
    assert ended == []
