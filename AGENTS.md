# AIOS Frontend Contributor Guide

## Ownership

This repository is the shared browser shell for AIOS Agents 1–4. Keep changes within the owning agent's directory. Agent 3 contributors may update `agent3/` and the minimum shared shell or release integration needed for Agent 3, but must not refactor Agent 1, Agent 2, or Agent 4 features.

## Production releases

- Production UI releases must use `.github/workflows/deploy-agent3-ui.yaml` from `main`.
- The workflow is manually dispatched and targets the protected `production` environment. A successful push does not authorize or trigger a deployment.
- Every dispatch requires explicit operator release authorization and the least-privilege `AWS_UI_DEPLOY_ROLE_ARN` GitHub Actions secret.
- Never add automatic production deployment for ordinary pushes, pull requests, dependency updates, security-control changes, runtime changes, or another agent's changes.
- Do not run `aws lambda update-function-code`, `make deploy`, or `scripts/deploy_agent3_ui.sh` locally for a normal release. The local path is reserved for an explicitly authorized emergency operator repair and must preserve the same checks and rollback behavior.
- Never create or modify IAM roles, Lambda configuration, Function URLs, AgentCore runtimes, or other infrastructure from this repository's release workflow.

## Release validation

- Run `make check` before committing frontend changes.
- Preserve the Agent 3 validation-output controls (`View output`, `View error`, and the truncation notice) and their regression tests.
- Supply `VITE_AGENT2_API` and `VITE_AGENT4_API` at production build time. Treat these values as public browser configuration, not credentials.
- The deployment workflow may update only the code package of `aios-remediation-demo-ui` in AWS account `734849394833`, Region `ap-southeast-1`.
- A failed health, asset, run-list, provider, or feature-marker smoke check must restore the previous Lambda code package.

## Git safety

- Do not commit credentials, bearer tokens, generated production bundles, or Lambda archives.
- Do not commit, push, merge, or deploy unless the user explicitly authorizes that action for the current task.
- If branch protection requires review, use the protected pull-request path; never bypass it.
