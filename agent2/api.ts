import type { ApproveBody, CaseView, CasesResponse, ReinvestigateBody, ReviewView } from "./types";

// The page is shared by all agents but each agent's gateway is its own Lambda, so this
// agent's API base is configurable at build time (VITE_AGENT2_API, e.g. the Function URL
// of agent2-log-ui, no trailing slash). Unset means same origin, which is what the Vite dev
// proxy and the standalone log-ui page use.
const API_BASE = ((import.meta.env.VITE_AGENT2_API as string | undefined) ?? "").replace(/\/+$/, "");

// The review function (agent2-review) is a second Lambda with its own Function URL: it is
// the only thing here that writes, and it is kept apart from the read-only gateway above.
// Unset means same origin, which the Vite dev proxy forwards to its dev server; a production
// build without it has no review function to call (reviewConfigured()).
function reviewBase(): string {
  return ((import.meta.env.VITE_AGENT2_REVIEW_API as string | undefined) ?? "").replace(/\/+$/, "");
}

export function reviewConfigured(): boolean {
  return reviewBase() !== "" || import.meta.env.DEV;
}

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    // The review function's own words for a refusal (409 REFUSED, 400 INVALID_REQUEST).
    public readonly reason?: string,
  ) {
    super(code);
    this.name = "GatewayError";
  }
}

async function request<T>(path: string, signal?: AbortSignal, base = API_BASE, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, { ...init, signal });
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

// The release picks the endpoint the function asks; the function then takes the release
// from the task itself, so a wrong one finds nothing rather than acting elsewhere.
export function getReview(taskId: string, release: string | null | undefined, signal?: AbortSignal): Promise<ReviewView> {
  return request(reviewPath(taskId, "", release), signal, reviewBase());
}

function post(path: string, body: unknown, signal?: AbortSignal): Promise<{ accepted: boolean }> {
  return request(path, signal, reviewBase(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 202 means handed to the review function's worker, not done: the outcome shows up later as
// a new request row in the case view. 409 carries the reason it was refused.
export function approve(
  taskId: string,
  release: string | null | undefined,
  body: ApproveBody,
  signal?: AbortSignal,
): Promise<{ accepted: boolean }> {
  return post(reviewPath(taskId, "/approve", release), body, signal);
}

export function reinvestigate(
  taskId: string,
  release: string | null | undefined,
  body: ReinvestigateBody,
  signal?: AbortSignal,
): Promise<{ accepted: boolean }> {
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
  REVIEW_NOT_CONFIGURED: "The review function is missing its configuration (Agent 2 runtime).",
  INVALID_TASK_ID: "That is not a valid task id.",
  TASK_NOT_FOUND: "Agent 2 has no such task on this release's endpoint.",
  INVALID_BODY: "The review function could not read the request.",
  AGENT2_UNAVAILABLE: "The review function could not reach Agent 2.",
  NOT_FOUND: "The review function has no such route. Is VITE_AGENT2_REVIEW_API its Function URL?",
  METHOD_NOT_ALLOWED: "The review function has no such route.",
  INVALID_GATEWAY_RESPONSE: "The review function returned something that was not JSON. It may have timed out.",
};

export function describeReviewError(error: unknown): string {
  if (error instanceof GatewayError) {
    if (error.reason) return error.reason;
    return REVIEW_MESSAGES[error.code] ?? error.code;
  }
  return "The review function could not be reached.";
}
