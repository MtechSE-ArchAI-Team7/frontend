import { dateTime, eventTone, humanize, outcome } from "../format";
import type { Brief, RequestRow } from "../types";
import { Status } from "./Status";

export function Requests({ requests }: { requests: RequestRow[] }) {
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
            <th scope="col" className="num">
              Warnings
            </th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => {
            const [tone, label] = outcome(r.outcome?.event, r.outcome?.delivered);
            return (
              <tr key={r.task_id}>
                <td className="nowrap" title={`task ${r.task_id}`}>
                  {dateTime(r.first_seen)}
                </td>
                <td>{r.kind === "approval" ? "Approval" : "Investigation"}</td>
                <td>
                  <Status tone={tone} label={label} />
                  <Reason brief={r.outcome} />
                </td>
                <td>
                  <BriefCell brief={r.delivery} />
                </td>
                <td>
                  <BriefCell brief={r.jira} />
                </td>
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
