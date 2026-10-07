"""Seed the agent4 runs bucket with two fake runs for local verification.

Scratch tool (not part of the test suite): POSTs run.json / report.md /
evidence.json for two fake runs to s3://aios-eval-agent-runs and rebuilds
runs/index.json. Usage:

    .venv/Scripts/python.exe scripts/seed_agent4_runs.py [--empty]

Requires AWS credentials for account 734849394833 (reads AWS_* from the
environment; falls back to mcp-atlassian-agent/.env next to the repo).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import boto3
from botocore.config import Config

BUCKET = "aios-eval-agent-runs"
REGION = "ap-southeast-1"
_REPO = Path(__file__).resolve().parent.parent
_ENV_FALLBACK = _REPO.parent / "mcp-atlassian-agent" / ".env"


def _load_env_fallback() -> None:
    if _ENV_FALLBACK.is_file():
        for line in _ENV_FALLBACK.read_text().splitlines():
            if line.startswith(("AWS_ACCESS_KEY_ID=", "AWS_SECRET_ACCESS_KEY=")):
                key, _, value = line.partition("=")
                import os

                os.environ.setdefault(key, value.strip())


def _now_minus(minutes: int) -> str:
    return (datetime.now(UTC) - timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


def _run(run_id: str, case_id: str | None, draft: bool, status: str, overall: str,
         pr: dict | None, started: str, finished: str | None) -> dict:
    return {
        "run_id": run_id,
        "case_id": case_id,
        "remediation_draft": draft,
        "status": status,
        "started_at": started,
        "finished_at": finished,
        "overall": overall,
        "pr": pr,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--empty", action="store_true", help="delete the seeded runs and index")
    args = parser.parse_args()

    _load_env_fallback()
    s3 = boto3.client(
        "s3",
        region_name=REGION,
        config=Config(retries={"max_attempts": 3, "mode": "standard"}),
    )

    run_a = "e443cc936bdc"
    run_b = "f77a1c0d5e92"
    runs = [
        _run(
            run_a, "CASE-DEMO-02", True, "done", "PASS",
            {"number": 3, "title": "[AIOS CASE-DEMO-02] Correct the inventory sync"},
            _now_minus(120), _now_minus(108),
        ),
        _run(
            run_b, None, False, "failed", "FAIL",
            {"number": 4, "title": "chore: bump dependencies"},
            _now_minus(45), _now_minus(30),
        ),
    ]

    if args.empty:
        for run_id in (run_a, run_b):
            for key in (f"runs/{run_id}/run.json", f"runs/{run_id}/report.md", f"runs/{run_id}/evidence.json"):
                s3.delete_object(Bucket=BUCKET, Key=key)
        s3.delete_object(Bucket=BUCKET, Key="runs/index.json")
        print("Seeded runs removed.")
        return 0

    def put(key: str, body: str, content_type: str) -> None:
        s3.put_object(
            Bucket=BUCKET,
            Key=key,
            Body=body.encode("utf-8"),
            ContentType=content_type,
        )
        print(f"put s3://{BUCKET}/{key}")

    for index, run_id in enumerate((run_a, run_b)):
        summary = runs[index]
        verdicts = (
            {"e2e-tests": "PASS", "security": "PASS", "log-errors": "PASS"}
            if summary["overall"] == "PASS"
            else {"e2e-tests": "FAIL", "security": "PASS", "log-errors": "INCONCLUSIVE"}
        )
        ledger = {
            "run_id": run_id,
            "case_id": summary["case_id"],
            "remediation_draft": summary["remediation_draft"],
            "status": summary["status"],
            "started_at": summary["started_at"],
            "finished_at": summary["finished_at"],
            "events": [
                {"at": summary["started_at"], "stage": "A", "message": "webhook accepted", "details": {"pr": summary["pr"]["number"]}},
                {"at": summary["started_at"], "stage": "B", "message": "workspace prepared"},
                {"at": summary["started_at"], "stage": "E", "message": "gates graded", "details": {"verdicts": verdicts}},
                {"at": summary["finished_at"], "stage": "F", "message": "report delivered"},
            ],
            "artifacts": {
                "run.json": {"path": f"runs/{run_id}/run.json", "bytes": 1024},
                "report.md": {"path": f"runs/{run_id}/report.md", "bytes": 2048},
                "evidence.json": {"path": f"runs/{run_id}/evidence.json", "bytes": 4096},
            },
        }
        report = (
            f"# Post-merge verification — {run_id}\n\n"
            f"- PR: #{summary['pr']['number']} {summary['pr']['title']}\n"
            f"- Case: {summary['case_id'] or '—'}\n"
            f"- Overall: **{summary['overall']}**\n\n"
            "## Gate verdicts\n\n"
            + "\n".join(f"- {gate}: {verdict}" for gate, verdict in verdicts.items())
            + "\n"
        )
        put(f"runs/{run_id}/run.json", json.dumps(ledger, indent=2), "application/json")
        put(f"runs/{run_id}/report.md", report, "text/markdown")
        put(
            f"runs/{run_id}/evidence.json",
            json.dumps({"run_id": run_id, "verdicts": verdicts, "samples": ["demo evidence payload"]}, indent=2),
            "application/json",
        )

    put("runs/index.json", json.dumps(runs, indent=2), "application/json")
    print(f"Seeded {len(runs)} runs. The gateway caches index.json for 30s per warm container.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
