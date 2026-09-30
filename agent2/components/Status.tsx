import { TONE_ICON, type Tone } from "../format";

export function Status({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-icon" aria-hidden="true">
        {TONE_ICON[tone]}
      </span>
      {label}
    </span>
  );
}
