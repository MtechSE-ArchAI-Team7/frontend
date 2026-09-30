import { useMemo, useState } from "react";
import { count, duration, usd } from "../format";
import { CATEGORY_LABELS, bar, countAuto, extent, flatten, isError, type GroupRow, type SpanRow } from "../spans";
import type { SpanNode, Trace } from "../types";

interface Props {
  traces: Trace[];
  selected: SpanNode | null;
  onSelect: (span: SpanNode) => void;
}

export function Waterfall({ traces, selected, onSelect }: Props) {
  const [index, setIndex] = useState(0);
  const [showAuto, setShowAuto] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const trace = traces[Math.min(index, traces.length - 1)];

  const rows = useMemo(() => (trace ? flatten(trace.roots, showAuto, expanded) : []), [trace, showAuto, expanded]);
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const ext = useMemo(() => (trace ? extent(trace.roots) : null), [trace]);
  const hidden = useMemo(() => (trace ? countAuto(trace.roots) : 0), [trace]);

  if (!trace) return <p className="muted">No spans were found for this case in the search window.</p>;

  return (
    <div className="waterfall">
      <div className="controls">
        {traces.length > 1 && (
          <label>
            <span>Trace</span>
            <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
              {traces.map((t, i) => (
                <option key={t.trace_id} value={i}>
                  {i + 1} of {traces.length} · {duration(t.duration_ms)} · {t.llm_calls} LLM calls
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} />
          Show auto-instrumented spans ({count(hidden)})
        </label>
        <span className="muted small trace-meta">
          {count(trace.span_count)} spans · {duration(trace.duration_ms)} · {usd(trace.cost_usd)}
        </span>
      </div>

      <ul className="legend" aria-label="Span kinds">
        {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
          <li key={key}>
            <span className={`swatch cat-${key}`} aria-hidden="true" />
            {label}
          </li>
        ))}
        {showAuto && (
          <li>
            <span className="swatch cat-auto" aria-hidden="true" />
            auto-instrumented
          </li>
        )}
      </ul>

      <div className="wf" role="table" aria-label={`Spans of trace ${trace.trace_id}`}>
        <div className="wf-row wf-axis" role="row" aria-hidden="true">
          <div className="wf-label" />
          <div className="wf-track">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <span key={f} className="wf-tick" style={{ left: `${f * 100}%` }}>
                {ext ? (f === 0 ? "0" : duration(((ext.end - ext.start) * f) / 1e6)) : ""}
              </span>
            ))}
          </div>
        </div>
        {rows.map((row) =>
          row.kind === "group" ? (
            <GroupRowView key={row.key} row={row} ext={ext} onToggle={() => toggle(row.key)} />
          ) : (
            <WaterfallRow
              key={row.node.span_id}
              row={row}
              ext={ext}
              selected={row.node.span_id === selected?.span_id}
              onSelect={onSelect}
            />
          ),
        )}
      </div>
    </div>
  );
}

function GroupRowView({ row, ext, onToggle }: { row: GroupRow; ext: ReturnType<typeof extent>; onToggle: () => void }) {
  const geometry = ext ? bar({ ...row.nodes[0], start_ns: row.start_ns, end_ns: row.end_ns }, ext) : { left: 0, width: 0 };
  const total = row.nodes.reduce((sum, n) => sum + (n.duration_ms ?? 0), 0);
  return (
    <button
      type="button"
      role="row"
      className="wf-row wf-group"
      aria-expanded={row.expanded}
      onClick={onToggle}
      title={`${row.nodes.length} × ${row.name}, ${duration(total)} in total${row.failed ? `, ${row.failed} failed` : ""}`}
    >
      <span className="wf-label" role="cell" style={{ paddingLeft: `${row.depth * 14 + 8}px` }}>
        <span className="wf-caret" aria-hidden="true">
          {row.expanded ? "▾" : "▸"}
        </span>
        <span className="wf-name">
          {row.name} × {row.nodes.length}
        </span>
        {row.failed > 0 && <span className="wf-failcount">✕ {row.failed} failed</span>}
      </span>
      <span className="wf-track" role="cell">
        <span
          className={`wf-bar wf-bar-group cat-${row.category}`}
          style={{ left: `${geometry.left}%`, width: `max(2px, ${geometry.width}%)` }}
        />
      </span>
    </button>
  );
}

function WaterfallRow({
  row,
  ext,
  selected,
  onSelect,
}: {
  row: SpanRow;
  ext: ReturnType<typeof extent>;
  selected: boolean;
  onSelect: (span: SpanNode) => void;
}) {
  const { node, depth, category } = row;
  const geometry = ext ? bar(node, ext) : { left: 0, width: 0 };
  const failed = isError(node);
  const attrs = node.attributes;
  const hint = [
    node.name,
    duration(node.duration_ms),
    typeof attrs.tokens_in === "number" ? `${attrs.tokens_in} → ${attrs.tokens_out} tokens` : null,
    typeof attrs.cost_usd === "number" ? usd(attrs.cost_usd) : null,
    typeof attrs.evidence_count === "number" ? `${attrs.evidence_count} evidence` : null,
    failed ? "failed" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      role="row"
      className={`wf-row${selected ? " selected" : ""}`}
      onClick={() => onSelect(node)}
      title={hint}
    >
      <span className="wf-label" role="cell" style={{ paddingLeft: `${depth * 14 + 8}px` }}>
        {failed && (
          <span className="wf-fail" aria-label="failed">
            ✕
          </span>
        )}
        <span className="wf-name">{node.name}</span>
        <span className="wf-dur">{duration(node.duration_ms)}</span>
      </span>
      <span className="wf-track" role="cell">
        <span
          className={`wf-bar cat-${category}${failed ? " failed" : ""}`}
          style={{ left: `${geometry.left}%`, width: `max(2px, ${geometry.width}%)` }}
        />
      </span>
    </button>
  );
}
