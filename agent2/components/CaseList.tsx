import { useMemo, useState } from "react";
import { outcome, relative } from "../format";
import type { CaseRow } from "../types";
import { Status } from "./Status";

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

interface Props {
  cases: CaseRow[] | null;
  error: string | null;
  selected: string | null;
  sinceHours: number;
  onSelect: (caseId: string) => void;
}

export function CaseList({ cases, error, selected, sinceHours, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const shown = useMemo(
    () => (cases ?? []).filter((c) => c.case_id.toLowerCase().includes(trimmed.toLowerCase())),
    [cases, trimmed],
  );
  const canOpen = CASE_ID.test(trimmed) && !shown.some((c) => c.case_id === trimmed);

  return (
    <nav className="caselist" aria-label="Cases">
      <form
        className="caselist-search"
        onSubmit={(e) => {
          e.preventDefault();
          if (CASE_ID.test(trimmed)) onSelect(trimmed);
        }}
      >
        <input
          type="search"
          placeholder="Filter or open a case id"
          aria-label="Filter or open a case id"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {canOpen && (
          <button type="submit" className="ghost small">
            Open {trimmed}
          </button>
        )}
      </form>

      {error && (
        <p className="caselist-note error" role="alert">
          {error}
        </p>
      )}
      {!error && cases === null && <p className="caselist-note">Reading CloudWatch…</p>}
      {cases !== null && cases.length === 0 && (
        <p className="caselist-note">No case finished in the last {sinceHours} h.</p>
      )}

      <ul>
        {shown.map((c) => {
          const [tone, label] = outcome(c.outcome, c.delivered);
          return (
            <li key={c.case_id}>
              <button
                type="button"
                className={`caserow${c.case_id === selected ? " selected" : ""}`}
                aria-current={c.case_id === selected ? "true" : undefined}
                onClick={() => onSelect(c.case_id)}
              >
                <span className="caserow-top">
                  <span className="caserow-id">{c.case_id}</span>
                  <span className="caserow-time" title={c.last_seen}>
                    {relative(c.last_seen)}
                  </span>
                </span>
                <span className="caserow-bottom">
                  <Status tone={tone} label={label} />
                  {c.requests > 1 && <span className="muted small">{c.requests} requests</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
