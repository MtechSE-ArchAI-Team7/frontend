// Mirrors log-ui/backend/timeline.py and handler.py. The backend is the source of truth.

export interface CaseRow {
  case_id: string;
  outcome: string;
  delivered?: unknown;
  first_seen: string;
  last_seen: string;
  requests: number;
  // Release cohort that handled the case (diagnosis-agent docs/release-cohorts.md); null or
  // absent for a request that carried no label, and from a backend that predates cohorts.
  release?: string | null;
}

export interface CasesResponse {
  cases: CaseRow[];
}

export interface Brief {
  event: string;
  [field: string]: unknown;
}

export interface RequestRow {
  task_id: string;
  // "reinvestigation": a person asked for this run from the review panel, named in
  // requested_by (diagnosis-agent log-ui/backend/timeline.py).
  kind: "investigation" | "approval" | "reinvestigation";
  first_seen: string;
  last_seen: string;
  outcome: Brief | null;
  delivery: Brief | null;
  jira: Brief | null;
  release?: string | null;
  requested_by?: string | null;
  warnings: number;
}

export interface SpanNode {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_ns: number;
  end_ns: number;
  duration_ms: number | null;
  status: string | null;
  status_message?: string | null;
  attributes: Record<string, unknown>;
  children: SpanNode[];
}

export interface Trace {
  trace_id: string;
  span_count: number;
  duration_ms: number | null;
  llm_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  roots: SpanNode[];
}

export interface AuditRecord {
  case_id: string;
  seq: number;
  event_type: string;
  actor: "agent" | "human" | "system";
  automated: boolean;
  occurred_at: string;
  redacted_payload: Record<string, unknown>;
  prompt_version: string | null;
  model: string | null;
  record_hash: string;
}

export interface AuditSection {
  error?: string;
  records?: AuditRecord[];
  verification?: {
    intact: boolean;
    records_checked: number;
    broken_at_seq: number | null;
    reason: string | null;
  };
}

export type Source = "log" | "span" | "audit";

export interface TimelineEntry {
  ts: string | null;
  source: Source;
  kind: string;
  tag: string | null;
  detail: Record<string, unknown>;
}

export interface LogLine {
  event: string;
  level?: string;
  timestamp: string;
  task_id?: string;
  [field: string]: unknown;
}

export interface CaseView {
  case_id: string;
  logs: LogLine[];
  requests: RequestRow[];
  traces: Trace[];
  audit: AuditSection;
  timeline: TimelineEntry[];
}

// Mirrors diagnosis-agent log-ui/review/review.py::view. Every string here is text to show
// as text: hypotheses are model output, excerpts and ticket text were written by whoever
// controls their source.

export type ReviewKind = "held" | "no_diagnosis" | "missing_fields" | "working" | "none";

export interface Hypothesis {
  rank: number;
  category?: string | null;
  root_cause?: string | null;
  evidence_strength?: number | null;
  reasoning?: string | null;
  evidence_refs?: string[];
}

export interface QuarantinedEvidence {
  evidence_id?: string | null;
  source_tool?: string | null;
  uri?: string | null;
  excerpt?: string | null;
  // Detection reasons, when the review function sends them.
  reasons?: string[];
}

export interface CaseScope {
  affected_services?: string[];
  time_window?: { start?: string; end?: string } | null;
}

export interface ReviewView {
  task_id: string | null;
  kind: ReviewKind;
  state: string | null;
  release: string | null;
  case_id?: string | null;
  // held
  marker?: string;
  hypotheses?: Hypothesis[];
  quarantined?: QuarantinedEvidence[];
  limitations?: string[];
  advisories?: string[];
  // no_diagnosis / missing_fields
  needs?: ({ question?: string } | string)[];
  case_scope?: CaseScope | null;
  missing_fields?: string[];
  known_services?: string[];
}

export interface ApproveBody {
  reviewer: string;
  marker: string;
  rank: number;
}

export interface ReinvestigateBody {
  reviewer: string;
  affected_services: string[];
  time_window: { start: string; end: string };
  context?: string;
  case_id?: string;
}
