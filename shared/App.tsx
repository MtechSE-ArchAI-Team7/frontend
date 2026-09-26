import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import Agent3App from "../agent3/App";

const AGENTS = [
  { id: "agent1", label: "Agent 1" },
  { id: "agent2", label: "Agent 2" },
  { id: "agent3", label: "Agent 3" },
  { id: "agent4", label: "Agent 4" },
] as const;

export type AgentId = (typeof AGENTS)[number]["id"];

export default function App() {
  const [activeAgent, setActiveAgent] = useState<AgentId>("agent3");
  const [homeSignal, setHomeSignal] = useState(0);
  const tabRefs = useRef<Record<AgentId, HTMLButtonElement | null>>({
    agent1: null,
    agent2: null,
    agent3: null,
    agent4: null,
  });

  function selectAgent(agentId: AgentId) {
    setActiveAgent(agentId);
  }

  function handleAgentTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % AGENTS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + AGENTS.length) % AGENTS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = AGENTS.length - 1;
    else return;

    event.preventDefault();
    const nextAgent = AGENTS[nextIndex].id;
    selectAgent(nextAgent);
    tabRefs.current[nextAgent]?.focus();
  }

  function goHome() {
    selectAgent("agent3");
    setHomeSignal((current) => current + 1);
  }

  return (
    <div className="console-root">
      <header className="utility-header">
        <a className="product-brand" href="#overview" aria-label="AIOS Operations home" onClick={goHome}>
          <span className="product-mark">A</span>
          <span>AIOS Operations</span>
        </a>
        <div className="utility-context">
          <span>Singapore</span>
          <span className="utility-divider" />
          <span>Resolution service</span>
          <span className="health-indicator"><i /> Available</span>
        </div>
      </header>

      <nav className="agent-tabs" aria-label="AIOS agents" role="tablist">
        {AGENTS.map((agent, index) => (
          <button
            key={agent.id}
            id={`agent-tab-${agent.id}`}
            ref={(element) => { tabRefs.current[agent.id] = element; }}
            type="button"
            role="tab"
            aria-selected={activeAgent === agent.id}
            aria-controls={`agent-panel-${agent.id}`}
            tabIndex={activeAgent === agent.id ? 0 : -1}
            onClick={() => selectAgent(agent.id)}
            onKeyDown={(event) => handleAgentTabKeyDown(event, index)}
          >
            {agent.label}
          </button>
        ))}
      </nav>

      <section
        id="agent-panel-agent3"
        role="tabpanel"
        aria-labelledby="agent-tab-agent3"
        hidden={activeAgent !== "agent3"}
      >
        <Agent3App homeSignal={homeSignal} />
      </section>

      {AGENTS.filter((agent) => agent.id !== "agent3").map((agent) => (
        <main
          key={agent.id}
          id={`agent-panel-${agent.id}`}
          className="empty-agent-workspace"
          role="tabpanel"
          aria-labelledby={`agent-tab-${agent.id}`}
          hidden={activeAgent !== agent.id}
        />
      ))}
    </div>
  );
}
