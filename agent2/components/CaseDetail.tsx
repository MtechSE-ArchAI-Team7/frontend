import { useEffect, useState } from "react";
import { describeError, getCase } from "../api";
import { count, duration, usd } from "../format";
import { findSpan } from "../spans";
import type { CaseView, SpanNode } from "../types";
import { AuditPanel } from "./AuditPanel";
import { LogsPanel } from "./LogsPanel";
import { Requests } from "./Requests";
import { SpanDetail } from "./SpanDetail";
import { TimelinePanel } from "./TimelinePanel";
import { Waterfall } from "./Waterfall";

type Tab = "waterfall" | "timeline" | "audit" | "logs";

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

          <Requests requests={view.requests} />

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
      {span && <SpanDetail span={span} onClose={() => setSpan(null)} />}
    </section>
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
