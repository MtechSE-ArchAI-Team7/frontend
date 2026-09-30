import { useState } from "react";

export function TokenGate({ message, onSubmit }: { message: string | null; onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h1>Agent 2 logs</h1>
        <p className="muted">Enter the access token. It is kept for this browser tab only.</p>
        <label htmlFor="agent2-token">Access token</label>
        <input
          id="agent2-token"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {message && (
          <p className="gate-error" role="alert">
            {message}
          </p>
        )}
        <button type="submit" disabled={!value.trim()}>
          Continue
        </button>
      </form>
    </div>
  );
}
