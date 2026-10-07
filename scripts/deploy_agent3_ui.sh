#!/usr/bin/env bash
set -euo pipefail

readonly expected_account="734849394833"
readonly aws_region="ap-southeast-1"
readonly function_name="aios-remediation-demo-ui"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ui_root="${repository_root}/agent3"
readonly python_executable="${repository_root}/.venv/bin/python"
readonly agent1_api="${VITE_AGENT1_API:-}"
readonly agent2_api="${VITE_AGENT2_API:-}"
readonly agent4_api="${VITE_AGENT4_API:-}"

for command_name in aws curl uv zip; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required deployment command is unavailable: ${command_name}" >&2
    exit 1
  fi
done

if [[ ! -x "$python_executable" ]]; then
  echo "The project Python 3.12 environment is missing. Run uv sync --frozen first." >&2
  exit 1
fi

if [[ ! -f "${ui_root}/backend/site/index.html" ]]; then
  echo "The production UI build is missing. Run make build first." >&2
  exit 1
fi

if [[ "$agent2_api" != "https://sz3tbpu564gwikyhk2j3f7jn6y0vsusz.lambda-url.ap-southeast-1.on.aws" ]]; then
  echo "VITE_AGENT2_API does not match the approved production gateway." >&2
  exit 1
fi
if [[ ! "$agent1_api" =~ ^https://[A-Za-z0-9.-]+\.lambda-url\.ap-southeast-1\.on\.aws$ ]]; then
  echo "VITE_AGENT1_API must be the Agent 1 HTTPS Lambda Function URL in ap-southeast-1." >&2
  exit 1
fi
if [[ "$agent4_api" != "http://localhost:8000" && ! "$agent4_api" =~ ^https://[^/]+$ ]]; then
  echo "VITE_AGENT4_API must be the accepted local fallback or an HTTPS origin without a path." >&2
  exit 1
fi

verify_ui_asset() {
  local asset_file="$1" marker
  for marker in \
    "View output" \
    "View error" \
    "Output was truncated by the validation limit." \
    "Post-merge runs" \
    "$agent1_api" \
    "$agent2_api" \
    "$agent4_api"; do
    if ! grep -Fq -- "$marker" "$asset_file"; then
      echo "The UI asset is missing the required release marker: ${marker}" >&2
      return 1
    fi
  done
}

local_asset_path="$(find "${ui_root}/backend/site/assets" -maxdepth 1 -type f -name '*.js' -print -quit)"
if [[ -z "$local_asset_path" ]]; then
  echo "The production UI build does not contain a JavaScript asset." >&2
  exit 1
fi
verify_ui_asset "$local_asset_path"

actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$actual_account" != "$expected_account" ]]; then
  echo "Refusing to deploy from AWS account ${actual_account}; expected ${expected_account}." >&2
  exit 1
fi

IFS=$'\t' read -r runtime handler architecture timeout state update_status < <(
  aws lambda get-function-configuration \
    --function-name "$function_name" \
    --region "$aws_region" \
    --query '[Runtime,Handler,Architectures[0],Timeout,State,LastUpdateStatus]' \
    --output text
)
if [[ "$runtime" != "python3.12" || "$handler" != "handler.lambda_handler" || "$architecture" != "arm64" ||
      "$timeout" != "900" || "$state" != "Active" || "$update_status" != "Successful" ]]; then
  echo "Refusing to deploy because the existing Lambda configuration does not match the approved target." >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/aios-demo-ui-deploy.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
readonly package_dir="${work_dir}/package"
readonly archive_path="${work_dir}/demo-ui.zip"
readonly previous_archive="${work_dir}/previous.zip"
mkdir -p "$package_dir"

previous_code_url="$(
  aws lambda get-function \
    --function-name "$function_name" \
    --region "$aws_region" \
    --query 'Code.Location' \
    --output text
)"
curl --fail --silent --show-error "$previous_code_url" --output "$previous_archive"

uv pip install \
  --quiet \
  --only-binary=:all: \
  --python-version 3.12 \
  --python-platform aarch64-manylinux2014 \
  --requirement "${ui_root}/backend/requirements.txt" \
  --target "$package_dir"
cp "${ui_root}/backend/handler.py" "${package_dir}/handler.py"
cp -R "${ui_root}/backend/site" "${package_dir}/site"
(
  cd "$package_dir"
  zip -q -r "$archive_path" .
)

rollback() {
  echo "Deployment smoke check failed; restoring the previous Lambda package." >&2
  aws lambda update-function-code \
    --function-name "$function_name" \
    --region "$aws_region" \
    --zip-file "fileb://${previous_archive}" \
    --output json >/dev/null
  aws lambda wait function-updated-v2 --function-name "$function_name" --region "$aws_region"
}

smoke_checks() {
  local function_url base_url health_file index_file asset_path asset_file runs_file probe_file
  function_url="$(
    aws lambda get-function-url-config \
      --function-name "$function_name" \
      --region "$aws_region" \
      --query 'FunctionUrl' \
      --output text
  )"
  base_url="${function_url%/}"
  health_file="${work_dir}/health.json"
  index_file="${work_dir}/index.html"
  asset_file="${work_dir}/asset.js"
  runs_file="${work_dir}/runs.json"
  probe_file="${work_dir}/probe.json"

  curl --fail-with-body --silent --show-error "${base_url}/api/health" --output "$health_file" || return 1
  "$python_executable" -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data == {"status":"Healthy","service":"aios-remediation-demo-ui"}' "$health_file" || return 1

  curl --fail-with-body --silent --show-error "$base_url/" --output "$index_file" || return 1
  grep -q '<div id="root"></div>' "$index_file" || return 1
  asset_path="$(sed -n 's#.*src="\(/assets/[^"]*\.js\)".*#\1#p' "$index_file" | head -n 1)"
  if [[ -z "$asset_path" ]]; then
    echo "The deployed index did not reference a JavaScript asset." >&2
    return 1
  fi
  curl --fail --silent --show-error "${base_url}${asset_path}" --output "$asset_file" || return 1
  verify_ui_asset "$asset_file" || return 1

  curl --fail-with-body --silent --show-error "${base_url}/api/runs" --output "$runs_file" || return 1
  "$python_executable" -c 'import json,sys; data=json.load(open(sys.argv[1])); output=data["output"]; assert output["schema_version"] == "1.0"; assert isinstance(output["runs"], list); assert len(output["runs"]) <= 20' "$runs_file" || return 1

  curl --fail-with-body --silent --show-error \
    --max-time 890 \
    --request POST \
    --header 'Content-Type: application/json' \
    --data '{}' \
    "${base_url}/api/probe" \
    --output "$probe_file" || return 1
  "$python_executable" -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["output"]["status"] == "ok"; assert data["output"]["provider"] == "openai"' "$probe_file" || return 1
  echo "$function_url"
}

aws lambda update-function-code \
  --function-name "$function_name" \
  --region "$aws_region" \
  --zip-file "fileb://${archive_path}" \
  --output json >/dev/null
aws lambda wait function-updated-v2 --function-name "$function_name" --region "$aws_region"

if ! deployed_url="$(smoke_checks)"; then
  rollback
  exit 1
fi

echo "Demo UI deployed and verified: ${deployed_url}"
