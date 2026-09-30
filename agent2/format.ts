export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

// A status is never colour alone: every tone renders with its icon and a text label.
export const TONE_ICON: Record<Tone, string> = {
  good: "✓",
  warning: "!",
  serious: "!",
  critical: "✕",
  neutral: "•",
};

const OUTCOMES: Record<string, [Tone, string]> = {
  task_completed: ["good", "Completed"],
  approval_processed: ["good", "Approval processed"],
  task_insufficient_evidence: ["warning", "Insufficient evidence"],
  task_input_required_missing_fields: ["serious", "Input required"],
  task_input_required_after_jira: ["serious", "Input required"],
  case_rejected_time_window: ["serious", "Rejected: time window"],
  task_failed: ["critical", "Failed"],
  task_failed_bad_schema: ["critical", "Failed: bad schema"],
  task_cancelled: ["critical", "Cancelled"],
  approval_refused: ["critical", "Approval refused"],
};

export function outcome(event: string | null | undefined, delivered?: unknown): [Tone, string] {
  if (!event) return ["neutral", "No outcome logged"];
  // Structlog renders the bool as a string. An approval that did not reach Agent 3 is
  // not a success, whatever the approval itself did.
  if (event === "approval_processed" && (delivered === false || delivered === "False")) {
    return ["serious", "Approved, not delivered"];
  }
  return OUTCOMES[event] ?? ["neutral", humanize(event)];
}

export function eventTone(event: string): Tone {
  if (event.endsWith("_succeeded") || event === "jira_comment_written") return "good";
  if (event.includes("rejected") || event.includes("failed") || event.includes("refused")) return "critical";
  if (event.includes("skipped") || event.includes("incomplete") || event.includes("not_awaited")) return "warning";
  return outcome(event)[0];
}

export function humanize(event: string): string {
  const text = event.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function clock(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function dateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function relative(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms === 0) return "0";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  // Round once, then split: rounding the remainder alone gave "2 min 60 s".
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

export function usd(value: number): string {
  return value >= 0.01 ? `$${value.toFixed(2)}` : value > 0 ? `$${value.toFixed(4)}` : "$0";
}

export function count(value: number): string {
  return value.toLocaleString();
}
