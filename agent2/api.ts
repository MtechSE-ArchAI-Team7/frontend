import type { ActionStarted, ApproveBody, CaseView, CasesResponse, ReinvestigateBody, ReviewView } from "./types";

// The page is shared by all agents but each agent's gateway is its own Lambda, so this
// agent's API base is configurable at build time (VITE_AGENT2_API, e.g. the Function URL
// of agent2-log-ui, no trailing slash). Unset means same origin, which is what the Vite dev
// proxy and the standalone log-ui page use.
const API_BASE = ((import.meta.env.VITE_AGENT2_API as string | undefined) ?? "").replace(/\/+$/, "");

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    // The gateway's own words for a refused review action (409 REFUSED, 400 INVALID_REQUEST).
    public readonly reason?: string,
  ) {
    super(code);
    this.name = "GatewayError";
  }
}

async function request<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, signal });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new GatewayError("INVALID_GATEWAY_RESPONSE", response.ok ? 502 : response.status);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GatewayError("INVALID_GATEWAY_RESPONSE", response.status);
  }
  const body = parsed as Record<string, unknown>;
  if (!response.ok) {
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    throw new GatewayError(String(body.error ?? `HTTP_${response.status}`), response.status, reason);
  }
  return body as T;
}

export function listCases(sinceHours: number, signal?: AbortSignal): Promise<CasesResponse> {
  return request(`/api/cases?since_hours=${sinceHours}`, signal);
}

export function getCase(caseId: string, sinceHours: number, signal?: AbortSignal): Promise<CaseView> {
  return request(`/api/cases/${encodeURIComponent(caseId)}?since_hours=${sinceHours}`, signal);
}

function reviewPath(taskId: string, action: string, release: string | null | undefined): string {
  const query = release ? `?release=${encodeURIComponent(release)}` : "";
  return `/api/review/tasks/${encodeURIComponent(taskId)}${action}${query}`;
}

// The review routes are the gateway's too (diagnosis-agent log-ui/backend/review_routes.py),
// the only ones that write. The release picks the endpoint the gateway asks; it then takes
// the release from the task itself, so a wrong one finds nothing rather than acting elsewhere.
export function getReview(taskId: string, release: string | null | undefined, signal?: AbortSignal): Promise<ReviewView> {
  return request(reviewPath(taskId, "", release), signal);
}

function post(path: string, body: unknown, signal?: AbortSignal): Promise<ActionStarted> {
  return request(path, signal, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 202 means Agent 2 has the new task, whose id comes back, not that it went through: Agent 2
// may still refuse it (its review limits, the approval claim). 409 is the gateway's refusal,
// before anything was sent; 502 AGENT2_UNAVAILABLE means Agent 2 did not take it.
export function approve(
  taskId: string,
  release: string | null | undefined,
  body: ApproveBody,
  signal?: AbortSignal,
): Promise<ActionStarted> {
  return post(reviewPath(taskId, "/approve", release), body, signal);
}

export function reinvestigate(
  taskId: string,
  release: string | null | undefined,
  body: ReinvestigateBody,
  signal?: AbortSignal,
): Promise<ActionStarted> {
  return post(reviewPath(taskId, "/reinvestigate", release), body, signal);
}

const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: "The gateway still asks for a token. Deploy the agent2-log-ui gateway without it.",
  GATEWAY_NOT_CONFIGURED: "The gateway is missing its configuration (log group).",
  INVALID_CASE_ID: "That is not a valid case id.",
  INVALID_SINCE: "That time range is not allowed.",
  CLOUDWATCH_ACCESS_DENIED: "The gateway is not allowed to read CloudWatch.",
  LOG_GROUP_NOT_FOUND: "The configured log group does not exist.",
  CLOUDWATCH_RATE_LIMITED: "CloudWatch is throttling requests. Try again in a moment.",
  UPSTREAM_FAILED: "CloudWatch returned an error.",
  INVALID_GATEWAY_RESPONSE: "The gateway returned something that was not JSON. It may have timed out.",
};

export function describeError(error: unknown): string {
  if (error instanceof GatewayError) return MESSAGES[error.code] ?? error.code;
  return "The gateway could not be reached.";
}

const REVIEW_MESSAGES: Record<string, string> = {
  REVIEW_NOT_CONFIGURED: "The gateway is not set up for review actions (no Agent 2 runtime configured).",
  INVALID_TASK_ID: "That is not a valid task id.",
  TASK_NOT_FOUND: "Agent 2 has no such task on this release's endpoint.",
  INVALID_BODY: "The gateway could not read the request.",
  AGENT2_UNAVAILABLE: "The gateway could not reach Agent 2.",
  NOT_FOUND: "The gateway has no review routes. It may predate them.",
  METHOD_NOT_ALLOWED: "The gateway has no such review route.",
  INVALID_GATEWAY_RESPONSE: "The gateway returned something that was not JSON. It may have timed out.",
};

export function describeReviewError(error: unknown): string {
  if (error instanceof GatewayError) {
    if (error.reason) return error.reason;
    return REVIEW_MESSAGES[error.code] ?? error.code;
  }
  return "The gateway could not be reached.";
}

// On a POST, 502 AGENT2_UNAVAILABLE is definite: Agent 2 did not take the task, so nothing
// was started and the reviewer may try again.
export function notStarted(error: unknown): boolean {
  return error instanceof GatewayError && error.status === 502 && error.code === "AGENT2_UNAVAILABLE";
}
