import { useEffect } from "react";
import { clock, duration } from "../format";
import { categorize, isError } from "../spans";
import type { SpanNode } from "../types";
import { Status } from "./Status";

export function SpanDetail({ span, onClose }: { span: SpanNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const attributes = Object.entries(span.attributes).sort(([a], [b]) => a.localeCompare(b));
  return (
    <aside className="drawer" aria-label={`Span ${span.name}`}>
      <div className="drawer-head">
        <h3>{span.name}</h3>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close span detail">
          ✕
        </button>
      </div>
      <dl className="kv">
        <dt>Duration</dt>
        <dd>{duration(span.duration_ms)}</dd>
        <dt>Started</dt>
        <dd className="mono">{clock(span.start_ns ? new Date(span.start_ns / 1e6).toISOString() : null)}</dd>
        <dt>Status</dt>
        <dd>
          {isError(span) ? <Status tone="critical" label="Failed" /> : (span.status ?? "—")}
          {span.status_message && <div className="mono reason">{span.status_message}</div>}
        </dd>
        <dt>Kind</dt>
        <dd>{categorize(span.name) === "auto" ? "auto-instrumented" : "Agent 2"}</dd>
        <dt>Span id</dt>
        <dd className="mono">{span.span_id}</dd>
        <dt>Children</dt>
        <dd>{span.children.length}</dd>
      </dl>
      <h4>Attributes</h4>
      {attributes.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <dl className="kv">
          {attributes.map(([k, v]) => (
            <div key={k} className="kv-row">
              <dt className="mono">{k}</dt>
              <dd className="mono">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </aside>
  );
}
