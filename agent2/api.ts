import type { CaseView, CasesResponse } from "./types";

const TOKEN_KEY = "agent2-log-ui-token";

// The page is shared by all agents but each agent's gateway is its own Lambda, so this
// agent's API base is configurable at build time (VITE_AGENT2_API, e.g. the Function URL
// of agent2-log-ui, no trailing slash). Unset means same origin, which is what the Vite dev
// proxy and the standalone log-ui page use.
const API_BASE = ((import.meta.env.VITE_AGENT2_API as string | undefined) ?? "").replace(/\/+$/, "");

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "GatewayError";
  }
}

// sessionStorage, not localStorage: the token should not outlive the tab. Storage can
// throw (private mode, blocked site data), in which case the token lives in memory only.
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
    /* memory only */
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GatewayError("INVALID_GATEWAY_RESPONSE", response.status);
  }
  const body = parsed as Record<string, unknown>;
  if (!response.ok) {
    throw new GatewayError(String(body.error ?? `HTTP_${response.status}`), response.status);
  }
  return body as T;
}

export function listCases(sinceHours: number, signal?: AbortSignal): Promise<CasesResponse> {
  return request(`/api/cases?since_hours=${sinceHours}`, signal);
}

export function getCase(caseId: string, sinceHours: number, signal?: AbortSignal): Promise<CaseView> {
  return request(`/api/cases/${encodeURIComponent(caseId)}?since_hours=${sinceHours}`, signal);
}

const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: "The token was not accepted.",
  GATEWAY_NOT_CONFIGURED: "The gateway is missing its configuration (token secret or log group).",
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
