"""Tests for the Agent 4 verification console Lambda gateway."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any, Protocol, cast

import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

_HANDLER_PATH = Path(__file__).with_name("handler.py")
_RUN_ID = "e443cc936bdc"
_OTHER_RUN_ID = "a1b2c3d4e5f6"


class _FakeS3:
    def __init__(self, objects: dict[str, bytes] | None = None, error: Exception | None = None) -> None:
        self.objects = objects or {}
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def get_object(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        key = kwargs["Key"]
        if key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "missing"}}, "GetObject")
        return {"Body": _FakeBody(self.objects[key])}


class _FakeBody:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self, limit: int = -1) -> bytes:
        return self._data if limit < 0 else self._data[:limit]


class _HandlerModule(Protocol):
    _s3_client: Any
    _SITE_ROOT: Path

    def lambda_handler(self, event: dict[str, Any], context: Any) -> dict[str, Any]: ...


@pytest.fixture
def handler(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> _HandlerModule:
    spec = importlib.util.spec_from_file_location("agent4_lambda_handler", _HANDLER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("RUNS_BUCKET", "aios-eval-agent-runs")
    # Keep cache tests hermetic: point the warm-container cache at a per-test file.
    monkeypatch.setenv("RUNS_INDEX_CACHE_PATH", str(tmp_path / "index-cache.json"))
    return cast(_HandlerModule, module)


def _event(method: str, path: str) -> dict[str, Any]:
    return {
        "version": "2.0",
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "body": "",
        "isBase64Encoded": False,
        "queryStringParameters": {},
    }


def _runs_index() -> bytes:
    return json.dumps(
        [
            {
                "run_id": _RUN_ID,
                "case_id": "CASE-DEMO-02",
                "remediation_draft": True,
                "status": "done",
                "started_at": "2026-10-01T10:00:00+00:00",
                "finished_at": "2026-10-01T10:12:00+00:00",
                "overall": "PASS",
                "pr": {"number": 3, "title": "[AIOS CASE-DEMO-02] Correct the inventory sync"},
            },
            {
                "run_id": _OTHER_RUN_ID,
                "case_id": None,
                "remediation_draft": False,
                "status": "failed",
                "started_at": None,
                "finished_at": None,
                "overall": "FAIL",
                "pr": None,
            },
        ]
    ).encode()


def _body(response: dict[str, Any]) -> Any:
    return json.loads(response["body"])


def test_healthz_does_not_touch_s3(handler: _HandlerModule) -> None:
    fake = _FakeS3(error=RuntimeError("must not be called"))
    handler._s3_client = fake
    response = handler.lambda_handler(_event("GET", "/healthz"), None)
    assert response["statusCode"] == 200
    assert _body(response) == {"status": "Healthy", "service": "aios-eval-agent-ui"}
    assert fake.calls == []


def test_runs_json_returns_seeded_index(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({"runs/index.json": _runs_index()})
    response = handler.lambda_handler(_event("GET", "/runs.json"), None)
    assert response["statusCode"] == 200
    assert response["headers"]["content-type"] == "application/json; charset=utf-8"
    runs = _body(response)
    assert isinstance(runs, list) and len(runs) == 2
    assert runs[0]["run_id"] == _RUN_ID
    assert runs[0]["pr"]["number"] == 3


def test_missing_index_serves_empty_list(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({})
    response = handler.lambda_handler(_event("GET", "/runs.json"), None)
    assert response["statusCode"] == 200
    assert _body(response) == []


def test_invalid_index_is_rejected(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({"runs/index.json": b'{"not": "a list"}'})
    response = handler.lambda_handler(_event("GET", "/runs.json"), None)
    assert response["statusCode"] == 502
    assert _body(response) == {"error": "INVALID_RUNS_INDEX"}


def test_index_entry_with_bad_run_id_is_rejected(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({"runs/index.json": b'[{"run_id": "../escape"}]'})
    response = handler.lambda_handler(_event("GET", "/runs.json"), None)
    assert response["statusCode"] == 502
    assert _body(response) == {"error": "INVALID_RUNS_INDEX"}


def test_run_json_served_from_store(handler: _HandlerModule) -> None:
    ledger = json.dumps({"run_id": _RUN_ID, "status": "done", "events": [], "artifacts": {}}).encode()
    handler._s3_client = _FakeS3({f"runs/{_RUN_ID}/run.json": ledger})
    response = handler.lambda_handler(_event("GET", f"/runs/{_RUN_ID}/run.json"), None)
    assert response["statusCode"] == 200
    assert _body(response)["run_id"] == _RUN_ID


def test_missing_run_json_is_404(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({})
    response = handler.lambda_handler(_event("GET", f"/runs/{_RUN_ID}/run.json"), None)
    assert response["statusCode"] == 404
    assert _body(response) == {"error": "RUN_NOT_FOUND"}


def test_corrupt_run_json_is_rejected(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({f"runs/{_RUN_ID}/run.json": b"not json{"})
    response = handler.lambda_handler(_event("GET", f"/runs/{_RUN_ID}/run.json"), None)
    assert response["statusCode"] == 502
    assert _body(response) == {"error": "INVALID_STORE_OBJECT"}


def test_report_md_served_as_markdown(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({f"runs/{_RUN_ID}/report.md": b"# Run report\n\nAll gates green."})
    response = handler.lambda_handler(_event("GET", f"/runs/{_RUN_ID}/report.md"), None)
    assert response["statusCode"] == 200
    assert response["headers"]["content-type"] == "text/markdown; charset=utf-8"
    assert "# Run report" in response["body"]


def test_missing_report_is_404(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({})
    response = handler.lambda_handler(_event("GET", f"/runs/{_RUN_ID}/report.md"), None)
    assert response["statusCode"] == 404
    assert _body(response) == {"error": "RUN_NOT_FOUND"}


def test_named_artifact_served_with_guessed_type(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({f"runs/{_RUN_ID}/junit.xml": b"<testsuites/>"})
    response = handler.lambda_handler(_event("GET", f"/runs/{_RUN_ID}/junit.xml"), None)
    assert response["statusCode"] == 200
    assert response["headers"]["content-type"].startswith("text/xml") or response["headers"][
        "content-type"
    ].startswith("application/xml")


def test_named_artifact_missing_is_404(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({})
    response = handler.lambda_handler(_event("GET", f"/runs/{_RUN_ID}/evidence.json"), None)
    assert response["statusCode"] == 404
    assert _body(response) == {"error": "ARTIFACT_NOT_FOUND"}


def test_traversal_run_id_is_rejected(handler: _HandlerModule) -> None:
    fake = _FakeS3({})
    handler._s3_client = fake
    response = handler.lambda_handler(_event("GET", "/runs/..%2Fsecrets/run.json"), None)
    assert response["statusCode"] == 404
    assert fake.calls == []


def test_unknown_runs_route_is_404(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({})
    response = handler.lambda_handler(_event("GET", "/runs"), None)
    assert response["statusCode"] == 404
    assert _body(response) == {"error": "NOT_FOUND"}


def test_post_is_method_not_allowed(handler: _HandlerModule) -> None:
    handler._s3_client = _FakeS3({})
    response = handler.lambda_handler(_event("POST", "/runs.json"), None)
    assert response["statusCode"] == 405
    assert _body(response) == {"error": "METHOD_NOT_ALLOWED"}


def test_options_preflight(handler: _HandlerModule) -> None:
    response = handler.lambda_handler(_event("OPTIONS", "/runs.json"), None)
    assert response["statusCode"] == 204
    assert response["headers"]["access-control-allow-origin"] == "*"
    assert "GET" in response["headers"]["access-control-allow-methods"]


def test_s3_error_maps_to_store_failure(handler: _HandlerModule) -> None:
    denied = ClientError({"Error": {"Code": "AccessDenied", "Message": "sensitive IAM detail"}}, "GetObject")
    handler._s3_client = _FakeS3(error=denied)
    response = handler.lambda_handler(_event("GET", "/runs.json"), None)
    assert response["statusCode"] == 502
    assert _body(response) == {"error": "STORE_REQUEST_FAILED"}
    assert "sensitive IAM detail" not in response["body"]


def test_index_cached_per_warm_container(handler: _HandlerModule, tmp_path: Path) -> None:
    store = _FakeS3({"runs/index.json": _runs_index()})
    handler._s3_client = store

    first = handler.lambda_handler(_event("GET", "/runs.json"), None)
    assert first["statusCode"] == 200

    # Replace the store contents: the warm container must serve the cached copy.
    store.objects = {"runs/index.json": json.dumps([{"run_id": "zzzz0000zzzz"}]).encode()}
    second = handler.lambda_handler(_event("GET", "/runs.json"), None)
    assert second["statusCode"] == 200
    assert [run["run_id"] for run in _body(second)] == [_RUN_ID, _OTHER_RUN_ID]
    assert len(store.calls) == 1

    # Past the TTL the gateway goes back to the store.
    cache_file = tmp_path / "index-cache.json"
    stale = cache_file.stat().st_mtime - 3600
    import os

    os.utime(cache_file, (stale, stale))
    third = handler.lambda_handler(_event("GET", "/runs.json"), None)
    assert third["statusCode"] == 200
    assert [run["run_id"] for run in _body(third)] == ["zzzz0000zzzz"]
    assert len(store.calls) == 2


def test_oversized_index_is_rejected(handler: _HandlerModule) -> None:
    big = json.dumps([{"run_id": f"run{i:012x}"} for i in range(600)]).encode()
    handler._s3_client = _FakeS3({"runs/index.json": big})
    response = handler.lambda_handler(_event("GET", "/runs.json"), None)
    assert response["statusCode"] == 502
    assert _body(response) == {"error": "INVALID_RUNS_INDEX"}


def test_static_site_uses_cache_policy_and_blocks_traversal(
    handler: _HandlerModule, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    site = tmp_path / "site"
    (site / "assets").mkdir(parents=True)
    (site / "index.html").write_text('<div id="root"></div>')
    (site / "assets" / "app.js").write_text("console.log('agent4')")
    monkeypatch.setattr(handler, "_SITE_ROOT", site)

    index = handler.lambda_handler(_event("GET", "/"), None)
    asset = handler.lambda_handler(_event("GET", "/assets/app.js"), None)
    fallback = handler.lambda_handler(_event("GET", "/runs-view"), None)
    traversal = handler.lambda_handler(_event("GET", "/../secret.txt"), None)

    assert index["statusCode"] == 200
    assert index["headers"]["cache-control"] == "no-cache"
    assert asset["headers"]["cache-control"] == "public,max-age=31536000,immutable"
    assert fallback["statusCode"] == 200  # SPA fallback serves index.html
    assert traversal["statusCode"] == 404
