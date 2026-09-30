import { useMemo, useState } from "react";
import { clock, duration } from "../format";
import { categorize } from "../spans";
import type { Source, TimelineEntry } from "../types";
import { JsonBlock } from "./JsonBlock";

const SOURCES: [Source, string][] = [
  ["log", "Log"],
  ["span", "Span"],
  ["audit", "Audit"],
];

export function TimelinePanel({ entries, onSpan }: { entries: TimelineEntry[]; onSpan: (spanId: string) => void }) {
  const [enabled, setEnabled] = useState<Record<Source, boolean>>({ log: true, span: true, audit: true });
  const [showAuto, setShowAuto] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const shown = useMemo(
    () =>
      entries
        .map((entry, i) => ({ entry, i }))
        .filter(({ entry }) => enabled[entry.source])
        .filter(({ entry }) => entry.source !== "span" || showAuto || categorize(entry.kind) !== "auto"),
    [entries, enabled, showAuto],
  );

  return (
    <div className="timeline">
      <div className="controls">
        {SOURCES.map(([source, label]) => (
          <label key={source} className="check">
            <input
              type="checkbox"
              checked={enabled[source]}
              onChange={(e) => setEnabled({ ...enabled, [source]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} />
          Auto-instrumented spans
        </label>
        <span className="muted small">{shown.length} entries</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Source</th>
              <th scope="col">Event</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ entry, i }) => (
              <TimelineRow
                key={i}
                entry={entry}
                open={open === i}
                onToggle={() => {
                  if (entry.source === "span") onSpan(String(entry.detail.span_id));
                  else setOpen(open === i ? null : i);
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TimelineRow({ entry, open, onToggle }: { entry: TimelineEntry; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`tl-row${open ? " open" : ""}`}>
        <td className="nowrap mono">{clock(entry.ts)}</td>
        <td>
          <span className={`source source-${entry.source}`}>{entry.source}</span>
        </td>
        <td>
          <button type="button" className="linklike" onClick={onToggle} aria-expanded={open}>
            {entry.kind}
          </button>
          {entry.tag && <span className="muted small"> {entry.tag}</span>}
        </td>
        <td className="muted small">{summary(entry)}</td>
      </tr>
      {open && (
        <tr className="tl-detail">
          <td colSpan={4}>
            <JsonBlock value={entry.detail} />
          </td>
        </tr>
      )}
    </>
  );
}

const SKIP = new Set(["case_id", "task_id", "trace_id", "timestamp", "event", "level"]);

function summary(entry: TimelineEntry): string {
  if (entry.source === "span") return duration(entry.detail.duration_ms as number | null);
  if (entry.source === "audit") return entry.detail.automated === false ? "by a person" : "";
  return Object.entries(entry.detail)
    .filter(([k]) => !SKIP.has(k))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ")
    .slice(0, 180);
}
