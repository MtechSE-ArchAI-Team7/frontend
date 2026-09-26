# AIOS Frontend

This repository contains the shared browser shell for the AIOS demonstration and the independently owned UI surfaces for Agents 1–4.

## Repository layout

```text
shared/            Shared application entry point, utility header, agent navigation, and shell tests
agent1/            Reserved for Agent 1; intentionally empty
agent2/            Reserved for Agent 2; intentionally empty
agent3/            Resolution/remediation console and its Lambda gateway
agent4/            Reserved for Agent 4; intentionally empty
scripts/           Guarded deployment tooling
```

Agent 3 is selected by default. Selecting Agent 1, Agent 2, or Agent 4 leaves the workspace blank while keeping the shared headers available. The Agent 3 console retains its state when another agent tab is selected.

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
