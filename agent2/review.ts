import type { RequestRow } from "./types";

// What the review panel needs that is not in the API: which rows get a badge, the reviewer
// rule, and the time-window conversions. The review function and Agent 2 check everything
// again; these are for a useful form, not for safety.

export type Badge = "held" | "no_diagnosis";

export const BADGE_LABEL: Record<Badge, string> = {
  held: "Held for review",
  no_diagnosis: "No diagnosis",
};

const NO_DIAGNOSIS_EVENTS = new Set([
  "task_insufficient_evidence",
  "task_input_required_missing_fields",
  "task_input_required_after_jira",
]);

// A held diagnosis completes as "diagnosed" and its delivery is declined by the handoff gate
// with "requires_human_review is true" (diagnosis-agent output/handoff_mapping.py). The panel
// reads the task itself, so a row that only looks held finds out there.
export function reviewBadge(row: RequestRow): Badge | null {
  if (row.kind === "approval" || !row.outcome) return null;
  if (NO_DIAGNOSIS_EVENTS.has(row.outcome.event)) return "no_diagnosis";
  const reason = row.delivery?.reason;
  if (
    row.outcome.event === "task_completed" &&
    row.outcome.status === "diagnosed" &&
    typeof reason === "string" &&
    reason.includes("requires_human_review")
  ) {
    return "held";
  }
  return null;
}

export const REVIEWER_MAX_LENGTH = 64;
// Agent 2's rule for an approver (schemas/approval.py, Python's Unicode \w): a name, not
// markup. It lands on the ticket, in the audit log and on Agent 3's audit refs.
const REVIEWER = /^[\p{L}\p{N}\p{M}_ .'-]{1,64}$/u;

export function reviewerProblem(value: string): string | null {
  if (!value.trim()) return "Enter your name.";
  if (!REVIEWER.test(value)) {
    return `A name of 1–${REVIEWER_MAX_LENGTH} letters, digits, spaces or . - ' _ only.`;
  }
  return null;
}

export const CONTEXT_MAX_LENGTH = 4000;
export const MAX_SERVICES = 10;

// <input type="datetime-local"> holds local wall time without a zone; the API wants ISO 8601
// with one. The pickers show the reviewer's local time and send UTC.
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// After an action is handed over, the case view is read again on this schedule until a
// request row it did not have before shows up. A re-investigation logs its row as it starts;
// an approval when Agent 2 has checked and delivered it.
export const POLL_INTERVAL_MS = 10_000;
export const POLL_DURATION_MS = 5 * 60_000;
