import { expect, test } from "vitest";
import { bar, categorize, countAuto, extent, findSpan, flatten } from "./spans";
import type { SpanNode } from "./types";

function node(name: string, start: number, end: number, children: SpanNode[] = [], id = name): SpanNode {
  return {
    span_id: id,
    parent_span_id: null,
    name,
    start_ns: start,
    end_ns: end,
    duration_ms: (end - start) / 1e6,
    status: "UNSET",
    attributes: {},
    children,
  };
}

// Real shape: ADOT's `POST /` wraps a2a spans, which wrap our investigation.
// Times start at 100: a zero timestamp means "missing" to extent().
const tree = [
  node("POST /", 100, 200, [
    node("a2a.server.routes.jsonrpc_dispatcher.JsonRpcDispatcher.handle_requests", 101, 199, [
      node("investigation", 102, 190, [
        node("node.plan", 103, 140, [node("llm.call", 104, 139), node("chat claude-sonnet-5", 105, 138)]),
        node("tool.logs.search", 141, 150),
      ]),
    ]),
  ]),
  node("agent3.invoke", 191, 195),
];

test("categorizes by the names Agent 2 creates, everything else is auto", () => {
  expect(categorize("investigation")).toBe("root");
  expect(categorize("node.decide")).toBe("node");
  expect(categorize("tool.retrieval.runbooks")).toBe("tool");
  expect(categorize("llm.call")).toBe("llm");
  expect(categorize("agent3.invoke")).toBe("agent3");
  expect(categorize("jira.write_back")).toBe("jira");
  expect(categorize("chat claude-haiku-4-5-20251001")).toBe("auto");
  expect(categorize("POST")).toBe("auto");
});

test("hiding auto spans promotes their children instead of dropping them", () => {
  const rows = flatten(tree, false);
  expect(rows.map((r) => [r.kind === "span" ? r.node.name : r.name, r.depth])).toEqual([
    ["investigation", 0],
    ["node.plan", 1],
    ["llm.call", 2],
    ["tool.logs.search", 1],
    ["agent3.invoke", 0],
  ]);
});

test("showing auto spans keeps the real depth", () => {
  const rows = flatten(tree, true);
  expect(rows.find((r) => r.kind === "span" && r.node.name === "investigation")?.depth).toBe(2);
  expect(rows).toHaveLength(8);
  expect(countAuto(tree)).toBe(3);
});

test("bars are placed as percentages of the whole trace", () => {
  const ext = extent(tree)!;
  expect(ext).toEqual({ start: 100, end: 200 });
  expect(bar(node("x", 125, 175), ext)).toEqual({ left: 25, width: 50 });
  // A span running past the extent never draws outside the track.
  expect(bar(node("x", 190, 250), ext)).toEqual({ left: 90, width: 10 });
});

test("finds a span anywhere in any trace", () => {
  const trace = { trace_id: "t", span_count: 0, duration_ms: 0, llm_calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  expect(findSpan([{ ...trace, roots: tree }], "tool.logs.search")?.start_ns).toBe(141);
  expect(findSpan([{ ...trace, roots: tree }], "nope")).toBeNull();
});

test("an approval that did not reach Agent 3 is not shown as a success", async () => {
  const { outcome } = await import("./format");
  expect(outcome("approval_processed", "False")).toEqual(["serious", "Approved, not delivered"]);
  expect(outcome("approval_processed", "True")[0]).toBe("good");
  expect(outcome(null)).toEqual(["neutral", "No outcome logged"]);
});


test("a run of same-named leaf siblings collapses into one expandable group", () => {
  const calls = Array.from({ length: 6 }, (_, i) => node("llm.call", 110 + i, 111 + i, [], `c${i}`));
  calls[2].status = "ERROR";
  const act = node("node.act", 105, 130, [node("tool.logs.search", 106, 108), ...calls]);
  const roots = [node("investigation", 100, 200, [act])];

  const collapsed = flatten(roots, false);
  expect(collapsed.map((r) => (r.kind === "group" ? `group ${r.name} x${r.nodes.length}` : r.node.name))).toEqual([
    "investigation",
    "node.act",
    "tool.logs.search",
    "group llm.call x6",
  ]);
  const group = collapsed[3];
  if (group.kind !== "group") throw new Error("expected a group");
  expect(group.failed).toBe(1);
  expect([group.start_ns, group.end_ns]).toEqual([110, 116]);

  const open = flatten(roots, false, new Set([group.key]));
  expect(open).toHaveLength(4 + 6);
  expect(open[4]).toMatchObject({ kind: "span", depth: 3 });
});

test("durations never read as 60 seconds", async () => {
  const { duration } = await import("./format");
  expect(duration(179_900)).toBe("3 min 0 s");
  expect(duration(59_990)).toBe("1 min 0 s");
  expect(duration(0)).toBe("0");
  expect(duration(7280)).toBe("7.28 s");
});
