import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

describe("shared agent shell", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("selects Agent 3 by default and preserves its console", () => {
    render(<App />);

    expect(screen.getByRole("tab", { name: /^Agent 3$/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Run Console" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Remediation console" })).toBeVisible();
  });

  it.each(["Agent 1", "Agent 2", "Agent 4"])("shows a blank workspace for %s", (label) => {
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${label}$`) }));

    expect(screen.getByRole("tab", { name: new RegExp(`^${label}$`) })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toBeEmptyDOMElement();
    expect(screen.getByRole("tab", { name: "Run Console", hidden: true })).not.toBeVisible();
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
});
