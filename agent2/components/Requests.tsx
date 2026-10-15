import { dateTime, eventTone, humanize, outcome } from "../format";
import { BADGE_LABEL, type Badge, reviewBadge } from "../review";
import type { Brief, RequestRow } from "../types";
import { Status } from "./Status";

const KIND_LABEL: Record<RequestRow["kind"], string> = {
  investigation: "Investigation",
  approval: "Approval",
  reinvestigation: "Re-investigation",
};

interface Props {
  requests: RequestRow[];
  // Opens the review panel for a row the badge marks as held or without a diagnosis.
  onReview?: (row: RequestRow, badge: Badge) => void;
  // A row that appeared while the case view was being watched after a review action.
  highlight?: string | null;
}

export function Requests({ requests, onReview, highlight }: Props) {
  if (requests.length === 0) return null;
  return (
    <div className="table-wrap">
      <table className="table requests">
        <caption>Requests, oldest first</caption>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Kind</th>
            <th scope="col">Outcome</th>
            <th scope="col">Agent 3 delivery</th>
            <th scope="col">Jira</th>
            <th scope="col">Release</th>
            <th scope="col" className="num">
              Warnings
            </th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => {
            const [tone, label] = outcome(r.outcome?.event, r.outcome?.delivered);
            const badge = reviewBadge(r);
            return (
              <tr key={r.task_id} className={r.task_id === highlight ? "fresh" : undefined}>
                <td className="nowrap" title={`task ${r.task_id}`}>
                  {dateTime(r.first_seen)}
                </td>
                <td>
                  {KIND_LABEL[r.kind] ?? humanize(String(r.kind))}
                  {r.kind === "reinvestigation" && (
                    <div className="muted small">
                      requested by {r.requested_by ? r.requested_by : "an unnamed reviewer"}
                    </div>
                  )}
                </td>
                <td>
                  <Status tone={tone} label={label} />
                  <Reason brief={r.outcome} />
                  {badge && onReview && (
                    <button
                      type="button"
                      className={`ghost small review-badge review-${badge}`}
                      aria-haspopup="dialog"
                      onClick={() => onReview(r, badge)}
                    >
                      {BADGE_LABEL[badge]}
                    </button>
                  )}
                </td>
                <td>
                  <BriefCell brief={r.delivery} />
                </td>
                <td>
                  <BriefCell brief={r.jira} />
                </td>
                <td>{r.release ? <code>{r.release}</code> : <span className="muted">—</span>}</td>
                <td className="num">{r.warnings || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BriefCell({ brief }: { brief: Brief | null }) {
  if (!brief) return <span className="muted">—</span>;
  return (
    <>
      <Status tone={eventTone(brief.event)} label={humanize(brief.event)} />
      <Reason brief={brief} />
    </>
  );
}

function Reason({ brief }: { brief: Brief | null }) {
  const extra = brief?.status ?? brief?.reason;
  return extra ? <div className="muted small reason">{String(extra)}</div> : null;
}
