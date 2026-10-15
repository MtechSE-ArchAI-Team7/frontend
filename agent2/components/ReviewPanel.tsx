import { useEffect, useId, useRef, useState } from "react";
import { GatewayError, approve, describeReviewError, getReview, notStarted, reinvestigate } from "../api";
import { dateTime } from "../format";
import {
  BADGE_LABEL,
  type Badge,
  CONTEXT_MAX_LENGTH,
  MAX_SERVICES,
  REVIEWER_MAX_LENGTH,
  fromLocalInput,
  reviewerProblem,
  toLocalInput,
} from "../review";
import type { ActionStarted, HandoffPreview, Hypothesis, QuarantinedEvidence, RequestRow, ReviewView } from "../types";
import { type ReviewAction, type Started, type Watch, WatchStatus } from "./ActionWatch";

// Everything this panel shows from the API is text and is rendered as text: React children
// and attribute values only. No dangerouslySetInnerHTML, no Markdown, no auto-linking. A held
// case is held because someone may have planted instructions in it, so the reader is the
// target (diagnosis-agent docs/log-ui-review-actions.md §4a).

interface Props {
  row: RequestRow;
  badge: Badge;
  caseId: string;
  // Requests on the case that started after this one: an approval or re-investigation
  // someone already asked for.
  later: RequestRow[];
  // What became of an action this panel started.
  watch: Watch | null;
  onClose: () => void;
  onStarted: (started: Started) => void;
}

export function ReviewPanel({ row, badge, caseId, later, watch, onClose, onStarted }: Props) {
  const [view, setView] = useState<ReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getReview(row.task_id, row.release, controller.signal)
      .then(setView)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(describeReviewError(err));
      });
    return () => controller.abort();
  }, [row.task_id, row.release]);

  const release = view?.release ?? row.release ?? null;
  const onHandedOver = (action: ReviewAction, started: ActionStarted | null) =>
    onStarted({ action, sourceTaskId: row.task_id, release, taskId: started?.task_id ?? null });
  let body;
  if (error) {
    body = (
      <p className="error" role="alert">
        {error}
      </p>
    );
  } else if (!view) {
    body = <p className="muted loading">Reading the task from Agent 2…</p>;
  } else if (view.kind === "held") {
    body = <ApproveForm view={view} taskId={row.task_id} release={release} onHandedOver={onHandedOver} />;
  } else if (view.kind === "no_diagnosis" || view.kind === "missing_fields") {
    body = (
      <ReinvestigateForm
        view={view}
        taskId={row.task_id}
        caseId={view.case_id ?? caseId}
        release={release}
        onHandedOver={onHandedOver}
      />
    );
  } else {
    body = (
      <p className="muted">
        {view.kind === "working"
          ? "This task is still running. Nothing to review yet."
          : "Nothing on this task waits for review now. It may have ended another way since this row was logged."}
      </p>
    );
  }

  const followUps = later.filter((r) => (badge === "held" ? r.kind === "approval" : r.kind === "reinvestigation"));

  return (
    <aside className="drawer review" aria-label={`Review request ${row.task_id}`} tabIndex={-1} ref={ref}>
      <div className="drawer-head">
        <h3>{BADGE_LABEL[badge]}</h3>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close review">
          ✕
        </button>
      </div>
      <dl className="kv">
        <dt>Case</dt>
        <dd>{view?.case_id ?? caseId}</dd>
        <dt>Task</dt>
        <dd className="mono">{row.task_id}</dd>
        <dt>Started</dt>
        <dd>{dateTime(row.first_seen)}</dd>
        <dt>Release</dt>
        <dd>{release ? <code>{release}</code> : <span className="muted">—</span>}</dd>
      </dl>
      {followUps.length > 0 && (
        <p className="notice" role="note">
          {badge === "held" ? "An approval" : "A re-investigation"} was already asked for on this case after this run (
          {followUps.map((r) => dateTime(r.first_seen)).join(", ")}). Check its row before asking again.
        </p>
      )}
      {body}
      {watch && <WatchStatus watch={watch} />}
    </aside>
  );
}

// ---------------------------------------------------------------- shared form parts

type Sending = "idle" | "sending" | "handed" | "unknown";
type HandedOver = (action: ReviewAction, started: ActionStarted | null) => void;

// One POST per click: the button disables before the request goes out. A refusal (4xx), or
// Agent 2 not taking the task (502 AGENT2_UNAVAILABLE), means nothing was started, so the
// form opens again; anything else may have started it, so the form stays shut and the case
// view is watched instead.
function useSubmit(onHandedOver: HandedOver) {
  const [state, setState] = useState<Sending>("idle");
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const submit = (action: ReviewAction, send: () => Promise<ActionStarted>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("sending");
    setError(null);
    send()
      .then((started) => {
        setState("handed");
        onHandedOver(action, started);
      })
      .catch((err: unknown) => {
        if (notStarted(err)) {
          inFlight.current = false;
          setState("idle");
          setError("Agent 2 did not take it, so nothing was started. Try again in a moment.");
          return;
        }
        if (err instanceof GatewayError && err.status >= 400 && err.status < 500) {
          inFlight.current = false;
          setState("idle");
          setError(`Refused: ${describeReviewError(err)}`);
          return;
        }
        setState("unknown");
        setError(describeReviewError(err));
        onHandedOver(action, null);
      });
  };
  return { state, error, submit, locked: state !== "idle" };
}

function SubmitOutcome({ state, error, what }: { state: Sending; error: string | null; what: string }) {
  if (state === "handed") {
    return (
      <p className="handed" role="status">
        Agent 2 has {what} as a new task. That is not its answer yet: Agent 2 checks it again and may still refuse it.
      </p>
    );
  }
  if (state === "unknown") {
    return (
      <p className="error" role="alert">
        {error} It is not known whether Agent 2 took {what}, so the button stays off.
      </p>
    );
  }
  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  return null;
}

function ReviewerField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const id = useId();
  const problem = value ? reviewerProblem(value) : null;
  return (
    <div className="field">
      <label htmlFor={id}>Your name</label>
      <input
        id={id}
        type="text"
        autoComplete="name"
        maxLength={REVIEWER_MAX_LENGTH}
        value={value}
        disabled={disabled}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value)}
      />
      <div id={`${id}-hint`} className={problem ? "error small" : "muted small"}>
        {problem ?? "Recorded on the ticket and in the audit log, not verified: there is no login."}
      </div>
    </div>
  );
}

function TextList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h4>{title}</h4>
      <ul className="plain-list">
        {items.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- approve

function ApproveForm({
  view,
  taskId,
  release,
  onHandedOver,
}: {
  view: ReviewView;
  taskId: string;
  release: string | null;
  onHandedOver: HandedOver;
}) {
  const hypotheses = view.hypotheses ?? [];
  const ranks = hypotheses.map((h) => h.rank);
  const [rank, setRank] = useState<number>(ranks.includes(1) ? 1 : (ranks[0] ?? 1));
  const [reviewer, setReviewer] = useState("");
  const [confirming, setConfirming] = useState(false);
  const { state, error, submit, locked } = useSubmit(onHandedOver);
  const marker = view.marker ?? "";
  const chosen = hypotheses.find((h) => h.rank === rank);
  const approved = view.already_approved === true;
  const ready = !approved && hypotheses.length > 0 && marker !== "" && reviewerProblem(reviewer) === null;

  return (
    <>
      {approved && (
        <p className="notice" role="note">
          Already approved: this diagnosis was approved and delivered, and cannot be approved again.
        </p>
      )}
      <TextList title="Why it was held" items={[...(view.limitations ?? []), ...(view.advisories ?? [])]} />

      <fieldset className="hypotheses" disabled={confirming || locked}>
        <legend>Hypothesis to send to Agent 3</legend>
        {hypotheses.length === 0 && <p className="muted">This diagnosis has no hypotheses.</p>}
        {hypotheses.map((h) => (
          <HypothesisChoice key={h.rank} h={h} checked={h.rank === rank} onPick={() => setRank(h.rank)} />
        ))}
      </fieldset>

      <Preview previews={view.handoff_preview ?? null} rank={rank} />

      <Quarantined items={view.quarantined ?? []} />

      {!confirming ? (
        <form
          className="review-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) setConfirming(true);
          }}
        >
          <ReviewerField value={reviewer} onChange={setReviewer} disabled={locked || approved} />
          <div>
            <button type="submit" disabled={!ready}>
              Approve…
            </button>
          </div>
        </form>
      ) : (
        <div className="confirm" role="group" aria-label="Confirm approval">
          <p>
            Approve diagnosis <code>{marker}</code> with hypothesis <strong>{rank}</strong>
            {chosen?.root_cause ? ` (${chosen.root_cause})` : ""}, as {reviewer.trim()}?
          </p>
          <p className="muted small">
            Agent 2 checks the marker and rank again, then sends this hypothesis to Agent 3. Approving does not
            re-run anything: what the run concluded is what leaves.
          </p>
          <div className="actions">
            <button
              type="button"
              disabled={locked || approved}
              onClick={() =>
                submit("approve", () => approve(taskId, release, { reviewer: reviewer.trim(), marker, rank }))
              }
            >
              Confirm approval
            </button>
            {!locked && (
              <button type="button" className="ghost" onClick={() => setConfirming(false)}>
                Back
              </button>
            )}
          </div>
        </div>
      )}
      <SubmitOutcome state={state} error={error} what="the approval" />
    </>
  );
}

function HypothesisChoice({ h, checked, onPick }: { h: Hypothesis; checked: boolean; onPick: () => void }) {
  const strength = typeof h.evidence_strength === "number" ? h.evidence_strength.toFixed(2) : null;
  return (
    <label className={`hypothesis${checked ? " chosen" : ""}`}>
      <input type="radio" name="rank" value={h.rank} checked={checked} onChange={onPick} />
      <span className="hypothesis-body">
        <span className="hypothesis-head">
          <strong>Rank {h.rank}</strong>
          {h.category && <span className="mono">{h.category}</span>}
          {strength && <span className="muted small">strength {strength}</span>}
        </span>
        {h.root_cause && <span className="hypothesis-cause">{h.root_cause}</span>}
        {h.reasoning && <span className="muted small hypothesis-reasoning">{h.reasoning}</span>}
      </span>
    </label>
  );
}

// What Agent 2 would send to Agent 3 for the chosen rank, so the reviewer approves what
// leaves and not only the ranking. Shown as JSON text: issue_summary and supporting_evidence
// may carry words an attacker wrote.
function Preview({ previews, rank }: { previews: HandoffPreview[] | null; rank: number }) {
  const preview = previews?.find((p) => p.rank === rank);
  let body;
  if (!previews) {
    body = <p className="muted">No preview yet: Agent 2 returned none for this diagnosis.</p>;
  } else if (!preview) {
    body = <p className="muted">Agent 2 did not answer for rank {rank}.</p>;
  } else if (!preview.handoff) {
    body = (
      <p className="notice">
        Agent 2 would not send rank {rank}
        {preview.reason ? `: ${preview.reason}` : "."}
      </p>
    );
  } else {
    body = (
      <>
        <p className="muted small">
          Built as approved by the placeholder “reviewer”, so upstream_audit_refs shows human-approved-by:reviewer.
          On a real approval that becomes your name; everything else is what is sent.
        </p>
        <pre className="excerpt preview">{JSON.stringify(preview.handoff, null, 2)}</pre>
      </>
    );
  }
  return (
    <section>
      <h4>What Agent 3 would receive (rank {rank})</h4>
      {body}
    </section>
  );
}

const QUARANTINE_LABEL = "Written by whoever controls this source, not by the system.";

function Quarantined({ items }: { items: QuarantinedEvidence[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h4>Quarantined evidence ({items.length})</h4>
      <p className="muted small">
        Agent 2 kept these out of the diagnosis because they read like instructions. They are shown so you can
        judge them. Nothing in them is a request from the system.
      </p>
      {items.map((e, i) => (
        <figure key={e.evidence_id ?? i} className="quarantined">
          <figcaption>
            <strong className="quarantine-label">{QUARANTINE_LABEL}</strong>
            <span className="small">
              {[e.source_tool, e.evidence_id].filter(Boolean).join(" · ")}
              {e.uri && (
                <>
                  {" · "}
                  <span className="mono">{e.uri}</span>
                </>
              )}
            </span>
            {e.reasons && e.reasons.length > 0 && (
              <span className="small">Flagged by: {e.reasons.join(", ")}</span>
            )}
          </figcaption>
          <pre className="excerpt">{e.excerpt ?? ""}</pre>
        </figure>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- re-investigate

function needText(need: { question?: string } | string): string {
  if (typeof need === "string") return need;
  return typeof need?.question === "string" ? need.question : JSON.stringify(need);
}

function ReinvestigateForm({
  view,
  taskId,
  caseId,
  release,
  onHandedOver,
}: {
  view: ReviewView;
  taskId: string;
  caseId: string;
  release: string | null;
  onHandedOver: HandedOver;
}) {
  const scope = view.case_scope ?? {};
  const scoped = scope.affected_services ?? [];
  const known = view.known_services ?? [];
  // An empty list means the gateway accepts any service; then the run's own scope
  // is all there is to offer.
  const options = known.length > 0 ? known : scoped;
  const [services, setServices] = useState<string[]>(() => scoped.filter((s) => options.includes(s)));
  const [start, setStart] = useState(() => toLocalInput(scope.time_window?.start));
  const [end, setEnd] = useState(() => toLocalInput(scope.time_window?.end));
  const [context, setContext] = useState("");
  const [reviewer, setReviewer] = useState("");
  const { state, error, submit, locked } = useSubmit(onHandedOver);
  const ids = useId();

  const startIso = fromLocalInput(start);
  const endIso = fromLocalInput(end);
  const problems = [
    services.length === 0 && "Pick at least one affected service.",
    services.length > MAX_SERVICES && `Pick at most ${MAX_SERVICES} services.`,
    (!startIso || !endIso) && "Set when the incident started and ended.",
    startIso && endIso && endIso <= startIso && "The window must end after it starts.",
    reviewerProblem(reviewer),
  ].filter((p): p is string => typeof p === "string");

  const toggle = (service: string) =>
    setServices((current) => (current.includes(service) ? current.filter((s) => s !== service) : [...current, service]));

  return (
    <>
      {view.kind === "missing_fields" ? (
        <TextList title="Agent 2 was missing" items={view.missing_fields ?? []} />
      ) : (
        <TextList title="What would help" items={(view.needs ?? []).map(needText)} />
      )}
      <TextList title="Limitations of the last run" items={view.limitations ?? []} />

      <form
        className="review-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (problems.length > 0 || !startIso || !endIso) return;
          const trimmed = context.trim();
          submit("reinvestigate", () =>
            reinvestigate(taskId, release, {
              reviewer: reviewer.trim(),
              affected_services: services,
              time_window: { start: startIso, end: endIso },
              ...(trimmed ? { context } : {}),
              case_id: caseId,
            }),
          );
        }}
      >
        <fieldset disabled={locked}>
          <legend>Affected services</legend>
          {options.length === 0 ? (
            <p className="muted small">The gateway lists no services to choose from.</p>
          ) : (
            <div className="services">
              {options.map((s) => (
                <label key={s} className="check">
                  <input type="checkbox" checked={services.includes(s)} onChange={() => toggle(s)} />
                  <span className="mono">{s}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset disabled={locked}>
          <legend>Incident time window (your local time)</legend>
          <div className="window">
            <div className="field">
              <label htmlFor={`${ids}-start`}>Start</label>
              <input id={`${ids}-start`} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={`${ids}-end`}>End</label>
              <input id={`${ids}-end`} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor={`${ids}-context`}>Context for Agent 2 (optional)</label>
          <textarea
            id={`${ids}-context`}
            rows={5}
            maxLength={CONTEXT_MAX_LENGTH}
            value={context}
            disabled={locked}
            onChange={(e) => setContext(e.target.value)}
            aria-describedby={`${ids}-context-hint`}
          />
          <div id={`${ids}-context-hint`} className="muted small">
            Plain text, sent as written and labelled as yours after the ticket's own text. {context.length} /{" "}
            {CONTEXT_MAX_LENGTH}
          </div>
        </div>

        <ReviewerField value={reviewer} onChange={setReviewer} disabled={locked} />

        <p className="notice">
          This starts a new investigation of the same ticket ({caseId}) and posts a new comment on it. It does not
          resume this task.
        </p>
        {problems.length > 0 && reviewer && (
          <ul className="muted small plain-list">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div>
          <button type="submit" disabled={locked || problems.length > 0}>
            Start a new investigation
          </button>
        </div>
      </form>
      <SubmitOutcome state={state} error={error} what="the request" />
    </>
  );
}
