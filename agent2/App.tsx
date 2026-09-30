import { useCallback, useEffect, useState } from "react";
import { GatewayError, describeError, getToken, listCases, setToken } from "./api";
import { CaseList } from "./components/CaseList";
import { CaseDetail } from "./components/CaseDetail";
import { TokenGate } from "./components/TokenGate";
import type { CaseRow } from "./types";

export const RANGES = [
  { hours: 24, label: "24 h" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: 336, label: "14 days" },
] as const;

// The page is shared with the other agents, so this agent's deep links are namespaced:
// #/agent2/AH-39. Anything else in the hash (Agent 3's #runs, say) is not a case id.
export const HASH_PREFIX = "#/agent2/";

function caseFromHash(): string | null {
  const { hash } = window.location;
  if (!hash.startsWith(HASH_PREFIX)) return null;
  try {
    return decodeURIComponent(hash.slice(HASH_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

export default function App({ active }: { active: boolean }) {
  const [token, setTokenState] = useState<string | null>(getToken());
  const [gateMessage, setGateMessage] = useState<string | null>(null);

  const signOut = useCallback((message: string | null = null) => {
    setToken(null);
    setTokenState(null);
    setGateMessage(message);
  }, []);

  return (
    <div className="agent2-root">
      {token ? (
        <Shell
          active={active}
          onUnauthorized={() => signOut("The token was not accepted.")}
          onSignOut={() => signOut()}
        />
      ) : (
        <TokenGate
          message={gateMessage}
          onSubmit={(value) => {
            setToken(value);
            setTokenState(value);
            setGateMessage(null);
          }}
        />
      )}
    </div>
  );
}

function Shell({
  active,
  onUnauthorized,
  onSignOut,
}: {
  active: boolean;
  onUnauthorized: () => void;
  onSignOut: () => void;
}) {
  const [sinceHours, setSinceHours] = useState<number>(24);
  const [cases, setCases] = useState<CaseRow[] | null>(null);
  const [casesError, setCasesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(caseFromHash());
  const [reloadKey, setReloadKey] = useState(0);

  // Stays mounted while another agent's tab is showing, so the hash is only this agent's
  // business while its own tab is the active one.
  useEffect(() => {
    if (!active) return;
    const onHash = () => {
      const { hash } = window.location;
      // Another agent's link (#runs) says nothing about this agent's selection; an empty
      // hash (Back to the start) does.
      if (hash && !hash.startsWith(HASH_PREFIX)) return;
      setSelected(caseFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [active]);

  useEffect(() => {
    const controller = new AbortController();
    setCases(null);
    setCasesError(null);
    listCases(sinceHours, controller.signal)
      .then((body) => setCases(body.cases))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof GatewayError && error.status === 401) onUnauthorized();
        else setCasesError(describeError(error));
      });
    return () => controller.abort();
  }, [sinceHours, reloadKey, onUnauthorized]);

  const select = (caseId: string) => {
    window.location.hash = `${HASH_PREFIX.slice(1)}${encodeURIComponent(caseId)}`;
    setSelected(caseId);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <h1>Agent 2 logs</h1>
        <p className="topbar-sub">Container logs, spans and audit, joined per case</p>
        <div className="topbar-actions">
          <label className="range">
            <span>Range</span>
            <select value={sinceHours} onChange={(e) => setSinceHours(Number(e.target.value))}>
              {RANGES.map((r) => (
                <option key={r.hours} value={r.hours}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Refresh
          </button>
          <button type="button" className="ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <div className="layout">
        <CaseList cases={cases} error={casesError} selected={selected} onSelect={select} sinceHours={sinceHours} />
        <main className="main">
          {selected ? (
            <CaseDetail
              key={`${selected}:${sinceHours}:${reloadKey}`}
              caseId={selected}
              sinceHours={sinceHours}
              onUnauthorized={onUnauthorized}
            />
          ) : (
            <div className="empty">
              <p>Pick a case on the left, or type a case id to open one outside the list.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
