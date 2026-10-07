import type { RunDetail, RunResponse, RunSummary, RunsResponse, WorkflowEvent } from "./types";

const TOKEN_KEY = "agent1-log-ui-token";
const API_BASE = (import.meta.env.VITE_AGENT1_API ?? "").replace(/\/+$/, "");
export const isGatewayConfigured = Boolean(API_BASE);

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "GatewayError";
  }
}

let memoryToken: string | null = null;

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Keep the session usable when browser storage is unavailable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function request(path: string, signal?: AbortSignal): Promise<unknown> {
  if (!isGatewayConfigured) throw new GatewayError("GATEWAY_NOT_CONFIGURED", 503);
  const token = getToken();
  const response = await fetch(`${API_BASE}${path}`, {
    signal,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new GatewayError("INVALID_GATEWAY_RESPONSE", response.ok ? 502 : response.status);
  }
  if (!isRecord(parsed)) {
    throw new GatewayError("INVALID_GATEWAY_RESPONSE", response.status);
  }
  if (!response.ok) {
    throw new GatewayError(String(parsed.error ?? `HTTP_${response.status}`), response.status);
  }
  return parsed;
}

function parseSummary(value: unknown): RunSummary | null {
  if (!isRecord(value)) return null;
  const requiredStrings = ["run_id", "case_id", "first_seen", "last_seen", "status", "current_step"];
  if (requiredStrings.some((key) => typeof value[key] !== "string")) return null;
  if (typeof value.event_count !== "number" || !Number.isInteger(value.event_count) || value.event_count < 0) return null;
  const nullableStrings = ["terminal_outcome", "ticket_id", "trace_id", "service", "issue_type", "priority"];
  if (nullableStrings.some((key) => value[key] !== null && typeof value[key] !== "string")) return null;
  if (value.confidence !== null && (typeof value.confidence !== "number" || !Number.isFinite(value.confidence))) return null;
  return value as unknown as RunSummary;
}

function parseEvent(value: unknown): WorkflowEvent | null {
  if (!isRecord(value)) return null;
  const stringFields = ["event_id", "run_id", "case_id", "timestamp", "stage", "actor_type", "action", "status", "summary"];
  if (stringFields.some((key) => typeof value[key] !== "string")) return null;
  if (value.schema_version !== "1.0" || value.event_type !== "helpdesk.workflow.event") return null;
  if (value.trace_id !== null && typeof value.trace_id !== "string") return null;
  if (value.duration_ms !== undefined && (typeof value.duration_ms !== "number" || !Number.isFinite(value.duration_ms))) return null;
  if (!isRecord(value.details)) return null;
  if (Object.values(value.details).some((item) =>
    typeof item !== "string"
    && typeof item !== "number"
    && typeof item !== "boolean"
    && !(Array.isArray(item) && item.every((entry) => typeof entry === "string")))) return null;
  return value as unknown as WorkflowEvent;
}

function validEnvelope(value: Record<string, unknown>): value is Record<string, unknown> & { partial: boolean } {
  return typeof value.partial === "boolean";
}

export async function listRuns(sinceHours: number, signal?: AbortSignal): Promise<RunsResponse> {
  const response = await request(`/api/runs?since_hours=${sinceHours}`, signal);
  if (!isRecord(response) || !validEnvelope(response) || !Array.isArray(response.runs)) {
    throw new GatewayError("INVALID_GATEWAY_RESPONSE", 502);
  }
  const runs = response.runs.map(parseSummary);
  if (runs.some((run) => run === null)) throw new GatewayError("INVALID_GATEWAY_RESPONSE", 502);
  return { runs: runs as RunSummary[], partial: response.partial };
}

export async function getRun(runId: string, sinceHours: number, signal?: AbortSignal): Promise<RunResponse> {
  const response = await request(`/api/runs/${encodeURIComponent(runId)}?since_hours=${sinceHours}`, signal);
  if (!isRecord(response) || !validEnvelope(response) || !isRecord(response.run) || !Array.isArray(response.run.events)) {
    throw new GatewayError("INVALID_GATEWAY_RESPONSE", 502);
  }
  const summary = parseSummary(response.run);
  const events = response.run.events.map(parseEvent);
  if (!summary || events.some((event) => event === null)) throw new GatewayError("INVALID_GATEWAY_RESPONSE", 502);
  const run: RunDetail = { ...summary, events: events as WorkflowEvent[] };
  return { run, partial: response.partial };
}

const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: "The access token was not accepted.",
  GATEWAY_NOT_CONFIGURED: "The Agent 1 log gateway is missing its token or CloudWatch log-group configuration.",
  INVALID_SINCE: "That time range is not allowed.",
  INVALID_RUN_ID: "That run identifier is not valid.",
  RUN_NOT_FOUND: "No Agent 1 events for that run were found in the selected time range.",
  CLOUDWATCH_ACCESS_DENIED: "The log gateway is not allowed to read the configured CloudWatch log group.",
  LOG_GROUP_NOT_FOUND: "The configured helpdesk-agent log group does not exist.",
  CLOUDWATCH_RATE_LIMITED: "CloudWatch is throttling requests. Try again in a moment.",
  UPSTREAM_FAILED: "CloudWatch returned an error.",
  INVALID_GATEWAY_RESPONSE: "The Agent 1 gateway returned an invalid response.",
  ORIGIN_NOT_ALLOWED: "This UI origin is not allowed by the Agent 1 gateway.",
};

export function describeError(error: unknown): string {
  if (error instanceof GatewayError) return MESSAGES[error.code] ?? error.code;
  return "The Agent 1 gateway could not be reached.";
}
