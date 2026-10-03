# AIOS Frontend

This repository contains the shared browser shell for the AIOS demonstration and the independently owned UI surfaces for Agents 1–4.

## Repository layout

```text
shared/            Shared application entry point, utility header, agent navigation, and shell tests
agent1/            Reserved for Agent 1; intentionally empty
agent2/            Agent 2 log viewer (front end only; its gateway is deployed from the diagnosis-agent repository)
agent3/            Resolution/remediation console and its Lambda gateway
agent4/            Agent 4 post-merge runs console (front end only; reads the eval_agent receiver)
scripts/           Guarded deployment tooling
```

Agent 3 is selected by default. Selecting Agent 1 leaves the workspace blank while keeping the shared headers available. The Agent 3, Agent 2, and Agent 4 consoles retain their state when another agent tab is selected.

## Agent 4 post-merge runs console

Agent 4's tab reads the `eval_agent` receiver (source and deployment live in the `mcp-atlassian-agent` repository, `atlassian_agent.webhook`). The receiver serves read-only JSON with `Access-Control-Allow-Origin: *`, so no gateway of its own is needed.

- `GET <receiver>/runs.json` — run summaries, newest first: run id, PR, case badge (`CASE-xxx` plus a `remediation draft` marker), status, overall verdict (PASS green / FAIL red / INCONCLUSIVE amber), started time.
- Clicking a run opens the detail view: gate-verdict table from `run.json` (last `gates graded` event), artifact list linking through the receiver's `GET /runs/<id>/<artifact>` route, and the run's `report.md` rendered as pre-formatted text. `report.md` 404s until the run reaches Stage F; that shows as "no report yet", not an error.
- `VITE_AGENT4_API` sets the receiver base URL at build time (no trailing slash). Unset defaults to `http://localhost:8000`, the receiver's compose port — `npm run dev` works against a locally running receiver with no configuration.
- The receiver redacts secret-shaped strings on serve, and the tab calls only GET routes; the webhook write route accepts no cross-origin calls.

## Agent 2 log viewer

Agent 2's tab reads its own gateway, `agent2-log-ui` (source, tests, and deployment live in the diagnosis-agent repository). Every request needs the gateway's bearer token, which the tab asks for and keeps in `sessionStorage`.

- `VITE_AGENT2_API` sets the gateway's base URL at build time (its Function URL, no path). Unset means the page's own origin. The gateway must list the page's origin in `LOG_UI_ALLOWED_ORIGINS` (Terraform variable `allowed_origins` in diagnosis-agent `infra/log-ui`).
- For local work, run the gateway's `dev_server.py` from diagnosis-agent (`127.0.0.1:8787`) and leave `VITE_AGENT2_API` unset: `npm run dev` proxies `/api/cases` to it.
- Case links are `#/agent2/<case id>`; opening one selects the Agent 2 tab. Agent 2 does not call its gateway until its tab is first opened.
- `agent2/styles.css` is scoped to `.agent2-root`. Keep it that way: the other agents' stylesheets are global, and nothing in `agent2/` may change how they render.

## Development

The project uses Node.js for the React/Vite application and Python 3.12 with `uv` for the Agent 3 Lambda gateway tests.

```bash
make sync
make typecheck
make test
make build
```

The production build is written to `agent3/backend/site/` and is not committed.

The Agent 3 scenario under `agent3/scenarios/` is the browser's demonstration input. The generated tool catalogue under `agent3/generated/` is a presentation snapshot of the remediation service's typed `/v1/tools` contract. When the service catalogue or demonstration handoff changes, update the corresponding Agent 3 snapshot and its tests in the same change.

## Agent 3 deployment

`make deploy` runs a clean dependency install, typecheck, frontend and gateway tests, and production build before updating the existing `aios-remediation-demo-ui` Lambda in AWS account `734849394833` and region `ap-southeast-1`.

The deployment changes only the Lambda code package. It verifies the existing runtime, handler, ARM64 architecture, timeout, state, and AWS account before writing. After deployment it checks the health route, compiled JavaScript asset, bounded run listing, and explicit provider probe. A failed smoke check restores the previous package automatically. It never starts a remediation run, changes Lambda configuration, or provisions infrastructure.

Required Lambda environment values remain operator-managed:

- `AGENTCORE_RUNTIME_ARN`
- `AGENTCORE_REGION=ap-southeast-1`
- `AGENTCORE_QUALIFIER=DEFAULT`
