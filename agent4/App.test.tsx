import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const RUN_ID = "e443cc936bdc";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function textResponse(body: string, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as Response;
}

function runSummary(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    case_id: "CASE-DEMO-02",
    remediation_draft: true,
    status: "done",
    started_at: "2026-10-01T10:00:00+00:00",
    finished_at: "2026-10-01T10:12:00+00:00",
    overall: "PASS",
    pr: { number: 3, title: "[AIOS CASE-DEMO-02] Correct the inventory sync" },
    ...overrides,
  };
}

function ledgerFixture() {
  return {
    run_id: RUN_ID,
    case_id: "CASE-DEMO-02",
    remediation_draft: true,
    status: "done",
    started_at: "2026-10-01T10:00:00+00:00",
    finished_at: "2026-10-01T10:12:00+00:00",
    events: [
      { at: "2026-10-01T10:02:00+00:00", stage: "A", message: "evidence pack built", details: { files: 2 } },
      {
        at: "2026-10-01T10:10:00+00:00",
        stage: "E",
        message: "gates graded",
        details: { verdicts: { "e2e-tests": "PASS", security: "PASS", "log-errors": "INCONCLUSIVE" } },
      },
    ],
    artifacts: {
      "report.md": { path: `runs/${RUN_ID}/report.md`, bytes: 4096 },
      "run.json": { path: `runs/${RUN_ID}/run.json`, bytes: 2048 },
      "junit.xml": { path: `runs/${RUN_ID}/junit.xml`, bytes: 8192 },
    },
  };
}

describe("Agent 4 post-merge runs console", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists runs from the receiver with verdict chips and case badges", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        runSummary(),
        runSummary({
          run_id: "aaaaaaaaaaaa",
          case_id: null,
          remediation_draft: false,
          status: "failed",
          overall: "FAIL",
          pr: null,
          started_at: "2026-09-28T19:54:25+00:00",
        }),
      ]),
    );
    render(<App />);

    expect(await screen.findByText("Post-merge runs")).toBeVisible();
    expect(screen.getByText("2 runs")).toBeInTheDocument();
    // newest-first: the CASE-DEMO-02 run row
    expect(screen.getByText("CASE-DEMO-02")).toBeInTheDocument();
    expect(screen.getByText("remediation draft")).toBeInTheDocument();
    expect(screen.getByText("#3")).toBeInTheDocument();
    // verdict chips: PASS green, FAIL red, PENDING for no-verdict runs
    expect(screen.getAllByText("PASS").some((chip) => chip.classList.contains("success"))).toBe(true);
    expect(screen.getAllByText("FAIL").some((chip) => chip.classList.contains("error"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/runs.json", expect.anything());
  });

  it("shows the empty state when the receiver has no runs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    render(<App />);

    expect(await screen.findByText(/No runs recorded yet/)).toBeInTheDocument();
  });

  it("shows a readable error state when the receiver is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    render(<App />);

    expect(await screen.findByText("Receiver unreachable")).toBeVisible();
    expect(screen.getByText(/receiver could not be reached/i)).toBeInTheDocument();
  });

  it("opens a run detail with verdict table, artifacts, and report", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([runSummary()]))
      .mockResolvedValueOnce(jsonResponse(ledgerFixture()))
      .mockResolvedValueOnce(textResponse("# Post-merge assessment\n\nAll gates passed."));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    expect(await screen.findByRole("heading", { name: "Post-merge run" })).toBeVisible();
    // verdict table rows from the LAST gates-graded event
    expect(screen.getByText("e2e-tests")).toBeInTheDocument();
    expect(screen.getByText("security")).toBeInTheDocument();
    expect(screen.getByText("log-errors")).toBeInTheDocument();
    expect(screen.getAllByText("INCONCLUSIVE").some((chip) => chip.classList.contains("warning"))).toBe(true);
    // artifact links via the receiver artifact route
    const reportLink = screen.getByRole("link", { name: "report.md ↗" });
    expect(reportLink).toHaveAttribute("href", `/runs/${RUN_ID}/report.md`);
    expect(screen.getByRole("link", { name: "junit.xml ↗" })).toHaveAttribute(
      "href",
      `/runs/${RUN_ID}/junit.xml`,
    );
    // report body rendered as pre-formatted text
    expect(await screen.findByText(/All gates passed/)).toBeInTheDocument();
    // back to the list
    fireEvent.click(screen.getByRole("button", { name: "Back to runs" }));
    expect(await screen.findByText("Post-merge runs")).toBeVisible();
  });

  it("treats a missing report.md as not-yet-written, not an error", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([runSummary({ status: "running", overall: null, finished_at: null })]),
      )
      .mockResolvedValueOnce(jsonResponse({ ...ledgerFixture(), artifacts: {} }))
      .mockResolvedValueOnce(textResponse("not found", 404));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    expect(await screen.findByText(/has not reached Stage F/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/No artifacts recorded/)).toBeInTheDocument();
    expect(screen.getByText(/No gates graded yet|e2e-tests/)).toBeInTheDocument();
  });

  it("shows the ledger error state when run.json cannot be fetched", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([runSummary()]))
      .mockResolvedValueOnce(jsonResponse({ error: "nope" }, 500));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Run detail failed");
    expect(screen.getByText("Ledger unavailable.")).toBeInTheDocument();
  });
});
