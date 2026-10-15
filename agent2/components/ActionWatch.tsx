import { useEffect, useRef, useState } from "react";
import { getCase, getReview } from "../api";
import { dateTime, humanize } from "../format";
import { POLL_INTERVAL_MS, TASK_POLL_INTERVAL_MS, WATCH_DURATION_MS } from "../review";
import type { CaseView, RequestRow, ReviewKind, ReviewView } from "../types";

export type ReviewAction = "approve" | "reinvestigate";

// What a 202 left to find out. The new task's id comes with the 202; without it (the POST's
// answer was lost) only the case view can tell.
export interface Watch {
  id: number;
  action: ReviewAction;
  // The request the review panel acted on, and the release its endpoint is on.
  sourceTaskId: string;
  release: string | null;
  taskId: string | null;
  known: string[];
  until: number;
  task: { state: string | null; kind: ReviewKind | null; refusal: string | null } | null;
  found: RequestRow | null;
  expired: boolean;
}

const RUNNING = new Set(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"]);

function settled(watch: Watch): boolean {
  const state = watch.task?.state;
  return !!state && !RUNNING.has(state);
}

function progressOf(view: ReviewView): Watch["task"] {
  const failed = view.state === "TASK_STATE_FAILED";
  return {
    state: view.state,
    kind: view.kind,
    refusal: failed && typeof view.reason === "string" && view.reason ? view.reason : null,
  };
}

export interface Started {
  action: ReviewAction;
  sourceTaskId: string;
  release: string | null;
  taskId: string | null;
}

let watchIds = 0;

// Reads the action's task every 5 s until it ends, and the case view every 10 s until the
// task's request row shows up, both until the action's deadline. Separate timers, so a task
// update does not restart the case read.
export function useActionWatch(caseId: string, sinceHours: number, view: CaseView | null, onCase: (v: CaseView) => void) {
  const [watch, setWatch] = useState<Watch | null>(null);
  const current = useRef<Watch | null>(null);
  current.current = watch;
  const onCaseRef = useRef(onCase);
  onCaseRef.current = onCase;

  const id = watch?.id;
  const caseActive = !!watch && !watch.found && !watch.expired;
  const taskActive = !!watch && !!watch.taskId && !settled(watch) && !watch.expired;

  const update = (watchId: number, change: (w: Watch) => Watch) =>
    setWatch((w) => (w && w.id === watchId ? change(w) : w));

  useEffect(() => {
    if (!caseActive || id === undefined) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      const w = current.current;
      if (!w) return;
      if (Date.now() > w.until) {
        update(w.id, (x) => ({ ...x, expired: true }));
        return;
      }
      getCase(caseId, sinceHours, controller.signal)
        .then((next) => {
          onCaseRef.current(next);
          const fresh = next.requests.find((r) => (w.taskId ? r.task_id === w.taskId : !w.known.includes(r.task_id)));
          if (fresh) update(w.id, (x) => ({ ...x, found: fresh }));
        })
        // A failed read is tried again at the next tick; the page keeps what it showed.
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [caseActive, id, caseId, sinceHours]);

  useEffect(() => {
    if (!taskActive || id === undefined) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      const w = current.current;
      if (!w?.taskId) return;
      if (Date.now() > w.until) {
        update(w.id, (x) => ({ ...x, expired: true }));
        return;
      }
      getReview(w.taskId, w.release, controller.signal)
        .then((v) => update(w.id, (x) => ({ ...x, task: progressOf(v) })))
        .catch(() => undefined);
    }, TASK_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [taskActive, id]);

  const start = (started: Started) =>
    setWatch({
      ...started,
      id: ++watchIds,
      known: view?.requests.map((r) => r.task_id) ?? [],
      until: Date.now() + WATCH_DURATION_MS[started.action],
      task: null,
      found: null,
      expired: false,
    });

  return { watch, start };
}

// Everything here is text: Agent 2's reason is shown as written, never as markup.
export function WatchStatus({ watch }: { watch: Watch }) {
  const what = watch.action === "approve" ? "approval" : "re-investigation";
  const minutes = Math.round(WATCH_DURATION_MS[watch.action] / 60_000);
  return (
    <div className="watch">
      {watch.taskId && <TaskLine watch={watch} what={what} minutes={minutes} />}
      <p role="status">
        {watch.found
          ? `Its request row is in the table, started ${dateTime(watch.found.first_seen)}.`
          : watch.expired
            ? `No request row for the ${what} after ${minutes} min. Use Refresh later.`
            : `Waiting for its request row; reading the case again every ${POLL_INTERVAL_MS / 1000} s.`}
      </p>
    </div>
  );
}

function TaskLine({ watch, what, minutes }: { watch: Watch; what: string; minutes: number }) {
  const task = watch.task;
  const id = <code>{watch.taskId}</code>;
  if (task?.state === "TASK_STATE_FAILED") {
    return task.refusal ? (
      <p className="error" role="alert">
        Agent 2 refused the {what}: {task.refusal}
      </p>
    ) : (
      <p className="error" role="alert">
        Agent 2's task {id} for the {what} failed without a reason. Its request row and Agent 2's logs may say more.
      </p>
    );
  }
  if (task?.state === "TASK_STATE_COMPLETED") {
    const again =
      watch.action === "reinvestigate" && task.kind === "held"
        ? " Its diagnosis is held for review again."
        : watch.action === "reinvestigate" && task.kind === "no_diagnosis"
          ? " It ended without a diagnosis again."
          : "";
    return (
      <p className="handed" role="status">
        Agent 2 finished the {what} (task {id}). Its request row shows the outcome.{again}
      </p>
    );
  }
  if (task && settled(watch)) {
    return (
      <p role="status">
        Agent 2's task {id} for the {what} ended: {humanize((task.state ?? "").replace(/^TASK_STATE_/, "").toLowerCase())}.
      </p>
    );
  }
  if (watch.expired) {
    return (
      <p role="status">
        Agent 2's task {id} was still running after {minutes} min. Its request row will show how it ends.
      </p>
    );
  }
  return (
    <p role="status">
      Agent 2 has the {what} as task {id}
      {task?.state ? ` (${humanize(task.state.replace(/^TASK_STATE_/, "").toLowerCase())})` : ""}; checking it every{" "}
      {TASK_POLL_INTERVAL_MS / 1000} s.
    </p>
  );
}
