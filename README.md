# AIOS Frontend

This repository contains the shared browser shell for the AIOS demonstration and the independently owned UI surfaces for Agents 1–4.

## Repository layout

```text
shared/            Shared application entry point, utility header, agent navigation, and shell tests
agent1/            Agent 1 helpdesk workflow console and CloudWatch gateway
agent2/            Agent 2 log viewer (front end only; its gateway is deployed from the diagnosis-agent repository)
agent3/            Resolution/remediation console and its Lambda gateway
agent4/            Agent 4 post-merge runs console (front end only; reads the eval_agent receiver)
scripts/           Guarded deployment tooling
```

Agent 3 is selected by default. Agent 1, Agent 2, and Agent 4 are mounted on first selection and retain their state when another agent tab is selected.

## Agent 1 helpdesk operations console

Agent 1 is a read-only operator view over structured helpdesk workflow events. It shows recent runs, their terminal outcome and triage summary, the deterministic routing gates and thresholds, and a timestamped workflow activity timeline. It polls every 15 seconds while its tab is active. A run without a terminal event is shown as running and marked stale after a minute without a new event; missing telemetry is not treated as proof that no action occurred.

The UI reads a separately provisioned Agent 1 gateway. Set `VITE_AGENT1_API` to the gateway's HTTPS Function URL (no trailing slash) at build time. If it is unset, the tab clearly reports that its data source is not configured; it does not call Agent 3's `/api/runs` endpoint or display fabricated run status. The UI does not prompt for or send an application bearer token and warns operators that gateway login is disabled.

The gateway source is `agent1/backend/handler.py`. Deploy it as a Python Lambda with a Function URL and configure:

- `HELPDESK_AGENT_LOG_GROUP` — exact CloudWatch log group receiving the helpdesk-agent container's application logs.
- `AGENT1_LOG_UI_ALLOWED_ORIGINS` — comma-separated exact UI origins; avoid wildcard origins.
- `AWS_REGION` — region containing the log group.

Grant the gateway role only `logs:FilterLogEvents` on that log group. The handler exposes read-only `GET /api/runs?since_hours=24|72|168|336` and `GET /api/runs/<run-id>?since_hours=...`; it does not expose arbitrary CloudWatch queries, raw application logs, or log text. The Lambda's maximum event window is bounded, and its `partial` flag tells the UI when the configured limit was reached. Configure the Function URL with auth type `NONE` for direct browser access. The gateway has no application-level authentication: its URL is publicly callable, and CORS only controls which browser origins may read responses; it is not access control for non-browser clients. Do not use this setup for sensitive or restricted operational data unless the gateway is placed behind a real access-control layer such as an authenticated API gateway or private network.

The helpdesk agent emits versioned `agent_event=` records for workflow starts/finishes, named steps, and clarification/FAQ routing decisions. Its gateway filters only those records and returns allowlisted fields. Event case references are SHA-256-derived opaque identifiers; customer messages, raw prompts, and unrestricted log content are not displayed. CloudWatch ingestion/retention, gateway deployment, IAM, Function URL, and build-time API URL remain operator-managed; this repository's Agent 3 release workflow does not provision or update them.

The Agent 3 console treats a denied inspection call as guardrail activity. It marks Inspect complete only when the
trace contains the terminal `REPOSITORY_INSPECTED` event, and it keeps unrecovered inspection errors failed. This also
corrects presentation of immutable older traces whose raw summary used `code=MUTABLE_REF_DENIED`.

## Agent 4 post-merge runs console

Agent 4's tab reads the `eval_agent` receiver (source and deployment live in the `mcp-atlassian-agent` repository, `atlassian_agent.webhook`). The receiver serves read-only JSON with `Access-Control-Allow-Origin: *`, so no gateway of its own is needed.

- `GET <receiver>/runs.json` — run summaries, newest first: run id, PR, case badge (`CASE-xxx` plus a `remediation draft` marker), status, overall verdict (PASS green / FAIL red / INCONCLUSIVE amber), started time.
- Clicking a run opens the detail view: gate-verdict table from `run.json` (last `gates graded` event), artifact list linking through the receiver's `GET /runs/<id>/<artifact>` route, and the run's `report.md` rendered as pre-formatted text. `report.md` 404s until the run reaches Stage F; that shows as "no report yet", not an error.
- `VITE_AGENT4_API` sets the receiver base URL at build time (no trailing slash). Unset defaults to `http://localhost:8000`, the receiver's compose port — `npm run dev` works against a locally running receiver with no configuration.
- The receiver redacts secret-shaped strings on serve, and the tab calls only GET routes; the webhook write route accepts no cross-origin calls.

The current production release default intentionally keeps `VITE_AGENT4_API=http://localhost:8000` until the Agent 4 owner provides a public receiver URL. The Agent 4 tab is present, but remote browsers cannot retrieve run data with that fallback. Supply the approved HTTPS receiver origin when it becomes available and run a new guarded release.

## Agent 2 log viewer

Agent 2's tab reads its own gateway, `agent2-log-ui` (source, tests, and deployment live in the diagnosis-agent repository). The gateway has no login, so the tab opens straight onto the case list and sends no token. Anyone who can reach the gateway's URL can read its (redacted) case data.

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

Run details expose bounded validation stdout or stderr through `View output` and `View error`. When the runtime reports that its output cap was reached, the UI displays `Output was truncated by the validation limit.` These controls are release-protected feature markers.

## Agent 3 deployment

Normal releases use the manually dispatched **Deploy Agent 3 UI** workflow from `main`. The workflow runs `make check`, embeds the approved Agent 2 and Agent 4 browser endpoints, obtains short-lived AWS credentials through GitHub OIDC, and then updates the existing `aios-remediation-demo-ui` Lambda in AWS account `734849394833` and Region `ap-southeast-1`.

The repository Actions secret `AWS_UI_DEPLOY_ROLE_ARN` must contain the release role ARN. This private repository belongs to a GitHub Free organization, where environment secrets and deployment-branch protection are unavailable, so the workflow deliberately does not target a GitHub environment. The role's OIDC trust policy is the authoritative branch guard and must match only the immutable repository subject for `main`:

```text
repo:MtechSE-ArchAI-Team7@301624271/frontend@1388403410:ref:refs/heads/main
```

The role grants only the calls needed to inspect and update the code package of:

```text
arn:aws:lambda:ap-southeast-1:734849394833:function:aios-remediation-demo-ui
```

The Lambda resource permissions are `lambda:GetFunction`, `lambda:GetFunctionConfiguration`, `lambda:GetFunctionUrlConfig`, and `lambda:UpdateFunctionCode`; the workflow also needs `sts:GetCallerIdentity` for its account guard. It does not need any Lambda configuration, IAM, AgentCore, or infrastructure mutation permission.

The workflow does not create the role, change IAM, or modify Lambda configuration. It refuses non-`main` dispatches. The Agent 2 input is pinned to its approved Function URL; the Agent 4 input accepts the documented localhost fallback or a path-free HTTPS origin.

The deployment changes only the Lambda code package. It verifies the existing runtime, handler, ARM64 architecture, timeout, state, AWS account, compiled endpoint values, and protected Agent 3 feature markers before writing. After deployment it checks the health route, downloaded JavaScript asset and feature markers, bounded run listing, and explicit provider probe. A failed smoke check restores the previous package automatically. It never starts a remediation run, changes Lambda configuration, or provisions infrastructure.

`make deploy` and `scripts/deploy_agent3_ui.sh` remain available only for an explicitly authorized emergency operator repair. They require the production build URLs and enforce the same preflight and rollback checks as the workflow:

```bash
VITE_AGENT1_API=https://<agent1-function-id>.lambda-url.ap-southeast-1.on.aws \
VITE_AGENT2_API=https://sz3tbpu564gwikyhk2j3f7jn6y0vsusz.lambda-url.ap-southeast-1.on.aws \
VITE_AGENT4_API=http://localhost:8000 \
make deploy
```

When manually running the `Deploy Agent 3 UI` workflow, enter the Agent 1 gateway Function URL in the required `agent1-api-url` input, just as the workflow asks for the Agent 2 and Agent 4 URLs. Use the HTTPS Lambda Function URL without a trailing slash; this is a public endpoint URL, not a secret.

Required Lambda environment values remain operator-managed:

- `AGENTCORE_RUNTIME_ARN`
- `AGENTCORE_REGION=ap-southeast-1`
- `AGENTCORE_QUALIFIER=DEFAULT`
