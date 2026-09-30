import { useState } from "react";
import { clock, humanize } from "../format";
import type { AuditSection } from "../types";
import { JsonBlock } from "./JsonBlock";
import { Status } from "./Status";

const ERRORS: Record<string, string> = {
  AUDIT_NOT_CONFIGURED: "Audit is not connected to this gateway yet (no AUDIT_DATABASE_URL). Logs and spans still work.",
  AUDIT_UNAVAILABLE: "The audit database could not be read. Logs and spans above are unaffected.",
};

export function AuditPanel({ audit }: { audit: AuditSection }) {
  const [open, setOpen] = useState<number | null>(null);
  if (audit.error) {
    return <p className="muted">{ERRORS[audit.error] ?? audit.error}</p>;
  }
  const records = audit.records ?? [];
  const v = audit.verification;
  return (
    <div className="audit">
      {v && (
        <p className="chain">
          {v.intact ? (
            <Status tone="good" label={`Hash chain intact · ${v.records_checked} records verified`} />
          ) : (
            <Status tone="critical" label={`Hash chain broken at seq ${v.broken_at_seq}: ${v.reason}`} />
          )}
        </p>
      )}
      {records.length === 0 ? (
        <p className="muted">No audit records for this case.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="num">
                  Seq
                </th>
                <th scope="col">Time</th>
                <th scope="col">Event</th>
                <th scope="col">Actor</th>
                <th scope="col">Model</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <FragmentRow key={r.seq} open={open === r.seq} colSpan={5} payload={r.redacted_payload}>
                  <td className="num">{r.seq}</td>
                  <td className="nowrap mono">{clock(r.occurred_at)}</td>
                  <td>
                    <button
                      type="button"
                      className="linklike"
                      aria-expanded={open === r.seq}
                      onClick={() => setOpen(open === r.seq ? null : r.seq)}
                    >
                      {humanize(r.event_type)}
                    </button>
                  </td>
                  <td>
                    {r.actor}
                    {!r.automated && <span className="muted small"> (not automated)</span>}
                  </td>
                  <td className="muted small">{r.model ?? "—"}</td>
                </FragmentRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FragmentRow({
  open,
  colSpan,
  payload,
  children,
}: {
  open: boolean;
  colSpan: number;
  payload: unknown;
  children: React.ReactNode;
}) {
  return (
    <>
      <tr>{children}</tr>
      {open && (
        <tr className="tl-detail">
          <td colSpan={colSpan}>
            <JsonBlock value={payload} />
          </td>
        </tr>
      )}
    </>
  );
}
