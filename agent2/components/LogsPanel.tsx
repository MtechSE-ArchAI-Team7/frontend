import { Fragment, useState } from "react";
import { clock } from "../format";
import type { LogLine } from "../types";
import { JsonBlock } from "./JsonBlock";

export function LogsPanel({ logs }: { logs: LogLine[] }) {
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const shown = logs.map((line, i) => ({ line, i })).filter(({ line }) => !onlyWarnings || isWarning(line));

  return (
    <div>
      <div className="controls">
        <label className="check">
          <input type="checkbox" checked={onlyWarnings} onChange={(e) => setOnlyWarnings(e.target.checked)} />
          Warnings and errors only
        </label>
        <span className="muted small">{shown.length} lines</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Level</th>
              <th scope="col">Event</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ line, i }) => (
              <Fragment key={i}>
                <tr>
                  <td className="nowrap mono">{clock(line.timestamp)}</td>
                  <td>
                    <span className={`level level-${line.level ?? "info"}`}>{line.level ?? "info"}</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="linklike"
                      aria-expanded={open === i}
                      onClick={() => setOpen(open === i ? null : i)}
                    >
                      {line.event}
                    </button>
                  </td>
                </tr>
                {open === i && (
                  <tr className="tl-detail">
                    <td colSpan={3}>
                      <JsonBlock value={line} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function isWarning(line: LogLine): boolean {
  return line.level === "warning" || line.level === "error" || line.level === "critical";
}
