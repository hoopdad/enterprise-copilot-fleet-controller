#!/bin/bash
# tests/test-usage-metrics-scenarios.sh — Scenario tests for usage metrics schema fields
#
# Covers:
#   1) Fresh init scenario via scripts/init.sh
#   2) Upgrade scenario via scripts/upgrade.sh
#
# Verifies generated projects emit .metrics/usage.jsonl entries with enhanced fields.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LATEST_VERSION="$(cat "$FRAMEWORK_DIR/VERSION" | tr -d '[:space:]')"
WORK_ROOT="$SCRIPT_DIR/.scenario-workspace"

PASS=0
FAIL=0
TESTS_RUN=0

cleanup() {
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT

assert_success() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$1" -eq 0 ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $2"
  fi
}

ensure_python_deps() {
  if ! python3 -c "import mcp" >/dev/null 2>&1; then
    echo "Installing python dependencies for MCP tools..."
    pip install -q -r "$FRAMEWORK_DIR/tools/requirements.txt"
  fi
}

validate_usage_entry() {
  local usage_file="$1"
  local scenario_name="$2"

  python3 - "$usage_file" "$scenario_name" <<'PY'
import json
import sys
from pathlib import Path

usage_path = Path(sys.argv[1])
scenario = sys.argv[2]

if not usage_path.exists():
    raise SystemExit(f"{scenario}: missing usage log at {usage_path}")

lines = [ln.strip() for ln in usage_path.read_text().splitlines() if ln.strip()]
if not lines:
    raise SystemExit(f"{scenario}: usage log is empty")

entry = json.loads(lines[-1])
candidate = ["event_id", "run_id", "origin", "status", "duration_ms"]
present = [k for k in candidate if k in entry]

if len(present) < 3:
    raise SystemExit(
        f"{scenario}: expected >=3 enhanced fields from {candidate}, got {present}. "
        f"Entry: {entry}"
    )

for key in ("event_id", "run_id", "origin", "status"):
    if key in entry and (not isinstance(entry[key], str) or not entry[key].strip()):
        raise SystemExit(f"{scenario}: field '{key}' must be a non-empty string. Entry: {entry}")

if "duration_ms" in entry:
    value = entry["duration_ms"]
    if not isinstance(value, (int, float)) or value < 0:
        raise SystemExit(f"{scenario}: field 'duration_ms' must be a non-negative number. Entry: {entry}")
PY
}

emit_usage_via_tracker() {
  local project_dir="$1"

  PROJECT_DIR="$project_dir" PROJECT_NAME="$(basename "$project_dir")" FRAMEWORK_DIR="$FRAMEWORK_DIR" \
  python3 - <<'PY'
import importlib.util
import os

server_path = os.path.join(os.environ["FRAMEWORK_DIR"], "tools", "usage-tracker", "server.py")
spec = importlib.util.spec_from_file_location("usage_tracker_server", server_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.log_usage(agent="scenario-test", action="task_start", detail="scenario usage schema validation")
PY
}

scenario_fresh_init() {
  echo "═══ Scenario 1: Fresh init usage metrics fields ═══"
  local scenario_dir="$WORK_ROOT/fresh-init"
  local project_dir="$scenario_dir/project"

  mkdir -p "$project_dir"

  cat > "$scenario_dir/init.yml" <<'YAML'
project:
  name: scenario-project
  description: "Scenario test project"
  app_description: "Usage schema validation project"
  create_repos: false
  github_owner: testowner
  parent_dir: ""
  enable_mcp: true

children:
  - name: scenario-api
    url: ""
    role: "backend"
    description: "API backend"
YAML

  mkdir -p "$scenario_dir/mock-bin"
  cat > "$scenario_dir/mock-bin/copilot" <<'MOCK'
#!/bin/bash
exit 0
MOCK
  cat > "$scenario_dir/mock-bin/gh" <<'MOCK'
#!/bin/bash
exit 0
MOCK
  chmod +x "$scenario_dir/mock-bin/copilot" "$scenario_dir/mock-bin/gh"

  (
    cd "$project_dir"
    git init -q
    git commit --allow-empty -m "init" -q
    PATH="$scenario_dir/mock-bin:$PATH" bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$scenario_dir/init.yml" --start-phase 1 >/dev/null 2>&1
  )

  emit_usage_via_tracker "$project_dir"
  validate_usage_entry "$project_dir/.metrics/usage.jsonl" "fresh-init"
}

scenario_upgrade() {
  echo "═══ Scenario 2: Upgrade usage metrics fields ═══"
  local scenario_dir="$WORK_ROOT/upgrade"
  local project_dir="$scenario_dir/project"

  mkdir -p "$project_dir/.copilot"
  cat > "$project_dir/.framework-version" <<'EOF'
2.4.0
EOF
  cat > "$project_dir/.copilot/mcp.json" <<EOF
{
  "_framework_version": "2.4.0",
  "mcpServers": {
    "usage-tracker": {
      "description": "Append usage events, summarize recent workflow activity, and report usage quality/anomalies.",
      "command": "python3",
      "args": ["$FRAMEWORK_DIR/tools/usage-tracker/server.py"],
      "env": {
        "PROJECT_DIR": "$project_dir",
        "PROJECT_NAME": "scenario-project-upgrade"
      }
    }
  }
}
EOF
  cat > "$project_dir/.copilot/instructions.md" <<'EOF'
# Orchestrator

## MCP Tools

| Tool | When to Use |
|------|-------------|
| `log_usage` | Record orchestration events with status + timing metadata for correlation |

## Usage Metrics Schema (v2.4.0+)

When using `log_usage`, include enriched fields whenever known:
- `status`: `"success"` or `"failure"` for task/tool outcomes
- `duration_ms`: elapsed time for completed operations
- `run_id`/`event_id`/`parent_event_id`: keep correlation across delegations
- `origin`: use `"top_level"` for root work and `"nested"` for delegated flows

## Anti-Patterns
- placeholder
EOF

  (
    cd "$project_dir"
    git init -q
    git add -A
    git commit -m "seed pre-upgrade project" -q
    bash "$FRAMEWORK_DIR/scripts/upgrade.sh" --project-dir "$project_dir" >/dev/null 2>&1
  )

  if [[ ! -f "$project_dir/.framework-version" ]] || ! grep -q "$LATEST_VERSION" "$project_dir/.framework-version"; then
    echo "  FAIL: upgrade scenario did not move project to framework v$LATEST_VERSION"
    return 1
  fi
  if ! grep -q "\"_framework_version\": \"$LATEST_VERSION\"" "$project_dir/.github/mcp.json"; then
    echo "  FAIL: upgrade scenario did not refresh MCP framework metadata to v$LATEST_VERSION"
    return 1
  fi
  if ! grep -q '"azure-resource-status"' "$project_dir/.github/mcp.json"; then
    echo "  FAIL: upgrade scenario did not add azure-resource-status tool"
    return 1
  fi
  if ! grep -q '"lint-local"' "$project_dir/.github/mcp.json"; then
    echo "  FAIL: upgrade scenario did not add lint-local tool"
    return 1
  fi
  if ! grep -q '"terraform-local"' "$project_dir/.github/mcp.json"; then
    echo "  FAIL: upgrade scenario did not add terraform-local tool"
    return 1
  fi
  if ! grep -q 'usage quality/anomalies' "$project_dir/.github/mcp.json"; then
    echo "  FAIL: upgrade scenario did not refresh usage-tracker guidance"
    return 1
  fi
  if ! grep -q '"repo-index"' "$project_dir/.github/mcp.json"; then
    echo "  FAIL: upgrade scenario did not add repo-index MCP tool"
    return 1
  fi
  if ! grep -q '"child-agent-runner"' "$project_dir/.github/mcp.json"; then
    echo "  FAIL: upgrade scenario did not add child-agent-runner MCP tool"
    return 1
  fi
  if [[ ! -f "$project_dir/.repo-index.yml" ]]; then
    echo "  FAIL: upgrade scenario did not create .repo-index.yml"
    return 1
  fi
  if ! grep -q '## Usage Metrics Schema (v2.5.0+)' "$project_dir/.github/copilot-instructions.md"; then
    echo "  FAIL: upgrade scenario did not refresh usage schema guidance"
    return 1
  fi
  if ! grep -q '## Usage Quality Reporting (v2.5.0+)' "$project_dir/.github/copilot-instructions.md"; then
    echo "  FAIL: upgrade scenario did not add usage quality reporting guidance"
    return 1
  fi
  if ! grep -q 'terraform_fmt_check' "$project_dir/.github/copilot-instructions.md"; then
    echo "  FAIL: upgrade scenario did not refresh orchestrator terraform guidance"
    return 1
  fi

  emit_usage_via_tracker "$project_dir"
  validate_usage_entry "$project_dir/.metrics/usage.jsonl" "upgrade"
}

echo "═══ Usage Metrics Scenario Tests ═══"
ensure_python_deps
rm -rf "$WORK_ROOT"
mkdir -p "$WORK_ROOT"

set +e
scenario_fresh_init
assert_success $? "fresh init scenario failed"

scenario_upgrade
assert_success $? "upgrade scenario failed"
set -e

echo ""
echo "═══ Results ═══"
echo "  Tests: $TESTS_RUN  Pass: $PASS  Fail: $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "  ✗ SOME SCENARIOS FAILED"
  exit 1
else
  echo "  ✓ ALL SCENARIOS PASSED"
  exit 0
fi
