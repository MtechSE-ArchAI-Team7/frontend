// Mirrors log-ui/backend/timeline.py and handler.py. The backend is the source of truth.

export interface CaseRow {
  case_id: string;
  outcome: string;
  delivered?: unknown;
  first_seen: string;
  last_seen: string;
  requests: number;
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
  kind: "investigation" | "approval";
  first_seen: string;
  last_seen: string;
  outcome: Brief | null;
  delivery: Brief | null;
  jira: Brief | null;
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
