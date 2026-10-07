import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

describe("shared agent shell", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("selects Agent 3 by default and preserves its console", () => {
    render(<App />);

    expect(screen.getByRole("tab", { name: /^Agent 3$/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Runs" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recent runs" })).toBeVisible();
  });

  it.each(["Agent 1"])(`shows the operator workspace for %s without an application token`, async (label) => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ runs: [], partial: false }),
    } as Response);
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${label}$`) }));

    expect(screen.getByRole("tab", { name: new RegExp(`^${label}$`) })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "Recent runs" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Runs", hidden: true })).not.toBeVisible();
    const agent1Call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).startsWith("https://agent1.test"));
    expect(agent1Call).toBeDefined();
    expect(agent1Call?.[1]?.headers).toBeUndefined();
    expect(sessionStorage.length).toBe(0);
  });

  it("does not mount Agent 4, or call its receiver, until its tab is first opened", () => {
    render(<App />);
    const agent4Calls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/runs.json"));
    expect(agent4Calls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("tab", { name: /^Agent 4$/ }));
    expect(agent4Calls()).toHaveLength(1);
    expect(String(agent4Calls()[0][0])).toMatch(/\/runs\.json$/);
  });

  it("shows Agent 4's runs console in its own tab and keeps it mounted", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    } as Response);
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: /^Agent 4$/ }));
    expect(screen.getByRole("tab", { name: /^Agent 4$/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "Post-merge runs" })).toBeVisible();
    expect(screen.getByText(/No runs recorded yet/)).toBeInTheDocument();

    // stays mounted (state preserved) while another tab is selected
    fireEvent.click(screen.getByRole("tab", { name: /^Agent 3$/ }));
    expect(screen.getByRole("heading", { name: "Post-merge runs", hidden: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /^Agent 4$/ }));
    expect(screen.getByRole("heading", { name: "Post-merge runs" })).toBeVisible();
    expect(screen.getByText(/No runs recorded yet/)).toBeInTheDocument();
  });

  it("supports keyboard navigation across agent tabs", () => {
    render(<App />);
    const agent3 = screen.getByRole("tab", { name: /^Agent 3$/ });

    agent3.focus();
    fireEvent.keyDown(agent3, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /^Agent 4$/ })).toHaveFocus();
    expect(screen.getByRole("tab", { name: /^Agent 4$/ })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: /^Agent 4$/ }), { key: "Home" });
    expect(screen.getByRole("tab", { name: /^Agent 1$/ })).toHaveFocus();
  });

  it("keeps Agent 3 state mounted while another workspace is selected", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /^Agent$/ }));
    expect(screen.getByText("Tool and policy boundary")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: /^Agent 1$/ }));
    fireEvent.click(screen.getByRole("tab", { name: /^Agent 3$/ }));

    expect(screen.getByText("Tool and policy boundary")).toBeVisible();
    expect(screen.getByRole("tab", { name: /^Agent$/ })).toHaveAttribute("aria-selected", "true");
  });

  it("returns to the Runs list from the shared home action", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: "Manual Run" }));
    expect(screen.getByRole("heading", { name: "Manual remediation run" })).toBeVisible();

    fireEvent.click(screen.getByRole("link", { name: "AIOS Operations home" }));

    expect(screen.getByRole("tab", { name: "Runs" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Recent runs" })).toBeVisible();
  });

  it("does not mount Agent 2, or call its gateway, until its tab is first opened", () => {
    render(<App />);
    const agent2Calls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/api/cases"));
    expect(agent2Calls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("tab", { name: /^Agent 2$/ }));
    expect(agent2Calls()).toHaveLength(1);
    expect(String(agent2Calls()[0][0])).toMatch(/\/api\/cases\?since_hours=24$/);
  });

  it("shows Agent 2's logs in its own tab, with no token gate, and keeps Agent 3 untouched", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("tab", { name: /^Agent 2$/ }));

    expect(screen.getByRole("tab", { name: /^Agent 2$/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Agent 2 logs" })).toBeVisible();
    expect(screen.queryByLabelText("Access token")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Runs", hidden: true })).not.toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: /^Agent 3$/ }));
    expect(screen.getByRole("heading", { name: "Recent runs" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Agent 2 logs", hidden: true })).not.toBeVisible();
  });

  it("opens on Agent 2 for a case link, and leaves Agent 3 the default otherwise", () => {
    window.location.hash = "#/agent2/AH-39";
    const { unmount } = render(<App />);
    expect(screen.getByRole("tab", { name: /^Agent 2$/ })).toHaveAttribute("aria-selected", "true");
    unmount();

    window.location.hash = "#runs";
    render(<App />);
    expect(screen.getByRole("tab", { name: /^Agent 3$/ })).toHaveAttribute("aria-selected", "true");
    window.location.hash = "";
  });
});
