#!/bin/bash
# tests/test-init.sh — Integration test for scripts/init.sh
#
# Verifies: project structure is generated correctly from a config file.
# Does NOT invoke copilot CLI (mocks it) to keep tests self-contained.
#
# Usage: bash tests/test-init.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRAMEWORK_VERSION="$(cat "$FRAMEWORK_DIR/VERSION" | tr -d '[:space:]')"
PASS=0
FAIL=0
TESTS_RUN=0

# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────
cleanup() {
  if [[ -n "${TEST_DIR:-}" && -d "$TEST_DIR" ]]; then
    rm -rf "$TEST_DIR"
  fi
}
trap cleanup EXIT

assert_file_exists() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ -f "$1" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: expected file: $1"
  fi
}

assert_dir_exists() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ -d "$1" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: expected directory: $1"
  fi
}

assert_file_contains() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if grep -q "$2" "$1" 2>/dev/null; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $1 should contain '$2'"
  fi
}

assert_file_not_exists() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ ! -e "$1" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: expected NOT to exist: $1"
  fi
}

assert_dir_not_exists() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ ! -d "$1" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: expected directory NOT to exist: $1"
  fi
}

assert_exit_code() {
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$1" -eq "$2" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: expected exit code $2, got $1"
  fi
}

# ─────────────────────────────────────────────────────────────
# Setup: create temp directory and mock copilot CLI
# ─────────────────────────────────────────────────────────────
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lean-test-init.XXXXXX")
echo "Test workspace: $TEST_DIR"

# Mock copilot command — no-op for deterministic template paths
MOCK_BIN="$TEST_DIR/mock-bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/copilot" << 'MOCK'
#!/bin/bash
# Mock copilot with optional metrics output and argument assertions.
if [[ -n "${COPILOT_LOG:-}" ]]; then
  echo "$*" >> "$COPILOT_LOG"
fi
if [[ "${MOCK_REQUIRE_URL_ALLOWLIST:-false}" == "true" ]]; then
  for required in \
    "--allow-url https://azure.com" \
    "--allow-url http://azure.com" \
    "--allow-url https://*.azure.com" \
    "--allow-url http://*.azure.com" \
    "--allow-url https://github.com" \
    "--allow-url http://github.com" \
    "--allow-url https://*.github.com" \
    "--allow-url http://*.github.com" \
    "--allow-url https://microsoft.com" \
    "--allow-url http://microsoft.com" \
    "--allow-url https://*.microsoft.com" \
    "--allow-url http://*.microsoft.com"; do
    if [[ "$*" != *"$required"* ]]; then
      echo "missing allowlist arg: $required" >&2
      exit 1
    fi
  done
fi
if [[ -n "${MOCK_COPILOT_OUTPUT:-}" ]]; then
  call_count=1
  if [[ -n "${MOCK_COPILOT_COUNTER_FILE:-}" ]]; then
    if [[ -f "$MOCK_COPILOT_COUNTER_FILE" ]]; then
      call_count=$(cat "$MOCK_COPILOT_COUNTER_FILE" 2>/dev/null || echo "0")
      if ! [[ "$call_count" =~ ^[0-9]+$ ]]; then
        call_count=0
      fi
    else
      call_count=0
    fi
    call_count=$((call_count + 1))
    echo "$call_count" > "$MOCK_COPILOT_COUNTER_FILE"
  fi
  if [[ -n "${MOCK_COPILOT_ZERO_METRICS_UNTIL_CALL:-}" ]] && [[ "$call_count" -le "$MOCK_COPILOT_ZERO_METRICS_UNTIL_CALL" ]]; then
    printf '%b\n' "Input tokens: 0\nOutput tokens: 0\nTotal tokens: 0\nSTATUS: PASS\nFINDINGS:\n- none\nREMEDIATION_HINTS:\n- none"
  elif [[ -n "${MOCK_COPILOT_OUTPUT_JSON:-}" ]]; then
    printf '%b\n' "$MOCK_COPILOT_OUTPUT_JSON"
  else
    printf '%b\n' "$MOCK_COPILOT_OUTPUT"
  fi
fi
exit "${MOCK_COPILOT_EXIT_CODE:-0}"
MOCK
chmod +x "$MOCK_BIN/copilot"

# Mock gh command
cat > "$MOCK_BIN/gh" << 'MOCK'
#!/bin/bash
if [[ -n "${GH_LOG:-}" ]]; then
  echo "$*" >> "$GH_LOG"
fi
if [[ "$*" == *"repo create"* ]]; then
  echo "https://github.com/testowner/test-repo"
elif [[ "$*" == *"repo view"* ]]; then
  exit 1  # repo doesn't exist yet
fi
MOCK
chmod +x "$MOCK_BIN/gh"

export PATH="$MOCK_BIN:$PATH"

# Create test config
cat > "$TEST_DIR/init.yml" << 'CONFIG'
project:
  name: test-project
  description: "Integration test project"
  app_description: "A test app for CI validation"
  create_repos: false
  github_owner: testowner
  parent_dir: ""

children:
  - name: test-api
    url: ""
    role: "backend"
    description: "API backend"
  - name: test-web
    url: ""
    role: "frontend"
    description: "Web frontend"
CONFIG

# ─────────────────────────────────────────────────────────────
# Test 1: Syntax check of init wrapper + core scripts
# ─────────────────────────────────────────────────────────────
echo ""
echo "═══ Test 1: Syntax validation ═══"
bash -n "$FRAMEWORK_DIR/scripts/init.sh"
assert_exit_code $? 0
bash -n "$FRAMEWORK_DIR/scripts/init-core.sh"
assert_exit_code $? 0
python3 -m py_compile "$FRAMEWORK_DIR/scripts/init.py"
assert_exit_code $? 0

# ─────────────────────────────────────────────────────────────
# Test 1a: init wrapper delegates to Python entrypoint
# ─────────────────────────────────────────────────────────────
echo "═══ Test 1a: init wrapper delegates to Python entrypoint ═══"
PYTHON_WRAPPER_LOG="$TEST_DIR/python-wrapper.log"
cat > "$MOCK_BIN/python-wrapper" << 'MOCK'
#!/bin/bash
echo "$*" > "$PYTHON_WRAPPER_LOG"
exit 0
MOCK
chmod +x "$MOCK_BIN/python-wrapper"

set +e
PYTHON_WRAPPER_LOG="$PYTHON_WRAPPER_LOG" PYTHON="$MOCK_BIN/python-wrapper" bash "$FRAMEWORK_DIR/scripts/init.sh" --help > /dev/null 2>&1
RC=$?
set -e
assert_exit_code $RC 0
assert_file_contains "$PYTHON_WRAPPER_LOG" "init.py --help"

# ─────────────────────────────────────────────────────────────
# Test 2: --help flag exits cleanly via wrapper/core path
# ─────────────────────────────────────────────────────────────
echo "═══ Test 2: --help exits 0 ═══"
bash "$FRAMEWORK_DIR/scripts/init.sh" --help > /dev/null 2>&1
assert_exit_code $? 0

# ─────────────────────────────────────────────────────────────
# Test 3: Missing config file fails
# ─────────────────────────────────────────────────────────────
echo "═══ Test 3: Missing config errors ═══"
set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config /nonexistent.yml > /dev/null 2>&1
RC=$?
set -e
assert_exit_code $RC 1

# ─────────────────────────────────────────────────────────────
# Test 4: Run init — verify current structure
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4: Init generates current project structure ═══"

PROJECT_DIR="$TEST_DIR/test-project"
CHILD_API_DIR="$TEST_DIR/test-api"
CHILD_WEB_DIR="$TEST_DIR/test-web"
mkdir -p "$PROJECT_DIR"
cd "$PROJECT_DIR"
git init -q
git commit --allow-empty -m "init" -q

# Run init (phases 1-3 — structure + agents + orchestrator)
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init.yml" --start-phase 1 > "$TEST_DIR/init-output.log" 2>&1 || true

# Verify expected directories
assert_dir_exists "$PROJECT_DIR/.contracts"
assert_dir_exists "$PROJECT_DIR/.requirements"
assert_dir_exists "$PROJECT_DIR/.decisions"
assert_dir_exists "$PROJECT_DIR/.copilot"
assert_dir_not_exists "$PROJECT_DIR/.github/agents"
assert_dir_exists "$CHILD_API_DIR/.github/agents"
assert_dir_exists "$CHILD_WEB_DIR/.github/agents"
assert_dir_exists "$CHILD_API_DIR/work/todo"
assert_dir_exists "$CHILD_API_DIR/work/ready-for-review"
assert_dir_exists "$CHILD_API_DIR/work/done"
assert_dir_exists "$CHILD_WEB_DIR/work/todo"
assert_dir_exists "$CHILD_WEB_DIR/work/ready-for-review"
assert_dir_exists "$CHILD_WEB_DIR/work/done"

# Verify NO .agents/ directory (v1.x artifact)
assert_file_not_exists "$PROJECT_DIR/.agents"

# Verify framework version
assert_file_exists "$PROJECT_DIR/.framework-version"
if [[ -f "$PROJECT_DIR/.framework-version" ]]; then
  assert_file_contains "$PROJECT_DIR/.framework-version" "$FRAMEWORK_VERSION"
fi

# Verify repo index manifest
assert_file_exists "$PROJECT_DIR/.repo-index.yml"
if [[ -f "$PROJECT_DIR/.repo-index.yml" ]]; then
  assert_file_contains "$PROJECT_DIR/.repo-index.yml" "name: \"test-api\""
  assert_file_contains "$PROJECT_DIR/.repo-index.yml" "local_path: \"../test-api\""
fi

# Verify specialist agent files generated
assert_file_exists "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md"
assert_file_exists "$CHILD_WEB_DIR/.github/agents/test-web-specialist.agent.md"
assert_file_exists "$CHILD_API_DIR/.github/agents/test-api-critic.agent.md"
assert_file_exists "$CHILD_WEB_DIR/.github/agents/test-web-critic.agent.md"
if [[ -f "$CHILD_API_DIR/.github/agents/test-api-critic.agent.md" ]]; then
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-critic.agent.md" "pattern_constraints"
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-critic.agent.md" "Never PASS a request that contradicts"
fi

# Verify agent.md content structure
if [[ -f "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" ]]; then
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" "^---"
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" "name: test-api-specialist"
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" "tools:"
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" "../test-api"
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" "work/todo"
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" "ready-for-review"
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" "pattern_constraints"
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" "insist on MCP-first orchestration"
  assert_file_contains "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" "Anti-Patterns"
fi

if [[ -f "$CHILD_WEB_DIR/.github/agents/test-web-specialist.agent.md" ]]; then
  assert_file_contains "$CHILD_WEB_DIR/.github/agents/test-web-specialist.agent.md" "name: test-web-specialist"
  # MCP is disabled by default, so frontend should not have scoped MCP tools
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! grep -q "scaffold-generator" "$CHILD_WEB_DIR/.github/agents/test-web-specialist.agent.md" 2>/dev/null; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: frontend specialist should NOT have scaffold-generator when MCP is disabled"
  fi
fi

# Backend should also not have scaffold-generator when MCP is disabled
if [[ -f "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" ]]; then
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! grep -q "scaffold-generator" "$CHILD_API_DIR/.github/agents/test-api-specialist.agent.md" 2>/dev/null; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: backend specialist should NOT have scaffold-generator when MCP is disabled"
  fi
fi

# Verify orchestrator (.github/copilot-instructions.md)
assert_file_exists "$PROJECT_DIR/.github/copilot-instructions.md"
if [[ -f "$PROJECT_DIR/.github/copilot-instructions.md" ]]; then
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "Orchestrator"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "test-project"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "\\.github/agents/test-api-specialist.agent.md"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "\\.github/agents/test-api-critic.agent.md"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "work/todo"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "NEW Copilot CLI"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "MCP-first orchestration is mandatory"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "Do not use \`task\`, background sub-agents"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "First dispatch action must be a direct MCP tool call to \`check_repo_index\`"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "Do not run shell checks like \`command -v check_repo_index\`"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "Anti-Patterns"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "Critic Gate"
  assert_file_contains "$PROJECT_DIR/.github/copilot-instructions.md" "Accept only PASS"
fi

# Verify MCP config is OFF by default
assert_file_not_exists "$PROJECT_DIR/.github/mcp.json"
# Verify optional features are OFF by default
assert_file_not_exists "$PROJECT_DIR/.copilot/workflow-templates/mobile-ci.yml"
assert_file_not_exists "$PROJECT_DIR/.copilot/workflow-templates/mobile-cd.yml"
assert_file_not_exists "$PROJECT_DIR/.copilot/docs/developer-onboarding.md"
assert_file_not_exists "$PROJECT_DIR/.copilot/docs/portability-blueprint.md"

# Verify decisions log
assert_file_exists "$PROJECT_DIR/.decisions/log.md"

# ─────────────────────────────────────────────────────────────
# Test 4a: Copilot metrics summary + URL allowlist coverage
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4a: Copilot metrics summary and URL allowlist ═══"

cat > "$TEST_DIR/init-copilot-metrics.yml" << 'CONFIG'
project:
  name: test-project-copilot-metrics
  description: "Integration test for Copilot telemetry"
  app_description: "Generate starter backlog"
  create_repos: false
  github_owner: testowner
  parent_dir: ""
  nfr: |
    - Security: enforce least privilege access boundaries

children:
  - name: test-api-metrics
    url: ""
    role: "backend"
    description: "API backend"
CONFIG

PROJECT_DIR_METRICS="$TEST_DIR/test-project-copilot-metrics"
mkdir -p "$PROJECT_DIR_METRICS"
cd "$PROJECT_DIR_METRICS"
git init -q
git commit --allow-empty -m "init" -q

COPILOT_LOG="$TEST_DIR/copilot-metrics.log"
: > "$COPILOT_LOG"
export COPILOT_LOG
export MOCK_REQUIRE_URL_ALLOWLIST=true
export MOCK_COPILOT_OUTPUT=$'AI created tokens: 7\nInput tokens: 100\nCached tokens: 20\nOutput tokens: 55\nReasoning tokens: 11\nTotal tokens: 186\nSTATUS: PASS\nFINDINGS:\n- none\nREMEDIATION_HINTS:\n- none'
export MOCK_COPILOT_EXIT_CODE=0

bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-copilot-metrics.yml" --start-phase 1 > "$TEST_DIR/init-copilot-metrics-output.log" 2>&1 || true

TESTS_RUN=$((TESTS_RUN + 1))
if [[ -f "$COPILOT_LOG" && "$(wc -l < "$COPILOT_LOG")" -ge 2 ]]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: expected copilot invocations (initial + critique) to be logged"
fi
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "Copilot usage summary"
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "Phase 6: Running initial Copilot prompt"
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "Phase 6b: Critique and remediation"
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "Critic gate pass 1/3"
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "Stage totals: invocations="
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "Final aggregate totals: invocations="
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "ai_created_tokens="
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "input_tokens="
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "cached_tokens="
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "output_tokens="
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "reasoning_tokens="
assert_file_contains "$TEST_DIR/init-copilot-metrics-output.log" "total_tokens="
TESTS_RUN=$((TESTS_RUN + 1))
if [[ -f "$COPILOT_LOG" ]] && grep -q -- "--silent" "$COPILOT_LOG"; then
  FAIL=$((FAIL + 1))
  echo "  FAIL: copilot invocations should not use --silent (it suppresses usage metrics)"
else
  PASS=$((PASS + 1))
fi

TESTS_RUN=$((TESTS_RUN + 1))
if [[ -f "$COPILOT_LOG" ]] && grep -Eq -- "--add-dir ${TEST_DIR}/test-api-metrics/work( |$)" "$COPILOT_LOG"; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: expected parent copilot invocation to scope child access to child work/ directory"
fi

TESTS_RUN=$((TESTS_RUN + 1))
if [[ -f "$COPILOT_LOG" ]] && grep -Eq -- "--add-dir ${TEST_DIR}/test-api-metrics( |$)" "$COPILOT_LOG"; then
  FAIL=$((FAIL + 1))
  echo "  FAIL: parent copilot invocation should not get full child repo access"
else
  PASS=$((PASS + 1))
fi

unset COPILOT_LOG MOCK_REQUIRE_URL_ALLOWLIST MOCK_COPILOT_OUTPUT MOCK_COPILOT_EXIT_CODE

# ─────────────────────────────────────────────────────────────
# Test 4b: Run init with enable_mcp=true — verify MCP artifacts
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4b: Init with enable_mcp=true generates MCP config ═══"

cat > "$TEST_DIR/init-mcp.yml" << 'CONFIG'
project:
  name: test-project-mcp
  description: "Integration test project with MCP"
  app_description: "A test app for MCP CI validation"
  create_repos: false
  github_owner: testowner
  parent_dir: ""
  enable_mcp: true

children:
  - name: test-api-mcp
    url: ""
    role: "backend"
    description: "API backend"
CONFIG

PROJECT_DIR_MCP="$TEST_DIR/test-project-mcp"
mkdir -p "$PROJECT_DIR_MCP"
cd "$PROJECT_DIR_MCP"
git init -q
git commit --allow-empty -m "init" -q

bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-mcp.yml" --start-phase 1 > "$TEST_DIR/init-mcp-output.log" 2>&1 || true

assert_file_exists "$PROJECT_DIR_MCP/.github/mcp.json"
if [[ -f "$PROJECT_DIR_MCP/.github/mcp.json" ]]; then
  assert_file_contains "$PROJECT_DIR_MCP/.github/mcp.json" "mcpServers"
  assert_file_contains "$PROJECT_DIR_MCP/.github/mcp.json" "scaffold-generator"
  assert_file_contains "$PROJECT_DIR_MCP/.github/mcp.json" "security-scanner"
  assert_file_contains "$PROJECT_DIR_MCP/.github/mcp.json" "repo-index"
  assert_file_contains "$PROJECT_DIR_MCP/.github/mcp.json" "child-agent-runner"
  assert_file_contains "$PROJECT_DIR_MCP/.github/mcp.json" "lint-local"
  assert_file_contains "$PROJECT_DIR_MCP/.github/mcp.json" "terraform-local"
  assert_file_contains "$PROJECT_DIR_MCP/.github/mcp.json" "azure-resource-status"
  assert_file_contains "$PROJECT_DIR_MCP/.github/mcp.json" "git-pr-orchestrator"
  assert_file_contains "$PROJECT_DIR_MCP/.github/mcp.json" "usage quality/anomalies"
  TESTS_RUN=$((TESTS_RUN + 1))
  if python3 - <<PYEOF
import json, pathlib
json.loads(pathlib.Path("$PROJECT_DIR_MCP/.github/mcp.json").read_text(encoding="utf-8"))
PYEOF
  then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: generated .github/mcp.json must be valid JSON"
  fi
fi

if [[ -f "$PROJECT_DIR_MCP/.github/copilot-instructions.md" ]]; then
  assert_file_contains "$PROJECT_DIR_MCP/.github/copilot-instructions.md" "## Usage Metrics Schema (v2.5.0+)"
  assert_file_contains "$PROJECT_DIR_MCP/.github/copilot-instructions.md" "## Usage Quality Reporting (v2.5.0+)"
fi

if [[ -f "$TEST_DIR/test-api-mcp/.github/agents/test-api-mcp-specialist.agent.md" ]]; then
  assert_file_contains "$TEST_DIR/test-api-mcp/.github/agents/test-api-mcp-specialist.agent.md" "scaffold-generator"
fi

# ─────────────────────────────────────────────────────────────
# Test 4c: Init with optional_features enabled
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4c: Init with optional features generates optional artifacts ═══"

cat > "$TEST_DIR/init-optional.yml" << 'CONFIG'
project:
  name: test-project-optional
  description: "Integration test project with optional features"
  create_repos: false
  github_owner: testowner
  parent_dir: ""

optional_features:
  mobile_ci_cd: true
  runner_self_heal: true
  semantic_release: true
  onboarding_docs: true
  portability_blueprints: true

children:
  - name: test-mobile
    url: ""
    role: "frontend"
    description: "Mobile frontend"
CONFIG

PROJECT_DIR_OPTIONAL="$TEST_DIR/test-project-optional"
mkdir -p "$PROJECT_DIR_OPTIONAL"
cd "$PROJECT_DIR_OPTIONAL"
git init -q
git commit --allow-empty -m "init" -q

bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-optional.yml" --start-phase 1 > "$TEST_DIR/init-optional-output.log" 2>&1 || true

assert_file_exists "$PROJECT_DIR_OPTIONAL/.copilot/workflow-templates/mobile-ci.yml"
assert_file_exists "$PROJECT_DIR_OPTIONAL/.copilot/workflow-templates/mobile-cd.yml"
assert_file_exists "$PROJECT_DIR_OPTIONAL/.copilot/docs/developer-onboarding.md"
assert_file_exists "$PROJECT_DIR_OPTIONAL/.copilot/docs/portability-blueprint.md"
if [[ -f "$PROJECT_DIR_OPTIONAL/.copilot/workflow-templates/mobile-ci.yml" ]]; then
  assert_file_contains "$PROJECT_DIR_OPTIONAL/.copilot/workflow-templates/mobile-ci.yml" "Check and install prerequisites"
  assert_file_contains "$PROJECT_DIR_OPTIONAL/.copilot/workflow-templates/mobile-ci.yml" "semantic_version_release"
fi

# ─────────────────────────────────────────────────────────────
# Test 4d: Init with visibility=local creates local repos only
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4d: Init with visibility=local creates local repos ═══"

cat > "$TEST_DIR/init-local.yml" << 'CONFIG'
project:
  name: test-project-local
  description: "Integration test project with local repos"
  create_repos: true
  visibility: local
  parent_dir: ""

children:
  - name: test-api-local
    local_path: "../test-api-local"
    role: "backend"
    description: "Local API backend"
  - name: test-web-local
    local_path: "../test-web-local"
    role: "frontend"
    description: "Local web frontend"
CONFIG

PROJECT_DIR_LOCAL="$TEST_DIR/test-project-local"
mkdir -p "$PROJECT_DIR_LOCAL"
cd "$PROJECT_DIR_LOCAL"
git init -q
git commit --allow-empty -m "init" -q

GH_LOG="$TEST_DIR/gh-local.log"
: > "$GH_LOG"
export GH_LOG

bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-local.yml" > "$TEST_DIR/init-local-output.log" 2>&1 || true

assert_dir_exists "$TEST_DIR/test-api-local/.git"
assert_dir_exists "$TEST_DIR/test-web-local/.git"
assert_file_exists "$PROJECT_DIR_LOCAL/.repo-index.yml"
if [[ -f "$PROJECT_DIR_LOCAL/.repo-index.yml" ]]; then
  assert_file_contains "$PROJECT_DIR_LOCAL/.repo-index.yml" 'visibility: "local"'
  assert_file_contains "$PROJECT_DIR_LOCAL/.repo-index.yml" 'remote_url: ""'
fi
TESTS_RUN=$((TESTS_RUN + 1))
if [[ ! -s "$GH_LOG" ]]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: local visibility should not call gh"
fi

# ─────────────────────────────────────────────────────────────
# Test 4e: Invalid optional feature boolean fails
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4e: Invalid optional feature boolean errors ═══"

cat > "$TEST_DIR/init-invalid-optional.yml" << 'CONFIG'
project:
  name: test-project-invalid-optional
  description: "Invalid optional feature config"
  create_repos: false
  github_owner: testowner
  parent_dir: ""

optional_features:
  mobile_ci_cd: maybe

children:
  - name: test-api-invalid
    url: ""
    role: "backend"
    description: "API backend"
CONFIG

PROJECT_DIR_INVALID_OPTIONAL="$TEST_DIR/test-project-invalid-optional"
mkdir -p "$PROJECT_DIR_INVALID_OPTIONAL"
cd "$PROJECT_DIR_INVALID_OPTIONAL"
git init -q
git commit --allow-empty -m "init" -q

set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-invalid-optional.yml" --start-phase 1 > "$TEST_DIR/init-invalid-optional-output.log" 2>&1
RC_INVALID_OPTIONAL=$?
set -e
assert_exit_code $RC_INVALID_OPTIONAL 1
if [[ -f "$TEST_DIR/init-invalid-optional-output.log" ]]; then
  assert_file_contains "$TEST_DIR/init-invalid-optional-output.log" "optional_features.mobile_ci_cd must be true or false"
fi

# ─────────────────────────────────────────────────────────────
# Test 4f: Child relative paths are anchored to harness dir
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4f: Child relative local_path uses harness dir as base ═══"

HARNESS_PARENT_DIR="$TEST_DIR/harness-parent"
RUNNER_DIR="$TEST_DIR/path-semantics-runner"
mkdir -p "$RUNNER_DIR"

cat > "$TEST_DIR/init-path-semantics.yml" <<CONFIG
project:
  name: test-project-path-semantics
  description: "Path semantics validation"
  create_repos: true
  visibility: local
  parent_dir: "$HARNESS_PARENT_DIR"

children:
  - name: test-api-path
    local_path: "./children/test-api-path"
    role: "backend"
    description: "API backend"
CONFIG

(
  cd "$RUNNER_DIR"
  bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-path-semantics.yml" > "$TEST_DIR/init-path-semantics-output.log" 2>&1 || true
)

assert_dir_exists "$HARNESS_PARENT_DIR/children/test-api-path/.git"
assert_dir_not_exists "$RUNNER_DIR/children/test-api-path"
assert_file_contains "$HARNESS_PARENT_DIR/.repo-index.yml" 'local_path: "./children/test-api-path"'

# ─────────────────────────────────────────────────────────────
# Test 4g: Missing required technology hard-fails with unmet output
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4g: Required technologies hard-fail when unmet ═══"

cat > "$TEST_DIR/init-tech-hard-fail.yml" << 'CONFIG'
project:
  name: test-project-tech-hard-fail
  description: "Hard fail on unmet technology constraints"
  create_repos: false
  parent_dir: ""
  nfr: |
    - Microsoft Agent Framework is required for agent workflows.

children:
  - name: test-api-tech-hard-fail
    url: ""
    role: "backend"
    description: "API backend"
CONFIG

PROJECT_DIR_TECH_FAIL="$TEST_DIR/test-project-tech-hard-fail"
mkdir -p "$PROJECT_DIR_TECH_FAIL"
cd "$PROJECT_DIR_TECH_FAIL"
git init -q
git commit --allow-empty -m "init" -q

set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-tech-hard-fail.yml" --start-phase 1 > "$TEST_DIR/init-tech-hard-fail-output.log" 2>&1
RC_TECH_FAIL=$?
set -e

assert_exit_code "$RC_TECH_FAIL" 1
assert_file_contains "$TEST_DIR/init-tech-hard-fail-output.log" "UNMET_REQUIREMENTS"
assert_file_contains "$TEST_DIR/init-tech-hard-fail-output.log" "Microsoft Agent Framework requirement is unmet"

# ─────────────────────────────────────────────────────────────
# Test 4h: Default metrics policy accepts zero metrics without retrying
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4h: Copilot zero metrics accepted without retry ═══"

cat > "$TEST_DIR/init-zero-token-metrics.yml" << 'CONFIG'
project:
  name: test-project-zero-token-metrics
  description: "Copilot token strictness validation"
  app_description: "Generate starter backlog"
  create_repos: false
  parent_dir: ""

children:
  - name: test-api-zero-token
    url: ""
    role: "backend"
    description: "API backend"
CONFIG

PROJECT_DIR_ZERO_TOKEN="$TEST_DIR/test-project-zero-token-metrics"
mkdir -p "$PROJECT_DIR_ZERO_TOKEN"
cd "$PROJECT_DIR_ZERO_TOKEN"
git init -q
git commit --allow-empty -m "init" -q

MOCK_COUNTER_DEFAULT="$TEST_DIR/copilot-default-policy.count"
echo "0" > "$MOCK_COUNTER_DEFAULT"
export MOCK_COPILOT_COUNTER_FILE="$MOCK_COUNTER_DEFAULT"
export MOCK_COPILOT_ZERO_METRICS_UNTIL_CALL=20
export MOCK_COPILOT_OUTPUT=$'AI created tokens: 8\nInput tokens: 90\nCached tokens: 12\nOutput tokens: 40\nReasoning tokens: 5\nTotal tokens: 147\nSTATUS: PASS\nFINDINGS:\n- none\nREMEDIATION_HINTS:\n- none'
export MOCK_COPILOT_EXIT_CODE=0
set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-zero-token-metrics.yml" --start-phase 1 > "$TEST_DIR/init-zero-token-metrics-output.log" 2>&1
RC_ZERO_TOKEN=$?
set -e
DEFAULT_POLICY_CALLS=$(cat "$MOCK_COUNTER_DEFAULT" 2>/dev/null || echo "0")
unset MOCK_COPILOT_COUNTER_FILE MOCK_COPILOT_ZERO_METRICS_UNTIL_CALL MOCK_COPILOT_OUTPUT MOCK_COPILOT_EXIT_CODE

assert_exit_code "$RC_ZERO_TOKEN" 0
assert_file_contains "$TEST_DIR/init-zero-token-metrics-output.log" "Copilot metrics anomaly (warn mode, no retry)"
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "$DEFAULT_POLICY_CALLS" -eq 2 ]]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: expected exactly 2 copilot invocations (no retries for zero metrics, but Phase 2 validation may trigger agent regeneration), but got $DEFAULT_POLICY_CALLS"
fi

# ─────────────────────────────────────────────────────────────
# Test 4i: Warn mode allows zero-token anomalies to continue
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4i: Copilot metrics warn mode continues with warning ═══"

cat > "$TEST_DIR/init-zero-token-warn.yml" << 'CONFIG'
project:
  name: test-project-zero-token-warn
  description: "Copilot token warning mode validation"
  app_description: "Generate starter backlog"
  create_repos: false
  parent_dir: ""

copilot_usage_metrics:
  enforcement_mode: warn

children:
  - name: test-api-zero-token-warn
    url: ""
    role: "backend"
    description: "API backend"
CONFIG

PROJECT_DIR_ZERO_TOKEN_WARN="$TEST_DIR/test-project-zero-token-warn"
mkdir -p "$PROJECT_DIR_ZERO_TOKEN_WARN"
cd "$PROJECT_DIR_ZERO_TOKEN_WARN"
git init -q
git commit --allow-empty -m "init" -q

export MOCK_COPILOT_OUTPUT=$'Input tokens: 0\nOutput tokens: 0\nTotal tokens: 0\nSTATUS: PASS\nFINDINGS:\n- none\nREMEDIATION_HINTS:\n- none'
export MOCK_COPILOT_EXIT_CODE=0
set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-zero-token-warn.yml" --start-phase 1 > "$TEST_DIR/init-zero-token-warn-output.log" 2>&1
RC_ZERO_TOKEN_WARN=$?
set -e
unset MOCK_COPILOT_OUTPUT MOCK_COPILOT_EXIT_CODE

assert_exit_code "$RC_ZERO_TOKEN_WARN" 0
assert_file_contains "$TEST_DIR/init-zero-token-warn-output.log" "Copilot metrics anomaly (warn mode, no retry)"
assert_file_contains "$TEST_DIR/init-zero-token-warn-output.log" "metrics_anomalies="


# ─────────────────────────────────────────────────────────────
# Test 4j: Strict mode fails on zero metrics without retrying
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4j: Copilot strict mode fails on zero metrics ═══"

cat > "$TEST_DIR/init-zero-token-retry-strict.yml" << 'CONFIG'
project:
  name: test-project-zero-token-retry-strict
  description: "Copilot token retry strict validation"
  app_description: "Generate starter backlog"
  create_repos: false
  parent_dir: ""

copilot_usage_metrics:
  enforcement_mode: strict
  retry_attempts: 2

children:
  - name: test-api-zero-token-retry-strict
    url: ""
    role: "backend"
    description: "API backend"
CONFIG

PROJECT_DIR_ZERO_TOKEN_RETRY_STRICT="$TEST_DIR/test-project-zero-token-retry-strict"
mkdir -p "$PROJECT_DIR_ZERO_TOKEN_RETRY_STRICT"
cd "$PROJECT_DIR_ZERO_TOKEN_RETRY_STRICT"
git init -q
git commit --allow-empty -m "init" -q

MOCK_COUNTER_STRICT="$TEST_DIR/copilot-retry-strict.count"
echo "0" > "$MOCK_COUNTER_STRICT"
export MOCK_COPILOT_COUNTER_FILE="$MOCK_COUNTER_STRICT"
export MOCK_COPILOT_ZERO_METRICS_UNTIL_CALL=20
export MOCK_COPILOT_OUTPUT=$'AI created tokens: 8\nInput tokens: 90\nCached tokens: 12\nOutput tokens: 40\nReasoning tokens: 5\nTotal tokens: 147\nSTATUS: PASS\nFINDINGS:\n- none\nREMEDIATION_HINTS:\n- none'
export MOCK_COPILOT_EXIT_CODE=0
set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-zero-token-retry-strict.yml" --start-phase 1 > "$TEST_DIR/init-zero-token-retry-strict-output.log" 2>&1
RC_ZERO_TOKEN_RETRY_STRICT=$?
set -e
STRICT_CALLS=$(cat "$MOCK_COUNTER_STRICT" 2>/dev/null || echo "0")
unset MOCK_COPILOT_COUNTER_FILE MOCK_COPILOT_ZERO_METRICS_UNTIL_CALL MOCK_COPILOT_OUTPUT MOCK_COPILOT_EXIT_CODE

assert_exit_code "$RC_ZERO_TOKEN_RETRY_STRICT" 97
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "$STRICT_CALLS" -eq 1 ]]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: expected exactly 1 copilot invocation in strict mode (no retries for zero metrics), but got $STRICT_CALLS"
fi

# ─────────────────────────────────────────────────────────────
# Test 4k: Warn mode continues without retrying on zero metrics
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4k: Copilot warn mode accepts zero metrics without retry ═══"

cat > "$TEST_DIR/init-zero-token-retry-warn.yml" << 'CONFIG'
project:
  name: test-project-zero-token-retry-warn
  description: "Copilot token retry warn validation"
  app_description: "Generate starter backlog"
  create_repos: false
  parent_dir: ""

copilot_usage_metrics:
  enforcement_mode: warn
  retry_attempts: 2

children:
  - name: test-api-zero-token-retry-warn
    url: ""
    role: "backend"
    description: "API backend"
CONFIG

PROJECT_DIR_ZERO_TOKEN_RETRY_WARN="$TEST_DIR/test-project-zero-token-retry-warn"
mkdir -p "$PROJECT_DIR_ZERO_TOKEN_RETRY_WARN"
cd "$PROJECT_DIR_ZERO_TOKEN_RETRY_WARN"
git init -q
git commit --allow-empty -m "init" -q

MOCK_COUNTER_WARN="$TEST_DIR/copilot-retry-warn.count"
echo "0" > "$MOCK_COUNTER_WARN"
export MOCK_COPILOT_COUNTER_FILE="$MOCK_COUNTER_WARN"
export MOCK_COPILOT_ZERO_METRICS_UNTIL_CALL=20
export MOCK_COPILOT_OUTPUT=$'AI created tokens: 8\nInput tokens: 90\nCached tokens: 12\nOutput tokens: 40\nReasoning tokens: 5\nTotal tokens: 147\nSTATUS: PASS\nFINDINGS:\n- none\nREMEDIATION_HINTS:\n- none'
export MOCK_COPILOT_EXIT_CODE=0
set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-zero-token-retry-warn.yml" --start-phase 1 > "$TEST_DIR/init-zero-token-retry-warn-output.log" 2>&1
RC_ZERO_TOKEN_RETRY_WARN=$?
set -e
WARN_CALLS=$(cat "$MOCK_COUNTER_WARN" 2>/dev/null || echo "0")
unset MOCK_COPILOT_COUNTER_FILE MOCK_COPILOT_ZERO_METRICS_UNTIL_CALL MOCK_COPILOT_OUTPUT MOCK_COPILOT_EXIT_CODE

assert_exit_code "$RC_ZERO_TOKEN_RETRY_WARN" 0
assert_file_contains "$TEST_DIR/init-zero-token-retry-warn-output.log" "Copilot metrics anomaly (warn mode, no retry)"
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "$WARN_CALLS" -eq 2 ]]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: expected exactly 2 copilot invocations in warn mode (no retries for zero metrics), but got $WARN_CALLS"
fi

# ─────────────────────────────────────────────────────────────
# Test 4l: Baseline commits are created only after eval pass
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4l: Post-eval baseline commits in parent + child repos ═══"

cat > "$TEST_DIR/init-baseline-commits.yml" << 'CONFIG'
project:
  name: test-project-baseline-commits
  description: "Baseline commit sequencing validation"
  app_description: "Create implementation plan and backlog"
  create_repos: true
  visibility: local
  parent_dir: ""

children:
  - name: test-api-baseline
    local_path: "../test-api-baseline"
    role: "backend"
    description: "API backend"
  - name: test-web-baseline
    local_path: "../test-web-baseline"
    role: "frontend"
    description: "Web frontend"
CONFIG

PROJECT_DIR_BASELINE="$TEST_DIR/test-project-baseline-commits"
mkdir -p "$PROJECT_DIR_BASELINE"
cd "$PROJECT_DIR_BASELINE"
git init -q
git commit --allow-empty -m "init" -q

export MOCK_COPILOT_OUTPUT=$'AI created tokens: 8\nInput tokens: 90\nCached tokens: 12\nOutput tokens: 40\nReasoning tokens: 5\nTotal tokens: 147\nSTATUS: PASS\nFINDINGS:\n- none\nREMEDIATION_HINTS:\n- none'
export MOCK_COPILOT_EXIT_CODE=0
set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-baseline-commits.yml" > "$TEST_DIR/init-baseline-commits-output.log" 2>&1
RC_BASELINE=$?
set -e
unset MOCK_COPILOT_OUTPUT MOCK_COPILOT_EXIT_CODE

assert_exit_code "$RC_BASELINE" 0
assert_file_contains "$TEST_DIR/init-baseline-commits-output.log" "Phase 6b: Critique and remediation"
assert_file_contains "$TEST_DIR/init-baseline-commits-output.log" "Critic gate pass 1/3"

PARENT_HEAD_MSG=$(git -C "$PROJECT_DIR_BASELINE" --no-pager log -1 --pretty=%B 2>/dev/null || true)
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "$PARENT_HEAD_MSG" == *"initialize enterprise-copilot-fleet-controller v2"* ]]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: parent baseline commit message missing expected marker"
fi

for child_repo in "$TEST_DIR/test-api-baseline" "$TEST_DIR/test-web-baseline"; do
  CHILD_HEAD_MSG=$(git -C "$child_repo" --no-pager log -1 --pretty=%B 2>/dev/null || true)
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$CHILD_HEAD_MSG" == *"copilot baseline after eval pass"* ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: child baseline commit missing expected marker for $child_repo"
  fi
done

# ─────────────────────────────────────────────────────────────
# Test 4m: critic_evaluator=false skips critic gate and still allows baseline commits
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4m: critic_evaluator=false skips critic gate blocking ═══"

cat > "$TEST_DIR/init-critic-disabled.yml" << 'CONFIG'
project:
  name: test-project-critic-disabled
  description: "Critic gate optional feature disabled should not block commits"
  app_description: "Generate baseline implementation skeleton"
  initial_prompt: "Create initial project backlog and skeleton tasks."
  create_repos: true
  visibility: local
  parent_dir: ""

optional_features:
  critic_evaluator: false

children:
  - name: test-api-critic-disabled
    local_path: "../test-api-critic-disabled"
    role: "backend"
    description: "API backend"
  - name: test-web-critic-disabled
    local_path: "../test-web-critic-disabled"
    role: "frontend"
    description: "Web frontend"
CONFIG

PROJECT_DIR_CRITIC_DISABLED="$TEST_DIR/test-project-critic-disabled"
mkdir -p "$PROJECT_DIR_CRITIC_DISABLED"
cd "$PROJECT_DIR_CRITIC_DISABLED"
git init -q
git commit --allow-empty -m "init" -q

export MOCK_COPILOT_OUTPUT=$'AI created tokens: 8\nInput tokens: 90\nCached tokens: 12\nOutput tokens: 40\nReasoning tokens: 5\nTotal tokens: 147\nSTATUS: FAIL\nFINDINGS:\n- Requirement mismatch in generated artifacts\nREMEDIATION_HINTS:\n- Update orchestrator and specialist instructions'
export MOCK_COPILOT_EXIT_CODE=0
set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-critic-disabled.yml" > "$TEST_DIR/init-critic-disabled-output.log" 2>&1
RC_CRITIC_DISABLED=$?
set -e
unset MOCK_COPILOT_OUTPUT MOCK_COPILOT_EXIT_CODE

assert_exit_code "$RC_CRITIC_DISABLED" 0
assert_file_contains "$TEST_DIR/init-critic-disabled-output.log" "Critic gate optional feature disabled — skipping critique/remediation loop"
TESTS_RUN=$((TESTS_RUN + 1))
if [[ ! -f "$TEST_DIR/init-critic-disabled-output.log" ]] || ! grep -q "Critic gate pass 1/3" "$TEST_DIR/init-critic-disabled-output.log" 2>/dev/null; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: critic gate pass loop should be skipped when optional_features.critic_evaluator=false"
fi

PARENT_DISABLED_HEAD_MSG=$(git -C "$PROJECT_DIR_CRITIC_DISABLED" --no-pager log -1 --pretty=%B 2>/dev/null || true)
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "$PARENT_DISABLED_HEAD_MSG" == *"initialize enterprise-copilot-fleet-controller v2"* ]]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: parent baseline commit should be created when critic gate is disabled"
fi

for child_repo in "$TEST_DIR/test-api-critic-disabled" "$TEST_DIR/test-web-critic-disabled"; do
  CHILD_DISABLED_HEAD_MSG=$(git -C "$child_repo" --no-pager log -1 --pretty=%B 2>/dev/null || true)
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$CHILD_DISABLED_HEAD_MSG" == *"copilot baseline after eval pass"* ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: child baseline commit should be created when critic gate is disabled for $child_repo"
  fi
done

# ─────────────────────────────────────────────────────────────
# Test 4n: default critic gate enabled blocks baseline commits on FAIL
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4n: Default critic gate blocks baseline commit creation on FAIL ═══"

cat > "$TEST_DIR/init-critic-fail-gate.yml" << 'CONFIG'
project:
  name: test-project-critic-fail-gate
  description: "Default critic gate failure should block baseline commits"
  app_description: "Generate baseline implementation skeleton"
  initial_prompt: "Create initial project backlog and skeleton tasks."
  create_repos: true
  visibility: local
  parent_dir: ""

children:
  - name: test-api-critic-fail
    local_path: "../test-api-critic-fail"
    role: "backend"
    description: "API backend"
  - name: test-web-critic-fail
    local_path: "../test-web-critic-fail"
    role: "frontend"
    description: "Web frontend"
CONFIG

PROJECT_DIR_CRITIC_FAIL="$TEST_DIR/test-project-critic-fail-gate"
mkdir -p "$PROJECT_DIR_CRITIC_FAIL"
cd "$PROJECT_DIR_CRITIC_FAIL"
git init -q
git commit --allow-empty -m "init" -q

export MOCK_COPILOT_OUTPUT=$'AI created tokens: 8\nInput tokens: 90\nCached tokens: 12\nOutput tokens: 40\nReasoning tokens: 5\nTotal tokens: 147\nSTATUS: FAIL\nFINDINGS:\n- Requirement mismatch in generated artifacts\nREMEDIATION_HINTS:\n- Update orchestrator and specialist instructions'
export MOCK_COPILOT_EXIT_CODE=0
set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-critic-fail-gate.yml" > "$TEST_DIR/init-critic-fail-gate-output.log" 2>&1
RC_CRITIC_FAIL=$?
set -e
unset MOCK_COPILOT_OUTPUT MOCK_COPILOT_EXIT_CODE

assert_exit_code "$RC_CRITIC_FAIL" 1
assert_file_contains "$TEST_DIR/init-critic-fail-gate-output.log" "Critic gate failed after 3 attempts"
assert_file_contains "$TEST_DIR/init-critic-fail-gate-output.log" "STATUS: FAIL"

PARENT_FAIL_HEAD_MSG=$(git -C "$PROJECT_DIR_CRITIC_FAIL" --no-pager log -1 --pretty=%B 2>/dev/null || true)
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "$PARENT_FAIL_HEAD_MSG" != *"initialize enterprise-copilot-fleet-controller v2"* ]]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: parent baseline commit should be blocked on critic FAIL"
fi

for child_repo in "$TEST_DIR/test-api-critic-fail" "$TEST_DIR/test-web-critic-fail"; do
  CHILD_FAIL_HEAD_MSG=$(git -C "$child_repo" --no-pager log -1 --pretty=%B 2>/dev/null || true)
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$CHILD_FAIL_HEAD_MSG" != *"copilot baseline after eval pass"* ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: child baseline commit should be blocked on critic FAIL for $child_repo"
  fi
done

# ─────────────────────────────────────────────────────────────
# Test 4o: critic is not a supported child repo role
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4o: Critic is rejected as a child repo role ═══"

cat > "$TEST_DIR/init-invalid-critic-role.yml" << 'CONFIG'
project:
  name: test-project-invalid-critic-role
  description: "Critic child role should be rejected"
  create_repos: false
  parent_dir: ""

children:
  - name: test-api-invalid-critic-role
    url: ""
    role: "backend"
    description: "API backend"
  - name: test-critic-invalid-role
    url: ""
    role: "critic"
    description: "Deprecated child role"
CONFIG

PROJECT_DIR_INVALID_CRITIC_ROLE="$TEST_DIR/test-project-invalid-critic-role"
mkdir -p "$PROJECT_DIR_INVALID_CRITIC_ROLE"
cd "$PROJECT_DIR_INVALID_CRITIC_ROLE"
git init -q
git commit --allow-empty -m "init" -q

set +e
bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-invalid-critic-role.yml" --start-phase 1 > "$TEST_DIR/init-invalid-critic-role-output.log" 2>&1
RC_INVALID_CRITIC_ROLE=$?
set -e
assert_exit_code "$RC_INVALID_CRITIC_ROLE" 1
assert_file_contains "$TEST_DIR/init-invalid-critic-role-output.log" "invalid role 'critic'"

# ─────────────────────────────────────────────────────────────
# Test 4p: Pattern child constraints are materialized into guardrails
# ─────────────────────────────────────────────────────────────
echo "═══ Test 4p: Pattern constraints propagate into platform guardrails ═══"

cat > "$TEST_DIR/init-pattern-constraints.yml" << 'CONFIG'
project:
  name: test-project-pattern-constraints
  pattern: "azure-fullstack"
  create_repos: true
  visibility: local
  parent_dir: ""
CONFIG

PROJECT_DIR_PATTERN_CONSTRAINTS="$TEST_DIR/test-project-pattern-constraints"
mkdir -p "$PROJECT_DIR_PATTERN_CONSTRAINTS"
cd "$PROJECT_DIR_PATTERN_CONSTRAINTS"
git init -q
git commit --allow-empty -m "init" -q

bash "$FRAMEWORK_DIR/scripts/init.sh" --config "$TEST_DIR/init-pattern-constraints.yml" --start-phase 1 > "$TEST_DIR/init-pattern-constraints-output.log" 2>&1 || true

assert_file_exists "$PROJECT_DIR_PATTERN_CONSTRAINTS/.requirements/platform-guardrails.yml"
if [[ -f "$PROJECT_DIR_PATTERN_CONSTRAINTS/.requirements/platform-guardrails.yml" ]]; then
  assert_file_contains "$PROJECT_DIR_PATTERN_CONSTRAINTS/.requirements/platform-guardrails.yml" 'pattern_constraints:'
  assert_file_contains "$PROJECT_DIR_PATTERN_CONSTRAINTS/.requirements/platform-guardrails.yml" 'repo: "test-project-pattern-constraints-agent"'
  assert_file_contains "$PROJECT_DIR_PATTERN_CONSTRAINTS/.requirements/platform-guardrails.yml" 'FoundryChatClient'
fi
if [[ -f "$PROJECT_DIR_PATTERN_CONSTRAINTS/.github/copilot-instructions.md" ]]; then
  assert_file_contains "$PROJECT_DIR_PATTERN_CONSTRAINTS/.github/copilot-instructions.md" "pattern_constraints"
  assert_file_contains "$PROJECT_DIR_PATTERN_CONSTRAINTS/.github/copilot-instructions.md" "Do not inject constraints that conflict"
fi

# ─────────────────────────────────────────────────────────────
# Test 5: upgrade.sh syntax check
# ─────────────────────────────────────────────────────────────
echo "═══ Test 5: upgrade.sh syntax valid ═══"
bash -n "$FRAMEWORK_DIR/scripts/upgrade.sh"
assert_exit_code $? 0

# ─────────────────────────────────────────────────────────────
# Test 6: upgrade.sh --help exits cleanly
# ─────────────────────────────────────────────────────────────
echo "═══ Test 6: upgrade.sh --help exits 0 ═══"
bash "$FRAMEWORK_DIR/scripts/upgrade.sh" --help > /dev/null 2>&1
assert_exit_code $? 0

# ─────────────────────────────────────────────────────────────
# Test 7: upgrade.sh reports already at latest
# ─────────────────────────────────────────────────────────────
echo "═══ Test 7: upgrade.sh already at latest ═══"
if [[ -f "$PROJECT_DIR/.framework-version" ]]; then
  cp "$FRAMEWORK_DIR/VERSION" "$PROJECT_DIR/.framework-version"
  git -C "$PROJECT_DIR" add -A && git -C "$PROJECT_DIR" commit -m "set version" -q 2>/dev/null || true
  OUTPUT=$(bash "$FRAMEWORK_DIR/scripts/upgrade.sh" --project-dir "$PROJECT_DIR" 2>&1 || true)
  TESTS_RUN=$((TESTS_RUN + 1))
  if echo "$OUTPUT" | grep -q "nothing to do"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: upgrade should say nothing to do when at latest"
  fi
fi

# ─────────────────────────────────────────────────────────────
# Test 8: upgrade.sh dry-run doesn't modify files
# ─────────────────────────────────────────────────────────────
echo "═══ Test 8: upgrade.sh --dry-run is non-destructive ═══"
if [[ -f "$PROJECT_DIR/.framework-version" ]]; then
  echo "0.0.0" > "$PROJECT_DIR/.framework-version"
  git -C "$PROJECT_DIR" add -A && git -C "$PROJECT_DIR" commit -m "set v0" -q 2>/dev/null || true
  BEFORE=$(cat "$PROJECT_DIR/.framework-version")
  bash "$FRAMEWORK_DIR/scripts/upgrade.sh" --project-dir "$PROJECT_DIR" --dry-run > /dev/null 2>&1 || true
  AFTER=$(cat "$PROJECT_DIR/.framework-version")
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$BEFORE" == "$AFTER" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: dry-run modified .framework-version"
  fi
fi

# ─────────────────────────────────────────────────────────────
# Test 9: Migration script syntax check
# ─────────────────────────────────────────────────────────────
echo "═══ Test 9: migration v1.3.0_to_v2.0.0.sh syntax valid ═══"
bash -n "$FRAMEWORK_DIR/migrations/v1.3.0_to_v2.0.0.sh"
assert_exit_code $? 0

# ─────────────────────────────────────────────────────────────
# Test 10: New migration script syntax check
# ─────────────────────────────────────────────────────────────
echo "═══ Test 10: migration v2.6.0_to_v2.7.0.sh syntax valid ═══"
bash -n "$FRAMEWORK_DIR/migrations/v2.6.0_to_v2.7.0.sh"
assert_exit_code $? 0

# ─────────────────────────────────────────────────────────────
# Test 11: migration v2.7.0_to_v2.8.0.sh syntax valid
# ─────────────────────────────────────────────────────────────
echo "═══ Test 11: migration v2.7.0_to_v2.8.0.sh syntax valid ═══"
bash -n "$FRAMEWORK_DIR/migrations/v2.7.0_to_v2.8.0.sh"
assert_exit_code $? 0

# ─────────────────────────────────────────────────────────────
# Test 12: migration v2.8.0_to_v2.9.0.sh syntax valid
# ─────────────────────────────────────────────────────────────
echo "═══ Test 12: migration v2.8.0_to_v2.9.0.sh syntax valid ═══"
bash -n "$FRAMEWORK_DIR/migrations/v2.8.0_to_v2.9.0.sh"
assert_exit_code $? 0

# ─────────────────────────────────────────────────────────────
# Test 12a: migration v2.9.0_to_v2.10.0.sh syntax valid
# ─────────────────────────────────────────────────────────────
echo "═══ Test 12a: migration v2.9.0_to_v2.10.0.sh syntax valid ═══"
bash -n "$FRAMEWORK_DIR/migrations/v2.9.0_to_v2.10.0.sh"
assert_exit_code $? 0

# ─────────────────────────────────────────────────────────────
# Test 13: upgrade.sh applies v2.7.0 → v2.10.0 migration chain
# ─────────────────────────────────────────────────────────────
echo "═══ Test 13: upgrade.sh applies v2.7.0 to v2.10.0 migration chain ═══"

UPGRADE_DIR="$TEST_DIR/test-project-upgrade"
mkdir -p "$UPGRADE_DIR/.copilot"
cat > "$UPGRADE_DIR/.framework-version" <<'EOF'
2.7.0
EOF
mkdir -p "$UPGRADE_DIR/.github/agents" "$UPGRADE_DIR/work/test-api-mcp"
cat > "$UPGRADE_DIR/.github/agents/test-api-mcp-specialist.agent.md" <<'EOF'
---
name: test-api-mcp-specialist
description: "API specialist"
tools: []
---
You are the backend specialist for test-api-mcp (work/test-api-mcp).
EOF
cat > "$UPGRADE_DIR/.copilot/instructions.md" <<'EOF'
# Orchestrator

| Agent | Role | Repo |
|-------|------|------|
| @test-api-mcp-specialist | backend | work/test-api-mcp |

## MCP Tools

MCP is disabled for this project (`project.enable_mcp: false`).
Set `project.enable_mcp: true` and run init again to generate `.copilot/mcp.json`.

## Anti-Patterns
- placeholder
EOF
cat > "$UPGRADE_DIR/.copilot/mcp.json" <<'EOF'
{
  "_framework_version": "2.7.0",
  "mcpServers": {
    "submodule-sync": {
      "description": "Sync/check parent work/* submodule SHAs after child repo changes.",
      "command": "python3",
      "args": ["tools/submodule-sync/server.py"],
      "env": {
        "PROJECT_DIR": "/tmp/test-project-upgrade"
      }
    }
  }
}
EOF
cd "$UPGRADE_DIR"
git init -q
git add -A
git commit -m "init" -q

bash "$FRAMEWORK_DIR/scripts/upgrade.sh" --project-dir "$UPGRADE_DIR" > "$TEST_DIR/upgrade-output.log" 2>&1 || true

TESTS_RUN=$((TESTS_RUN + 1))
if [[ -f "$UPGRADE_DIR/.framework-version" ]] && grep -q "2.10.0" "$UPGRADE_DIR/.framework-version" &&    grep -q "local-only" "$UPGRADE_DIR/.github/copilot-instructions.md" &&    ! grep -q "project.enable_mcp: false" "$UPGRADE_DIR/.github/copilot-instructions.md"; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: upgrade did not apply v2.7.0 → v2.10.0 migration chain correctly"
fi

# ─────────────────────────────────────────────────────────────
# Test 14: v2.8.0 → v2.9.0 migrates parent artifacts to child repo
# ─────────────────────────────────────────────────────────────
echo "═══ Test 14: v2.8.0 to v2.9.0 migrates child workflow artifacts ═══"

UPGRADE_DIR_V29="$TEST_DIR/test-project-upgrade-v29"
CHILD_DIR_V29="$TEST_DIR/test-api-v29"
mkdir -p "$UPGRADE_DIR_V29/.copilot" "$UPGRADE_DIR_V29/.github/agents" "$UPGRADE_DIR_V29/work/test-api-v29/todo" "$CHILD_DIR_V29"
cat > "$UPGRADE_DIR_V29/.framework-version" <<'EOF'
2.8.0
EOF
cat > "$UPGRADE_DIR_V29/.repo-index.yml" <<EOF
repos:
  - name: "test-api-v29"
    role: "backend"
    local_path: "../test-api-v29"
    description: "API backend"
    remote_url: ""
    default_branch: "main"
EOF
cat > "$UPGRADE_DIR_V29/.copilot/instructions.md" <<'EOF'
# Orchestrator

## Your Protocol
1. old step
EOF
cat > "$UPGRADE_DIR_V29/.github/agents/test-api-v29-specialist.agent.md" <<'EOF'
---
name: test-api-v29-specialist
description: "API specialist"
tools: []
---
You are the backend specialist for test-api-v29 (work/test-api-v29).
Use work/test-api-v29/todo and move to work/test-api-v29/ready-for-review.
EOF
cat > "$UPGRADE_DIR_V29/.github/agents/test-api-v29-critic.agent.md" <<'EOF'
---
name: test-api-v29-critic
description: "API critic"
tools: []
---
You are the backend critic for test-api-v29 (work/test-api-v29).
Move PASS requests from work/test-api-v29/ready-for-review to work/test-api-v29/done.
EOF
cat > "$UPGRADE_DIR_V29/work/test-api-v29/todo/request-001.md" <<'EOF'
request
EOF
cd "$UPGRADE_DIR_V29"
git init -q
git add -A
git commit -m "init" -q

bash "$FRAMEWORK_DIR/scripts/upgrade.sh" --project-dir "$UPGRADE_DIR_V29" > "$TEST_DIR/upgrade-v29-output.log" 2>&1 || true

TESTS_RUN=$((TESTS_RUN + 1))
if [[ -f "$UPGRADE_DIR_V29/.framework-version" ]] && grep -q "2.10.0" "$UPGRADE_DIR_V29/.framework-version" && \
   [[ -f "$CHILD_DIR_V29/.github/agents/test-api-v29-specialist.agent.md" ]] && \
   [[ -f "$CHILD_DIR_V29/.github/agents/test-api-v29-critic.agent.md" ]] && \
   [[ -f "$CHILD_DIR_V29/work/todo/request-001.md" ]] && \
   ! grep -q "work/test-api-v29/todo" "$CHILD_DIR_V29/.github/agents/test-api-v29-specialist.agent.md"; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  echo "  FAIL: v2.8.0 → v2.9.0 migration did not relocate child artifacts correctly"
fi
# ─────────────────────────────────────────────────────────────
# Results
# ─────────────────────────────────────────────────────────────
echo ""
echo "═══ Results ═══"
echo "  Tests: $TESTS_RUN  Pass: $PASS  Fail: $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "  ✗ FAILED"
  exit 1
else
  echo "  ✓ ALL PASSED"
  exit 0
fi
