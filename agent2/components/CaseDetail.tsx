import { useEffect, useState } from "react";
import { describeError, getCase } from "../api";
import { count, dateTime, duration, usd } from "../format";
import { type Badge, POLL_DURATION_MS, POLL_INTERVAL_MS } from "../review";
import { findSpan } from "../spans";
import type { CaseView, RequestRow, SpanNode } from "../types";
import { AuditPanel } from "./AuditPanel";
import { LogsPanel } from "./LogsPanel";
import { Requests } from "./Requests";
import { type ReviewAction, ReviewPanel } from "./ReviewPanel";
import { SpanDetail } from "./SpanDetail";
import { TimelinePanel } from "./TimelinePanel";
import { Waterfall } from "./Waterfall";

type Tab = "waterfall" | "timeline" | "audit" | "logs";

// After a review action is handed over: the request rows already seen, and until when to
// keep reading the case view for one that is not among them.
interface Watch {
  action: ReviewAction;
  known: string[];
  until: number;
  found: RequestRow | null;
  expired: boolean;
}

interface Props {
  caseId: string;
  sinceHours: number;
}

export function CaseDetail({ caseId, sinceHours }: Props) {
  const [view, setView] = useState<CaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [tab, setTab] = useState<Tab>("waterfall");
  const [span, setSpan] = useState<SpanNode | null>(null);
  const [review, setReview] = useState<{ row: RequestRow; badge: Badge } | null>(null);
  const [watch, setWatch] = useState<Watch | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    getCase(caseId, sinceHours, controller.signal)
      .then(setView)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(describeError(err));
      })
      .finally(() => window.clearInterval(timer));
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [caseId, sinceHours]);

  useEffect(() => {
    if (!watch || watch.found || watch.expired) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      if (Date.now() > watch.until) {
        setWatch((w) => w && { ...w, expired: true });
        return;
      }
      getCase(caseId, sinceHours, controller.signal)
        .then((next) => {
          setView(next);
          const fresh = next.requests.find((r) => !watch.known.includes(r.task_id));
          if (fresh) setWatch((w) => w && { ...w, found: fresh });
        })
        // A failed read is tried again at the next tick; the page keeps what it showed.
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [watch, caseId, sinceHours]);

  const handedOver = (action: ReviewAction) => {
    setWatch({
      action,
      known: view?.requests.map((r) => r.task_id) ?? [],
      until: Date.now() + POLL_DURATION_MS,
      found: null,
      expired: false,
    });
  };

  if (error) {
    return (
      <section className="case">
        <h2>{caseId}</h2>
        <p className="error" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!view) {
    return (
      <section className="case" aria-busy="true">
        <h2>{caseId}</h2>
        <p className="muted loading">
          Reading logs, spans and audit for {caseId}… {elapsed > 0 && `${elapsed} s`}
          <br />
          <span className="small">A case with several requests usually takes 5–15 s.</span>
        </p>
      </section>
    );
  }

  const totals = view.traces.reduce(
    (acc, t) => ({
      llm: acc.llm + t.llm_calls,
      tokensIn: acc.tokensIn + t.tokens_in,
      tokensOut: acc.tokensOut + t.tokens_out,
      cost: acc.cost + t.cost_usd,
      ms: acc.ms + (t.duration_ms ?? 0),
    }),
    { llm: 0, tokensIn: 0, tokensOut: 0, cost: 0, ms: 0 },
  );
  const empty = view.logs.length === 0 && view.traces.length === 0;

  const tabs: [Tab, string][] = [
    ["waterfall", `Spans (${view.traces.length})`],
    ["timeline", `Timeline (${view.timeline.length})`],
    ["audit", `Audit (${view.audit.records?.length ?? "—"})`],
    ["logs", `Logs (${view.logs.length})`],
  ];

  return (
    <section className="case">
      <h2>{caseId}</h2>
      {empty ? (
        <p className="muted">
          Nothing for {caseId} in the last {sinceHours} h. Widen the range if the case is older.
        </p>
      ) : (
        <>
          <dl className="tiles">
            <Tile label="Requests" value={count(view.requests.length)} />
            <Tile label="Time in traces" value={duration(totals.ms)} />
            <Tile label="LLM calls" value={count(totals.llm)} />
            <Tile label="Tokens in / out" value={`${count(totals.tokensIn)} / ${count(totals.tokensOut)}`} />
            <Tile label="LLM cost" value={usd(totals.cost)} />
          </dl>

          {watch && <WatchStatus watch={watch} />}
          <Requests
            requests={view.requests}
            highlight={watch?.found?.task_id ?? null}
            onReview={(row, badge) => {
              setSpan(null);
              setReview({ row, badge });
            }}
          />

          <div className="tabs" role="tablist">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`tab${tab === id ? " active" : ""}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div role="tabpanel">
            {tab === "waterfall" && <Waterfall traces={view.traces} onSelect={setSpan} selected={span} />}
            {tab === "timeline" && (
              <TimelinePanel
                entries={view.timeline}
                onSpan={(id) => setSpan(findSpan(view.traces, id))}
              />
            )}
            {tab === "audit" && <AuditPanel audit={view.audit} />}
            {tab === "logs" && <LogsPanel logs={view.logs} />}
          </div>
        </>
      )}
      {/* The span drawer opens over the review panel, which stays mounted so a half-filled
          form survives a look at a span. */}
      {span && <SpanDetail span={span} onClose={() => setSpan(null)} />}
      {review && (
        <ReviewPanel
          key={review.row.task_id}
          row={review.row}
          badge={review.badge}
          caseId={caseId}
          later={view.requests.filter((r) => r.first_seen > review.row.first_seen)}
          onClose={() => setReview(null)}
          onHandedOver={handedOver}
        />
      )}
    </section>
  );
}

function WatchStatus({ watch }: { watch: Watch }) {
  const what = watch.action === "approve" ? "approval" : "re-investigation";
  if (watch.found) {
    return (
      <p className="watch" role="status">
        The {what} shows up as a new request row, started {dateTime(watch.found.first_seen)}.
      </p>
    );
  }
  if (watch.expired) {
    return (
      <p className="watch" role="status">
        No new request row for the {what} after {Math.round(POLL_DURATION_MS / 60_000)} min. Use Refresh later, or
        look in Agent 2's logs for review_action_finished.
      </p>
    );
  }
  return (
    <p className="watch" role="status">
      Waiting for the {what} to show up as a new request row; reading the case again every {POLL_INTERVAL_MS / 1000}{" "}
      s.
    </p>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
