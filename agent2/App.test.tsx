import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { setToken } from "./api";
import type { CaseView } from "./types";

const CASE: CaseView = {
  case_id: "AH-39",
  logs: [
    { event: "task_completed", level: "info", timestamp: "2026-09-23T06:12:24.48Z", task_id: "t1", status: "diagnosed" },
    {
      event: "delivery_incomplete",
      level: "warning",
      timestamp: "2026-09-23T06:12:24.49Z",
      task_id: "t1",
      reason: "requires_human_review is true",
    },
  ],
  requests: [
    {
      task_id: "t1",
      kind: "investigation",
      first_seen: "2026-09-23T06:12:24.48Z",
      last_seen: "2026-09-23T06:12:24.49Z",
      outcome: { event: "task_completed", status: "diagnosed" },
      delivery: { event: "delivery_incomplete", reason: "requires_human_review is true" },
      jira: null,
      warnings: 1,
    },
  ],
  traces: [
    {
      trace_id: "a".repeat(32),
      span_count: 3,
      duration_ms: 9000,
      llm_calls: 1,
      tokens_in: 1200,
      tokens_out: 300,
      cost_usd: 0.0081,
      roots: [
        {
          span_id: "r1",
          parent_span_id: null,
          name: "investigation",
          start_ns: 1,
          end_ns: 9_000_000_001,
          duration_ms: 9000,
          status: "UNSET",
          attributes: { case_id: "AH-39" },
          children: [
            {
              span_id: "l1",
              parent_span_id: "r1",
              name: "llm.call",
              start_ns: 10,
              end_ns: 4_000_000_010,
              duration_ms: 4000,
              status: "UNSET",
              attributes: { model: "claude-sonnet-5", tokens_in: 1200, tokens_out: 300, cost_usd: 0.0081 },
              children: [],
            },
            {
              span_id: "c1",
              parent_span_id: "r1",
              name: "chat claude-sonnet-5",
              start_ns: 20,
              end_ns: 3_000_000_000,
              duration_ms: 3000,
              status: "UNSET",
              attributes: {},
              children: [],
            },
          ],
        },
      ],
    },
  ],
  audit: { error: "AUDIT_NOT_CONFIGURED" },
  timeline: [
    {
      ts: "2026-09-23T06:12:24.480000+00:00",
      source: "log",
      kind: "task_completed",
      tag: "info",
      detail: { status: "diagnosed", description: "<img src=x onerror=alert(1)>" },
    },
  ],
};

type Route = (url: string, init?: RequestInit) => { status: number; body: unknown };

function mockFetch(route: Route) {
  const calls: { url: string; auth: string | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers.authorization });
      const { status, body } = route(url, init);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

beforeEach(() => {
  setToken(null);
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("asks for the token first and sends it as a bearer header", async () => {
  const calls = mockFetch(() => ({ status: 200, body: { cases: [] } }));
  render(<App active />);

  expect(calls).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "tok-123" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  await screen.findByText(/No case finished/);
  expect(calls[0]).toEqual({ url: "/api/cases?since_hours=24", auth: "Bearer tok-123" });
});

test("a rejected token sends the user back to the gate with a reason", async () => {
  setToken("stale");
  mockFetch(() => ({ status: 401, body: { error: "UNAUTHORIZED" } }));
  render(<App active />);

  expect(await screen.findByRole("alert")).toHaveTextContent("The token was not accepted.");
  expect(screen.getByLabelText("Access token")).toBeInTheDocument();
});

test("opening a case shows requests, totals, and our spans without the auto-instrumented ones", async () => {
  setToken("tok");
  mockFetch((url) =>
    url.startsWith("/api/cases/")
      ? { status: 200, body: CASE }
      : {
          status: 200,
          body: {
            cases: [
              {
                case_id: "AH-39",
                outcome: "approval_processed",
                first_seen: "2026-09-23T06:12:24Z",
                last_seen: "2026-09-23T15:31:43Z",
                requests: 5,
              },
            ],
          },
        },
  );
  render(<App active />);

  fireEvent.click(await screen.findByRole("button", { name: /AH-39/ }));
  expect(await screen.findByRole("heading", { name: "AH-39" })).toBeInTheDocument();

  const requests = screen.getByRole("table", { name: /Requests/ });
  expect(within(requests).getByText("Completed")).toBeInTheDocument();
  expect(within(requests).getByText("requires_human_review is true")).toBeInTheDocument();
  expect(screen.getByText("$0.0081")).toBeInTheDocument();

  expect(screen.getByText("llm.call")).toBeInTheDocument();
  expect(screen.queryByText("chat claude-sonnet-5")).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(/Show auto-instrumented spans \(1\)/));
  expect(screen.getByText("chat claude-sonnet-5")).toBeInTheDocument();

  fireEvent.click(screen.getByText("llm.call"));
  const drawer = screen.getByRole("complementary", { name: "Span llm.call" });
  expect(within(drawer).getByText("claude-sonnet-5")).toBeInTheDocument();
  expect(window.location.hash).toBe("#/agent2/AH-39");
});

test("audit that is not connected says so instead of failing the page", async () => {
  setToken("tok");
  window.location.hash = "#/agent2/AH-39";
  mockFetch((url) => (url.startsWith("/api/cases/") ? { status: 200, body: CASE } : { status: 200, body: { cases: [] } }));
  render(<App active />);

  fireEvent.click(await screen.findByRole("tab", { name: /Audit/ }));
  expect(screen.getByText(/Audit is not connected/)).toBeInTheDocument();
});

test("record content is rendered as text, never as markup", async () => {
  setToken("tok");
  window.location.hash = "#/agent2/AH-39";
  mockFetch((url) => (url.startsWith("/api/cases/") ? { status: 200, body: CASE } : { status: 200, body: { cases: [] } }));
  const { container } = render(<App active />);

  fireEvent.click(await screen.findByRole("tab", { name: /Timeline/ }));
  fireEvent.click(screen.getByRole("button", { name: "task_completed" }));
  expect(container.querySelector("img")).toBeNull();
  // Both the summary cell and the opened JSON show it -- as text.
  expect(screen.getAllByText(/onerror=alert/)).toHaveLength(2);
});

test("another agent's hash link does not change the selected case", async () => {
  mockFetch((url) =>
    url.startsWith("/api/cases?") ? { status: 200, body: { cases: [] } } : { status: 200, body: CASE },
  );
  setToken("tok");
  window.location.hash = "#/agent2/AH-39";
  render(<App active />);
  await screen.findByRole("heading", { name: "AH-39" });

  window.location.hash = "#runs";
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(screen.getByRole("heading", { name: "AH-39" })).toBeInTheDocument();
});

test("the API base is configurable and a trailing slash is ignored", async () => {
  vi.stubEnv("VITE_AGENT2_API", "https://agent2.example.test/");
  vi.resetModules();
  const api = await import("./api");
  const calls = mockFetch(() => ({ status: 200, body: { cases: [] } }));
  api.setToken("tok");

  await api.listCases(24);

  expect(calls[0].url).toBe("https://agent2.example.test/api/cases?since_hours=24");
  vi.unstubAllEnvs();
});

