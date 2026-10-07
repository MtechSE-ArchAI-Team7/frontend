import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Agent1App from "./App";

const run = {
  run_id: "2db1f13e-7351-4a1f-a4c6-630646366d52",
  case_id: "case-0123456789abcdef",
  first_seen: "2026-10-07T10:00:00+00:00",
  last_seen: "2026-10-07T10:00:03+00:00",
  status: "COMPLETED",
  current_step: "awaiting_clarification",
  terminal_outcome: "awaiting_clarification",
  ticket_id: "HELP-123",
  trace_id: "a".repeat(32),
  service: "jira",
  issue_type: "access",
  priority: "high",
  confidence: 0.42,
  event_count: 4,
  events: [
    {
      schema_version: "1.0",
      event_type: "helpdesk.workflow.event",
      event_id: "event-start",
      run_id: "2db1f13e-7351-4a1f-a4c6-630646366d52",
      case_id: "case-0123456789abcdef",
      trace_id: "a".repeat(32),
      timestamp: "2026-10-07T10:00:00+00:00",
      stage: "intake",
      actor_type: "DETERMINISTIC",
      action: "run.started",
      status: "STARTED",
      summary: "Helpdesk run started",
      details: { source: "email" },
    },
    {
      schema_version: "1.0",
      event_type: "helpdesk.workflow.event",
      event_id: "event-triage-decision",
      run_id: "2db1f13e-7351-4a1f-a4c6-630646366d52",
      case_id: "case-0123456789abcdef",
      trace_id: "a".repeat(32),
      timestamp: "2026-10-07T10:00:01+00:00",
      stage: "clarification_gate",
      actor_type: "DETERMINISTIC",
      action: "gate.decision",
      status: "DECIDED",
      summary: "Clarification Gate selected clarify",
      details: {
        decision: "clarify",
        reason_code: "confidence_low_or_information_missing",
        confidence: 0.42,
        confidence_threshold: 0.6,
        missing_info_count: 1,
      },
    },
    {
      schema_version: "1.0",
      event_type: "helpdesk.workflow.event",
      event_id: "event-finish",
      run_id: "2db1f13e-7351-4a1f-a4c6-630646366d52",
      case_id: "case-0123456789abcdef",
      trace_id: "a".repeat(32),
      timestamp: "2026-10-07T10:00:03+00:00",
      stage: "intake",
      actor_type: "DETERMINISTIC",
      action: "run.finished",
      status: "COMPLETED",
      summary: "Helpdesk run finished",
      details: { terminal_outcome: "awaiting_clarification" },
    },
  ],
};

function jsonResponse(value: unknown) {
  return { ok: true, status: 200, json: async () => value };
}

describe("Agent 1 operator console", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.location.hash = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes("/api/runs/2db1f13e")
        ? jsonResponse({ run, partial: false })
        : jsonResponse({ runs: [run], partial: false });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("gates run visibility behind a session-only token", async () => {
    render(<Agent1App active />);
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "operator-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Open operator view" }));

    expect(await screen.findByRole("heading", { name: "Recent runs" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /HELP-123/ }));
    expect(await screen.findByRole("heading", { name: "Why the workflow routed this way" })).toBeInTheDocument();
    expect(sessionStorage.getItem("agent1-log-ui-token")).toBe("operator-token");
  });

  it("shows the recorded gate, threshold, and explicit confidence caveat", async () => {
    sessionStorage.setItem("agent1-log-ui-token", "operator-token");
    render(<Agent1App active />);

    fireEvent.click(await screen.findByRole("button", { name: /HELP-123/ }));
    expect((await screen.findAllByText("Clarification Gate selected clarify")).length).toBeGreaterThan(0);
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("Estimate, not calibrated correctness")).toBeInTheDocument();
    const decisionSection = screen.getByRole("heading", { name: "Why the workflow routed this way" }).closest("section");
    expect(decisionSection).not.toBeNull();
    if (!decisionSection) throw new Error("Decision panel is missing");
    expect(within(decisionSection).getByText("Confidence Threshold")).toBeInTheDocument();
    expect(within(decisionSection).getByText("0.6")).toBeInTheDocument();
    expect(screen.getByText(/chain-of-thought.*intentionally not shown/)).toBeInTheDocument();
  });

  it("opens a run from an Agent 1 deep link", async () => {
    sessionStorage.setItem("agent1-log-ui-token", "operator-token");
    window.location.hash = "#/agent1/2db1f13e-7351-4a1f-a4c6-630646366d52";
    render(<Agent1App active />);

    await waitFor(() => expect(screen.getAllByRole("heading", { name: "HELP-123" }).length).toBeGreaterThan(0));
    expect(screen.getByText("Workflow activity")).toBeInTheDocument();
  });
});
