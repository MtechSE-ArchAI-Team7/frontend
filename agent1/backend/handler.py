"""Read-only gateway for structured Agent 1 workflow events in CloudWatch Logs."""

from __future__ import annotations

import json
import math
import os
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import unquote

import boto3
from botocore.exceptions import BotoCoreError, ClientError

_RUN_PATH = re.compile(r"^/api/runs/([^/]+)$")
_RUN_ID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_CASE_REFERENCE = re.compile(r"^case-[0-9a-f]{16}$")
_TRACE_ID = re.compile(r"^[0-9a-fA-F]{32}$")
_EVENT_ID = _RUN_ID
_EVENT_MARKER = "agent_event="
_MAX_EVENTS = 10_000
_ALLOWED_RANGES = {24, 72, 168, 336}
_SAFE_DETAILS = {
    "source",
    "current_step",
    "terminal_outcome",
    "ticket_id",
    "service",
    "issue_type",
    "priority",
    "confidence",
    "confidence_threshold",
    "missing_info_count",
    "clarification_round",
    "max_clarification_rounds",
    "decision",
    "reason_code",
    "faq_score",
    "faq_threshold",
    "faq_result_count",
    "history_entries",
    "failure_type",
    "operation_statuses",
    "browser_decision",
    "browser_status",
    "tool_statuses",
    "handoff_submitted",
    "diagnosis_task_id",
    "diagnosis_run_id",
}
_SAFE_WORD = re.compile(r"^[a-zA-Z0-9_.:-]{1,128}$")
_SAFE_TICKET = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}-[0-9]{1,12}$")
_logs_client: Any | None = None


def _response(
    status: int,
    body: dict[str, Any] | None,
    *,
    origin: str | None = None,
    allowed_origins: set[str] | None = None,
) -> dict[str, Any]:
    headers = {"content-type": "application/json"}
    if origin and allowed_origins and origin in allowed_origins:
        headers["access-control-allow-origin"] = origin
        headers["access-control-allow-methods"] = "GET, OPTIONS"
        headers["access-control-allow-headers"] = "content-type"
        headers["vary"] = "Origin"
    return {
        "statusCode": status,
        "headers": headers,
        "body": "" if body is None else json.dumps(body, separators=(",", ":")),
    }


def _origin(event: dict[str, Any]) -> str | None:
    headers = event.get("headers")
    if not isinstance(headers, dict):
        return None
    value = headers.get("origin", headers.get("Origin"))
    return value if isinstance(value, str) else None


def _allowed_origins() -> set[str]:
    return {
        value.strip().rstrip("/")
        for value in os.environ.get("AGENT1_LOG_UI_ALLOWED_ORIGINS", "").split(",")
        if value.strip()
    }


def _logs() -> Any:
    global _logs_client
    if _logs_client is None:
        _logs_client = boto3.client("logs", region_name=os.environ.get("AWS_REGION") or None)
    return _logs_client


def _safe_details(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    safe: dict[str, Any] = {}
    for key, item in value.items():
        if key not in _SAFE_DETAILS:
            continue
        if key in {"confidence", "confidence_threshold", "faq_score", "faq_threshold"}:
            if isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(item):
                lower, upper = (-1_000.0, 1_000.0) if key == "faq_score" else (0.0, 1.0)
                if lower <= item <= upper:
                    safe[key] = float(item)
        elif key in {
            "missing_info_count",
            "clarification_round",
            "max_clarification_rounds",
            "faq_result_count",
            "history_entries",
        }:
            if isinstance(item, int) and not isinstance(item, bool) and item >= 0:
                safe[key] = min(item, 100_000)
        elif key == "ticket_id":
            if isinstance(item, str) and _SAFE_TICKET.fullmatch(item):
                safe[key] = item
        elif key == "source":
            if item in {"email", "chat", "a2a", "unknown"}:
                safe[key] = item
        elif key == "handoff_submitted":
            if isinstance(item, bool):
                safe[key] = item
        elif key in {"operation_statuses", "tool_statuses"} and isinstance(item, list):
            entries = [
                entry[:132]
                for entry in item[:32]
                if isinstance(entry, str) and _SAFE_WORD.fullmatch(entry)
            ]
            if entries:
                safe[key] = entries
        elif isinstance(item, str) and _SAFE_WORD.fullmatch(item):
            safe[key] = item
    return safe


def _parse_event(message: Any) -> dict[str, Any] | None:
    if not isinstance(message, str) or _EVENT_MARKER not in message:
        return None
    encoded = message.split(_EVENT_MARKER, 1)[1]
    try:
        value = json.loads(encoded)
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict):
        return None
    required = (
        "schema_version",
        "event_type",
        "event_id",
        "run_id",
        "case_id",
        "timestamp",
        "stage",
        "actor_type",
        "action",
        "status",
        "summary",
    )
    if any(not isinstance(value.get(key), str) for key in required):
        return None
    if value["schema_version"] != "1.0" or value["event_type"] != "helpdesk.workflow.event":
        return None
    if not _RUN_ID.fullmatch(value["run_id"]) or not _CASE_REFERENCE.fullmatch(value["case_id"]):
        return None
    if not _EVENT_ID.fullmatch(value["event_id"]):
        return None
    if value["actor_type"] not in {"DETERMINISTIC", "MODEL_ASSISTED", "TOOL", "HUMAN"}:
        return None
    if value["action"] not in {"run.started", "run.finished", "step.started", "step.finished", "gate.decision"}:
        return None
    if value["status"] not in {"STARTED", "COMPLETED", "FAILED", "SKIPPED", "DECIDED"}:
        return None
    if not all(_SAFE_WORD.fullmatch(value[key]) for key in ("stage",)):
        return None
    trace_id = value.get("trace_id")
    if trace_id is not None and (not isinstance(trace_id, str) or not _TRACE_ID.fullmatch(trace_id)):
        trace_id = None
    try:
        datetime.fromisoformat(value["timestamp"].replace("Z", "+00:00"))
    except ValueError:
        return None
    event = {
        "schema_version": "1.0",
        "event_type": "helpdesk.workflow.event",
        "event_id": value["event_id"][:64],
        "run_id": value["run_id"],
        "case_id": value["case_id"],
        "trace_id": trace_id,
        "timestamp": value["timestamp"],
        "stage": value["stage"],
        "actor_type": value["actor_type"],
        "action": value["action"],
        "status": value["status"],
        "details": _safe_details(value.get("details")),
    }
    details = event["details"]
    if event["action"] == "gate.decision":
        decision = details.get("decision", "unknown").replace("_", " ")
        event["summary"] = f"{event['stage'].replace('_', ' ').title()} selected {decision}"
    elif event["action"] == "run.started":
        event["summary"] = "Helpdesk run started"
    elif event["action"] == "run.finished":
        event["summary"] = "Helpdesk run finished"
    else:
        event["summary"] = f"{event['stage'].replace('_', ' ').title()} {event['status'].lower()}"
    duration = value.get("duration_ms")
    if isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0:
        event["duration_ms"] = min(duration, 86_400_000)
    return event


def _read_events(log_group: str, start_ms: int, end_ms: int) -> tuple[list[dict[str, Any]], bool]:
    events: list[dict[str, Any]] = []
    next_token: str | None = None
    while len(events) < _MAX_EVENTS:
        kwargs: dict[str, Any] = {
            "logGroupName": log_group,
            "startTime": start_ms,
            "endTime": end_ms,
            "filterPattern": f'"{_EVENT_MARKER}"',
            "limit": min(1_000, _MAX_EVENTS - len(events)),
        }
        if next_token:
            kwargs["nextToken"] = next_token
        result = _logs().filter_log_events(**kwargs)
        for log_event in result.get("events", []):
            parsed = _parse_event(log_event.get("message"))
            if parsed is not None:
                events.append(parsed)
        new_token = result.get("nextToken")
        if not new_token or new_token == next_token:
            return events, False
        next_token = new_token
    return events, bool(next_token)


def _run_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(events, key=lambda item: item["timestamp"])
    first = ordered[0]
    latest = ordered[-1]
    triage = next(
        (
            event["details"]
            for event in reversed(ordered)
            if event["stage"] == "triage" and event["action"] == "step.finished"
        ),
        {},
    )
    outcome_event = next(
        (event for event in reversed(ordered) if event["action"] == "run.finished"),
        None,
    )
    outcome = (outcome_event or {}).get("details", {}).get("terminal_outcome")
    status = "RUNNING" if outcome_event is None else (
        "FAILED" if outcome_event["status"] == "FAILED" else "COMPLETED"
    )
    details = latest.get("details", {})
    state_details = next(
        (event["details"] for event in reversed(ordered) if "current_step" in event["details"]),
        {},
    )
    return {
        "run_id": first["run_id"],
        "case_id": first["case_id"],
        "first_seen": first["timestamp"],
        "last_seen": latest["timestamp"],
        "status": status,
        "current_step": details.get("current_step", state_details.get("current_step", outcome or latest["stage"])),
        "terminal_outcome": outcome,
        "ticket_id": details.get("ticket_id")
        or next(
            (event["details"]["ticket_id"] for event in reversed(ordered) if "ticket_id" in event["details"]),
            None,
        ),
        "trace_id": next((event["trace_id"] for event in reversed(ordered) if event["trace_id"]), None),
        "service": triage.get("service"),
        "issue_type": triage.get("issue_type"),
        "priority": triage.get("priority"),
        "confidence": triage.get("confidence"),
        "event_count": len(ordered),
    }


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    del context
    method = str(event.get("requestContext", {}).get("http", {}).get("method", "GET")).upper()
    path = unquote(str(event.get("rawPath", "/")))
    origin = _origin(event)
    allowed_origins = _allowed_origins()
    if method == "OPTIONS":
        return _response(204, None, origin=origin, allowed_origins=allowed_origins)
    if origin and allowed_origins and origin.rstrip("/") not in allowed_origins:
        return _response(403, {"error": "ORIGIN_NOT_ALLOWED"}, origin=origin, allowed_origins=allowed_origins)

    log_group = os.environ.get("HELPDESK_AGENT_LOG_GROUP", "")
    if not log_group:
        return _response(503, {"error": "GATEWAY_NOT_CONFIGURED"}, origin=origin, allowed_origins=allowed_origins)

    query = event.get("queryStringParameters")
    query = query if isinstance(query, dict) else {}
    try:
        hours = int(query.get("since_hours", "24"))
    except (TypeError, ValueError):
        return _response(400, {"error": "INVALID_SINCE"}, origin=origin, allowed_origins=allowed_origins)
    if hours not in _ALLOWED_RANGES:
        return _response(400, {"error": "INVALID_SINCE"}, origin=origin, allowed_origins=allowed_origins)

    run_match = _RUN_PATH.fullmatch(path)
    if path != "/api/runs" and run_match is None:
        return _response(404, {"error": "NOT_FOUND"}, origin=origin, allowed_origins=allowed_origins)
    if path != "/api/runs" and method != "GET":
        return _response(405, {"error": "METHOD_NOT_ALLOWED"}, origin=origin, allowed_origins=allowed_origins)
    if path == "/api/runs" and method != "GET":
        return _response(405, {"error": "METHOD_NOT_ALLOWED"}, origin=origin, allowed_origins=allowed_origins)
    if run_match and not _RUN_ID.fullmatch(run_match.group(1)):
        return _response(400, {"error": "INVALID_RUN_ID"}, origin=origin, allowed_origins=allowed_origins)

    now = datetime.now(UTC)
    try:
        events, partial = _read_events(
            log_group,
            int((now - timedelta(hours=hours)).timestamp() * 1000),
            int(now.timestamp() * 1000),
        )
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"ResourceNotFoundException"}:
            return _response(503, {"error": "LOG_GROUP_NOT_FOUND"}, origin=origin, allowed_origins=allowed_origins)
        if code in {"AccessDeniedException", "UnrecognizedClientException"}:
            return _response(502, {"error": "CLOUDWATCH_ACCESS_DENIED"}, origin=origin, allowed_origins=allowed_origins)
        if code in {"ThrottlingException", "ServiceUnavailableException"}:
            return _response(503, {"error": "CLOUDWATCH_RATE_LIMITED"}, origin=origin, allowed_origins=allowed_origins)
        return _response(502, {"error": "UPSTREAM_FAILED"}, origin=origin, allowed_origins=allowed_origins)
    except BotoCoreError:
        return _response(502, {"error": "UPSTREAM_FAILED"}, origin=origin, allowed_origins=allowed_origins)

    runs: dict[str, list[dict[str, Any]]] = {}
    for item in events:
        runs.setdefault(item["run_id"], []).append(item)
    if run_match:
        run_id = run_match.group(1)
        selected = runs.get(run_id)
        if not selected:
            return _response(404, {"error": "RUN_NOT_FOUND"}, origin=origin, allowed_origins=allowed_origins)
        return _response(
            200,
            {
                "run": {**_run_summary(selected), "events": sorted(selected, key=lambda item: item["timestamp"])},
                "partial": partial,
            },
            origin=origin,
            allowed_origins=allowed_origins,
        )

    summaries = sorted(
        (_run_summary(items) for items in runs.values()),
        key=lambda item: item["last_seen"],
        reverse=True,
    )
    return _response(200, {"runs": summaries, "partial": partial}, origin=origin, allowed_origins=allowed_origins)
