export interface RunSummary {
  run_id: string;
  case_id: string;
  first_seen: string;
  last_seen: string;
  status: string;
  current_step: string;
  terminal_outcome: string | null;
  ticket_id: string | null;
  trace_id: string | null;
  service: string | null;
  issue_type: string | null;
  priority: string | null;
  confidence: number | null;
  event_count: number;
}

export interface WorkflowEvent {
  schema_version: "1.0";
  event_type: "helpdesk.workflow.event";
  event_id: string;
  run_id: string;
  case_id: string;
  trace_id: string | null;
  timestamp: string;
  stage: string;
  actor_type: "DETERMINISTIC" | "MODEL_ASSISTED" | "TOOL" | string;
  action: string;
  status: string;
  summary: string;
  duration_ms?: number;
  details: Record<string, string | number | boolean | string[]>;
}

export interface RunDetail extends RunSummary {
  events: WorkflowEvent[];
}

export interface RunsResponse {
  runs: RunSummary[];
  partial: boolean;
}

export interface RunResponse {
  run: RunDetail;
  partial: boolean;
}
