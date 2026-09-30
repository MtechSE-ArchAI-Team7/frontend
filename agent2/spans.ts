import type { SpanNode, Trace } from "./types";

// What a span is, by the names Agent 2 itself creates (docs/observability.md §1).
// Everything else is ADOT auto-instrumentation: `POST`, `chat claude-*`, `a2a.server.*`.
// On AH-39 that was ~1100 of ~1150 spans, so it is hidden by default.
export type SpanCategory = "root" | "node" | "tool" | "llm" | "agent3" | "jira" | "auto";

export const CATEGORY_LABELS: Record<Exclude<SpanCategory, "auto">, string> = {
  root: "investigation",
  node: "graph node",
  tool: "tool call",
  llm: "LLM call",
  agent3: "Agent 3 handoff",
  jira: "Jira write",
};

export function categorize(name: string): SpanCategory {
  if (name === "investigation") return "root";
  if (name.startsWith("node.")) return "node";
  if (name.startsWith("tool.")) return "tool";
  if (name === "llm.call") return "llm";
  if (name === "agent3.invoke") return "agent3";
  if (name.startsWith("jira.")) return "jira";
  return "auto";
}

export interface SpanRow {
  kind: "span";
  node: SpanNode;
  depth: number;
  category: SpanCategory;
}

/** A run of same-named leaf siblings shown as one row. node.act fires one classifier
 * `llm.call` per evidence item -- 100+ on AH-39 -- which buried the eight nodes that
 * make up the actual investigation. */
export interface GroupRow {
  kind: "group";
  key: string;
  name: string;
  nodes: SpanNode[];
  depth: number;
  category: SpanCategory;
  expanded: boolean;
  failed: number;
  start_ns: number;
  end_ns: number;
}

export type Row = SpanRow | GroupRow;

export const GROUP_MIN = 4;

/** Depth-first rows for the waterfall. A hidden span's children are promoted to its
 * depth rather than dropped: our `investigation` span sits under ADOT's `POST /`, and
 * hiding `POST /` must not hide the investigation. */
export function flatten(roots: SpanNode[], showAuto: boolean, expanded: ReadonlySet<string> = new Set()): Row[] {
  const shown = (node: SpanNode) => showAuto || categorize(node.name) !== "auto";
  const visible = (nodes: SpanNode[]): SpanNode[] =>
    nodes.flatMap((node) => (shown(node) ? [node] : visible(node.children)));

  const rows: Row[] = [];
  const emit = (siblings: SpanNode[], depth: number, parentKey: string) => {
    let i = 0;
    while (i < siblings.length) {
      const node = siblings[i];
      const kids = visible(node.children);
      let j = i + 1;
      if (kids.length === 0) {
        while (j < siblings.length && siblings[j].name === node.name && visible(siblings[j].children).length === 0) j++;
      }
      if (j - i >= GROUP_MIN) {
        const run = siblings.slice(i, j);
        const key = `${parentKey}/${node.name}/${node.span_id}`;
        const open = expanded.has(key);
        rows.push({
          kind: "group",
          key,
          name: node.name,
          nodes: run,
          depth,
          category: categorize(node.name),
          expanded: open,
          failed: run.filter(isError).length,
          start_ns: Math.min(...run.map((n) => n.start_ns)),
          end_ns: Math.max(...run.map((n) => n.end_ns)),
        });
        if (open) for (const n of run) rows.push({ kind: "span", node: n, depth: depth + 1, category: categorize(n.name) });
        i = j;
        continue;
      }
      rows.push({ kind: "span", node, depth, category: categorize(node.name) });
      emit(kids, depth + 1, node.span_id);
      i += 1;
    }
  };
  emit(visible(roots), 0, "");
  return rows;
}

export function countAuto(roots: SpanNode[]): number {
  let n = 0;
  const visit = (node: SpanNode) => {
    if (categorize(node.name) === "auto") n += 1;
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return n;
}

export interface Extent {
  start: number;
  end: number;
}

export function extent(roots: SpanNode[]): Extent | null {
  let start = Infinity;
  let end = -Infinity;
  const visit = (node: SpanNode) => {
    if (node.start_ns) start = Math.min(start, node.start_ns);
    if (node.end_ns) end = Math.max(end, node.end_ns);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return Number.isFinite(start) && end > start ? { start, end } : null;
}

/** Bar position as percentages of the trace's extent. */
export function bar(node: SpanNode, ext: Extent): { left: number; width: number } {
  const span = ext.end - ext.start;
  const left = ((node.start_ns - ext.start) / span) * 100;
  const width = ((Math.max(node.end_ns, node.start_ns) - node.start_ns) / span) * 100;
  return { left: clamp(left), width: clamp(width, 0, 100 - clamp(left)) };
}

function clamp(value: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, value));
}

export function findSpan(traces: Trace[], spanId: string): SpanNode | null {
  for (const trace of traces) {
    const stack = [...trace.roots];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.span_id === spanId) return node;
      stack.push(...node.children);
    }
  }
  return null;
}

export function isError(node: SpanNode): boolean {
  return node.status === "ERROR" || node.attributes.ok === false;
}
