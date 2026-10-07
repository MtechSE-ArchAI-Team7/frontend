import { useCallback, useEffect, useMemo, useState } from "react";
import { describeError, GatewayError, getRun, getToken, isGatewayConfigured, listRuns, setToken } from "./api";
import type { RunDetail, RunSummary, WorkflowEvent } from "./types";

const RUN_RANGES = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: 336, label: "14 days" },
] as const;

const HASH_PREFIX = "#/agent1/";
const REFRESH_MS = 15_000;
const STALE_MS = 60_000;

function runFromHash(): string | null {
  if (!window.location.hash.startsWith(HASH_PREFIX)) return null;
  try {
    return decodeURIComponent(window.location.hash.slice(HASH_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

function pretty(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 30 ? `${value.slice(0, 12)}…${value.slice(-10)}` : value;
}

function clock(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

function elapsed(start: string, end: string): string {
  const milliseconds = Math.max(0, Date.parse(end) - Date.parse(start));
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function percent(value: number | null): string {
  return value === null ? "Not recorded" : `${Math.round(value * 100)}%`;
}

function tone(status: string | null | undefined): string {
  const value = (status ?? "").toLowerCase();
  if (value.includes("failed") || value.includes("error") || value.includes("ticket_creation_failed")) return "error";
  if (value.includes("awaiting") || value.includes("diagnosis") || value.includes("running") || value.includes("started") || value.includes("stale")) return "warning";
  if (value.includes("completed") || value.includes("faq_answer_provided") || value.includes("success")) return "success";
  return "neutral";
}

function formatValue(value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) return value.map(pretty).join(" · ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }
  return pretty(value);
}

function TokenGate({ message, onSubmit }: { message: string | null; onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="agent1-gate">
      <form
        className="agent1-gate-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <span className="agent1-kicker">Restricted operator view</span>
        <h1>Agent 1 · Helpdesk operations</h1>
        <p>Enter the log gateway access token. It is kept in this browser tab only.</p>
        <label htmlFor="agent1-access-token">Access token</label>
        <input
          id="agent1-access-token"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {message && <p className="agent1-error" role="alert">{message}</p>}
        <button type="submit" disabled={!value.trim()}>Open operator view</button>
      </form>
    </div>
  );
}

export default function Agent1App({ active }: { active: boolean }) {
  const [token, setTokenState] = useState<string | null>(getToken());
  const [gateMessage, setGateMessage] = useState<string | null>(null);

  const signOut = useCallback((message: string | null = null) => {
    setToken(null);
    setTokenState(null);
    setGateMessage(message);
  }, []);

  return (
    <div className="agent1-root">
      {!isGatewayConfigured ? (
        <div className="agent1-gate">
          <section className="agent1-gate-card agent1-config-card" aria-labelledby="agent1-config-title">
            <span className="agent1-kicker">Operator data source</span>
            <h1 id="agent1-config-title">Agent 1 gateway is not configured</h1>
            <p>Set <code>VITE_AGENT1_API</code> to the protected Agent 1 CloudWatch gateway URL and rebuild this UI. No run status is inferred or fabricated.</p>
          </section>
        </div>
      ) : token ? (
        <Console active={active} onUnauthorized={() => signOut("The access token was not accepted.")} onSignOut={() => signOut()} />
      ) : (
        <TokenGate
          message={gateMessage}
          onSubmit={(value) => {
            setToken(value);
            setTokenState(value);
            setGateMessage(null);
          }}
        />
      )}
    </div>
  );
}

function Console({
  active,
  onUnauthorized,
  onSignOut,
}: {
  active: boolean;
  onUnauthorized: () => void;
  onSignOut: () => void;
}) {
  const [sinceHours, setSinceHours] = useState<number>(24);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [selected, setSelected] = useState<string | null>(runFromHash());
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!active) return undefined;
    let inFlight = false;
    let alive = true;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const response = await listRuns(sinceHours, controller.signal);
        if (!alive) return;
        setRuns(response.runs);
        setPartial(response.partial);
        setListError(null);
      } catch (error: unknown) {
        if (!alive || controller.signal.aborted) return;
        if (error instanceof GatewayError && error.status === 401) onUnauthorized();
        else setListError(describeError(error));
      } finally {
        inFlight = false;
      }
    };
    setRuns(null);
    setListError(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(timer);
      window.clearInterval(clockTimer);
    };
  }, [active, sinceHours, refreshKey, onUnauthorized]);

  useEffect(() => {
    if (!active) return undefined;
    const onHash = () => {
      const { hash } = window.location;
      if (hash && !hash.startsWith(HASH_PREFIX)) return;
      setSelected(runFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [active]);

  useEffect(() => {
    if (!active || !selected) {
      setDetail(null);
      setDetailError(null);
      return undefined;
    }
    let alive = true;
    let inFlight = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const response = await getRun(selected, sinceHours, controller.signal);
        if (alive) {
          setDetail(response.run);
          setPartial((previous) => previous || response.partial);
          setDetailError(null);
        }
      } catch (error: unknown) {
        if (!alive || controller.signal.aborted) return;
        if (error instanceof GatewayError && error.status === 401) onUnauthorized();
        else setDetailError(describeError(error));
      } finally {
        inFlight = false;
        if (alive) setDetailLoading(false);
      }
    };
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [active, selected, sinceHours, refreshKey, onUnauthorized]);

  const visibleRuns = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (runs ?? []).filter((run) => {
      const matchesText = !normalized || [
        run.case_id,
        run.run_id,
        run.ticket_id ?? "",
        run.service ?? "",
        run.issue_type ?? "",
      ].some((value) => value.toLowerCase().includes(normalized));
      const matchesStatus = statusFilter === "all"
        || (statusFilter === "running" ? run.status === "RUNNING" : run.terminal_outcome === statusFilter);
      return matchesText && matchesStatus;
    });
  }, [runs, query, statusFilter]);

  function selectRun(runId: string) {
    window.location.hash = `${HASH_PREFIX.slice(1)}${encodeURIComponent(runId)}`;
    setSelected(runId);
  }

  const stale = detail?.status === "RUNNING" && now - Date.parse(detail.last_seen) > STALE_MS;

  return (
    <div className="agent1-console">
      <header className="agent1-header">
        <div>
          <span className="agent1-kicker">Service operations · Read only</span>
          <h1>Agent 1 · Helpdesk operations</h1>
          <p>Track intake, triage decisions, ticket actions, and escalation evidence.</p>
        </div>
        <div className="agent1-header-actions">
          <label>
            <span>Look back</span>
            <select value={sinceHours} onChange={(event) => setSinceHours(Number(event.target.value))}>
              {RUN_RANGES.map((range) => <option key={range.hours} value={range.hours}>{range.label}</option>)}
            </select>
          </label>
          <button type="button" className="agent1-secondary" onClick={() => setRefreshKey((value) => value + 1)}>Refresh</button>
          <button type="button" className="agent1-secondary" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <div className="agent1-freshness" role="status">
        <span className={`agent1-live-dot${listError ? " is-error" : runs === null ? " is-pending" : ""}`} />
        <span>{listError ? "Data source unavailable" : runs === null ? "Connecting to CloudWatch event feed" : "CloudWatch event feed connected"}</span>
        <span className="agent1-muted">Refreshes every 15 seconds while this tab is open</span>
      </div>

      {partial && (
        <p className="agent1-notice agent1-notice-warning" role="status">
          The gateway reached its event limit. Some runs or events may be missing from this time range.
        </p>
      )}

      <div className="agent1-layout">
        <aside className="agent1-run-list" aria-label="Recent helpdesk runs">
          <div className="agent1-list-heading">
            <div><h2>Recent runs</h2><span>{visibleRuns.length} shown</span></div>
          </div>
          <div className="agent1-list-controls">
            <label className="agent1-sr-only" htmlFor="agent1-run-search">Search cases and runs</label>
            <input id="agent1-run-search" type="search" placeholder="Search case, run, ticket…" value={query} onChange={(event) => setQuery(event.target.value)} />
            <label className="agent1-sr-only" htmlFor="agent1-status-filter">Filter by status</label>
            <select id="agent1-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">All outcomes</option>
              <option value="running">Running</option>
              <option value="awaiting_clarification">Awaiting clarification</option>
              <option value="faq_answer_provided">FAQ answered</option>
              <option value="diagnosis_required">Diagnosis required</option>
              <option value="ticket_creation_failed">Ticket creation failed</option>
            </select>
          </div>
          {listError && <p className="agent1-list-message agent1-error" role="alert">{listError}</p>}
          {!listError && runs === null && <p className="agent1-list-message" aria-busy="true">Reading recent workflow events…</p>}
          {!listError && runs?.length === 0 && <p className="agent1-list-message">No recorded runs in the selected period.</p>}
          {runs !== null && runs.length > 0 && visibleRuns.length === 0 && <p className="agent1-list-message">No runs match these filters.</p>}
          <ul className="agent1-runs">
            {visibleRuns.map((run) => (
              <li key={run.run_id}>
                <button type="button" className={`agent1-run-row${selected === run.run_id ? " is-selected" : ""}`} onClick={() => selectRun(run.run_id)}>
                  <span className="agent1-run-row-top">
                    <strong>{run.ticket_id ?? run.case_id}</strong>
                    <time dateTime={run.last_seen}>{relativeTime(run.last_seen, now)}</time>
                  </span>
                  <span className="agent1-run-row-bottom">
                    <StatusBadge status={run.terminal_outcome ?? run.status} />
                    <span>{pretty(run.priority ?? run.current_step)}</span>
                  </span>
                  <span className="agent1-run-row-meta">{pretty(run.service)} · {pretty(run.issue_type)}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="agent1-list-footnote">Case references are hashed. Visibility is limited to events retained in the configured log group.</p>
        </aside>

        <main className="agent1-detail">
          {selected ? (
            detailLoading && !detail ? (
              <p className="agent1-detail-message" aria-busy="true">Loading run events…</p>
            ) : detailError ? (
              <section className="agent1-content-card"><p className="agent1-error" role="alert">{detailError}</p></section>
            ) : detail ? (
              <RunDetailView run={detail} stale={stale} now={now} />
            ) : (
              <p className="agent1-detail-message">No event details are available for this run.</p>
            )
          ) : (
            <section className="agent1-empty">
              <span className="agent1-empty-mark" aria-hidden="true">A1</span>
              <h2>Select a helpdesk run</h2>
              <p>Choose a recent run to inspect how intake, triage, policy gates, tools, and outcomes connect.</p>
              <p className="agent1-muted">Only explicitly recorded workflow events appear here; missing telemetry is not evidence that no action occurred.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function relativeTime(value: string, now: number): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "unknown";
  const seconds = Math.max(0, Math.floor((now - milliseconds) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`agent1-status-badge ${tone(status)}`}><i aria-hidden="true" />{pretty(status)}</span>;
}

function RunDetailView({ run, stale, now }: { run: RunDetail; stale: boolean; now: number }) {
  const age = Math.max(0, now - Date.parse(run.last_seen));
  const duration = elapsed(run.first_seen, run.last_seen);
  const decisions = run.events.filter((event) => event.action === "gate.decision");
  return (
    <div className="agent1-run-detail">
      <header className="agent1-detail-heading">
        <div>
          <span className="agent1-kicker">Workflow run</span>
          <h2>{run.ticket_id ?? run.case_id}</h2>
          <p>Run <code>{shortId(run.run_id)}</code> · Last event {relativeTime(run.last_seen, now)}</p>
        </div>
        <StatusBadge status={stale ? "telemetry_stale" : run.terminal_outcome ?? run.status} />
      </header>

      {stale && (
        <p className="agent1-notice agent1-notice-warning" role="status">
          No event has arrived for {Math.floor(age / 60_000)} minutes. This run may be stalled, complete without a terminal event, or outside the current telemetry path.
        </p>
      )}

      <section className="agent1-content-card">
        <div className="agent1-card-heading">
          <div><span className="agent1-kicker">Run overview</span><h3>{pretty(run.terminal_outcome ?? run.current_step)}</h3></div>
          <span className="agent1-muted">Read-only evidence</span>
        </div>
        <div className="agent1-metrics">
          <Metric label="Priority" value={pretty(run.priority)} />
          <Metric label="Issue type" value={pretty(run.issue_type)} />
          <Metric label="Service" value={pretty(run.service)} />
          <Metric label="Model confidence" value={percent(run.confidence)} note="Estimate, not calibrated correctness" />
          <Metric label="Elapsed" value={duration} />
          <Metric label="Recorded events" value={run.event_count.toLocaleString()} />
        </div>
        <dl className="agent1-property-table">
          <div><dt>Case reference</dt><dd><code>{run.case_id}</code> <span className="agent1-muted">(hashed)</span></dd></div>
          <div><dt>Jira ticket</dt><dd>{run.ticket_id ?? "Not recorded"}</dd></div>
          <div><dt>Current step</dt><dd>{pretty(run.current_step)}</dd></div>
          <div><dt>Run began</dt><dd>{clock(run.first_seen)}</dd></div>
          <div><dt>Last event</dt><dd>{clock(run.last_seen)}</dd></div>
          <div><dt>Trace ID</dt><dd><code>{shortId(run.trace_id)}</code></dd></div>
        </dl>
        <p className="agent1-privacy-note">Customer messages, full model prompts, chain-of-thought, and unrestricted browser contents are intentionally not shown.</p>
      </section>

      <section className="agent1-content-card">
        <div className="agent1-card-heading">
          <div><span className="agent1-kicker">Decision audit</span><h3>Why the workflow routed this way</h3></div>
          <span className="agent1-count">{decisions.length}</span>
        </div>
        {decisions.length === 0 ? (
          <p className="agent1-empty-inline">No routing decision event is recorded for this run.</p>
        ) : (
          <ol className="agent1-decision-list">
            {decisions.map((event) => <DecisionCard event={event} key={event.event_id} />)}
          </ol>
        )}
        <p className="agent1-privacy-note">Decisions are explained from recorded rules, thresholds, and structured outputs—not hidden model reasoning.</p>
      </section>

      <section className="agent1-content-card">
        <div className="agent1-card-heading">
          <div><span className="agent1-kicker">Execution trace</span><h3>Workflow activity</h3></div>
          <span className="agent1-count">{run.events.length}</span>
        </div>
        {run.events.length === 0 ? <p className="agent1-empty-inline">No events are available.</p> : (
          <ol className="agent1-timeline">
            {[...run.events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).map((event) => (
              <TimelineEvent event={event} key={event.event_id} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="agent1-metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}

function DecisionCard({ event }: { event: WorkflowEvent }) {
  const facts = Object.entries(event.details).filter(([key]) => key !== "decision" && key !== "reason_code");
  return (
    <li className="agent1-decision-card">
      <div className="agent1-event-topline">
        <span className="agent1-actor deterministic">Deterministic gate</span>
        <time dateTime={event.timestamp}>{clock(event.timestamp)}</time>
      </div>
      <strong>{event.summary}</strong>
      <p>Reason: <code>{pretty(String(event.details.reason_code ?? "not_recorded"))}</code></p>
      {facts.length > 0 && (
        <dl className="agent1-facts">
          {facts.map(([key, value]) => <div key={key}><dt>{pretty(key)}</dt><dd>{formatValue(value)}</dd></div>)}
        </dl>
      )}
    </li>
  );
}

function TimelineEvent({ event }: { event: WorkflowEvent }) {
  const facts = Object.entries(event.details);
  return (
    <li className="agent1-timeline-item">
      <span className={`agent1-timeline-marker ${tone(event.status)}`} aria-hidden="true" />
      <div className="agent1-timeline-body">
        <div className="agent1-event-topline">
          <span className={`agent1-actor ${event.actor_type.toLowerCase()}`}>{pretty(event.actor_type)}</span>
          <time dateTime={event.timestamp}>{clock(event.timestamp)}</time>
        </div>
        <div className="agent1-event-title">
          <strong>{event.summary}</strong>
          <StatusBadge status={event.status} />
        </div>
        <p className="agent1-event-meta">{pretty(event.stage)} · {pretty(event.action)}{event.duration_ms !== undefined && ` · ${event.duration_ms.toLocaleString()} ms`}</p>
        {facts.length > 0 && (
          <details className="agent1-event-details">
            <summary>Recorded decision and operational fields</summary>
            <dl className="agent1-facts">
              {facts.map(([key, value]) => <div key={key}><dt>{pretty(key)}</dt><dd>{formatValue(value)}</dd></div>)}
            </dl>
          </details>
        )}
      </div>
    </li>
  );
}
