#!/usr/bin/env bash
# Deploy the Agent 4 verification console: Lambda Function URL gateway backed by
# the s3://aios-eval-agent-runs store, serving the built SPA from agent4/backend/site.
# Mirrors deploy_agent3_ui.sh (account guard, package, update, smoke, rollback) and
# additionally bootstraps the bucket / execution role / function / URL idempotently,
# because unlike agent3 this function has no pre-existing approved target yet.
set -euo pipefail

readonly expected_account="734849394833"
readonly aws_region="ap-southeast-1"
readonly bucket_name="aios-eval-agent-runs"
readonly function_name="aios-eval-agent-ui"
readonly role_name="aios-eval-agent-ui-lambda"
readonly policy_name="ReadEvalAgentRunsAndWriteLogs"
readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Native Windows tools (uv, the venv python, mktemp paths handed to fileb://)
# cannot consume MSYS /d/... paths, so export a Windows-style mirror of the root.
readonly repository_root_win="$(cygpath -m "${repository_root}" 2>/dev/null || echo "${repository_root}")"
readonly ui_root="${repository_root}/agent4"
readonly ui_root_win="${repository_root_win}/agent4"
if [[ -e "${repository_root}/.venv/Scripts/python.exe" ]]; then
  readonly python_executable="${repository_root_win}/.venv/Scripts/python.exe"
else
  readonly python_executable="${repository_root_win}/.venv/bin/python"
fi

for command_name in aws curl uv; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required deployment command is unavailable: ${command_name}" >&2
    exit 1
  fi
done

if [[ ! -e "$python_executable" ]]; then
  echo "The project Python 3.12 environment is missing. Run uv sync --frozen first." >&2
  exit 1
fi

if [[ ! -f "${ui_root}/backend/site/index.html" ]]; then
  echo "The production UI build is missing. Run make build first." >&2
  exit 1
fi

actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$actual_account" != "$expected_account" ]]; then
  echo "Refusing to deploy from AWS account ${actual_account}; expected ${expected_account}." >&2
  exit 1
fi

# --- S3 runs store (block public access + TLS-only policy) -------------------
if ! aws s3api head-bucket --bucket "$bucket_name" --region "$aws_region" >/dev/null 2>&1; then
  echo "Creating runs bucket s3://${bucket_name}..."
  aws s3api create-bucket \
    --bucket "$bucket_name" \
    --region "$aws_region" \
    --create-bucket-configuration LocationConstraint="$aws_region" \
    --output json >/dev/null
fi
aws s3api put-public-access-block \
  --bucket "$bucket_name" --region "$aws_region" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  >/dev/null
aws s3api put-bucket-policy --bucket "$bucket_name" --region "$aws_region" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"DenyInsecureCommunications\",
    \"Effect\": \"Deny\",
    \"Principal\": \"*\",
    \"Action\": \"s3:*\",
    \"Resource\": [
      \"arn:aws:s3:::${bucket_name}\",
      \"arn:aws:s3:::${bucket_name}/*\"
    ],
    \"Condition\": {\"Bool\": {\"aws:SecureTransport\": \"false\"}}
  }]
}" >/dev/null

# --- Execution role -----------------------------------------------------------
role_arn="$(aws iam get-role --role-name "$role_name" --query 'Role.Arn' --output text 2>/dev/null || true)"
if [[ -z "$role_arn" ]]; then
  echo "Creating execution role ${role_name}..."
  role_arn="$(aws iam create-role \
    --role-name "$role_name" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "lambda.amazonaws.com"},
        "Action": "sts:AssumeRole"
      }]
    }' \
    --query 'Role.Arn' --output text)"
fi

if ! aws iam get-role-policy --role-name "$role_name" --policy-name "$policy_name" >/dev/null 2>&1; then
  echo "Attaching inline policy ${policy_name}..."
  aws iam put-role-policy \
    --role-name "$role_name" \
    --policy-name "$policy_name" \
    --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [
        {
          \"Sid\": \"ReadEvalAgentRunsOnly\",
          \"Effect\": \"Allow\",
          \"Action\": [\"s3:GetObject\"],
          \"Resource\": \"arn:aws:s3:::${bucket_name}/runs/*\"
        },
        {
          \"Sid\": \"ListBucketSoMissingKeysAre404\",
          \"Effect\": \"Allow\",
          \"Action\": [\"s3:ListBucket\"],
          \"Resource\": \"arn:aws:s3:::${bucket_name}\"
        },
        {
          \"Sid\": \"CreateAgent4LogGroup\",
          \"Effect\": \"Allow\",
          \"Action\": \"logs:CreateLogGroup\",
          \"Resource\": \"arn:aws:logs:${aws_region}:${expected_account}:*\"
        },
        {
          \"Sid\": \"WriteAgent4FunctionLogs\",
          \"Effect\": \"Allow\",
          \"Action\": [\"logs:CreateLogStream\", \"logs:PutLogEvents\"],
          \"Resource\": \"arn:aws:logs:${aws_region}:${expected_account}:log-group:/aws/lambda/${function_name}:*\"
        }
      ]
    }" >/dev/null
fi

# --- Lambda function (create on first deploy, then update) -------------------
# mktemp under MSYS /tmp yields a path native tools can't read; use a Windows-style
# scratch dir so uv --target, python zipping, and fileb:// all agree.
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/aios-agent4-ui-deploy.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
work_dir_win="$(cygpath -m "$work_dir" 2>/dev/null || echo "$work_dir")"
readonly package_dir="${work_dir}/package"
readonly package_dir_win="${work_dir_win}/package"
readonly archive_path="${work_dir_win}/agent4-ui.zip"
readonly previous_archive="${work_dir_win}/previous.zip"
mkdir -p "$package_dir"

function_exists="$(aws lambda get-function-configuration \
  --function-name "$function_name" --region "$aws_region" \
  --query 'State' --output text 2>/dev/null || true)"

if [[ -n "$function_exists" && "$function_exists" != "None" ]]; then
  previous_code_url="$(aws lambda get-function \
    --function-name "$function_name" --region "$aws_region" \
    --query 'Code.Location' --output text)"
  curl --fail --silent --show-error "$previous_code_url" --output "$previous_archive"
fi

uv pip install \
  --quiet \
  --only-binary=:all: \
  --python-version 3.12 \
  --python-platform aarch64-manylinux2014 \
  --requirement "${ui_root_win}/backend/requirements.txt" \
  --target "$package_dir_win"
cp "${ui_root}/backend/handler.py" "${package_dir}/handler.py"
cp -R "${ui_root}/backend/site" "${package_dir}/site"

"$python_executable" - "$archive_path" "$package_dir_win" <<'PY'
import pathlib, sys, zipfile
archive, root = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            bundle.write(path, path.relative_to(root).as_posix())
print(f"packaged {archive.stat().st_size} bytes")
PY

if [[ -z "$function_exists" || "$function_exists" == "None" ]]; then
  echo "Creating Lambda function ${function_name}..."
  # Role propagation can lag creation by a few seconds.
  for attempt in 1 2 3 4 5; do
    if aws lambda create-function \
      --function-name "$function_name" \
      --region "$aws_region" \
      --runtime python3.12 \
      --handler handler.lambda_handler \
      --architectures arm64 \
      --timeout 60 \
      --memory-size 512 \
      --environment "Variables={RUNS_BUCKET=${bucket_name}}" \
      --role "$role_arn" \
      --zip-file "fileb://${archive_path}" \
      --output json >/dev/null; then
      break
    fi
    sleep 5
  done
else
  aws lambda update-function-configuration \
    --function-name "$function_name" \
    --region "$aws_region" \
    --environment "Variables={RUNS_BUCKET=${bucket_name}}" \
    --output json >/dev/null || true
  aws lambda wait function-updated-v2 --function-name "$function_name" --region "$aws_region"
  aws lambda update-function-code \
    --function-name "$function_name" \
    --region "$aws_region" \
    --zip-file "fileb://${archive_path}" \
    --output json >/dev/null
fi
aws lambda wait function-updated-v2 --function-name "$function_name" --region "$aws_region"

# --- Function URL (public, no auth — read-only demo data) --------------------
function_url="$(aws lambda get-function-url-config \
  --function-name "$function_name" --region "$aws_region" \
  --query 'FunctionUrl' --output text 2>/dev/null || true)"
if [[ -z "$function_url" ]]; then
  echo "Creating public Function URL..."
  function_url="$(aws lambda create-function-url-config \
    --function-name "$function_name" \
    --region "$aws_region" \
    --auth-type NONE \
    --cors 'AllowMethods=["*"],AllowHeaders=["content-type"],AllowOrigins=["*"],MaxAge=86400' \
    --query 'FunctionUrl' --output text)"
  aws lambda add-permission \
    --function-name "$function_name" \
    --region "$aws_region" \
    --statement-id function-url-invocation \
    --action lambda:InvokeFunctionUrl \
    --principal '*' \
    --function-url-auth-type NONE \
    --output json >/dev/null 2>&1 || true
fi
# Auth-type NONE needs BOTH statements (the console adds this pair; the InvokeFunctionUrl
# action alone leaves the URL returning 403 AccessDeniedException):
aws lambda add-permission \
  --function-name "$function_name" \
  --region "$aws_region" \
  --statement-id FunctionURLAllowInvokeFunction \
  --action lambda:InvokeFunction \
  --principal '*' \
  --invoked-via-function-url \
  --output json >/dev/null 2>&1 || true

# --- Smoke checks against the live URL ---------------------------------------
smoke_checks() {
  local base_url health_file index_file runs_file report_file run_id
  base_url="${function_url%/}"
  health_file="${work_dir_win}/health.json"
  index_file="${work_dir_win}/index.html"
  runs_file="${work_dir_win}/runs.json"
  report_file="${work_dir_win}/report.md"

  curl --fail-with-body --silent --show-error --max-time 30 "${base_url}/healthz" --output "$health_file" || return 1
  "$python_executable" -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data == {"status":"Healthy","service":"aios-eval-agent-ui"}' "$health_file" || return 1

  curl --fail-with-body --silent --show-error --max-time 30 "${base_url}/" --output "$index_file" || return 1
  grep -q '<div id="root"></div>' "$index_file" || return 1
  local asset_path
  asset_path="$(sed -n 's#.*src="\(/assets/[^"]*\.js\)".*#\1#p' "$index_file" | head -n 1)"
  if [[ -z "$asset_path" ]]; then
    echo "The deployed index did not reference a JavaScript asset." >&2
    return 1
  fi
  curl --fail --silent --show-error --max-time 30 --head "${base_url}${asset_path}" >/dev/null || return 1

  curl --fail-with-body --silent --show-error --max-time 30 "${base_url}/runs.json" --output "$runs_file" || return 1
  "$python_executable" -c 'import json,sys; data=json.load(open(sys.argv[1])); assert isinstance(data, list); assert len(data) >= 1; assert all("run_id" in r for r in data)' "$runs_file" || return 1

  run_id="$("$python_executable" -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["run_id"])' "$runs_file")"
  curl --fail-with-body --silent --show-error --max-time 30 "${base_url}/runs/${run_id}/run.json" --output "${work_dir_win}/run.json" || return 1
  curl --fail-with-body --silent --show-error --max-time 30 "${base_url}/runs/${run_id}/report.md" --output "$report_file" || return 1
  grep -q '# ' "$report_file" || return 1
  echo "$function_url"
}

if ! deployed_url="$(smoke_checks)"; then
  if [[ -f "$previous_archive" ]]; then
    echo "Deployment smoke check failed; restoring the previous Lambda package." >&2
    aws lambda update-function-code \
      --function-name "$function_name" \
      --region "$aws_region" \
      --zip-file "fileb://${previous_archive}" \
      --output json >/dev/null
    aws lambda wait function-updated-v2 --function-name "$function_name" --region "$aws_region"
  fi
  exit 1
fi

echo "Agent 4 UI deployed and verified: ${deployed_url}"
echo "Build the shell with: VITE_AGENT4_API=${deployed_url%/}"
