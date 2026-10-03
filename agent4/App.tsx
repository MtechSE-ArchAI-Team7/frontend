import { useEffect, useMemo, useState } from "react";
import {
  GatewayError,
  artifactUrl,
  describeError,
  getLedger,
  getReport,
  listRuns,
} from "./api";
import type { LedgerEvent, RunLedger, RunSummary } from "./api";

type View = "list" | "detail";

const VERDICT_TONE: Record<string, string> = {
  PASS: "success",
  FAIL: "error",
  INCONCLUSIVE: "warning",
};

function statusTone(value: string | null | undefined): string {
  if (value === "done") return "success";
  if (value === "running" || value === "started") return "warning";
  if (value === "failed") return "error";
  return "neutral";
}

function displayStatus(value: string | null | undefined): string {
  return value ? value.replaceAll("_", " ") : "—";
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function verdictTone(overall: string | null): string {
  if (!overall) return "neutral";
  return VERDICT_TONE[overall] ?? "neutral";
}

// The last "gates graded" event carries the machine verdicts this run closed on.
function lastGateVerdicts(events: LedgerEvent[] | undefined): Record<string, string> {
  let verdicts: Record<string, string> = {};
  for (const event of events ?? []) {
    const details = event.details as Record<string, unknown> | undefined;
    const found = details?.verdicts;
    if (found && typeof found === "object" && found !== null && !Array.isArray(found)) {
      verdicts = found as Record<string, string>;
    }
  }
  return verdicts;
}

function RunRow({ run, onOpen }: { run: RunSummary; onOpen: (runId: string) => void }) {
  return (
    <tr>
      <td><code title={run.run_id}>{run.run_id}</code></td>
      <td>
        {run.pr ? (
          run.pr.number !== null && run.pr.number !== undefined ? `#${run.pr.number}` : "—"
        ) : (
          "—"
        )}
        {run.pr?.title ? <small className="run-pr-title">{run.pr.title}</small> : null}
      </td>
      <td>
        {run.case_id ? (
          <span className="case-badge">
            {run.case_id}
            {run.remediation_draft && <small className="draft-marker">remediation draft</small>}
          </span>
        ) : (
          <span className="case-badge muted">no case</span>
        )}
      </td>
      <td><span className={`status-badge ${statusTone(run.status)}`}><i />{displayStatus(run.status)}</span></td>
      <td>
        <span className={`status-badge ${verdictTone(run.overall)}`}>
          <i />{run.overall ?? "PENDING"}
        </span>
      </td>
      <td>{formatWhen(run.started_at)}</td>
      <td>
        <button className="secondary" type="button" onClick={() => onOpen(run.run_id)}>Open</button>
      </td>
    </tr>
  );
}

function ArtifactLinks({ ledger, runId }: { ledger: RunLedger; runId: string }) {
  const names = Object.keys(ledger.artifacts ?? {});
  if (names.length === 0) return <p className="empty-state">No artifacts recorded for this run.</p>;
  return (
    <ul className="artifact-list">
      {names.map((name) => (
        <li key={name}>
          <a href={artifactUrl(runId, name)} target="_blank" rel="noreferrer">{name} ↗</a>
          {ledger.artifacts?.[name]?.bytes !== undefined && (
            <small>{ledger.artifacts?.[name]?.bytes} bytes</small>
          )}
        </li>
      ))}
    </ul>
  );
}

function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [ledger, setLedger] = useState<RunLedger | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLedger(null);
    setReport(null);
    void getLedger(runId, controller.signal)
      .then((data) => setLedger(data))
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof GatewayError ? describeError(caught) : describeError(caught));
      });
    void getReport(runId, controller.signal)
      .then((text) => setReport(text))
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        // report.md exists only once the run reaches Stage F — its absence is normal mid-run
        if (caught instanceof GatewayError && caught.code === "HTTP_404") setReport(null);
      });
    return () => controller.abort();
  }, [runId]);

  const verdicts = useMemo(() => lastGateVerdicts(ledger?.events), [ledger]);

  return (
    <div className="run-detail">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <span>AIOS</span><span>/</span>
        <span>Verification</span><span>/</span>
        <button className="link-button breadcrumb-button" type="button" onClick={onBack}>Runs</button>
        <span>/</span><strong><code>{runId}</code></strong>
      </nav>

      <section className="page-header">
        <div>
          <h1>Post-merge run</h1>
          <p>Machine-verdict verification of a merged pull request.</p>
        </div>
        <div className="page-header-actions">
          <button className="secondary" type="button" onClick={onBack}>Back to runs</button>
        </div>
      </section>

      {error && (
        <div className="alert error" role="alert">
          <span className="alert-icon">!</span>
          <div><strong>Run detail failed</strong><p>{error}</p></div>
        </div>
      )}

      <section className="content-card">
        <header className="card-header">
          <div><h2>Gate verdicts</h2><p>Tri-state, worst-wins. INCONCLUSIVE means no evidence, never success.</p></div>
          <span className="count-badge">{Object.keys(verdicts).length}</span>
        </header>
        {Object.keys(verdicts).length === 0 ? (
          <div className="card-body"><div className="empty-state">No gates graded yet for this run.</div></div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Gate</th><th>Verdict</th></tr></thead>
              <tbody>
                {Object.entries(verdicts).map(([gate, verdict]) => (
                  <tr key={gate}>
                    <td><code>{gate}</code></td>
                    <td><span className={`status-badge ${verdictTone(verdict)}`}><i />{verdict}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="content-card">
        <header className="card-header">
          <div><h2>Artifacts</h2><p>Served read-only by the receiver, redacted on serve.</p></div>
          <span className="count-badge">{Object.keys(ledger?.artifacts ?? {}).length}</span>
        </header>
        <div className="card-body">
          {ledger ? <ArtifactLinks ledger={ledger} runId={runId} /> : (
            <div className="empty-state">{error ? "Ledger unavailable." : "Loading run ledger…"}</div>
          )}
        </div>
      </section>

      <section className="content-card">
        <header className="card-header">
          <div><h2>Report</h2><p>The delivered post-merge report (report.md).</p></div>
        </header>
        <div className="card-body">
          {report === null ? (
            <div className="empty-state">{error ? "" : "No report yet — the run has not reached Stage F."}</div>
          ) : (
            <pre className="report-pre">{report}</pre>
          )}
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("list");
  const [activeRunId, setActiveRunId] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (view !== "list") return undefined;
    const controller = new AbortController();
    let active = true;
    setBusy(true);
    void listRuns(controller.signal)
      .then((data) => {
        if (!active) return;
        setRuns(Array.isArray(data) ? data : []);
        setError("");
      })
      .catch((caught: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(describeError(caught));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [view]);

  function openRun(runId: string) {
    setActiveRunId(runId);
    setView("detail");
  }

  return (
    <div className="agent4-root">
      {view === "list" ? (
        <div id="agent4-runs">
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <span>AIOS</span><span>/</span><span>Verification</span><span>/</span><strong>Runs</strong>
          </nav>
          <section className="page-header">
            <div>
              <h1>Post-merge runs</h1>
              <p>Verification runs executed by the assessment agent after each merge to main.</p>
            </div>
            <div className="page-header-actions">
              <span className="identifier-badge">{runs.length} runs</span>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => setView("list")}
              >
                {busy ? "Refreshing…" : "Refresh runs"}
              </button>
            </div>
          </section>

          {error && (
            <div className="alert error" role="alert">
              <span className="alert-icon">!</span>
              <div><strong>Receiver unreachable</strong><p>{error}</p></div>
            </div>
          )}

          <section className="content-card">
            <header className="card-header">
              <div>
                <span className="section-kicker">Verification queue</span>
                <h2>Assessed merges</h2>
                <p>Every merged pull request gets one verification run, identified by its merge commit.</p>
              </div>
            </header>
            {runs.length === 0 ? (
              <div className="card-body">
                <div className="empty-state">
                  {error ? "" : "No runs recorded yet. A merged pull request starts the first one."}
                </div>
              </div>
            ) : (
              <div className="table-scroll">
                <table className="agent4-runs-table">
                  <thead>
                    <tr>
                      <th>Run</th><th>PR</th><th>Case</th><th>Status</th><th>Overall</th><th>Started</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <RunRow key={run.run_id} run={run} onOpen={openRun} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : (
        <RunDetail runId={activeRunId} onBack={() => setView("list")} />
      )}
    </div>
  );
}
