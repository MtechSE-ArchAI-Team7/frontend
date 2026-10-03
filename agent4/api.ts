// Agent 4 reads the eval_agent receiver directly (runs + artifacts). Like
// Agent 2's gateway base, the receiver base is configurable at build time
// (VITE_AGENT4_API, no trailing slash). The default is the receiver's local
// compose port; unset falls back to it so `npm run dev` works out of the box.
const DEFAULT_BASE = "http://localhost:8000";

export const API_BASE = ((import.meta.env.VITE_AGENT4_API as string | undefined) ?? DEFAULT_BASE).replace(/\/+$/, "");

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "GatewayError";
  }
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { signal });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new GatewayError("INVALID_RECEIVER_RESPONSE", response.ok ? 502 : response.status);
  }
  if (!response.ok) {
    throw new GatewayError(`HTTP_${response.status}`, response.status);
  }
  return parsed as T;
}

async function requestText(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${API_BASE}${path}`, { signal });
  if (!response.ok) {
    throw new GatewayError(`HTTP_${response.status}`, response.status);
  }
  return response.text();
}

// GET /runs.json — run summaries, newest first (see receiver webhook.py).
export interface RunSummary {
  run_id: string;
  case_id: string | null;
  remediation_draft: boolean;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  overall: "PASS" | "FAIL" | "INCONCLUSIVE" | null;
  pr: { number: number | null; title: string | null } | null;
}

export function listRuns(signal?: AbortSignal): Promise<RunSummary[]> {
  return requestJson<RunSummary[]>("/runs.json", signal);
}

// The run.json artifact (served via GET /runs/<id>/run.json, redacted on serve).
export interface LedgerEvent {
  at: string;
  stage: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RunLedger {
  run_id?: string;
  case_id?: string | null;
  remediation_draft?: boolean;
  status?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  events?: LedgerEvent[];
  artifacts?: Record<string, { path?: string; bytes?: number }>;
}

export function getLedger(runId: string, signal?: AbortSignal): Promise<RunLedger> {
  return requestJson<RunLedger>(`/runs/${encodeURIComponent(runId)}/run.json`, signal);
}

export function getReport(runId: string, signal?: AbortSignal): Promise<string> {
  return requestText(`/runs/${encodeURIComponent(runId)}/report.md`, signal);
}

export function artifactUrl(runId: string, name: string): string {
  return `${API_BASE}/runs/${encodeURIComponent(runId)}/${encodeURIComponent(name)}`;
}

const MESSAGES: Record<string, string> = {
  INVALID_RECEIVER_RESPONSE: "The receiver returned something that was not JSON. It may not be running.",
  HTTP_404: "That run or artifact was not found on the receiver.",
};

export function describeError(error: unknown): string {
  if (error instanceof GatewayError) return MESSAGES[error.code] ?? error.code.toLowerCase().replaceAll("_", " ");
  return "The receiver could not be reached. Check that it is running and reachable.";
}
