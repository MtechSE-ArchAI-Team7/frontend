import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import Agent1App from "../agent1/App";
import Agent2App, { HASH_PREFIX as AGENT2_HASH_PREFIX } from "../agent2/App";
import Agent3App from "../agent3/App";
import Agent4App from "../agent4/App";

const AGENT1_HASH_PREFIX = "#/agent1/";

const AGENTS = [
  { id: "agent1", label: "Agent 1" },
  { id: "agent2", label: "Agent 2" },
  { id: "agent3", label: "Agent 3" },
  { id: "agent4", label: "Agent 4" },
] as const;

export type AgentId = (typeof AGENTS)[number]["id"];

export default function App() {
  // Agent links open directly; otherwise Agent 3 remains the default workspace.
  const [activeAgent, setActiveAgent] = useState<AgentId>(() =>
    window.location.hash.startsWith(AGENT1_HASH_PREFIX)
      ? "agent1"
      : window.location.hash.startsWith(AGENT2_HASH_PREFIX)
        ? "agent2"
        : "agent3",
  );
  const [agent1Opened, setAgent1Opened] = useState(activeAgent === "agent1");
  // Agent 2 calls its gateway as soon as it mounts, so it is not mounted until its tab is
  // first opened; after that it stays mounted like Agent 3, keeping its selection.
  const [agent2Opened, setAgent2Opened] = useState(activeAgent === "agent2");
  // Agent 4 likewise calls its receiver on mount, so it is deferred until its tab is
  // first opened; after that it stays mounted like Agent 3, keeping its run selection.
  const [agent4Opened, setAgent4Opened] = useState(activeAgent === "agent4");
  const [homeSignal, setHomeSignal] = useState(0);
  const tabRefs = useRef<Record<AgentId, HTMLButtonElement | null>>({
    agent1: null,
    agent2: null,
    agent3: null,
    agent4: null,
  });

  function selectAgent(agentId: AgentId) {
    if (agentId === "agent1") setAgent1Opened(true);
    if (agentId === "agent2") setAgent2Opened(true);
    if (agentId === "agent4") setAgent4Opened(true);
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
        <a className="product-brand" href="#runs" aria-label="AIOS Operations home" onClick={goHome}>
          <span className="product-mark">A</span>
          <span>AIOS Operations</span>
        </a>
        <div className="utility-context">
          <span>Singapore</span>
          <span className="utility-divider" />
          <span>Resolution service</span>
          {activeAgent !== "agent1" && <span className="health-indicator"><i /> Available</span>}
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

      <section
        id="agent-panel-agent2"
        role="tabpanel"
        aria-labelledby="agent-tab-agent2"
        hidden={activeAgent !== "agent2"}
      >
        {agent2Opened && <Agent2App active={activeAgent === "agent2"} />}
      </section>

      <section
        id="agent-panel-agent4"
        role="tabpanel"
        aria-labelledby="agent-tab-agent4"
        hidden={activeAgent !== "agent4"}
      >
        {agent4Opened && <Agent4App />}
      </section>

      <section
        id="agent-panel-agent1"
        role="tabpanel"
        aria-labelledby="agent-tab-agent1"
        hidden={activeAgent !== "agent1"}
      >
        {agent1Opened && <Agent1App active={activeAgent === "agent1"} />}
      </section>
    </div>
  );
}
