"""Public presentation gateway for the Agent 4 verification console (Lambda + S3)."""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

_SITE_ROOT = Path(__file__).with_name("site")
_INDEX_KEY = "runs/index.json"
_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_ARTIFACT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_RUN_JSON_PATH = re.compile(r"^/runs/([^/]+)/run\.json$")
_REPORT_PATH = re.compile(r"^/runs/([^/]+)/report\.md$")
_ARTIFACT_PATH = re.compile(r"^/runs/([^/]+)/([^/]+)$")
_MAX_OBJECT_BYTES = 8_000_000
_MAX_RUNS_INDEX_ENTRIES = 500
_DEFAULT_INDEX_CACHE_PATH = Path("/tmp/agent4-runs-index.json")
_DEFAULT_INDEX_CACHE_TTL_SECONDS = 30.0
_SERVICE_NAME = "aios-eval-agent-ui"
_s3_client: Any | None = None


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Handle Lambda Function URL API and static-site requests."""

    del context
    method = str(event.get("requestContext", {}).get("http", {}).get("method", "GET")).upper()
    path = unquote(str(event.get("rawPath", "/")))

    if method == "OPTIONS":
        return _options_response()

    if path == "/healthz" and method == "GET":
        return _json_response(200, {"status": "Healthy", "service": _SERVICE_NAME})

    if path == "/runs.json":
        if method != "GET":
            return _method_not_allowed()
        return _runs_index_response()

    run_json_match = _RUN_JSON_PATH.fullmatch(path)
    if run_json_match is not None:
        if method != "GET":
            return _method_not_allowed()
        return _s3_json_response(f"runs/{run_json_match.group(1)}/run.json", missing_code="RUN_NOT_FOUND")

    report_match = _REPORT_PATH.fullmatch(path)
    if report_match is not None:
        if method != "GET":
            return _method_not_allowed()
        return _s3_text_response(
            f"runs/{report_match.group(1)}/report.md",
            content_type="text/markdown; charset=utf-8",
            missing_code="RUN_NOT_FOUND",
        )

    artifact_match = _ARTIFACT_PATH.fullmatch(path)
    if artifact_match is not None:
        if method != "GET":
            return _method_not_allowed()
        return _s3_artifact_response(artifact_match.group(1), artifact_match.group(2))

    if path == "/runs" or path.startswith("/runs/"):
        return _json_response(404, {"error": "NOT_FOUND"})
    if method not in {"GET", "HEAD"}:
        return _method_not_allowed()
    return _static_response(path, head=method == "HEAD")


def _s3() -> Any:
    global _s3_client
    if _s3_client is None:
        region = os.environ.get("AWS_REGION", "ap-southeast-1")
        _s3_client = boto3.client(
            "s3",
            region_name=region,
            config=Config(
                connect_timeout=5,
                read_timeout=20,
                retries={"max_attempts": 3, "mode": "standard"},
            ),
        )
    return _s3_client


def _bucket() -> str:
    return os.environ.get("RUNS_BUCKET", "aios-eval-agent-runs")


def _get_object(key: str) -> bytes | None:
    """Return object bytes, None on missing key; unexpected failures raise."""

    response = _s3().get_object(Bucket=_bucket(), Key=key)
    body = response.get("Body")
    raw = body.read(_MAX_OBJECT_BYTES + 1) if hasattr(body, "read") else body
    if not isinstance(raw, bytes) or len(raw) > _MAX_OBJECT_BYTES:
        raise _TooLarge()
    return raw


def _fetch_key(key: str) -> bytes | None:
    try:
        return _get_object(key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"NoSuchKey", "NoSuchBucket"}:
            return None
        raise
    except BotoCoreError:
        raise


class _TooLarge(Exception):
    """Internal marker for objects above the response size cap."""


def _runs_index_response() -> dict[str, Any]:
    cache_path = _index_cache_path()
    ttl = _index_cache_ttl()
    # st_mtime is wall-clock; compare against time.time() so an expired cache refetches.
    now = time.time()
    if cache_path is not None:
        try:
            if now - cache_path.stat().st_mtime < ttl:
                cached = cache_path.read_bytes()
                if _valid_runs_index(cached) is not None:
                    return _json_body_response(cached)
        except OSError:
            pass
    try:
        raw = _fetch_key(_INDEX_KEY)
    except _TooLarge:
        return _json_response(502, {"error": "RUNS_INDEX_TOO_LARGE"})
    except (ClientError, BotoCoreError):
        return _json_response(502, {"error": "STORE_REQUEST_FAILED"})
    if raw is None:
        # No runs pushed yet: an absent index is an empty queue, not an error.
        return _json_body_response(b"[]")
    if _valid_runs_index(raw) is None:
        return _json_response(502, {"error": "INVALID_RUNS_INDEX"})
    if cache_path is not None:
        try:
            cache_path.write_bytes(raw)
        except OSError:
            pass
    return _json_body_response(raw)


def _valid_runs_index(raw: bytes) -> list[dict[str, Any]] | None:
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(parsed, list) or len(parsed) > _MAX_RUNS_INDEX_ENTRIES:
        return None
    for entry in parsed:
        if not isinstance(entry, dict):
            return None
        run_id = entry.get("run_id")
        if not isinstance(run_id, str) or _RUN_ID.fullmatch(run_id) is None:
            return None
    return parsed


def _s3_json_response(key: str, *, missing_code: str) -> dict[str, Any]:
    try:
        raw = _fetch_key(key)
    except _TooLarge:
        return _json_response(413, {"error": "ARTIFACT_TOO_LARGE"})
    except (ClientError, BotoCoreError):
        return _json_response(502, {"error": "STORE_REQUEST_FAILED"})
    if raw is None:
        return _json_response(404, {"error": missing_code})
    try:
        json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _json_response(502, {"error": "INVALID_STORE_OBJECT"})
    return _json_body_response(raw)


def _s3_text_response(key: str, *, content_type: str, missing_code: str) -> dict[str, Any]:
    try:
        raw = _fetch_key(key)
    except _TooLarge:
        return _json_response(413, {"error": "ARTIFACT_TOO_LARGE"})
    except (ClientError, BotoCoreError):
        return _json_response(502, {"error": "STORE_REQUEST_FAILED"})
    if raw is None:
        return _json_response(404, {"error": missing_code})
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return _json_response(502, {"error": "INVALID_STORE_OBJECT"})
    return {
        "statusCode": 200,
        "headers": {
            "content-type": content_type,
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
        },
        "body": text,
    }


def _s3_artifact_response(run_id: str, name: str) -> dict[str, Any]:
    if _RUN_ID.fullmatch(run_id) is None or _ARTIFACT_NAME.fullmatch(name) is None:
        return _json_response(404, {"error": "NOT_FOUND"})
    try:
        raw = _fetch_key(f"runs/{run_id}/{name}")
    except _TooLarge:
        return _json_response(413, {"error": "ARTIFACT_TOO_LARGE"})
    except (ClientError, BotoCoreError):
        return _json_response(502, {"error": "STORE_REQUEST_FAILED"})
    if raw is None:
        return _json_response(404, {"error": "ARTIFACT_NOT_FOUND"})
    content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    headers = {
        "content-type": f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type,
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
    }
    if content_type.startswith("text/") or content_type in {"application/json", "image/svg+xml"}:
        try:
            return {"statusCode": 200, "headers": headers, "body": raw.decode("utf-8")}
        except UnicodeDecodeError:
            return _json_response(502, {"error": "INVALID_STORE_OBJECT"})
    return {
        "statusCode": 200,
        "headers": headers,
        "body": base64.b64encode(raw).decode("ascii"),
        "isBase64Encoded": True,
    }


def _index_cache_path() -> Path | None:
    value = os.environ.get("RUNS_INDEX_CACHE_PATH")
    return Path(value) if value else _DEFAULT_INDEX_CACHE_PATH


def _index_cache_ttl() -> float:
    try:
        return float(os.environ.get("RUNS_INDEX_CACHE_TTL_SECONDS", _DEFAULT_INDEX_CACHE_TTL_SECONDS))
    except ValueError:
        return _DEFAULT_INDEX_CACHE_TTL_SECONDS


def _method_not_allowed() -> dict[str, Any]:
    return _json_response(405, {"error": "METHOD_NOT_ALLOWED"})


def _options_response() -> dict[str, Any]:
    return {
        "statusCode": 204,
        "headers": {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, HEAD, OPTIONS",
            "access-control-allow-headers": "content-type",
            "access-control-max-age": "86400",
        },
        "body": "",
    }


def _json_body_response(raw: bytes) -> dict[str, Any]:
    return {
        "statusCode": 200,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
        },
        "body": raw.decode("utf-8"),
    }


def _static_response(path: str, *, head: bool) -> dict[str, Any]:
    requested = "index.html" if path == "/" else path.lstrip("/")
    candidate = (_SITE_ROOT / requested).resolve()
    if not candidate.is_relative_to(_SITE_ROOT.resolve()):
        return _json_response(404, {"error": "NOT_FOUND"})
    if not candidate.is_file():
        if "." in Path(requested).name:
            return _json_response(404, {"error": "NOT_FOUND"})
        candidate = _SITE_ROOT / "index.html"
    if not candidate.is_file():
        return _json_response(503, {"error": "SITE_NOT_BUILT"})

    content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
    data = b"" if head else candidate.read_bytes()
    cache_control = "public,max-age=31536000,immutable" if requested.startswith("assets/") else "no-cache"
    headers = {"content-type": f"{content_type}; charset=utf-8", "cache-control": cache_control}
    text_types = {"application/javascript", "application/json", "image/svg+xml"}
    if content_type.startswith("text/") or content_type in text_types:
        return {"statusCode": 200, "headers": headers, "body": data.decode("utf-8")}
    return {
        "statusCode": 200,
        "headers": headers,
        "body": base64.b64encode(data).decode("ascii"),
        "isBase64Encoded": True,
    }


def _json_response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
        },
        "body": json.dumps(body, separators=(",", ":")),
    }
