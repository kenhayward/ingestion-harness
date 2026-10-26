from fastapi.testclient import TestClient

from layout_service.app import create_app


class FakeAnalyser:
    def __init__(self, pages: int = 3) -> None:
        self.pages = pages
        self.calls: list[tuple[int, int]] = []

    def page_count(self, pdf: bytes) -> int:
        return self.pages

    def analyse(self, pdf: bytes, first: int, last: int) -> dict:
        self.calls.append((first, last))
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
