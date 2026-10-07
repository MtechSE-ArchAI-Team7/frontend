"""Tests for the Agent 1 CloudWatch event gateway."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any, Protocol, cast

import pytest

_HANDLER_PATH = Path(__file__).with_name("handler.py")
_RUN_ID = "2db1f13e-7351-4a1f-a4c6-630646366d52"


class _FakeLogs:
    def __init__(self, messages: list[dict[str, Any]]) -> None:
        self.messages = messages
        self.calls: list[dict[str, Any]] = []

    def filter_log_events(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"events": self.messages}


class _HandlerModule(Protocol):
    _logs_client: Any

    def lambda_handler(self, event: dict[str, Any], context: Any) -> dict[str, Any]: ...


@pytest.fixture
def handler(monkeypatch: pytest.MonkeyPatch) -> _HandlerModule:
    spec = importlib.util.spec_from_file_location("agent1_log_gateway", _HANDLER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("HELPDESK_AGENT_LOG_GROUP", "/aws/test/helpdesk")
    monkeypatch.setenv("AGENT1_LOG_UI_ALLOWED_ORIGINS", "https://console.example")
    return cast(_HandlerModule, module)


def _workflow_event(
    action: str,
    status: str,
    *,
    timestamp: str,
    details: dict[str, Any] | None = None,
    summary: str = "customer@example.com must never leak",
) -> dict[str, Any]:
    event = {
        "schema_version": "1.0",
        "event_type": "helpdesk.workflow.event",
        "event_id": (
            "8d3b5f4a-7a9a-44a6-b1d4-9cabc34e0001"
            if action == "step.finished"
            else "8d3b5f4a-7a9a-44a6-b1d4-9cabc34e0002"
        ),
        "run_id": _RUN_ID,
        "case_id": "case-0123456789abcdef",
        "trace_id": "a" * 32,
        "timestamp": timestamp,
        "stage": "triage",
        "actor_type": "MODEL_ASSISTED",
        "action": action,
        "status": status,
        "summary": summary,
        "details": details or {},
    }
    return {"message": f"2026-10-07 INFO helpdesk: agent_event={json.dumps(event)}"}


def _event(
    method: str,
    path: str,
    *,
    query: dict[str, str] | None = None,
) -> dict[str, Any]:
    headers = {"origin": "https://console.example"}
    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "headers": headers,
        "queryStringParameters": query or {},
    }


def _body(response: dict[str, Any]) -> dict[str, Any]:
    return json.loads(response["body"])


@pytest.mark.unit
def test_gateway_needs_no_ui_token_and_restricts_cors(
    handler: _HandlerModule,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("AGENT1_LOG_UI_TOKEN", raising=False)
    handler._logs_client = _FakeLogs([])
    response = handler.lambda_handler(_event("GET", "/api/runs"), None)
    assert response["statusCode"] == 200
    assert _body(response) == {"runs": [], "partial": False}
    assert response["headers"]["access-control-allow-origin"] == "https://console.example"
    assert response["headers"]["access-control-allow-headers"] == "content-type"

    forbidden = _event("GET", "/api/runs")
    forbidden["headers"]["origin"] = "https://attacker.example"
    response = handler.lambda_handler(forbidden, None)
    assert response["statusCode"] == 403
    assert "access-control-allow-origin" not in response["headers"]


@pytest.mark.unit
def test_run_list_and_detail_return_redacted_events(handler: _HandlerModule) -> None:
    logs = _FakeLogs(
        [
            _workflow_event(
                "step.finished",
                "COMPLETED",
                timestamp="2026-10-07T10:00:00+00:00",
                details={
                    "service": "jira",
                    "issue_type": "access",
                    "priority": "high",
                    "confidence": 0.82,
                    "customer_email": "customer@example.com",
                },
            ),
            _workflow_event(
                "run.finished",
                "COMPLETED",
                timestamp="2026-10-07T10:00:03+00:00",
                details={"terminal_outcome": "diagnosis_required"},
            ),
        ]
    )
    handler._logs_client = logs

    listed = handler.lambda_handler(_event("GET", "/api/runs"), None)
    assert listed["statusCode"] == 200
    run = _body(listed)["runs"][0]
    assert run["run_id"] == _RUN_ID
    assert run["status"] == "COMPLETED"
    assert run["terminal_outcome"] == "diagnosis_required"
    assert run["priority"] == "high"
    assert run["confidence"] == 0.82
    assert logs.calls[0]["logGroupName"] == "/aws/test/helpdesk"
    assert logs.calls[0]["filterPattern"] == '"agent_event="'

    detail = handler.lambda_handler(_event("GET", f"/api/runs/{_RUN_ID}"), None)
    assert detail["statusCode"] == 200
    serialized = json.dumps(_body(detail))
    assert "customer@example.com" not in serialized
    assert "must never leak" not in serialized
    events = _body(detail)["run"]["events"]
    assert events[0]["summary"] == "Triage completed"
    assert "customer_email" not in events[0]["details"]


@pytest.mark.unit
def test_gateway_validates_range_and_run_id(handler: _HandlerModule) -> None:
    invalid_range = handler.lambda_handler(
        _event("GET", "/api/runs", query={"since_hours": "25"}),
        None,
    )
    assert invalid_range["statusCode"] == 400
    assert _body(invalid_range) == {"error": "INVALID_SINCE"}

    invalid_run = handler.lambda_handler(_event("GET", "/api/runs/not-a-run"), None)
    assert invalid_run["statusCode"] == 400


@pytest.mark.unit
def test_missing_gateway_configuration_is_an_explicit_error(
    handler: _HandlerModule,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("HELPDESK_AGENT_LOG_GROUP")
    response = handler.lambda_handler(_event("GET", "/api/runs"), None)
    assert response["statusCode"] == 503
    assert _body(response) == {"error": "GATEWAY_NOT_CONFIGURED"}
