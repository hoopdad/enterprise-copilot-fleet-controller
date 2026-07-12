#!/bin/bash
# scripts/init-core.sh — Initialize the enterprise-copilot-fleet-controller v2.10.0 into a project
#
# Usage:
#   scripts/init.sh --config init.yml [--start-phase N]
#   scripts/init.sh                    (interactive)
#
# Prerequisites: git, copilot CLI (for non-empty repos), gh (optional, for repo creation)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# FRAMEWORK_DIR locates static assets (VERSION, templates/, skills/, patterns/).
# When launched from a stable snapshot (see scripts/init.py), the script body lives
# outside the repo, so honor INIT_FRAMEWORK_DIR to keep asset paths pointed at the
# real framework checkout. Falls back to the parent of SCRIPT_DIR for direct runs.
FRAMEWORK_DIR="${INIT_FRAMEWORK_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TEMPLATE_DIR="$FRAMEWORK_DIR/templates/init"
INIT_HELPERS_PY="$SCRIPT_DIR/init/helpers.py"
TARGET_DIR="$(pwd)"
HARNESS_DIR="$TARGET_DIR"
FRAMEWORK_VERSION="$(cat "$FRAMEWORK_DIR/VERSION" 2>/dev/null || echo "0.0.0")"
ORCHESTRATOR_INSTRUCTIONS_REL=".github/copilot-instructions.md"
LEGACY_ORCHESTRATOR_INSTRUCTIONS_REL=".copilot/instructions.md"
MCP_CONFIG_REL=".github/mcp.json"
ORCHESTRATOR_INSTRUCTIONS_FILE="$TARGET_DIR/$ORCHESTRATOR_INSTRUCTIONS_REL"
LEGACY_ORCHESTRATOR_INSTRUCTIONS_FILE="$TARGET_DIR/$LEGACY_ORCHESTRATOR_INSTRUCTIONS_REL"
MCP_CONFIG_FILE="$TARGET_DIR/$MCP_CONFIG_REL"
CONFIG_FILE=""
START_PHASE=0
END_PHASE=6
INITIAL_PROMPT=""
AUTO_DELETE=false
ENABLE_MCP="false"
FEATURE_MOBILE_CI_CD="false"
FEATURE_RUNNER_SELF_HEAL="false"
FEATURE_SEMANTIC_RELEASE="false"
FEATURE_ONBOARDING_DOCS="false"
FEATURE_PORTABILITY_BLUEPRINTS="false"
FEATURE_FLEET_INSTRUMENT="true"
FEATURE_CRITIC_EVALUATOR="true"
COPILOT_METRICS_ENFORCEMENT_MODE="warn"
COPILOT_METRICS_RETRY_ATTEMPTS=2
INITIAL_GENERATION_RAN="false"
INIT_CRITIC_GATE_PASSED="false"
CRITIC_PROTOCOL_SECTION=""
CRITIC_SCOPE_REPOS_RAW=""
CRITIC_SCOPE_REQUIREMENTS_RAW=""
CRITIC_SCOPE_REPOS_PROMPT="- All repositories in .repo-index.yml"
CRITIC_SCOPE_REQUIREMENTS_PROMPT="- All active requirement and guardrail sources"
declare -a PATTERN_DOC_SNAPSHOT_NAMES=()
declare -a PATTERN_DOC_SNAPSHOT_CONTENTS=()

# ─────────────────────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config|-c)
      CONFIG_FILE="$2"; shift 2 ;;
    --start-phase|-s)
      START_PHASE="$2"; shift 2 ;;
    --end-phase|-e)
      END_PHASE="$2"; shift 2 ;;
    --auto-delete)
      AUTO_DELETE=true; shift ;;
    --help|-h)
      echo "Usage: scripts/init.sh [--config init.yml] [--start-phase N] [--end-phase N] [--auto-delete]"
      echo ""
      echo "Options:"
      echo "  --config, -c       Path to init YAML config"
      echo "  --start-phase, -s  Resume from phase N (0-6)"
      echo "  --auto-delete      Skip confirmation prompt for fresh_start file deletion"
      exit 0 ;;
    *)
      echo "ERROR: Unknown argument: $1"; exit 1 ;;
  esac
done

# ─────────────────────────────────────────────────────────────
# Modular helper sources
# ─────────────────────────────────────────────────────────────
INIT_LIB_DIR="$SCRIPT_DIR/init/core"
# shellcheck source=./init/core/common.sh
source "$INIT_LIB_DIR/common.sh"

# Copilot telemetry tracking
# shellcheck source=./init/core/copilot.sh
source "$INIT_LIB_DIR/copilot.sh"

collect_requirement_source_files() {
  local -a sources=()
  local req_file doc_file
  [[ -f "$TARGET_DIR/.copilot/guardrails/init-pattern.yml" ]] && sources+=("$TARGET_DIR/.copilot/guardrails/init-pattern.yml")
  [[ -f "$TARGET_DIR/.copilot/guardrails/pattern.yml" ]] && sources+=("$TARGET_DIR/.copilot/guardrails/pattern.yml")
  [[ -f "$TARGET_DIR/.copilot/guardrails/nfr.yml" ]] && sources+=("$TARGET_DIR/.copilot/guardrails/nfr.yml")
  if [[ -d "$TARGET_DIR/.copilot/guardrails/requirements-docs" ]]; then
    while IFS= read -r doc_file; do
      sources+=("$doc_file")
    done < <(find "$TARGET_DIR/.copilot/guardrails/requirements-docs" -maxdepth 1 -type f \( -name '*.md' -o -name '*.yml' \) | sort)
  fi
  if [[ -d "$TARGET_DIR/.requirements" ]]; then
    while IFS= read -r req_file; do
      sources+=("$req_file")
    done < <(find "$TARGET_DIR/.requirements" -maxdepth 1 -type f -name '*.yml' | sort)
  fi
  printf '%s\n' "${sources[@]}"
}

active_requirement_sources() {
  local req_file rel_path
  while IFS= read -r req_file; do
    [[ -z "$req_file" ]] && continue
    rel_path="${req_file#$TARGET_DIR/}"
    printf -- "- %s\n" "$rel_path"
  done < <(collect_requirement_source_files)
}

requirement_sources_contain_pattern() {
  local pattern="$1"
  local req_file
  while IFS= read -r req_file; do
    [[ -z "$req_file" ]] && continue
    if grep -Eiq "$pattern" "$req_file" 2>/dev/null; then
      return 0
    fi
  done < <(collect_requirement_source_files)
  return 1
}

evaluate_required_technologies() {
  local -a unmet=()
  local i role repo_name repo_path agent_file
  local has_agent_role=false has_infra_role=false
  local maf_required=false avm_required=false
  local maf_met=false avm_met=false

  for ((i=0; i<CHILD_COUNT; i++)); do
    role="${CHILD_ROLES[$i]}"
    [[ "$role" == "agent" ]] && has_agent_role=true
    [[ "$role" == "infra" ]] && has_infra_role=true
  done

  if [[ "$has_agent_role" == true ]] || requirement_sources_contain_pattern 'microsoft[[:space:]-]*agent[[:space:]-]*framework|agent_framework\.Agent|FoundryChatClient'; then
    maf_required=true
  fi
  if [[ "$has_infra_role" == true ]] || requirement_sources_contain_pattern 'azure[[:space:]-]*verified[[:space:]-]*modules|\bAVM\b'; then
    avm_required=true
  fi

  if [[ "$maf_required" == true ]]; then
    for ((i=0; i<CHILD_COUNT; i++)); do
      role="${CHILD_ROLES[$i]}"
      [[ "$role" != "agent" ]] && continue
      repo_name="${CHILD_NAMES[$i]}"
      repo_path="${CHILD_LOCAL_PATHS[$i]}"
      agent_file="$(specialist_agent_file_for_repo "$repo_name" "$repo_path")"
      if [[ -f "$agent_file" ]] && grep -Eiq 'microsoft[[:space:]-]*agent[[:space:]-]*framework|agent_framework\.Agent|FoundryChatClient' "$agent_file"; then
        maf_met=true
        break
      fi
    done
    if [[ "$maf_met" != true ]]; then
      unmet+=("Microsoft Agent Framework requirement is unmet: no agent specialist artifact references Microsoft Agent Framework/agent_framework.Agent/FoundryChatClient.")
    fi
  fi

  if [[ "$avm_required" == true ]]; then
    if [[ -f "$ORCHESTRATOR_INSTRUCTIONS_FILE" ]] && grep -Eiq 'azure[[:space:]-]*verified[[:space:]-]*modules|\bAVM\b' "$ORCHESTRATOR_INSTRUCTIONS_FILE"; then
      avm_met=true
    elif [[ -f "$LEGACY_ORCHESTRATOR_INSTRUCTIONS_FILE" ]] && grep -Eiq 'azure[[:space:]-]*verified[[:space:]-]*modules|\bAVM\b' "$LEGACY_ORCHESTRATOR_INSTRUCTIONS_FILE"; then
      avm_met=true
    fi
    if [[ "$avm_met" != true ]]; then
      for ((i=0; i<CHILD_COUNT; i++)); do
        role="${CHILD_ROLES[$i]}"
        [[ "$role" != "infra" ]] && continue
        repo_name="${CHILD_NAMES[$i]}"
        repo_path="${CHILD_LOCAL_PATHS[$i]}"
        agent_file="$(specialist_agent_file_for_repo "$repo_name" "$repo_path")"
        if [[ -f "$agent_file" ]] && grep -Eiq 'azure[[:space:]-]*verified[[:space:]-]*modules|\bAVM\b' "$agent_file"; then
          avm_met=true
          break
        fi
      done
    fi
    if [[ "$avm_met" != true ]]; then
      unmet+=("Azure Verified Modules requirement is unmet: no orchestrator/specialist artifact explicitly requires Azure Verified Modules (AVM).")
    fi
  fi

  if [[ "${#unmet[@]}" -eq 0 ]]; then
    return 0
  fi
  printf -- "- %s\n" "${unmet[@]}"
  return 1
}

run_orchestration_preflight() {
  local failures=0
  local i repo_name repo_path repo_dir specialist_file critic_file path
  local has_repo_index_server has_child_runner_server has_usage_tracker_server

  log "Running orchestration preflight checks..."
  log "Preflight debug: shell_cwd=$(pwd)"
  log "Preflight debug: target_dir=${TARGET_DIR}"
  log "Preflight debug: mcp_enabled=${ENABLE_MCP:-false} mcp_config=${MCP_CONFIG_FILE}"

  if ! command -v copilot >/dev/null 2>&1; then
    warn "Missing required executable: copilot"
    failures=$((failures + 1))
  fi
  if ! command -v git >/dev/null 2>&1; then
    warn "Missing required executable: git"
    failures=$((failures + 1))
  fi
  if [[ "${ENABLE_MCP:-false}" == "true" && ! -x "$FRAMEWORK_DIR/.venv/bin/python" ]]; then
    warn "Missing required MCP interpreter: $FRAMEWORK_DIR/.venv/bin/python"
    failures=$((failures + 1))
  fi

  if [[ ! -f "$TARGET_DIR/.repo-index.yml" ]]; then
    warn "Missing required file: .repo-index.yml"
    failures=$((failures + 1))
  fi
  if [[ ! -f "$ORCHESTRATOR_INSTRUCTIONS_FILE" ]]; then
    warn "Missing required file: $ORCHESTRATOR_INSTRUCTIONS_REL"
    failures=$((failures + 1))
  fi
  if [[ "${ENABLE_MCP:-false}" == "true" && ! -f "$MCP_CONFIG_FILE" ]]; then
    warn "Missing required file for MCP mode: $MCP_CONFIG_REL"
    failures=$((failures + 1))
  fi
  if [[ "${ENABLE_MCP:-false}" == "true" && -f "$MCP_CONFIG_FILE" ]]; then
    has_repo_index_server="no"
    has_child_runner_server="no"
    has_usage_tracker_server="no"
    if grep -q '"repo-index"' "$MCP_CONFIG_FILE"; then
      has_repo_index_server="yes"
    fi
    if grep -q '"child-agent-runner"' "$MCP_CONFIG_FILE"; then
      has_child_runner_server="yes"
    fi
    if grep -q '"usage-tracker"' "$MCP_CONFIG_FILE"; then
      has_usage_tracker_server="yes"
    fi
    log "Preflight debug: mcp_servers repo-index=${has_repo_index_server} child-agent-runner=${has_child_runner_server} usage-tracker=${has_usage_tracker_server}"

    # Smoke-test critical MCP servers: confirm they import and register tools.
    # A version-incompatible dependency (e.g. pydantic too old for mcp) crashes
    # servers on the @mcp.tool() decorator, silently exposing zero tools.
    if [[ -x "$FRAMEWORK_DIR/.venv/bin/python" ]]; then
      while IFS=$'\t' read -r server_name server_command server_script; do
        [[ -z "$server_script" ]] && continue
        if [[ "$server_command" != "$FRAMEWORK_DIR/.venv/bin/python" ]]; then
          warn "MCP server '$server_name' uses inconsistent interpreter: $server_command"
          failures=$((failures + 1))
          continue
        fi
        smoke_out="$(PROJECT_DIR="$TARGET_DIR" PROJECT_NAME="${PROJECT_NAME:-}" timeout 20 "$server_command" "$server_script" </dev/null 2>&1)"
        if printf '%s' "$smoke_out" | grep -q "Traceback (most recent call last)"; then
          warn "MCP server failed to start with configured interpreter: ${server_script}"
          warn "$(printf '%s' "$smoke_out" | grep -E 'Error|Traceback' | tail -n 1)"
          failures=$((failures + 1))
        else
          log "Preflight debug: mcp_server_startup ok=${server_script} interpreter=${server_command}"
        fi
      done < <("$FRAMEWORK_DIR/.venv/bin/python" -c "
import json, sys
try:
    cfg = json.load(open('$MCP_CONFIG_FILE'))
except Exception:
    sys.exit(0)
for name in ('repo-index', 'child-agent-runner'):
    srv = cfg.get('mcpServers', {}).get(name, {})
    command = srv.get('command') or ''
    args = srv.get('args') or []
    if args:
        print(f'{name}\t{command}\t{args[0]}')
")
    fi
  fi

  for ((i=0; i<CHILD_COUNT; i++)); do
    repo_name="${CHILD_NAMES[$i]}"
    repo_path="${CHILD_LOCAL_PATHS[$i]}"
    repo_dir="$(resolve_repo_path "$repo_path")"
    specialist_file="$(specialist_agent_file_for_repo "$repo_name" "$repo_path")"
    critic_file="$(critic_agent_file_for_repo "$repo_name" "$repo_path")"

    for path in \
      "$repo_dir" \
      "$repo_dir/.github/agents" \
      "$repo_dir/work" \
      "$repo_dir/work/todo" \
      "$repo_dir/work/ready-for-review" \
      "$repo_dir/work/done"; do
      if [[ ! -d "$path" ]]; then
        warn "Missing required child path for ${repo_name}: ${path}"
        failures=$((failures + 1))
      fi
    done

    if [[ ! -f "$specialist_file" ]]; then
      warn "Missing specialist agent file for ${repo_name}: ${specialist_file}"
      failures=$((failures + 1))
    fi
    if [[ ! -f "$critic_file" ]]; then
      warn "Missing critic agent file for ${repo_name}: ${critic_file}"
      failures=$((failures + 1))
    fi
    log "Preflight debug: child=${repo_name} repo_path=${repo_path} resolved=${repo_dir} specialist=${specialist_file} critic=${critic_file}"
  done

  if [[ "$failures" -gt 0 ]]; then
    echo "ERROR: Orchestration preflight failed with ${failures} issue(s)." >&2
    return 1
  fi

  log "Orchestration preflight passed"
  return 0
}

run_init_critique_remediation_loop() {
  local requirement_sources critique_output remediation_output machine_unmet critique_status
  local attempt max_attempts rc
  max_attempts=3

  if [[ "${FEATURE_CRITIC_EVALUATOR:-true}" != "true" ]]; then
    log "Critic gate optional feature disabled — skipping critique/remediation loop"
    INIT_CRITIC_GATE_PASSED="true"
    return 0
  fi

  requirement_sources="$(active_requirement_sources)"

  if [[ -z "$requirement_sources" ]]; then
    log "No active requirements/guardrails found — skipping critique-remediation loop"
    INIT_CRITIC_GATE_PASSED="true"
    return 0
  fi

  for attempt in $(seq 1 "$max_attempts"); do
    log "Critic gate pass ${attempt}/${max_attempts}: verifying generated artifacts against active requirements"
    if critique_output=$(copilot_prompt "Act as the critic/evaluator for generated initialization artifacts.
You are a hard gate: specialists implement, critic evaluates, acceptance requires PASS.

Audit the generated initialization artifacts for requirement fidelity.

Project root: $TARGET_DIR

Active requirement and guardrail sources:
$requirement_sources

Critic scope (repos):
${CRITIC_SCOPE_REPOS_PROMPT}

Critic scope (requirements):
${CRITIC_SCOPE_REQUIREMENTS_PROMPT}

Artifacts to verify:
- .github/copilot-instructions.md
- <child-repo>/.github/agents/*.agent.md
- <child-repo>/work/{todo,ready-for-review,done}/* (when present)
- .contracts/*.yml
- .requirements/*.yml
- .decisions/log.md

Tasks:
1. Read every listed source requirement/guardrail file.
2. Verify generated artifacts for likely omissions, contradictions, or requirement drift.
3. Focus on high-confidence issues only (missing mandatory requirement linkage, contradictory instructions, absent required constraints).
4. Explicitly FAIL if any artifact or child work request contradicts binding requirements from .requirements/*.yml, .contracts/*.yml, or .requirements/platform-guardrails.yml pattern_constraints.
5. Contradictions include introducing prohibitions that negate required technologies (example: forbidding external LLM usage when binding constraints require FoundryChatClient).
6. Prioritize findings that fall within the configured critic scope.
7. Return output in this exact format:
STATUS: PASS|FAIL
FINDINGS:
- <finding with source file + artifact file>
- <or 'none'>
REMEDIATION_HINTS:
- <specific edits needed>
- <or 'none'>

Return FAIL if any unresolved contradiction or omission remains. Return PASS only when all checked artifacts align with active requirements."); then
      :
    else
      rc=$?
      critique_output="${critique_output}

STATUS: FAIL
FINDINGS:
- Critique command failed with exit code ${rc}
REMEDIATION_HINTS:
- Re-run critique after fixing Copilot execution issues."
    fi

    machine_unmet=""
    if ! machine_unmet="$(evaluate_required_technologies)"; then
      warn "Machine-checkable requirement validation reported unmet requirements"
      critique_output="${critique_output}

STATUS: FAIL
UNMET_REQUIREMENTS:
${machine_unmet}"
    fi

    critique_status="$(echo "$critique_output" | grep -E '^STATUS:[[:space:]]*(PASS|FAIL)[[:space:]]*$' | tail -n 1 | sed -E 's/^STATUS:[[:space:]]*//' | tr -d '\r' | tr -d '[:space:]')"
    if [[ "$critique_status" != "PASS" && "$critique_status" != "FAIL" ]]; then
      critique_output="${critique_output}

STATUS: FAIL
FINDINGS:
- Critic output missing required STATUS: PASS|FAIL line
REMEDIATION_HINTS:
- Return exact STATUS format and resolve all findings"
      critique_status="FAIL"
    fi

    if [[ "$critique_status" == "PASS" ]]; then
      INIT_CRITIC_GATE_PASSED="true"
      log "Critic gate pass ${attempt} succeeded — no blocking contradictions detected"
      return 0
    fi

    INIT_CRITIC_GATE_PASSED="false"
    warn "Critic gate pass ${attempt} reported unresolved issues"
    if [[ "$attempt" -ge "$max_attempts" ]]; then
      echo "ERROR: Critic gate failed after ${max_attempts} attempts." >&2
      echo "Last critic output:" >&2
      echo "$critique_output" >&2
      if [[ -n "${machine_unmet:-}" ]]; then
        echo "UNMET_REQUIREMENTS:" >&2
        echo "$machine_unmet" >&2
      fi
      return 1
    fi

    log "Running remediation attempt ${attempt}/${max_attempts} based on critic findings"
    if remediation_output=$(copilot_prompt "Remediate generated initialization artifacts so they align with active requirements and guardrails.

Project root: $TARGET_DIR

Active requirement and guardrail sources:
$requirement_sources

Critic scope (repos):
${CRITIC_SCOPE_REPOS_PROMPT}

Critic scope (requirements):
${CRITIC_SCOPE_REQUIREMENTS_PROMPT}

Critique findings to resolve:
$critique_output

Instructions:
1. Edit generated artifacts directly to resolve each finding.
2. Preserve deterministic framework structure; only make targeted corrections.
3. If a finding is invalid, document why in .decisions/log.md.
4. Do not introduce new architecture beyond source requirements.
5. Keep critic gate semantics intact: specialists implement, critic evaluates with PASS/FAIL.
6. Remove or rewrite any contradictory request text that conflicts with .requirements/*.yml, .contracts/*.yml, or pattern_constraints in .requirements/platform-guardrails.yml.
7. Output exactly:
REMEDIATION: COMPLETE
CHANGES:
- <file>: <what changed>
- <or 'none'>"); then
      :
    else
      rc=$?
      warn "Remediation attempt ${attempt} failed (exit ${rc}); continuing to next critique pass"
    fi
  done

  INIT_CRITIC_GATE_PASSED="false"
  return 1
}

write_guardrail_snapshots() {
  local NFR_CONTENT i safe_doc_name repo_name role stack description stack_and_desc
  local esc_repo_name esc_role esc_stack esc_description
  mkdir -p "$TARGET_DIR/.copilot/guardrails"
  mkdir -p "$TARGET_DIR/.copilot/guardrails/requirements-docs"
  mkdir -p "$TARGET_DIR/.requirements"

  if [[ -n "${CONFIG_FILE:-}" && -f "$CONFIG_FILE" ]]; then
    cp "$CONFIG_FILE" "$TARGET_DIR/.copilot/guardrails/init-pattern.yml"
    log "Created .copilot/guardrails/init-pattern.yml"
  fi

  if [[ -n "${PATTERN_FILE:-}" && -f "$PATTERN_FILE" ]]; then
    cp "$PATTERN_FILE" "$TARGET_DIR/.copilot/guardrails/pattern.yml"
    log "Created .copilot/guardrails/pattern.yml"
  fi
  if [[ -n "${NFR:-}" ]]; then
    NFR_CONTENT=$(resolve_content "$NFR")
    printf '%s\n' "$NFR_CONTENT" > "$TARGET_DIR/.copilot/guardrails/nfr.yml"
    log "Created .copilot/guardrails/nfr.yml"
  fi
  if [[ "${#PATTERN_DOC_SNAPSHOT_NAMES[@]}" -gt 0 ]]; then
    for ((i=0; i<${#PATTERN_DOC_SNAPSHOT_NAMES[@]}; i++)); do
      safe_doc_name=$(echo "${PATTERN_DOC_SNAPSHOT_NAMES[$i]}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')
      [[ -z "$safe_doc_name" ]] && safe_doc_name="requirements-doc-$i"
      printf '%s\n' "${PATTERN_DOC_SNAPSHOT_CONTENTS[$i]}" > "$TARGET_DIR/.copilot/guardrails/requirements-docs/${safe_doc_name}.md"
    done
    log "Created .copilot/guardrails/requirements-docs/*.md snapshots"
  fi

  if [[ -f "$TARGET_DIR/.copilot/guardrails/pattern.yml" || -f "$TARGET_DIR/.copilot/guardrails/nfr.yml" || -f "$TARGET_DIR/.copilot/guardrails/init-pattern.yml" ]]; then
    write_from_template "requirements/platform-guardrails-prefix.yml.tmpl" "$TARGET_DIR/.requirements/platform-guardrails.yml"

    if [[ -n "${PATTERN_FILE:-}" && -f "$TARGET_DIR/.copilot/guardrails/pattern.yml" ]]; then
      {
        echo "pattern_constraints:"
        for ((i=0; i<CHILD_COUNT; i++)); do
          repo_name="$(normalize_requirement_text "${CHILD_NAMES[$i]:-}")"
          role="$(normalize_requirement_text "${CHILD_ROLES[$i]:-}")"
          stack="$(normalize_requirement_text "${CHILD_STACKS[$i]:-}")"
          description="$(normalize_requirement_text "${CHILD_DESCS[$i]:-}")"

          stack_and_desc=""
          [[ -n "$stack" ]] && stack_and_desc="$stack"
          if [[ -n "$description" ]]; then
            stack_and_desc="${stack_and_desc}${stack_and_desc:+; }${description}"
          fi
          [[ -z "$stack_and_desc" ]] && continue

          esc_repo_name="$(yaml_escape_double "$repo_name")"
          esc_role="$(yaml_escape_double "$role")"
          esc_stack="$(yaml_escape_double "$stack")"
          esc_description="$(yaml_escape_double "$description")"

          printf '  - repo: "%s"\n' "$esc_repo_name"
          printf '    role: "%s"\n' "$esc_role"
          if [[ -n "$stack" ]]; then
            printf '    stack: "%s"\n' "$esc_stack"
          fi
          if [[ -n "$description" ]]; then
            printf '    description: "%s"\n' "$esc_description"
          fi
        done
      } >> "$TARGET_DIR/.requirements/platform-guardrails.yml"
    fi

    append_template_file "requirements/platform-guardrails-suffix.yml.tmpl" "$TARGET_DIR/.requirements/platform-guardrails.yml"
    log "Created .requirements/platform-guardrails.yml"
  fi
}

create_post_eval_baseline_commits() {
  local i repo_dir child_message child_top
  local parent_commit_message

  parent_commit_message="feat!: initialize enterprise-copilot-fleet-controller v2 for $PROJECT_NAME

- Child-repo specialists/critics (<child>/.github/agents/*.agent.md)
- Orchestrator (.github/copilot-instructions.md)
- Project guardrails (.copilot/guardrails/*, .requirements/platform-guardrails.yml)
- MCP tools (.github/mcp.json, optional)
- Contract directory (.contracts/)
- Requirements directory (.requirements/)
- Decision log (.decisions/log.md)
- Child repo references (.repo-index.yml)"
  if [[ "${HAS_EXISTING_CODE:-false}" == true ]]; then
    parent_commit_message+="
- Extracted contracts from existing code"
  fi
  parent_commit_message+="

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

  git -C "$TARGET_DIR" add -A
  if ! git -C "$TARGET_DIR" diff --cached --quiet; then
    git -C "$TARGET_DIR" commit -m "$parent_commit_message"
  fi

  child_message="chore: copilot baseline after eval pass

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  for ((i=0; i<CHILD_COUNT; i++)); do
    repo_dir="$(resolve_repo_path "${CHILD_LOCAL_PATHS[$i]}")"
    child_top="$(git -C "$repo_dir" rev-parse --show-toplevel 2>/dev/null || true)"
    if [[ "$child_top" != "$(realpath -m "$repo_dir")" || ! -d "$repo_dir/.git" ]]; then
      continue
    fi
    git -C "$repo_dir" add -A
    if git -C "$repo_dir" diff --cached --quiet; then
      git -C "$repo_dir" commit --allow-empty -m "$child_message" >/dev/null 2>&1 || true
    else
      git -C "$repo_dir" commit -m "$child_message" >/dev/null 2>&1 || true
    fi
  done
}



# YAML parser — prefer yq, fall back to python3
parse_yaml_value() {
  local file="$1" query="$2"
  if command -v python3 &>/dev/null && [[ -f "$INIT_HELPERS_PY" ]]; then
    python3 "$INIT_HELPERS_PY" yaml-value --file "$file" --path "$query" 2>/dev/null || true
    return 0
  fi
  if command -v yq &>/dev/null; then
    yq eval "$query" "$file" 2>/dev/null | grep -v '^null$' || true
    return 0
  fi
  echo "ERROR: Need python3 with PyYAML (preferred) or yq" >&2
  exit 1
}

parse_yaml_multiline() {
  local file="$1" query="$2"
  if command -v python3 &>/dev/null && [[ -f "$INIT_HELPERS_PY" ]]; then
    python3 "$INIT_HELPERS_PY" yaml-multiline --file "$file" --path "$query" 2>/dev/null || true
    return 0
  fi
  if command -v yq &>/dev/null; then
    yq eval "$query" "$file" 2>/dev/null | grep -v '^null$' || true
  fi
}

parse_yaml_array_length() {
  local file="$1" query="$2"
  if command -v python3 &>/dev/null && [[ -f "$INIT_HELPERS_PY" ]]; then
    python3 "$INIT_HELPERS_PY" yaml-array-length --file "$file" --path "$query" 2>/dev/null || echo "0"
    return 0
  fi
  if command -v yq &>/dev/null; then
    yq eval "$query | length" "$file" 2>/dev/null || echo "0"
  fi
}

parse_yaml_string_list() {
  local file="$1" query="$2"
  if command -v python3 &>/dev/null && [[ -f "$INIT_HELPERS_PY" ]]; then
    python3 "$INIT_HELPERS_PY" yaml-string-list --file "$file" --path "$query" 2>/dev/null || true
  elif command -v yq &>/dev/null; then
    yq eval "$query | (if type == \"!!seq\" then .[] else . end)" "$file" 2>/dev/null | grep -v '^null$' || true
  fi
}

normalize_bool() {
  local value="${1:-}"
  value="${value,,}"
  case "$value" in
    true|false) echo "$value" ;;
    "") echo "" ;;
    *) echo "__INVALID__" ;;
  esac
}

normalize_visibility() {
  local value="${1:-}"
  value="${value,,}"
  case "$value" in
    public|private|local) echo "$value" ;;
    "") echo "" ;;
    *) echo "__INVALID__" ;;
  esac
}

normalize_metrics_enforcement_mode() {
  local value="${1:-}"
  value="${value,,}"
  case "$value" in
    strict|warn) echo "$value" ;;
    "") echo "" ;;
    *) echo "__INVALID__" ;;
  esac
}

require_bool() {
  local value="$1" key="$2"
  if [[ "$value" == "__INVALID__" ]]; then
    echo "ERROR: ${key} must be true or false" >&2
    exit 1
  fi
}

require_visibility() {
  local value="$1" key="$2"
  if [[ "$value" == "__INVALID__" ]]; then
    echo "ERROR: ${key} must be public, private, or local" >&2
    exit 1
  fi
}

require_metrics_enforcement_mode() {
  local value="$1" key="$2"
  if [[ "$value" == "__INVALID__" ]]; then
    echo "ERROR: ${key} must be strict or warn" >&2
    exit 1
  fi
}

require_non_negative_integer() {
  local value="$1" key="$2"
  if [[ -z "$value" ]]; then
    return 0
  fi
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "ERROR: ${key} must be a non-negative integer" >&2
    exit 1
  fi
}

optional_feature_state_table() {
  cat <<EOF
| Feature | Enabled | Notes |
|---------|---------|-------|
| mobile_ci_cd | ${FEATURE_MOBILE_CI_CD} | DEPRECATED (no-op) — GitHub Actions removed in favor of local \`azd\` |
| runner_self_heal | ${FEATURE_RUNNER_SELF_HEAL} | DEPRECATED (no-op) — GitHub Actions removed in favor of local \`azd\` |
| semantic_release | ${FEATURE_SEMANTIC_RELEASE} | DEPRECATED (no-op) — GitHub Actions removed in favor of local \`azd\` |
| onboarding_docs | ${FEATURE_ONBOARDING_DOCS} | Generate \`.copilot/docs/developer-onboarding.md\` |
| portability_blueprints | ${FEATURE_PORTABILITY_BLUEPRINTS} | Generate \`.copilot/docs/portability-blueprint.md\` |
| fleet_instrument | ${FEATURE_FLEET_INSTRUMENT} | Move the delivery protocol into an on-demand \`<project>-fleet-instrument\` agent and keep \`.github/copilot-instructions.md\` thin |
| critic_evaluator | ${FEATURE_CRITIC_EVALUATOR} | Run optional PASS/FAIL critic gate using configured \`critic.scope\` context |
EOF
}

derive_repo_name_from_url() {
  local url="$1"
  url="${url%/}"
  url="${url##*/}"
  echo "${url%.git}"
}

derive_repo_name_from_path() {
  local repo_path="$1"
  repo_path="${repo_path%/}"
  repo_path="${repo_path##*/}"
  echo "${repo_path%.git}"
}

default_local_path_for_repo() {
  local name="$1"
  echo "../${name}"
}

resolve_repo_path() {
  local repo_path="$1"
  if [[ "$repo_path" = /* ]]; then
    realpath -m "$repo_path"
  else
    realpath -m "$HARNESS_DIR/$repo_path"
  fi
}

child_repo_agents_dir() {
  local repo_path="$1"
  local repo_dir
  repo_dir="$(resolve_repo_path "$repo_path")"
  echo "$repo_dir/.github/agents"
}

specialist_agent_file_for_repo() {
  local repo_name="$1" repo_path="$2"
  echo "$(child_repo_agents_dir "$repo_path")/${repo_name}-specialist.agent.md"
}

critic_agent_file_for_repo() {
  local repo_name="$1" repo_path="$2"
  echo "$(child_repo_agents_dir "$repo_path")/${repo_name}-critic.agent.md"
}

ensure_local_repo() {
  local repo_dir="$1"
  local repo_real top_level
  mkdir -p "$repo_dir"
  repo_real="$(realpath -m "$repo_dir")"
  top_level="$(git -C "$repo_dir" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ "$top_level" != "$repo_real" || ! -d "$repo_dir/.git" ]]; then
    git -C "$repo_dir" init -q
  fi
}

# Resolve content from: a URL (http/https), a local file path, or literal text
ALLOWED_URL_PATTERNS='^https?://([[:alnum:]-]+\.)*(azure\.com|github\.com|microsoft\.com)(/|$)|^https?://(raw\.githubusercontent\.com|gist\.githubusercontent\.com)(/|$)'

resolve_content() {
  local source="$1"
  if [[ -z "$source" ]]; then
    return
  elif [[ "$source" =~ ^https?:// ]]; then
    if [[ ! "$source" =~ $ALLOWED_URL_PATTERNS ]]; then
      warn "Blocked URL fetch (not in allowlist): $source"
      echo ""
      return
    fi
    if command -v curl &>/dev/null; then
      curl -fsSL --max-time 10 "$source" 2>/dev/null || echo "$source"
    elif command -v wget &>/dev/null; then
      wget -qO- --timeout=10 "$source" 2>/dev/null || echo "$source"
    else
      warn "Cannot fetch URL (no curl/wget): $source"
      echo "$source"
    fi
  elif [[ -f "$source" ]]; then
    cat "$source"
  else
    echo "$source"
  fi
}

# ─────────────────────────────────────────────────────────────
# Tool scoping per role
# ─────────────────────────────────────────────────────────────
tools_for_role() {
  local role="$1"
  if [[ "${ENABLE_MCP:-false}" != "true" ]]; then
    echo ""
    return
  fi
  case "$role" in
    backend)
      echo '"scaffold-generator", "lint-local", "contract-compliance", "security-scanner", "usage-tracker"' ;;
    frontend)
      echo '"lint-local", "security-scanner", "usage-tracker"' ;;
    infra)
      echo '"terraform-local", "azure-resource-status", "azure-inspector", "lint-local", "security-scanner", "usage-tracker"' ;;
    agent|worker)
      echo '"lint-local", "security-scanner", "usage-tracker"' ;;
    *)
      echo '"lint-local", "security-scanner", "usage-tracker"' ;;
  esac
}

workflow_callouts_for_role() {
  local role="$1"
  case "$role" in
    backend)
      cat <<'EOF'
- **Linting:** Use `run_local_lint` before tests/builds to catch fast local issues.
- **Contract checks:** Use `check_contract_compliance` when routes or handlers change.
- **Scaffolding:** Use `scaffold_from_contract` when implementing new contract endpoints.
- **Security:** Run `security_scan` before handoff.
- **Usage quality:** Log major steps with `log_usage`; if iteration loops, call `get_usage_quality_report`.
EOF
      ;;
    frontend)
      cat <<'EOF'
- **Linting:** Use `run_local_lint` before tests/builds to catch fast local issues.
- **Security:** Run `security_scan` before handoff.
- **Usage quality:** Log major steps with `log_usage`; if iteration loops, call `get_usage_quality_report`.
EOF
      ;;
    infra)
      cat <<'EOF'
- **Terraform checks:** Use `terraform_fmt_check`, `terraform_init_validate`, and `terraform_plan_check` before PR.
- **Azure resource inspection:** Use `list_azure_resources` and `get_azure_status` (or `find_error`) to inspect live state.
- **Azure service details:** Use `inspect_container_app`, `inspect_cosmos`, or `inspect_acr` for focused diagnostics.
- **Linting/Security:** Use `run_local_lint` and `security_scan` before handoff.
- **Usage quality:** Log major steps with `log_usage`; if diagnostics repeat, call `get_usage_quality_report`.
EOF
      ;;
    *)
      cat <<'EOF'
- **Linting:** Use `run_local_lint` before tests/builds to catch fast local issues.
- **Security:** Run `security_scan` before handoff.
- **Usage quality:** Log major steps with `log_usage`; if iteration loops, call `get_usage_quality_report`.
EOF
      ;;
  esac
}

# Detect tech stack from repo contents
detect_stack() {
  local repo_dir="$1" role="$2"
  if [[ ! -d "$repo_dir" ]]; then
    default_stack_for_role "$role"
    return
  fi

  local stack=""
  # Check for key files
  if [[ -f "$repo_dir/pyproject.toml" || -f "$repo_dir/requirements.txt" || -f "$repo_dir/setup.py" ]]; then
    stack="Python"
    if grep -ql "fastapi\|FastAPI" "$repo_dir"/*.toml "$repo_dir"/*.txt 2>/dev/null; then
      stack="Python / FastAPI"
    elif grep -ql "django\|Django" "$repo_dir"/*.toml "$repo_dir"/*.txt 2>/dev/null; then
      stack="Python / Django"
    elif grep -ql "flask\|Flask" "$repo_dir"/*.toml "$repo_dir"/*.txt 2>/dev/null; then
      stack="Python / Flask"
    fi
    if [[ -f "$repo_dir/pytest.ini" || -f "$repo_dir/conftest.py" ]] || grep -ql "pytest" "$repo_dir"/*.toml "$repo_dir"/*.txt 2>/dev/null; then
      stack="$stack / pytest"
    fi
    if grep -ql "ruff" "$repo_dir"/*.toml 2>/dev/null || [[ -f "$repo_dir/ruff.toml" ]]; then
      stack="$stack / ruff"
    fi
  elif [[ -f "$repo_dir/package.json" ]]; then
    stack="TypeScript"
    if grep -ql '"react"' "$repo_dir/package.json" 2>/dev/null; then
      stack="TypeScript / React"
    fi
    if grep -ql '"vite"' "$repo_dir/package.json" 2>/dev/null; then
      stack="$stack / Vite"
    fi
    if grep -ql '"vitest"' "$repo_dir/package.json" 2>/dev/null; then
      stack="$stack / Vitest"
    elif grep -ql '"jest"' "$repo_dir/package.json" 2>/dev/null; then
      stack="$stack / Jest"
    fi
  elif compgen -G "$repo_dir/*.tf" > /dev/null 2>&1; then
    stack="Terraform / Azure"
  elif [[ -f "$repo_dir/go.mod" ]]; then
    stack="Go"
  else
    default_stack_for_role "$role"
    return
  fi
  echo "$stack"
}

default_stack_for_role() {
  local role="$1"
  case "$role" in
    backend)  echo "Python / FastAPI / pytest / ruff" ;;
    frontend) echo "TypeScript / React / Vite / Vitest" ;;
    infra)    echo "Terraform / azurerm provider" ;;
    agent)    echo "Python / Microsoft Agent Framework / pytest" ;;
    worker)   echo "Python / pytest" ;;
    *)        echo "Unknown" ;;
  esac
}

# Detect validation commands from repo contents
detect_validate_commands() {
  local repo_dir="$1" role="$2"
  local lint_cmd test_cmd build_cmd

  if [[ ! -d "$repo_dir" ]] || [[ $(find "$repo_dir" -maxdepth 1 -type f | wc -l) -lt 2 ]]; then
    # Empty/near-empty repo — use defaults
    default_validate_for_role "$role"
    return
  fi

  # Python repos
  if [[ -f "$repo_dir/pyproject.toml" || -f "$repo_dir/requirements.txt" ]]; then
    if grep -ql "ruff" "$repo_dir"/*.toml 2>/dev/null || [[ -f "$repo_dir/ruff.toml" ]]; then
      lint_cmd="ruff check . && ruff format --check ."
    else
      lint_cmd="echo 'no linter configured'"
    fi
    if [[ -f "$repo_dir/pytest.ini" || -f "$repo_dir/conftest.py" ]] || grep -ql "pytest" "$repo_dir"/*.toml "$repo_dir"/*.txt 2>/dev/null; then
      test_cmd="python3 -m pytest tests/"
    else
      test_cmd="echo 'no tests configured'"
    fi
    build_cmd="echo 'no build step (interpreted)'"
  # Node/TS repos
  elif [[ -f "$repo_dir/package.json" ]]; then
    lint_cmd="npm run lint 2>/dev/null || echo 'no lint script'"
    test_cmd="npm test 2>/dev/null || echo 'no test script'"
    build_cmd="npm run build 2>/dev/null || echo 'no build script'"
  # Terraform repos
  elif compgen -G "$repo_dir/*.tf" > /dev/null 2>&1; then
    lint_cmd="terraform fmt -check -recursive"
    test_cmd="terraform validate"
    build_cmd="terraform plan -out=tfplan"
  else
    default_validate_for_role "$role"
    return
  fi

  echo "lint:${lint_cmd}|test:${test_cmd}|build:${build_cmd}"
}

default_validate_for_role() {
  local role="$1"
  case "$role" in
    backend)
      echo "lint:ruff check . && ruff format --check .|test:python3 -m pytest tests/|build:echo 'no build step (interpreted)'" ;;
    frontend)
      echo "lint:npm run lint|test:npm test|build:npm run build" ;;
    infra)
      echo "lint:terraform fmt -check -recursive|test:terraform validate|build:terraform plan -out=tfplan" ;;
    agent)
      echo "lint:ruff check . && ruff format --check .|test:python3 -m pytest tests/|build:echo 'no build step (interpreted)'" ;;
    worker)
      echo "lint:ruff check . && ruff format --check .|test:python3 -m pytest tests/|build:echo 'no build step (interpreted)'" ;;
    *)
      echo "lint:echo 'no linter'|test:echo 'no tests'|build:echo 'no build'" ;;
  esac
}

# Check if a repo has existing source code
repo_has_code() {
  local repo_dir="$1"
  [[ -d "$repo_dir" ]] && [[ $(find "$repo_dir" -type f \( -name "*.py" -o -name "*.ts" -o -name "*.js" -o -name "*.tf" -o -name "*.go" -o -name "*.java" -o -name "*.rs" \) 2>/dev/null | head -3 | wc -l) -gt 0 ]]
}

build_repo_binding_context_prompt() {
  local repo_name="$1" repo_role="$2"
  if ! command -v python3 &>/dev/null; then
    echo "- Binding context unavailable: python3 is not installed."
    return 0
  fi

  python3 - "$TARGET_DIR" "$repo_name" "$repo_role" <<'PYEOF'
import glob
import os
import sys

try:
    import yaml
except Exception:
    print("- Binding context unavailable: PyYAML is not installed.")
    raise SystemExit(0)

target_dir, repo_name, repo_role = sys.argv[1:4]
repo_name_l = repo_name.lower()
repo_role_l = repo_role.lower()


def load_yaml(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def short(text, limit=220):
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def norm(value):
    return str(value or "").strip().lower()


lines = []
requirements_dir = os.path.join(target_dir, ".requirements")
contracts_dir = os.path.join(target_dir, ".contracts")

# Platform pattern constraints
platform_path = os.path.join(requirements_dir, "platform-guardrails.yml")
platform_data = load_yaml(platform_path)
pattern_constraints = platform_data.get("pattern_constraints")
constraint_lines = []
if isinstance(pattern_constraints, list):
    for item in pattern_constraints:
        if not isinstance(item, dict):
            continue
        item_repo = norm(item.get("repo"))
        item_role = norm(item.get("role"))
        if item_repo != repo_name_l and item_role != repo_role_l:
            continue
        parts = []
        if item.get("stack"):
            parts.append(f"stack={short(item['stack'])}")
        if item.get("description"):
            parts.append(f"description={short(item['description'])}")
        if not parts:
            continue
        constraint_lines.append(f"- {item.get('repo', repo_name)} ({item.get('role', repo_role)}): " + "; ".join(parts))

if constraint_lines:
    lines.append("### Binding Pattern Constraints")
    lines.extend(constraint_lines)

# Requirements scoped to this repo
requirement_lines = []
for req_path in sorted(glob.glob(os.path.join(requirements_dir, "*.yml"))):
    data = load_yaml(req_path)
    if not data:
        continue
    affected = data.get("affected_repos")
    include = False
    if isinstance(affected, list):
        for item in affected:
            if isinstance(item, dict):
                target_repo = norm(item.get("repo"))
                if target_repo == repo_name_l or target_repo == repo_role_l:
                    include = True
                    break
            elif norm(item) in {repo_name_l, repo_role_l}:
                include = True
                break
    if not include:
        continue

    feature = short(data.get("feature") or os.path.basename(req_path))
    acceptance = data.get("acceptance")
    if isinstance(acceptance, list) and acceptance:
        scenario = acceptance[0]
        if isinstance(scenario, dict):
            scenario_text = scenario.get("then") or scenario.get("scenario") or scenario.get("when")
        else:
            scenario_text = str(scenario)
    else:
        scenario_text = data.get("context") or "No acceptance details found"
    requirement_lines.append(f"- {os.path.basename(req_path)} ({feature}): {short(scenario_text)}")

if requirement_lines:
    lines.append("### Binding Requirements (.requirements/*.yml)")
    lines.extend(requirement_lines)

# Contracts scoped to this repo
contract_lines = []
for contract_path in sorted(glob.glob(os.path.join(contracts_dir, "*.yml"))):
    data = load_yaml(contract_path)
    if not data:
        continue
    provider = norm(data.get("provider"))
    consumers = data.get("consumers")
    consumer_set = set()
    if isinstance(consumers, list):
        consumer_set = {norm(v) for v in consumers}
    if provider != repo_name_l and repo_name_l not in consumer_set:
        continue
    name = short(data.get("name") or os.path.basename(contract_path))
    endpoints = data.get("endpoints")
    endpoint_count = len(endpoints) if isinstance(endpoints, list) else 0
    contract_lines.append(f"- {os.path.basename(contract_path)} ({name}), endpoints={endpoint_count}, provider={data.get('provider', '')}")

if contract_lines:
    lines.append("### Binding Contracts (.contracts/*.yml)")
    lines.extend(contract_lines)

if not lines:
    lines.append("- No repo-specific binding context found in .requirements or .contracts. Use guardrails as default source of truth.")

print("\n".join(lines))
PYEOF
}

# Generate deterministic .agent.md content
generate_agent_md() {
  local name="$1" role="$2" stack="$3" validate_str="$4" description="$5" repo_path="$6"
  local tools lint_cmd test_cmd build_cmd tool_callouts platform_guardrails_section

  tools=$(tools_for_role "$role")
  tool_callouts="$(workflow_callouts_for_role "$role")"
  platform_guardrails_section=""
  if [[ "$role" == "infra" ]]; then
    platform_guardrails_section=$(cat <<'EOF'
## Platform Guardrails
- Read `.copilot/guardrails/pattern.yml` and `.copilot/guardrails/nfr.yml` before implementing.
- Use Azure Verified Modules wherever the guardrails require them and an AVM exists.
- If an AVM does not exist for a needed Azure service, note the gap in `.decisions/log.md` before using a native resource.
EOF
)
  fi

  # Parse validate string (format: lint:CMD|test:CMD|build:CMD)
  lint_cmd=$(echo "$validate_str" | sed 's/.*lint:\([^|]*\).*/\1/')
  test_cmd=$(echo "$validate_str" | sed 's/.*test:\([^|]*\).*/\1/')
  build_cmd=$(echo "$validate_str" | sed 's/.*build:\([^|]*\).*/\1/')

  TPL_NAME="$name" \
  TPL_DESCRIPTION="$description" \
  TPL_REPO_PATH="$repo_path" \
  TPL_TOOLS="$tools" \
  TPL_ROLE="$role" \
  TPL_STACK="$stack" \
  TPL_LINT_CMD="$lint_cmd" \
  TPL_TEST_CMD="$test_cmd" \
  TPL_BUILD_CMD="$build_cmd" \
  TPL_TOOL_CALLOUTS="$tool_callouts" \
  TPL_PLATFORM_GUARDRAILS_SECTION="$platform_guardrails_section" \
  render_template_stdout "$TEMPLATE_DIR/agents/specialist.agent.md.tmpl"
}

generate_critic_md() {
  local name="$1" role="$2" description="$3" repo_path="$4" validate_str="$5"
  local tools lint_cmd test_cmd
  tools=$(tools_for_role "$role")
  lint_cmd=$(echo "$validate_str" | sed 's/.*lint:\([^|]*\).*/\1/')
  test_cmd=$(echo "$validate_str" | sed 's/.*test:\([^|]*\).*/\1/')
  TPL_NAME="$name" \
  TPL_DESCRIPTION="$description" \
  TPL_REPO_PATH="$repo_path" \
  TPL_TOOLS="$tools" \
  TPL_ROLE="$role" \
  TPL_LINT_CMD="$lint_cmd" \
  TPL_TEST_CMD="$test_cmd" \
  render_template_stdout "$TEMPLATE_DIR/agents/critic.agent.md.tmpl"
}

# ─── Skills install ──────────────────────────────────────────
# Render a single skill folder from the framework skills/ library into a repo's
# .github/skills/<name>/, substituting __TOKENS__ from project config.
render_skill_into() {
  local skill_name="$1" dest_repo_dir="$2"
  local src_dir="$FRAMEWORK_DIR/skills/$skill_name"
  local dst_dir="$dest_repo_dir/.github/skills/$skill_name"
  if [[ ! -d "$src_dir" ]]; then
    warn "Skill not found in library: $skill_name (skipping)"
    return 0
  fi
  mkdir -p "$dst_dir"
  local rel out
  while IFS= read -r src_file; do
    rel="${src_file#"$src_dir"/}"
    out="$dst_dir/$rel"
    mkdir -p "$(dirname "$out")"
    TPL_PROJECT_NAME="$PROJECT_NAME" \
    TPL_REGION="${REGION:-centralus}" \
    TPL_RESOURCE_GROUP="${PROJECT_NAME}-dev-rg" \
    TPL_ACR_NAME="<set-after-provision>" \
    TPL_COSMOS_ACCOUNT="<set-after-provision>" \
    TPL_ACA_ENV_SUFFIX="<set-after-provision>" \
    TPL_WEB_CLIENT_ID="<set-after-provision>" \
    TPL_API_CLIENT_ID="<set-after-provision>" \
    TPL_TENANT_ID="<set-after-provision>" \
    render_template_file "$src_file" "$out"
  done < <(find "$src_dir" -type f)
}

# scope_matches_repo <scope-token> <kind> <role>
#   kind = "parent" | "child"
scope_matches_repo() {
  local scope="$1" kind="$2" role="$3"
  case "$scope" in
    parent) [[ "$kind" == "parent" ]] ;;
    child)  [[ "$kind" == "child" ]] ;;
    role:*) [[ "$kind" == "child" && "${scope#role:}" == "$role" ]] ;;
    *) return 1 ;;
  esac
}

# Install pattern-declared skills into the parent and each child repo.
install_skills() {
  [[ -n "${PATTERN_FILE:-}" && -f "${PATTERN_FILE:-}" ]] || { log "No pattern skills to install"; return 0; }
  local skill_count
  skill_count=$(parse_yaml_array_length "$PATTERN_FILE" ".skills")
  [[ "${skill_count:-0}" -gt 0 ]] || { log "Pattern declares no skills"; return 0; }

  local parent_installed=0
  declare -A child_installed=()

  for ((s=0; s<skill_count; s++)); do
    local skill_name
    skill_name=$(parse_yaml_value "$PATTERN_FILE" ".skills.$s.name")
    [[ -n "$skill_name" ]] || continue
    local scopes
    scopes=$(parse_yaml_string_list "$PATTERN_FILE" ".skills.$s.scope")

    while IFS= read -r scope; do
      [[ -n "$scope" ]] || continue
      if scope_matches_repo "$scope" "parent" ""; then
        render_skill_into "$skill_name" "$TARGET_DIR"
        parent_installed=$((parent_installed + 1))
      fi
      local idx
      for ((idx=0; idx<CHILD_COUNT; idx++)); do
        local crole="${CHILD_ROLES[$idx]}" cpath cdir
        if scope_matches_repo "$scope" "child" "$crole"; then
          cpath="${CHILD_LOCAL_PATHS[$idx]}"
          cdir="$(resolve_repo_path "$cpath")"
          [[ -d "$cdir" ]] || continue
          render_skill_into "$skill_name" "$cdir"
          child_installed["${CHILD_NAMES[$idx]}"]=$(( ${child_installed["${CHILD_NAMES[$idx]}"]:-0} + 1 ))
        fi
      done
    done <<< "$scopes"
  done

  log "Installed $parent_installed skill(s) into parent .github/skills/"
  for ((idx=0; idx<CHILD_COUNT; idx++)); do
    local n="${CHILD_NAMES[$idx]}"
    [[ -n "${child_installed[$n]:-}" ]] && log "Installed ${child_installed[$n]} skill(s) into $n/.github/skills/"
  done
}

# External infra skills pulled from hoopdad/mcaps-infra-skills for infra repos.
INFRA_SKILLS_REPO="hoopdad/mcaps-infra-skills"
INFRA_SKILLS_REF="main"
INFRA_SKILLS_LIST="secure-azure-terraform-coder defender-servers-skill spoke-skill"

# Install the shared MCAPS infra skills into every child repo whose role is
# "infra". Uses the upstream install-skills.sh, targeting each child repo so the
# skills land in <child>/.github/skills/ alongside framework-provided skills.
install_infra_skills() {
  local idx crole cdir skill installer rc infra_repos=0 have_infra="false"

  for ((idx=0; idx<CHILD_COUNT; idx++)); do
    [[ "${CHILD_ROLES[$idx]}" == "infra" ]] && { have_infra="true"; break; }
  done
  if [[ "$have_infra" != "true" ]]; then
    log "No infra-role child repos — skipped MCAPS infra skills"
    return 0
  fi

  if ! command -v gh >/dev/null 2>&1 && ! command -v curl >/dev/null 2>&1; then
    warn "Neither gh nor curl available — skipping MCAPS infra skills install"
    return 0
  fi

  installer="$(mktemp)"
  if ! gh api -H "Accept: application/vnd.github.raw" \
      "repos/${INFRA_SKILLS_REPO}/contents/scripts/install-skills.sh?ref=${INFRA_SKILLS_REF}" \
      > "$installer" 2>/dev/null; then
    warn "Could not fetch install-skills.sh from ${INFRA_SKILLS_REPO} — skipping infra skills"
    rm -f "$installer"
    return 0
  fi

  for ((idx=0; idx<CHILD_COUNT; idx++)); do
    crole="${CHILD_ROLES[$idx]}"
    [[ "$crole" == "infra" ]] || continue
    cdir="$(resolve_repo_path "${CHILD_LOCAL_PATHS[$idx]}")"
    [[ -d "$cdir" ]] || { warn "Infra repo dir missing, skipping: $cdir"; continue; }
    infra_repos=$((infra_repos + 1))
    for skill in $INFRA_SKILLS_LIST; do
      rc=0
      bash "$installer" --repo "$INFRA_SKILLS_REPO" --ref "$INFRA_SKILLS_REF" \
        --target "$cdir" --skill "$skill" >/dev/null 2>&1 || rc=$?
      if [[ $rc -eq 0 ]]; then
        log "Installed infra skill '$skill' into ${CHILD_NAMES[$idx]}/.github/skills/"
      else
        warn "Failed to install infra skill '$skill' into ${CHILD_NAMES[$idx]} (rc=$rc)"
      fi
    done
  done

  rm -f "$installer"
  log "Installed MCAPS infra skills into $infra_repos infra-role child repo(s)"
}

# Replicate the MCP tools configuration into every child repo so child Copilot
# runs (spawned by child-agent-runner with cwd=<child repo>) auto-discover the
# workspace MCP config. The CLI discovers workspace MCP from `.mcp.json` or
# `.github/mcp.json`, so children use the same documented `.github/mcp.json`
# path as the parent — minus the parent-only orchestration servers.
install_child_mcp_configs() {
  [[ "${ENABLE_MCP:-false}" == "true" ]] || { log "MCP disabled — skipping child MCP config install"; return 0; }
  local idx cdir cfg installed=0
  for ((idx=0; idx<CHILD_COUNT; idx++)); do
    cdir="$(resolve_repo_path "${CHILD_LOCAL_PATHS[$idx]}")"
    [[ -d "$cdir" ]] || { warn "Child repo dir missing, skipping MCP config: $cdir"; continue; }
    cfg="$cdir/.github/mcp.json"
    write_child_mcp_config "$cfg"
    installed=$((installed + 1))
    log "Installed child MCP config into ${CHILD_NAMES[$idx]}/.github/mcp.json"
  done
  log "Installed child-scoped MCP config into $installed child repo(s)"
}

# Generate a child repo's .github/copilot-instructions.md (azd-aware, no GitHub Actions).
generate_child_instructions() {
  local name="$1" role="$2" desc="$3" repo_path="$4" stack="$5" validate_cmd="$6"
  local out_file mcp_bullets tools_csv repo_dir
  repo_dir="$(resolve_repo_path "$repo_path")"
  out_file="$repo_dir/.github/copilot-instructions.md"
  mkdir -p "$repo_dir/.github"
  tools_csv="$(tools_for_role "$role")"
  if [[ -n "$tools_csv" ]]; then
    mcp_bullets="$(echo "$tools_csv" | tr ',' '\n' | sed -e 's/^[[:space:]]*//' -e 's/"//g' -e 's/^/- `/' -e 's/$/`/')"
  else
    mcp_bullets="- (MCP tools disabled for this project)"
  fi
  TPL_FRAMEWORK_VERSION="$FRAMEWORK_VERSION" \
  TPL_NAME="$name" \
  TPL_PROJECT_NAME="$PROJECT_NAME" \
  TPL_ROLE="$role" \
  TPL_DESCRIPTION="$desc" \
  TPL_STACK="$stack" \
  TPL_VALIDATE_CMD="$validate_cmd" \
  TPL_CHILD_MCP_TOOLS="$mcp_bullets" \
  render_template_file "$TEMPLATE_DIR/child-instructions.md.tmpl" "$out_file"
}

# Validate LLM-generated agent.md for reasonableness
validate_agent_md() {
  local file="$1" name="$2" role="$3" repo_path="$4"
  if command -v python3 &>/dev/null && [[ -f "$INIT_HELPERS_PY" ]]; then
    python3 "$INIT_HELPERS_PY" validate-agent-md \
      --file "$file" \
      --name "$name" \
      --role "$role" \
      --repo-path "$repo_path"
    return $?
  fi
  # Fallback: minimal shell check if Python helper is unavailable.
  [[ -f "$file" ]] || { echo "FAIL: file not created"; return 1; }
  grep -q "^name:" "$file" && grep -q "^description:" "$file" && grep -q "^tools:" "$file" || {
    echo "FAIL: missing required frontmatter fields; "
    return 1
  }
  grep -Fq "$repo_path" "$file" || { echo "FAIL: missing reference to ${repo_path}; "; return 1; }
  return 0
}

# ─────────────────────────────────────────────────────────────
# Load config
# ─────────────────────────────────────────────────────────────
if [[ -n "$CONFIG_FILE" ]]; then
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: Config file not found: $CONFIG_FILE"; exit 1
  fi
  CONFIG_FILE="$(realpath -m "$CONFIG_FILE")"
  PROJECT_NAME=$(parse_yaml_value "$CONFIG_FILE" ".project.name")
  PROJECT_DESC=$(parse_yaml_value "$CONFIG_FILE" ".project.description")
  APP_DESC=$(parse_yaml_value "$CONFIG_FILE" ".project.app_description")
  CREATE_REPOS=$(parse_yaml_value "$CONFIG_FILE" ".project.create_repos")
  GITHUB_OWNER=$(parse_yaml_value "$CONFIG_FILE" ".project.github_owner")
  INITIAL_PROMPT=$(parse_yaml_value "$CONFIG_FILE" ".project.initial_prompt")
  REPO_VISIBILITY=$(parse_yaml_value "$CONFIG_FILE" ".project.visibility")
  FRESH_START=$(parse_yaml_value "$CONFIG_FILE" ".project.fresh_start")
  NFR=$(parse_yaml_value "$CONFIG_FILE" ".project.nfr")
  PARENT_DIR=$(parse_yaml_value "$CONFIG_FILE" ".project.parent_dir")
  PATTERN=$(parse_yaml_value "$CONFIG_FILE" ".project.pattern")
  ENABLE_MCP=$(parse_yaml_value "$CONFIG_FILE" ".project.enable_mcp")
  DEPLOYMENT_MODEL=$(parse_yaml_value "$CONFIG_FILE" ".project.deployment_model")
  REGION=$(parse_yaml_value "$CONFIG_FILE" ".project.region")
  cfg_mobile_ci_cd=$(parse_yaml_value "$CONFIG_FILE" ".optional_features.mobile_ci_cd")
  cfg_runner_self_heal=$(parse_yaml_value "$CONFIG_FILE" ".optional_features.runner_self_heal")
  cfg_semantic_release=$(parse_yaml_value "$CONFIG_FILE" ".optional_features.semantic_release")
  cfg_onboarding_docs=$(parse_yaml_value "$CONFIG_FILE" ".optional_features.onboarding_docs")
  cfg_portability_blueprints=$(parse_yaml_value "$CONFIG_FILE" ".optional_features.portability_blueprints")
  cfg_fleet_instrument=$(parse_yaml_value "$CONFIG_FILE" ".optional_features.fleet_instrument")
  cfg_critic_evaluator=$(parse_yaml_value "$CONFIG_FILE" ".optional_features.critic_evaluator")
  cfg_copilot_metrics_enforcement_mode=$(parse_yaml_value "$CONFIG_FILE" ".copilot_usage_metrics.enforcement_mode")
  cfg_copilot_metrics_retry_attempts=$(parse_yaml_value "$CONFIG_FILE" ".copilot_usage_metrics.retry_attempts")
  cfg_critic_scope_repos=$(parse_yaml_string_list "$CONFIG_FILE" ".critic.scope.repos")
  cfg_critic_scope_requirements=$(parse_yaml_string_list "$CONFIG_FILE" ".critic.scope.requirements")
  # Backward-compatible nested location support.
  [[ -z "$cfg_mobile_ci_cd" ]] && cfg_mobile_ci_cd=$(parse_yaml_value "$CONFIG_FILE" ".project.optional_features.mobile_ci_cd")
  [[ -z "$cfg_runner_self_heal" ]] && cfg_runner_self_heal=$(parse_yaml_value "$CONFIG_FILE" ".project.optional_features.runner_self_heal")
  [[ -z "$cfg_semantic_release" ]] && cfg_semantic_release=$(parse_yaml_value "$CONFIG_FILE" ".project.optional_features.semantic_release")
  [[ -z "$cfg_onboarding_docs" ]] && cfg_onboarding_docs=$(parse_yaml_value "$CONFIG_FILE" ".project.optional_features.onboarding_docs")
  [[ -z "$cfg_portability_blueprints" ]] && cfg_portability_blueprints=$(parse_yaml_value "$CONFIG_FILE" ".project.optional_features.portability_blueprints")
  [[ -z "$cfg_fleet_instrument" ]] && cfg_fleet_instrument=$(parse_yaml_value "$CONFIG_FILE" ".project.optional_features.fleet_instrument")
  [[ -z "$cfg_critic_evaluator" ]] && cfg_critic_evaluator=$(parse_yaml_value "$CONFIG_FILE" ".project.optional_features.critic_evaluator")
  [[ -z "$cfg_copilot_metrics_enforcement_mode" ]] && cfg_copilot_metrics_enforcement_mode=$(parse_yaml_value "$CONFIG_FILE" ".project.copilot_usage_metrics.enforcement_mode")
  [[ -z "$cfg_copilot_metrics_retry_attempts" ]] && cfg_copilot_metrics_retry_attempts=$(parse_yaml_value "$CONFIG_FILE" ".project.copilot_usage_metrics.retry_attempts")
  [[ -z "$cfg_critic_scope_repos" ]] && cfg_critic_scope_repos=$(parse_yaml_string_list "$CONFIG_FILE" ".project.critic.scope.repos")
  [[ -z "$cfg_critic_scope_requirements" ]] && cfg_critic_scope_requirements=$(parse_yaml_string_list "$CONFIG_FILE" ".project.critic.scope.requirements")

  # app_description can be multiline
  app_desc_multiline=$(parse_yaml_multiline "$CONFIG_FILE" ".project.app_description")
  if [[ -n "$app_desc_multiline" ]]; then
    APP_DESC="$app_desc_multiline"
  fi

  # NFR and initial_prompt can be multiline literals
  nfr_multiline=$(parse_yaml_multiline "$CONFIG_FILE" ".project.nfr")
  if [[ -n "$nfr_multiline" ]]; then
    NFR="$nfr_multiline"
  fi

  initial_prompt_multiline=$(parse_yaml_multiline "$CONFIG_FILE" ".project.initial_prompt")
  if [[ -n "$initial_prompt_multiline" ]]; then
    INITIAL_PROMPT="$initial_prompt_multiline"
  fi

  # If app_description is set but initial_prompt is not, use app_description
  if [[ -n "${APP_DESC:-}" && -z "${INITIAL_PROMPT:-}" ]]; then
    INITIAL_PROMPT="$APP_DESC"
  fi

  REPO_VISIBILITY=$(normalize_visibility "$REPO_VISIBILITY")
  require_visibility "$REPO_VISIBILITY" "project.visibility"
  [[ -z "$REPO_VISIBILITY" ]] && REPO_VISIBILITY="private"
  ENABLE_MCP=${ENABLE_MCP,,}
  [[ -z "$ENABLE_MCP" ]] && ENABLE_MCP="false"

  # ─── Pattern expansion ───────────────────────────────────────
  CHILD_COUNT=$(parse_yaml_array_length "$CONFIG_FILE" ".children")
  declare -a CHILD_NAMES=() CHILD_URLS=() CHILD_ROLES=() CHILD_DESCS=() CHILD_VISIBILITIES=() CHILD_STACKS=() CHILD_LOCAL_PATHS=()

  # Resolve the pattern file whenever a pattern is named — independent of whether
  # children are auto-expanded. This lets skills, topology, and the pattern snapshot
  # apply even when children are listed explicitly.
  if [[ -n "${PATTERN:-}" ]]; then
    PATTERN_DIR="$FRAMEWORK_DIR/patterns/$PATTERN"
    PATTERN_FILE="$PATTERN_DIR/pattern.yml"
    if [[ ! -f "$PATTERN_FILE" ]]; then
      echo "ERROR: Pattern not found: $PATTERN (expected $PATTERN_FILE)"; exit 1
    fi
    log "Using pattern: $PATTERN"
  fi

  if [[ -n "${PATTERN:-}" && "$CHILD_COUNT" -eq 0 ]]; then
    PATTERN_DIR="$FRAMEWORK_DIR/patterns/$PATTERN"
    PATTERN_FILE="$PATTERN_DIR/pattern.yml"
    if [[ ! -f "$PATTERN_FILE" ]]; then
      echo "ERROR: Pattern not found: $PATTERN (expected $PATTERN_FILE)"; exit 1
    fi
    log "Using pattern: $PATTERN"

    # Load NFR from pattern if not set
    if [[ -z "${NFR:-}" ]]; then
      pattern_nfr_url=$(parse_yaml_value "$PATTERN_FILE" ".nfr_url")
      if [[ -n "$pattern_nfr_url" ]]; then
        NFR="$pattern_nfr_url"
      elif [[ -f "$PATTERN_DIR/nfr.yml" ]]; then
        NFR="$PATTERN_DIR/nfr.yml"
      fi
    fi

    # Load pattern documentation references
    PATTERN_DOCS=""
    PATTERN_DOC_COUNT=$(parse_yaml_array_length "$PATTERN_FILE" ".docs")
    for ((d=0; d<PATTERN_DOC_COUNT; d++)); do
      doc_name=$(parse_yaml_value "$PATTERN_FILE" ".docs.$d.name")
      doc_url=$(parse_yaml_value "$PATTERN_FILE" ".docs.$d.url")
      doc_local=$(parse_yaml_value "$PATTERN_FILE" ".docs.$d.local_path")
      doc_desc=$(parse_yaml_value "$PATTERN_FILE" ".docs.$d.description")
      doc_content=""
      if [[ -n "$doc_local" ]]; then
        resolved_path=$(realpath -m "$FRAMEWORK_DIR/$doc_local" 2>/dev/null || echo "")
        if [[ "$resolved_path" != "$FRAMEWORK_DIR"/* ]]; then
          # Resolved outside the framework tree — a genuine path-traversal attempt.
          warn "Blocked path traversal attempt in docs.local_path: $doc_local"
        elif [[ -f "$resolved_path" ]]; then
          doc_content=$(cat "$resolved_path")
        elif [[ -n "$doc_url" ]]; then
          # Local snapshot is missing — fall back to the source URL so the doc is not silently dropped.
          warn "Pattern doc local_path not found, falling back to url: $doc_local"
          doc_content=$(resolve_content "$doc_url")
        else
          warn "Pattern doc local_path not found and no url fallback: $doc_local"
        fi
      elif [[ -n "$doc_url" ]]; then
        doc_content=$(resolve_content "$doc_url")
      fi
      if [[ -n "$doc_content" ]]; then
        PATTERN_DOC_SNAPSHOT_NAMES+=("${doc_name:-doc-$d}")
        PATTERN_DOC_SNAPSHOT_CONTENTS+=("$doc_content")
        PATTERN_DOCS+="
---
## Pattern: ${doc_name} — ${doc_desc}

${doc_content}"
      fi
    done

    # Load description from pattern if not set
    if [[ -z "${PROJECT_DESC:-}" ]]; then
      PROJECT_DESC=$(parse_yaml_multiline "$PATTERN_FILE" ".description")
    fi

    # Load optional feature defaults from pattern (can be overridden by init.yml).
    pat_mobile_ci_cd=$(parse_yaml_value "$PATTERN_FILE" ".optional_features.mobile_ci_cd")
    pat_runner_self_heal=$(parse_yaml_value "$PATTERN_FILE" ".optional_features.runner_self_heal")
    pat_semantic_release=$(parse_yaml_value "$PATTERN_FILE" ".optional_features.semantic_release")
    pat_onboarding_docs=$(parse_yaml_value "$PATTERN_FILE" ".optional_features.onboarding_docs")
    pat_portability_blueprints=$(parse_yaml_value "$PATTERN_FILE" ".optional_features.portability_blueprints")
    pat_fleet_instrument=$(parse_yaml_value "$PATTERN_FILE" ".optional_features.fleet_instrument")
    pat_critic_evaluator=$(parse_yaml_value "$PATTERN_FILE" ".optional_features.critic_evaluator")

    [[ -n "$pat_mobile_ci_cd" ]] && FEATURE_MOBILE_CI_CD="$pat_mobile_ci_cd"
    [[ -n "$pat_runner_self_heal" ]] && FEATURE_RUNNER_SELF_HEAL="$pat_runner_self_heal"
    [[ -n "$pat_semantic_release" ]] && FEATURE_SEMANTIC_RELEASE="$pat_semantic_release"
    [[ -n "$pat_onboarding_docs" ]] && FEATURE_ONBOARDING_DOCS="$pat_onboarding_docs"
    [[ -n "$pat_portability_blueprints" ]] && FEATURE_PORTABILITY_BLUEPRINTS="$pat_portability_blueprints"
    [[ -n "$pat_fleet_instrument" ]] && FEATURE_FLEET_INSTRUMENT="$pat_fleet_instrument"
    [[ -n "$pat_critic_evaluator" ]] && FEATURE_CRITIC_EVALUATOR="$pat_critic_evaluator"

    # Deployment model + region (pattern defaults; init.yml project.* overrides win).
    pat_deployment_model=$(parse_yaml_value "$PATTERN_FILE" ".deployment_model")
    [[ -z "${DEPLOYMENT_MODEL:-}" && -n "$pat_deployment_model" ]] && DEPLOYMENT_MODEL="$pat_deployment_model"
    pat_region=$(parse_yaml_value "$PATTERN_FILE" ".region")
    [[ -z "${REGION:-}" && -n "$pat_region" ]] && REGION="$pat_region"

    # Expand pattern children
    CHILD_COUNT=$(parse_yaml_array_length "$PATTERN_FILE" ".children")
    if [[ "$REPO_VISIBILITY" != "local" && -z "$GITHUB_OWNER" ]]; then
      echo "ERROR: github_owner required when using a pattern unless visibility=local" && exit 1
    fi

    for ((i=0; i<CHILD_COUNT; i++)); do
      suffix="$(parse_yaml_value "$PATTERN_FILE" ".children.$i.suffix")"
      role="$(parse_yaml_value "$PATTERN_FILE" ".children.$i.role")"
      desc="$(parse_yaml_value "$PATTERN_FILE" ".children.$i.description")"
      child_stack="$(parse_yaml_value "$PATTERN_FILE" ".children.$i.stack")"
      name="${PROJECT_NAME}-${suffix}"
      if [[ "$REPO_VISIBILITY" == "local" ]]; then
        url=""
      else
        url="https://github.com/${GITHUB_OWNER}/${name}.git"
      fi
      CHILD_NAMES+=("$name")
      CHILD_URLS+=("$url")
      CHILD_ROLES+=("$role")
      CHILD_DESCS+=("$desc")
      CHILD_VISIBILITIES+=("$REPO_VISIBILITY")
      CHILD_STACKS+=("${child_stack:-}")
      CHILD_LOCAL_PATHS+=("$(default_local_path_for_repo "$name")")
    done
  else
    # Explicit children from init.yml
    for ((i=0; i<CHILD_COUNT; i++)); do
      url="$(parse_yaml_value "$CONFIG_FILE" ".children.$i.url")"
      name="$(parse_yaml_value "$CONFIG_FILE" ".children.$i.name")"
      local_path="$(parse_yaml_value "$CONFIG_FILE" ".children.$i.local_path")"
      child_visibility=$(parse_yaml_value "$CONFIG_FILE" ".children.$i.visibility")
      child_visibility=$(normalize_visibility "$child_visibility")
      require_visibility "$child_visibility" "children.$i.visibility"
      [[ -z "$child_visibility" ]] && child_visibility="$REPO_VISIBILITY"
      [[ -z "$local_path" ]] && local_path="$(default_local_path_for_repo "$name")"
      if [[ -z "$name" ]]; then
        if [[ -n "$url" ]]; then
          name="$(derive_repo_name_from_url "$url")"
        else
          name="$(derive_repo_name_from_path "$local_path")"
        fi
      fi
      if [[ "$child_visibility" == "local" ]]; then
        url=""
      elif [[ -z "$url" && -n "$GITHUB_OWNER" ]]; then
        url="https://github.com/${GITHUB_OWNER}/${name}.git"
      fi
      CHILD_NAMES+=("$name")
      CHILD_URLS+=("$url")
      CHILD_ROLES+=("$(parse_yaml_value "$CONFIG_FILE" ".children.$i.role")")
      CHILD_DESCS+=("$(parse_yaml_value "$CONFIG_FILE" ".children.$i.description")")
      CHILD_VISIBILITIES+=("$child_visibility")
      CHILD_STACKS+=("")  # Will be detected later
      CHILD_LOCAL_PATHS+=("$local_path")
    done
  fi

  for ((i=0; i<CHILD_COUNT; i++)); do
    CHILD_ROLES[$i]="${CHILD_ROLES[$i],,}"
    require_role "${CHILD_ROLES[$i]}" "children.$i.role"
  done

  # Deployment model + region final defaults (local-azd is the supported default).
  [[ -z "${DEPLOYMENT_MODEL:-}" ]] && DEPLOYMENT_MODEL="local-azd"
  [[ -z "${REGION:-}" ]] && REGION="centralus"

  # Explicit init.yml flags override pattern defaults.
  [[ -n "${cfg_mobile_ci_cd:-}" ]] && FEATURE_MOBILE_CI_CD="$cfg_mobile_ci_cd"
  [[ -n "${cfg_runner_self_heal:-}" ]] && FEATURE_RUNNER_SELF_HEAL="$cfg_runner_self_heal"
  [[ -n "${cfg_semantic_release:-}" ]] && FEATURE_SEMANTIC_RELEASE="$cfg_semantic_release"
  [[ -n "${cfg_onboarding_docs:-}" ]] && FEATURE_ONBOARDING_DOCS="$cfg_onboarding_docs"
  [[ -n "${cfg_portability_blueprints:-}" ]] && FEATURE_PORTABILITY_BLUEPRINTS="$cfg_portability_blueprints"
  [[ -n "${cfg_fleet_instrument:-}" ]] && FEATURE_FLEET_INSTRUMENT="$cfg_fleet_instrument"
  [[ -n "${cfg_critic_evaluator:-}" ]] && FEATURE_CRITIC_EVALUATOR="$cfg_critic_evaluator"
  [[ -n "${cfg_critic_scope_repos:-}" ]] && CRITIC_SCOPE_REPOS_RAW="$cfg_critic_scope_repos"
  [[ -n "${cfg_critic_scope_requirements:-}" ]] && CRITIC_SCOPE_REQUIREMENTS_RAW="$cfg_critic_scope_requirements"
else
  # Interactive mode
  read -rp "Project name: " PROJECT_NAME
  read -rp "Description: " PROJECT_DESC
  read -rp "Create repos if missing? (y/N): " CREATE_REPOS_INPUT
  CREATE_REPOS="false"
  REPO_VISIBILITY="private"
  [[ "$CREATE_REPOS_INPUT" =~ ^[Yy] ]] && CREATE_REPOS="true"
  if [[ "$CREATE_REPOS" == "true" ]]; then
    read -rp "GitHub owner (org/user): " GITHUB_OWNER
    read -rp "Repo visibility (public/private/local, default: private): " REPO_VISIBILITY_INPUT
    read -rp "Parent directory (blank = ./$PROJECT_NAME): " PARENT_DIR
    REPO_VISIBILITY=$(normalize_visibility "$REPO_VISIBILITY_INPUT")
    require_visibility "$REPO_VISIBILITY" "project.visibility"
    [[ -z "$REPO_VISIBILITY" ]] && REPO_VISIBILITY="private"
  fi
  read -rp "Enable MCP tool configuration? (y/N): " ENABLE_MCP_INPUT
  ENABLE_MCP="false"
  [[ "$ENABLE_MCP_INPUT" =~ ^[Yy] ]] && ENABLE_MCP="true"

  declare -a CHILD_NAMES=() CHILD_URLS=() CHILD_ROLES=() CHILD_DESCS=() CHILD_VISIBILITIES=() CHILD_STACKS=() CHILD_LOCAL_PATHS=()
  echo "Add child repos (empty name to stop):"
  while true; do
    read -rp "  Repo name: " name
    [[ -z "$name" ]] && break
    read -rp "  Git URL (blank for local-only repos): " url
    read -rp "  Local path (default: ../$name): " local_path
    [[ -z "$local_path" ]] && local_path="$(default_local_path_for_repo "$name")"
    read -rp "  Role (backend/frontend/infra/agent/worker/waf): " role
    read -rp "  Description (optional): " desc
    read -rp "  Visibility (public/private/local, default: $REPO_VISIBILITY): " child_visibility
    child_visibility=$(normalize_visibility "$child_visibility")
    require_visibility "$child_visibility" "children.$((CHILD_COUNT + 1)).visibility"
    [[ -z "$child_visibility" ]] && child_visibility="$REPO_VISIBILITY"
    role="${role,,}"
    require_role "$role" "children.$((CHILD_COUNT + 1)).role"
    CHILD_NAMES+=("$name")
    CHILD_URLS+=("$url")
    CHILD_ROLES+=("$role")
    CHILD_DESCS+=("$desc")
    CHILD_VISIBILITIES+=("$child_visibility")
    CHILD_STACKS+=("")
    CHILD_LOCAL_PATHS+=("$local_path")
  done
  CHILD_COUNT=${#CHILD_NAMES[@]}
fi

# Validate repo visibility selections.
REPO_VISIBILITY=$(normalize_visibility "$REPO_VISIBILITY")
require_visibility "$REPO_VISIBILITY" "project.visibility"
[[ -z "$REPO_VISIBILITY" ]] && REPO_VISIBILITY="private"

for ((i=0; i<CHILD_COUNT; i++)); do
  child_visibility="${CHILD_VISIBILITIES[$i]}"
  child_visibility=$(normalize_visibility "$child_visibility")
  require_visibility "$child_visibility" "children.$i.visibility"
  [[ -z "$child_visibility" ]] && child_visibility="$REPO_VISIBILITY"
  CHILD_VISIBILITIES[$i]="$child_visibility"
  CHILD_ROLES[$i]="${CHILD_ROLES[$i],,}"
  require_role "${CHILD_ROLES[$i]}" "children.$i.role"
  if [[ "$child_visibility" != "local" && -z "${CHILD_URLS[$i]}" && -n "$GITHUB_OWNER" ]]; then
    CHILD_URLS[$i]="https://github.com/${GITHUB_OWNER}/${CHILD_NAMES[$i]}.git"
  fi
done

# Normalize and validate booleans.
FEATURE_MOBILE_CI_CD=$(normalize_bool "$FEATURE_MOBILE_CI_CD")
FEATURE_RUNNER_SELF_HEAL=$(normalize_bool "$FEATURE_RUNNER_SELF_HEAL")
FEATURE_SEMANTIC_RELEASE=$(normalize_bool "$FEATURE_SEMANTIC_RELEASE")
FEATURE_ONBOARDING_DOCS=$(normalize_bool "$FEATURE_ONBOARDING_DOCS")
FEATURE_PORTABILITY_BLUEPRINTS=$(normalize_bool "$FEATURE_PORTABILITY_BLUEPRINTS")
FEATURE_FLEET_INSTRUMENT=$(normalize_bool "$FEATURE_FLEET_INSTRUMENT")
FEATURE_CRITIC_EVALUATOR=$(normalize_bool "$FEATURE_CRITIC_EVALUATOR")

require_bool "$FEATURE_MOBILE_CI_CD" "optional_features.mobile_ci_cd"
require_bool "$FEATURE_RUNNER_SELF_HEAL" "optional_features.runner_self_heal"
require_bool "$FEATURE_SEMANTIC_RELEASE" "optional_features.semantic_release"
require_bool "$FEATURE_ONBOARDING_DOCS" "optional_features.onboarding_docs"
require_bool "$FEATURE_PORTABILITY_BLUEPRINTS" "optional_features.portability_blueprints"
require_bool "$FEATURE_FLEET_INSTRUMENT" "optional_features.fleet_instrument"
require_bool "$FEATURE_CRITIC_EVALUATOR" "optional_features.critic_evaluator"
COPILOT_METRICS_ENFORCEMENT_MODE=$(normalize_metrics_enforcement_mode "${cfg_copilot_metrics_enforcement_mode:-}")
require_metrics_enforcement_mode "$COPILOT_METRICS_ENFORCEMENT_MODE" "copilot_usage_metrics.enforcement_mode"
[[ -z "$COPILOT_METRICS_ENFORCEMENT_MODE" ]] && COPILOT_METRICS_ENFORCEMENT_MODE="warn"
require_non_negative_integer "${cfg_copilot_metrics_retry_attempts:-}" "copilot_usage_metrics.retry_attempts"
[[ -n "${cfg_copilot_metrics_retry_attempts:-}" ]] && COPILOT_METRICS_RETRY_ATTEMPTS="${cfg_copilot_metrics_retry_attempts}"

[[ -z "$FEATURE_MOBILE_CI_CD" ]] && FEATURE_MOBILE_CI_CD="false"
[[ -z "$FEATURE_RUNNER_SELF_HEAL" ]] && FEATURE_RUNNER_SELF_HEAL="false"
[[ -z "$FEATURE_SEMANTIC_RELEASE" ]] && FEATURE_SEMANTIC_RELEASE="false"
[[ -z "$FEATURE_ONBOARDING_DOCS" ]] && FEATURE_ONBOARDING_DOCS="false"
[[ -z "$FEATURE_PORTABILITY_BLUEPRINTS" ]] && FEATURE_PORTABILITY_BLUEPRINTS="false"
[[ -z "$FEATURE_FLEET_INSTRUMENT" ]] && FEATURE_FLEET_INSTRUMENT="true"
[[ -z "$FEATURE_CRITIC_EVALUATOR" ]] && FEATURE_CRITIC_EVALUATOR="true"

build_critic_protocol_section

# If repo creation is enabled, remote repositories need a GitHub owner.
if [[ "$CREATE_REPOS" == "true" ]]; then
  requires_github_owner=false
  if [[ "$REPO_VISIBILITY" != "local" ]]; then
    requires_github_owner=true
  fi
  for child_visibility in "${CHILD_VISIBILITIES[@]}"; do
    if [[ "$child_visibility" != "local" ]]; then
      requires_github_owner=true
      break
    fi
  done
  if [[ "$requires_github_owner" == true && -z "${GITHUB_OWNER:-}" ]]; then
    echo "ERROR: github_owner is required when creating public/private repos" >&2
    exit 1
  fi
fi

# Feature dependencies.
if [[ "$FEATURE_RUNNER_SELF_HEAL" == "true" && "$FEATURE_MOBILE_CI_CD" != "true" ]]; then
  echo "ERROR: optional_features.runner_self_heal requires optional_features.mobile_ci_cd=true" >&2
  exit 1
fi
if [[ "$FEATURE_SEMANTIC_RELEASE" == "true" && "$FEATURE_MOBILE_CI_CD" != "true" ]]; then
  echo "ERROR: optional_features.semantic_release requires optional_features.mobile_ci_cd=true" >&2
  exit 1
fi

[[ -z "$PROJECT_NAME" ]] && echo "ERROR: project name required" && exit 1
[[ "$CHILD_COUNT" -eq 0 ]] && echo "ERROR: at least one child repo required" && exit 1

# If parent_dir is specified and doesn't exist, create it and cd into it
if [[ -n "${PARENT_DIR:-}" ]]; then
  if [[ ! -d "$PARENT_DIR" ]]; then
    log "Creating parent directory: $PARENT_DIR"
    mkdir -p "$PARENT_DIR"
  fi
  cd "$PARENT_DIR"
  TARGET_DIR="$(pwd)"
fi
HARNESS_DIR="$TARGET_DIR"
write_guardrail_snapshots

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│  enterprise-copilot-fleet-controller init               │"
echo "└─────────────────────────────────────────────────────────┘"
echo "  Project:  $PROJECT_NAME"
echo "  Target:   $TARGET_DIR"
echo "  Children: ${CHILD_NAMES[*]}"
echo "  Create:   ${CREATE_REPOS:-false}"
echo "  MCP:      ${ENABLE_MCP:-false}"
echo "  Optional features:"
echo "    mobile_ci_cd: ${FEATURE_MOBILE_CI_CD}"
echo "    runner_self_heal: ${FEATURE_RUNNER_SELF_HEAL}"
echo "    semantic_release: ${FEATURE_SEMANTIC_RELEASE}"
echo "    onboarding_docs: ${FEATURE_ONBOARDING_DOCS}"
echo "    portability_blueprints: ${FEATURE_PORTABILITY_BLUEPRINTS}"
echo "    fleet_instrument: ${FEATURE_FLEET_INSTRUMENT}"
echo "    critic_evaluator: ${FEATURE_CRITIC_EVALUATOR}"
echo "  Critic scope (repos):"
echo "${CRITIC_SCOPE_REPOS_PROMPT}"
echo "  Critic scope (requirements):"
echo "${CRITIC_SCOPE_REQUIREMENTS_PROMPT}"
echo ""

# ─────────────────────────────────────────────────────────────
# Phase 0: Create repos (if requested)
# ─────────────────────────────────────────────────────────────
if should_run_phase 0; then
if [[ "${CREATE_REPOS:-false}" == "true" ]]; then
  set_copilot_stage "Phase 0: Creating repositories"
  header "Phase 0: Creating repositories"

  gh_available=false
  if command -v gh &>/dev/null; then
    gh_available=true
  fi

  # Create parent repo
  if [[ "$REPO_VISIBILITY" == "local" ]]; then
    log "Project visibility is local — creating a local-only parent repo"
    if ! git rev-parse --git-dir &>/dev/null; then
      log "Initializing local git repo..."
      git init
    fi
  elif [[ "$gh_available" != true ]]; then
    warn "gh CLI not found — remote parent repo creation skipped."
  else
    if ! git rev-parse --git-dir &>/dev/null; then
      log "Initializing local git repo..."
      git init
    fi

    if [[ "$REPO_VISIBILITY" == "public" ]]; then
      visibility_flag="--public"
    else
      visibility_flag="--private"
    fi

    if ! gh repo view "${GITHUB_OWNER}/${PROJECT_NAME}" &>/dev/null 2>&1; then
      log "Creating GitHub repo: ${GITHUB_OWNER}/${PROJECT_NAME}"
      parent_create_args=("$visibility_flag" --source=.)
      [[ -n "$PROJECT_DESC" ]] && parent_create_args+=(--description "$PROJECT_DESC")
      gh repo create "${GITHUB_OWNER}/${PROJECT_NAME}" "${parent_create_args[@]}" 2>&1 || true
    else
      log "Parent repo ${GITHUB_OWNER}/${PROJECT_NAME} already exists on GitHub"
      if ! git remote get-url origin &>/dev/null 2>&1; then
        git remote add origin "https://github.com/${GITHUB_OWNER}/${PROJECT_NAME}.git"
        log "Added origin remote"
      fi
      # Fresh start handling
      if [[ "${FRESH_START:-false}" == "true" ]]; then
        log "fresh_start enabled — scanning framework files in ${PROJECT_NAME}"
        DELETE_LIST=()
        for fw_path in .agents .copilot .github/agents .github/copilot-instructions.md .github/mcp.json .contracts .requirements .gitmodules .framework-version .repo-index.yml; do
          if [[ -e "$TARGET_DIR/$fw_path" ]]; then
            DELETE_LIST+=("$fw_path")
          fi
        done
        if [[ -d "$TARGET_DIR/work" ]]; then
          DELETE_LIST+=("work/")
        fi

        DECISIONS_BACKUP=""
        if [[ -f "$TARGET_DIR/.decisions/log.md" ]]; then
          DECISIONS_BACKUP="$TARGET_DIR/.decisions/log.md.bak.$(date +%Y%m%d%H%M%S)"
          cp "$TARGET_DIR/.decisions/log.md" "$DECISIONS_BACKUP"
          DELETE_LIST+=(".decisions/")
        fi

        if [[ ${#DELETE_LIST[@]} -eq 0 ]]; then
          log "No framework files found to remove"
        else
          echo ""
          echo "  ┌─────────────────────────────────────────────────"
          echo "  │ fresh_start will DELETE these framework files:"
          echo "  │"
          for item in "${DELETE_LIST[@]}"; do
            echo "  │   • $item"
          done
          echo "  │"
          echo "  │ Project source code will NOT be touched."
          echo "  └─────────────────────────────────────────────────"
          echo ""

          proceed=false
          if [[ "$AUTO_DELETE" == true ]]; then
            log "Auto-delete enabled, proceeding without confirmation"
            proceed=true
          else
            read -rp "  Proceed with deletion? [y/N] " confirm
            if [[ "$confirm" =~ ^[Yy]$ ]]; then
              proceed=true
            fi
          fi

          if [[ "$proceed" == true ]]; then
            for fw_path in .agents .copilot .github/agents .github/copilot-instructions.md .github/mcp.json .contracts .requirements .gitmodules .framework-version .repo-index.yml; do
              if [[ -e "$TARGET_DIR/$fw_path" ]]; then
                git rm -rf "$fw_path" 2>/dev/null || rm -rf "$TARGET_DIR/$fw_path"
                log "  removed $fw_path"
              fi
            done
            if [[ -d "$TARGET_DIR/work" ]]; then
              git submodule deinit -f --all 2>/dev/null || true
              git rm -rf work 2>/dev/null || rm -rf "$TARGET_DIR/work"
              log "  removed work/"
            fi
            if [[ -d "$TARGET_DIR/.decisions" ]]; then
              git rm -rf .decisions 2>/dev/null || rm -rf "$TARGET_DIR/.decisions"
              log "  removed .decisions/ (backed up)"
            fi
            rm -rf "$TARGET_DIR/.git/modules" 2>/dev/null || true
            git commit -m "chore: fresh start — remove framework files" --allow-empty 2>/dev/null || true
            git push origin "$(git branch --show-current 2>/dev/null || echo main)" --force 2>/dev/null || true
            log "Framework files removed (project source preserved)"
          else
            log "Fresh start cancelled by user"
            exit 0
          fi
        fi
      fi
    fi
  fi

  # Create child repos
  for ((i=0; i<CHILD_COUNT; i++)); do
    name="${CHILD_NAMES[$i]}"
    desc="${CHILD_DESCS[$i]}"
    child_visibility="${CHILD_VISIBILITIES[$i]}"
    repo_dir="$(resolve_repo_path "${CHILD_LOCAL_PATHS[$i]}")"

    if [[ "$child_visibility" == "local" ]]; then
      log "Creating local repo: ${repo_dir}"
      ensure_local_repo "$repo_dir"
      CHILD_URLS[$i]=""
      continue
    fi

    if [[ "$gh_available" != true ]]; then
      warn "gh CLI not found — skipping remote repo creation for ${GITHUB_OWNER}/${name}"
      continue
    fi

    if [[ "$child_visibility" == "public" ]]; then
      child_visibility_flag="--public"
    else
      child_visibility_flag="--private"
    fi

    if gh repo view "${GITHUB_OWNER}/${name}" &>/dev/null 2>&1; then
      log "Repo $name already exists"
    else
      log "Creating repo: ${GITHUB_OWNER}/${name}"
      child_create_args=("$child_visibility_flag")
      [[ -n "$desc" ]] && child_create_args+=(--description "$desc")
      gh repo create "${GITHUB_OWNER}/${name}" "${child_create_args[@]}" 2>&1 || true
    fi
    CHILD_URLS[$i]="https://github.com/${GITHUB_OWNER}/${name}.git"
  done
else
  log "Skipping repo creation (create_repos not set)"
fi
fi  # end Phase 0

# ─────────────────────────────────────────────────────────────
# Phase 1: Create directory structure + repo index
# ─────────────────────────────────────────────────────────────
if should_run_phase 1; then
set_copilot_stage "Phase 1: Project structure"
header "Phase 1: Project structure"

# Ensure git repo
if ! git rev-parse --git-dir &>/dev/null; then
  log "Initializing git repo..."
  git init
fi

# Create framework directories
mkdir -p "$TARGET_DIR/.contracts"
mkdir -p "$TARGET_DIR/.requirements"
mkdir -p "$TARGET_DIR/.decisions"
mkdir -p "$TARGET_DIR/.copilot"
mkdir -p "$TARGET_DIR/.github"
mkdir -p "$TARGET_DIR/.copilot/guardrails"

# Child-repo workflow scaffolding
# Create the framework workflow structure for every child first so that all
# child repo roots exist before any orchestrator invocation (required for the
# scoped --add-dir access granted in add_child_repo_access_for_stage).
for ((i=0; i<CHILD_COUNT; i++)); do
  repo_dir="$(resolve_repo_path "${CHILD_LOCAL_PATHS[$i]}")"
  mkdir -p "$repo_dir/.github/agents"
  mkdir -p "$repo_dir/work/todo"
  mkdir -p "$repo_dir/work/ready-for-review"
  mkdir -p "$repo_dir/work/done"
done

# Orchestrator-driven folder scaffolding.
# The orchestrator agent scaffolds each child folder into a minimal, buildable
# starting point based on the pattern definition, using the Copilot CLI in
# autopilot / non-interactive mode (see copilot_prompt). Skipped for repos that
# already contain source code so re-runs never clobber real work.
if command -v copilot >/dev/null 2>&1; then
  for ((i=0; i<CHILD_COUNT; i++)); do
    name="${CHILD_NAMES[$i]}"
    role="${CHILD_ROLES[$i]}"
    desc="${CHILD_DESCS[$i]}"
    repo_path="${CHILD_LOCAL_PATHS[$i]}"
    repo_dir="$(resolve_repo_path "$repo_path")"

    if repo_has_code "$repo_dir"; then
      log "Existing code detected in $name — skipping orchestrator scaffolding"
      continue
    fi

    child_stack="${CHILD_STACKS[$i]}"
    [[ -z "$child_stack" ]] && child_stack="$(default_stack_for_role "$role")"

    log "Scaffolding $name ($role) from pattern definition via orchestrator..."
    copilot_prompt "Act as the orchestrator agent for the ${PROJECT_NAME} fleet. Scaffold the child repository folder at ${repo_dir} into a minimal, buildable starting point for its role, based on the pattern definition.

Pattern definition context (authoritative):
- Repository name: ${name}
- Role: ${role}
- Description: ${desc}
- Target stack: ${child_stack}
- Pattern snapshot: read the pattern definition at \`${TARGET_DIR}/.copilot/guardrails/pattern.yml\` (and \`${TARGET_DIR}/.copilot/guardrails/nfr.yml\` if present) for the full pattern, platform, and non-functional constraints. Honor any \`pattern_constraints\`.

Directory access (scoped to least privilege — do not fight it):
- WRITE access: exactly one child repo root — ${repo_dir}.
- READ access: the harness guardrails under ${TARGET_DIR}/.copilot/guardrails/ (pattern.yml, nfr.yml, init-pattern.yml).
- You have NO access to the parent workspace directory or any sibling repository; they are intentionally out of scope.
- You already know every path you need (all listed above). Do NOT run discovery commands — no \`find\`, \`ls\`, \`grep\`, \`cd\`, or globbing against the parent workspace or any directory outside ${repo_dir} and ${TARGET_DIR}. Those commands are denied by design and only waste the run. Open the exact files by the absolute paths given above.

Scaffolding requirements:
1. Create ONLY the conventional starter files for the target stack, rooted at ${repo_dir} (for example: pyproject.toml + src/ + tests/ for a Python service; package.json + Vite config + src/ for a React app; main.tf + variables.tf + outputs.tf for Terraform).
2. Produce a minimal skeleton with placeholder content that lints/builds cleanly — not a full implementation. No business logic beyond a trivial health/hello entry point.
3. Include a short README.md describing the repo's role and how to run lint/test/build.
4. Add a stack-appropriate .gitignore.
5. Match the platform and region choices from the pattern (default Azure region ${REGION:-centralus} where a region is required).

Hard constraints:
- Do NOT create, modify, or delete anything under ${repo_dir}/work/ or ${repo_dir}/.github/agents/ — those are managed by later phases.
- Do NOT touch any other repository or the parent framework directories.
- Do NOT probe, list, or explore any directory outside ${repo_dir} and ${TARGET_DIR}; every path you need is given above, so there is nothing to discover.
- Do NOT overwrite pre-existing files; only add what is missing.
- Keep it minimal; specialist agents implement features in later phases." || warn "Orchestrator scaffolding for $name did not complete cleanly (continuing)"
  done
else
  warn "copilot CLI not found — skipping orchestrator folder scaffolding"
fi

# Stamp framework version into project
echo "$FRAMEWORK_VERSION" > "$TARGET_DIR/.framework-version"
log "Framework version: $FRAMEWORK_VERSION"

# Generate MCP tools configuration (optional)
if [[ "${ENABLE_MCP:-false}" == "true" ]]; then
if [[ ! -f "$MCP_CONFIG_FILE" ]]; then
  write_mcp_config "$MCP_CONFIG_FILE"
  log "Created $MCP_CONFIG_REL (MCP tools configuration)"
fi
else
  log "MCP disabled — skipping $MCP_CONFIG_REL generation"
fi

# Seed .decisions/log.md
if [[ ! -f "$TARGET_DIR/.decisions/log.md" ]]; then
  write_from_template "decisions-log.md.tmpl" "$TARGET_DIR/.decisions/log.md"
  log "Created .decisions/log.md"
fi

# Optional feature artifacts
# NOTE: GitHub Actions CI/CD generation (incl. mobile workflow templates) was removed in v0.2.0
# in favor of local `azd` deployment. The mobile_ci_cd / runner_self_heal / semantic_release flags
# are retained as no-ops for backward compatibility with older init.yml files.
if [[ "$FEATURE_MOBILE_CI_CD" == "true" ]]; then
  warn "optional_features.mobile_ci_cd is deprecated and ignored (GitHub Actions removed in favor of azd)"
fi

if [[ "$FEATURE_ONBOARDING_DOCS" == "true" ]]; then
  mkdir -p "$TARGET_DIR/.copilot/docs"
  write_from_template "docs/developer-onboarding.md.tmpl" "$TARGET_DIR/.copilot/docs/developer-onboarding.md"
  log "Created .copilot/docs/developer-onboarding.md"
fi

if [[ "$FEATURE_PORTABILITY_BLUEPRINTS" == "true" ]]; then
  mkdir -p "$TARGET_DIR/.copilot/docs"
  write_from_template "docs/portability-blueprint.md.tmpl" "$TARGET_DIR/.copilot/docs/portability-blueprint.md"
  log "Created .copilot/docs/portability-blueprint.md"
fi

# Create repo index manifest (source of truth for child repo paths)
if [[ ! -f "$TARGET_DIR/.repo-index.yml" ]]; then
  {
    echo "# Child repository index for orchestrator + specialists"
    echo "# local_path may be relative to this parent repo or absolute."
    echo "repos:"
    for ((i=0; i<CHILD_COUNT; i++)); do
      name="${CHILD_NAMES[$i]}"
      role="${CHILD_ROLES[$i]}"
      desc="${CHILD_DESCS[$i]}"
      local_path="${CHILD_LOCAL_PATHS[$i]}"
      remote_url="${CHILD_URLS[$i]}"
      echo "  - name: \"$name\""
      echo "    role: \"$role\""
      echo "    local_path: \"$local_path\""
      echo "    visibility: \"${CHILD_VISIBILITIES[$i]}\""
      if [[ -n "$desc" ]]; then
        echo "    description: \"$desc\""
      else
        echo "    description: \"\""
      fi
      if [[ -n "$remote_url" ]]; then
        echo "    remote_url: \"$remote_url\""
      else
        echo "    remote_url: \"\""
      fi
      echo "    default_branch: \"main\""
    done
  } > "$TARGET_DIR/.repo-index.yml"
  log "Created .repo-index.yml (child repo references)"
fi

fi  # end Phase 1

# ─────────────────────────────────────────────────────────────
# Build REPO_SUMMARY (always — needed by later phases)
# ─────────────────────────────────────────────────────────────
REPO_SUMMARY=""
REPO_DISPATCH_HINTS=""
for ((i=0; i<CHILD_COUNT; i++)); do
  name="${CHILD_NAMES[$i]}"
  role="${CHILD_ROLES[$i]}"
  desc="${CHILD_DESCS[$i]}"
  local_path="${CHILD_LOCAL_PATHS[$i]}"
  resolved_path="$(resolve_repo_path "$local_path")"
  remote_url="${CHILD_URLS[$i]}"
  visibility="${CHILD_VISIBILITIES[$i]}"
  REPO_SUMMARY+="- ${name} (role: ${role}"
  REPO_SUMMARY+=", local_path: ${local_path}"
  REPO_SUMMARY+=", resolved_path: ${resolved_path}"
  REPO_SUMMARY+=", visibility: ${visibility}"
  [[ -n "$remote_url" ]] && REPO_SUMMARY+=", remote: ${remote_url}"
  [[ -n "$desc" ]] && REPO_SUMMARY+=", description: ${desc}"
  REPO_SUMMARY+=")"$'\n'
  REPO_DISPATCH_HINTS+="- repo=${name} repo_dir=${resolved_path} work_dir=${resolved_path}/work specialist=${resolved_path}/.github/agents/${name}-specialist.agent.md critic=${resolved_path}/.github/agents/${name}-critic.agent.md"$'\n'
done

# ─────────────────────────────────────────────────────────────
# Phase 2: Generate child-repo specialist + critic agents
# ─────────────────────────────────────────────────────────────
if should_run_phase 2; then
set_copilot_stage "Phase 2: Generating child-repo agents"
header "Phase 2: Generating child-repo agents"

for ((i=0; i<CHILD_COUNT; i++)); do
  name="${CHILD_NAMES[$i]}"
  role="${CHILD_ROLES[$i]}"
  desc="${CHILD_DESCS[$i]}"
  repo_path="${CHILD_LOCAL_PATHS[$i]}"
  repo_dir="$(resolve_repo_path "$repo_path")"
  specialist_file="$(specialist_agent_file_for_repo "$name" "$repo_path")"
  critic_file="$(critic_agent_file_for_repo "$name" "$repo_path")"

  mkdir -p "$(dirname "$specialist_file")"

  if [[ ! -f "$specialist_file" ]]; then
    if repo_has_code "$repo_dir"; then
      log "Existing code detected in $name — generating specialist via LLM..."

      tools_list=$(tools_for_role "$role")
      binding_context_prompt="$(build_repo_binding_context_prompt "$name" "$role")"
      role_specific_prompt=""
      if [[ "$role" == "infra" ]]; then
        role_specific_prompt=$(cat <<'EOF'

## Platform Guardrails
- Read `.copilot/guardrails/pattern.yml` and `.copilot/guardrails/nfr.yml` before implementing.
- Use Azure Verified Modules wherever the guardrails require them and an AVM exists.
- If an AVM does not exist for a needed Azure service, note the gap in `.decisions/log.md` before using a native resource.
EOF
)
      fi

      copilot_prompt "Analyze the repository at ${repo_dir} and generate a Copilot custom agent definition.

The repo's role is: ${role}
The repo's description is: ${desc}

Binding context that MUST be treated as authoritative:
${binding_context_prompt}

Examine the actual files to determine:
1. The tech stack (language, framework, build system, linter)
2. The validation commands (lint, test, build) — look at pyproject.toml, package.json, Makefile, etc.
3. Any binding constraints above that must be preserved in specialist behavior

Write a file to: ${specialist_file}

The file MUST follow this EXACT format:

---
name: ${name}-specialist
description: \"<one-line description of what this specialist does>\"
tools: [${tools_list}]
---

You are the ${role} specialist for ${name} (${repo_path}).
Run this workflow only from the child repo root via a NEW Copilot CLI invocation with cwd set to this repository.
If a parent orchestrator tries to route child execution through background sub-agents or task agents, reject that path and insist on MCP-first orchestration (\`check_repo_index\` + async child-agent-runner dispatch tools such as \`start_child_agents_batch\`/\`start_child_agent\`).

## Your Scope
- Repository: ${repo_path}
- Stack: <detected stack>
- Validation: \`<lint command> && <test command>\`

## Protocol
1. Pick the next change request file from \`work/todo/\`
2. Read relevant .requirements/*.yml and .contracts/*.yml context, including \`.requirements/platform-guardrails.yml\` \`pattern_constraints\` for this repo
3. Implement only in this repo
4. Run lint/test/build
5. Commit with a conventional commit message when handing off to critic review, with exactly one commit per specialist→critic iteration (1 loop = 1 commit; 3 loops = 3 commits)
6. Append implementation notes and move the request to \`work/ready-for-review/\`

## MCP Skill/Workflow Callouts
- Use tools only when they match this repo's scoped list.
- Prefer \`run_local_lint\` before test/build commands for quick feedback.
- For infra repos, run \`terraform_fmt_check\` + \`terraform_init_validate\` + \`terraform_plan_check\` and inspect Azure with \`list_azure_resources\` / \`get_azure_status\`.
- For backend repos with contracts, use \`check_contract_compliance\`; for new routes, use \`scaffold_from_contract\`.
- Run \`security_scan\` before handoff and record key events with \`log_usage\`; if you observe looping/retries, call \`get_usage_quality_report\`.

${role_specific_prompt}

## Anti-Patterns
- Never run this from the parent repo; always start a new call with cwd set to the child repo
- Never modify other repos
- Never change .contracts/ or .requirements/ without coordinator approval
- Never add constraints that contradict binding context from guardrails, requirements, contracts, or pattern_constraints
- Never skip validation
- Never move work items directly to \`work/done/\`
- Never squash or combine commits from separate specialist→critic iterations

IMPORTANT: Write ONLY the file content above. No explanation. The file must start with --- on the first line." || true

      check_result=$(validate_agent_md "$specialist_file" "$name" "$role" "$repo_path" 2>&1)
      if [[ $? -ne 0 ]]; then
        warn "LLM-generated specialist for $name failed validation: $check_result"
        log "Retrying with feedback..."

        copilot_prompt "The agent.md file you generated at ${specialist_file} has these problems:
${check_result}

Fix the file. Requirements:
- Must start with --- (YAML frontmatter delimiter)
- Must have name:, description:, and tools: fields in frontmatter
- tools: must only reference these known MCP servers: scaffold-generator, security-scanner, usage-tracker, azure-inspector, azure-resource-status, ci-monitor, deploy-verifier, contract-compliance, repo-index, lint-local, terraform-local, git-pr-orchestrator
- Must reference ${repo_path} in the body
- Must have an Anti-Patterns section

Rewrite ${specialist_file} now. No explanation." || true

        check_result=$(validate_agent_md "$specialist_file" "$name" "$role" "$repo_path" 2>&1)
        if [[ $? -ne 0 ]]; then
          warn "Retry failed for $name ($check_result) — falling back to deterministic template"
          rm -f "$specialist_file"
        else
          log "✓ Agent ${name}-specialist generated (LLM + validated)"
        fi
      else
        log "✓ Agent ${name}-specialist generated (LLM + validated)"
      fi
    fi

    if [[ ! -f "$specialist_file" ]]; then
      local_stack="${CHILD_STACKS[$i]}"
      if [[ -z "$local_stack" ]]; then
        local_stack=$(detect_stack "$repo_dir" "$role")
      fi
      validate_str=$(detect_validate_commands "$repo_dir" "$role")
      generate_agent_md "$name" "$role" "$local_stack" "$validate_str" "$desc" "$repo_path" > "$specialist_file"
      log "✓ Agent ${name}-specialist generated (deterministic)"
    fi
  else
    log "Agent ${name}-specialist already exists, skipping"
  fi

  if [[ ! -f "$critic_file" ]]; then
    critic_validate=$(detect_validate_commands "$repo_dir" "$role")
    generate_critic_md "$name" "$role" "$desc" "$repo_path" "$critic_validate" > "$critic_file"
    log "✓ Agent ${name}-critic generated (deterministic)"
  else
    log "Agent ${name}-critic already exists, skipping"
  fi

  # Child repo orchestration instructions (azd-aware; no GitHub Actions).
  child_instr_file="$repo_dir/.github/copilot-instructions.md"
  if [[ ! -f "$child_instr_file" ]]; then
    ci_stack="${CHILD_STACKS[$i]}"
    [[ -z "$ci_stack" ]] && ci_stack=$(default_stack_for_role "$role")
    ci_validate=$(detect_validate_commands "$repo_dir" "$role")
    generate_child_instructions "$name" "$role" "$desc" "$repo_path" "$ci_stack" "$ci_validate"
    log "✓ Child instructions generated for ${name} (.github/copilot-instructions.md)"
  else
    log "Child instructions already exist for ${name}, skipping"
  fi
done

fi  # end Phase 2

# ─────────────────────────────────────────────────────────────
# Phase 2.5: Install skills + parent topology + orchestrator agents
# ─────────────────────────────────────────────────────────────
if should_run_phase 2; then
set_copilot_stage "Phase 2.5: Installing skills, topology, orchestrator agents"
header "Phase 2.5: Installing skills, topology, orchestrator agents"

# Skills (parent + scoped children) from the framework skills/ library.
install_skills

# External MCAPS infra skills (secure-azure-terraform-coder, defender-servers-skill,
# spoke-skill) into infra-role child repos.
install_infra_skills

# Parent topology quick-reference.
if [[ -n "${PATTERN_FILE:-}" && -f "$TEMPLATE_DIR/topology.md.tmpl" ]]; then
  if [[ ! -f "$TARGET_DIR/.copilot/topology.md" ]]; then
    mkdir -p "$TARGET_DIR/.copilot"
    TPL_PROJECT_NAME="$PROJECT_NAME" \
    TPL_REGION="${REGION:-centralus}" \
    TPL_RESOURCE_GROUP="${PROJECT_NAME}-dev-rg" \
    render_template_file "$TEMPLATE_DIR/topology.md.tmpl" "$TARGET_DIR/.copilot/topology.md"
    log "✓ Created .copilot/topology.md"
  else
    log ".copilot/topology.md already exists, skipping"
  fi
fi

# Orchestrator-level agents declared by the pattern (e.g., e2e-tester).
if [[ -n "${PATTERN_FILE:-}" ]]; then
  orch_agent_count=$(parse_yaml_array_length "$PATTERN_FILE" ".orchestrator_agents")
  for ((oa=0; oa<${orch_agent_count:-0}; oa++)); do
    oa_name=$(parse_yaml_value "$PATTERN_FILE" ".orchestrator_agents.$oa")
    oa_tmpl="$TEMPLATE_DIR/agents/${oa_name}.agent.md.tmpl"
    oa_out="$TARGET_DIR/.github/agents/${PROJECT_NAME}-${oa_name}.agent.md"
    if [[ -f "$oa_tmpl" && ! -f "$oa_out" ]]; then
      mkdir -p "$TARGET_DIR/.github/agents"
      TPL_PROJECT_NAME="$PROJECT_NAME" \
      render_template_file "$oa_tmpl" "$oa_out"
      log "✓ Created orchestrator agent .github/agents/${PROJECT_NAME}-${oa_name}.agent.md"
    fi
  done
fi

# Pre-deploy gate script (commit + push + version-tag every repo before azd deploy).
if [[ -f "$TEMPLATE_DIR/scripts/predeploy-gate.sh.tmpl" ]]; then
  mkdir -p "$TARGET_DIR/scripts"
  gate_out="$TARGET_DIR/scripts/predeploy-gate.sh"
  TPL_PROJECT_NAME="$PROJECT_NAME" \
  render_template_file "$TEMPLATE_DIR/scripts/predeploy-gate.sh.tmpl" "$gate_out"
  chmod +x "$gate_out"
  log "✓ Created scripts/predeploy-gate.sh"
fi

fi  # end Phase 2.5


# ─────────────────────────────────────────────────────────────
# Phase 3: Generate .github/copilot-instructions.md (orchestrator)
# ─────────────────────────────────────────────────────────────
if should_run_phase 3; then
set_copilot_stage "Phase 3: Generating orchestrator (.github/copilot-instructions.md)"
header "Phase 3: Generating orchestrator (.github/copilot-instructions.md)"

INSTRUCTIONS_FILE="$ORCHESTRATOR_INSTRUCTIONS_FILE"

# Build child workflow reference for the instructions
CHILD_WORKFLOW_LIST=""
for ((i=0; i<CHILD_COUNT; i++)); do
  name="${CHILD_NAMES[$i]}"
  role="${CHILD_ROLES[$i]}"
  repo_path="${CHILD_LOCAL_PATHS[$i]}"
  CHILD_WORKFLOW_LIST+="| ${name} | ${role} | ${repo_path} | \`.github/agents/${name}-specialist.agent.md\` | \`.github/agents/${name}-critic.agent.md\` |
"
done

if [[ "${ENABLE_MCP:-false}" == "true" ]]; then
  MCP_SECTION=$(cat <<'EOF'
## MCP Tools

| Tool | When to Use |
|------|-------------|
| `check_all_contracts` | Before deploy to catch contract drift across all providers |
| `check_contract_compliance` | Validate one provider repo against one contract's routes |
| `run_local_lint` | Fast local lint pass before test/build or before delegating a fix back |
| `start_child_agent` / `start_child_agents_batch` | Start async child-repo Copilot runs; pass `resume_session_id` to reuse a prior session for critic remediation instead of cold-starting |
| `wait_for_child_agent_jobs` | Event-driven wait that blocks until dispatched jobs reach terminal state — prefer this over repeated `get_child_agent_job`/`list_child_agent_jobs` polling |
| `get_child_agent_job` / `list_child_agent_jobs` | One-off status/result checks (each run returns `session_id`, token/AIU `usage`, and a `PASS`/`FAIL`/`BLOCKED` `result` verdict) |
| `terraform_fmt_check` / `terraform_init_validate` / `terraform_plan_check` | Infra changes: formatting, validation, and plan safety checks before deploy |
| `list_azure_resources` / `get_azure_status` / `find_error` | Infra incidents: inspect Azure inventory, runtime status, and recent failure events |
| `inspect_container_app` / `inspect_cosmos` / `inspect_acr` | Deep Azure diagnostics when one service needs focused investigation |
| `diagnose_container_app` / `get_container_logs` / `list_revisions` / `check_image_accessibility` / `compare_container_apps` | Container App troubleshooting: activation failures, crash loops, image pull errors, health probes. Pair with the `container-app-troubleshoot` skill. |
| `check_repo_index` / `sync_repo_index` / `check_repo_queues` | Verify/normalize child repo references and inspect `work/{todo,ready-for-review,done}` queue state without shell checks |
| `create_prs` / `auto_merge_prs` | Pre-deploy gate: commit → push → PR → merge for every changed repo (no CI to wait for) |
| `deploy_local` | Run the local `azd` deployment flow (provision + service deploy) programmatically |
| `quick_deploy` | Single-service build+deploy cycle for fast iteration |
| `verify_deployment` | After an `azd` deploy to verify health/version endpoints are reachable |
| `security_scan` | Before final deploy to consolidate security findings from available scanners |
| `log_usage` | Record orchestration events with status + timing metadata for correlation |
| `get_usage_quality_report` | Review usage quality, anomalies, and value signals from `.metrics/usage.jsonl` |
EOF
)
  USAGE_SCHEMA_SECTION=$(cat <<'EOF'
## Usage Metrics Schema (v2.5.0+)

When using `log_usage`, include enriched fields whenever known:
- `status`: `"success"` or `"failure"` for task/tool outcomes
- `duration_ms`: elapsed time for completed operations
- `run_id`/`event_id`/`parent_event_id`: keep correlation across delegations
- `origin`: use `"top_level"` for root work and `"nested"` for delegated flows
EOF
)
  USAGE_QUALITY_SECTION=$(cat <<'EOF'
## Usage Quality Reporting (v2.5.0+)

Use `get_usage_quality_report(days=7, min_events=20)` to review whether tool usage
looks correct and valuable. Pay attention to duplicate bursts, high failure rates,
nested-vs-top-level balance, and redacted evidence/examples.
EOF
)
else
  MCP_SECTION=""
  USAGE_SCHEMA_SECTION=""
  USAGE_QUALITY_SECTION=""
fi


write_orchestrator_instructions \
  "$INSTRUCTIONS_FILE" \
  "$CHILD_WORKFLOW_LIST" \
  "$MCP_SECTION" \
  "$USAGE_SCHEMA_SECTION" \
  "$USAGE_QUALITY_SECTION"

log "✓ Created $ORCHESTRATOR_INSTRUCTIONS_REL (orchestrator)"

# When the fleet_instrument feature is enabled, the orchestrator instructions above are
# thin (delivery flow delegated); install the on-demand agent that carries the full protocol.
if [[ "${FEATURE_FLEET_INSTRUMENT:-false}" == "true" ]]; then
  write_fleet_instrument_agent \
    "$CHILD_WORKFLOW_LIST" \
    "$MCP_SECTION" \
    "$USAGE_SCHEMA_SECTION" \
    "$USAGE_QUALITY_SECTION"
  log "✓ Created .github/agents/${PROJECT_NAME}-fleet-instrument.agent.md (on-demand delivery orchestrator)"
fi

# Once-read capabilities index so the orchestrator can orient without eager filesystem scans.
write_capabilities_manifest
log "✓ Created .copilot/capabilities.md (capabilities manifest)"

fi  # end Phase 3

# ─────────────────────────────────────────────────────────────
# Phase 4: Analyze existing code (extract contracts)
# ─────────────────────────────────────────────────────────────
if should_run_phase 4; then
set_copilot_stage "Phase 4: Analyzing existing code"
header "Phase 4: Analyzing existing code"

HAS_EXISTING_CODE=false
for ((i=0; i<CHILD_COUNT; i++)); do
  name="${CHILD_NAMES[$i]}"
  repo_path="${CHILD_LOCAL_PATHS[$i]}"
  if repo_has_code "$(resolve_repo_path "$repo_path")"; then
    HAS_EXISTING_CODE=true
    break
  fi
done

if [[ "$HAS_EXISTING_CODE" == true ]]; then
  log "Existing source code detected — extracting contracts and requirements..."
  INITIAL_GENERATION_RAN="true"
  PHASE4_PROMPT=$(
    TPL_TARGET_DIR="$TARGET_DIR" \
    TPL_PROJECT_NAME="$PROJECT_NAME" \
    TPL_PROJECT_DESC="$PROJECT_DESC" \
    TPL_REPO_SUMMARY="$REPO_SUMMARY" \
    render_template_stdout "$TEMPLATE_DIR/prompts/phase4-analyze-existing.md.tmpl"
  )
  copilot_prompt "$PHASE4_PROMPT" || true
else
  log "No existing source code — skipping analysis (clean project)"
fi

fi  # end Phase 4

# ─────────────────────────────────────────────────────────────
# Phase 5: Commit
# ─────────────────────────────────────────────────────────────
if should_run_phase 5; then
set_copilot_stage "Phase 5: Committing initialization"
header "Phase 5: Committing initialization"
log "Deferring baseline commits until post-eval requirement checks pass"

fi  # end Phase 5

# ─────────────────────────────────────────────────────────────
# Post-Init Review
# ─────────────────────────────────────────────────────────────
if should_run_phase 5; then
header "Post-Init Review"
echo ""
echo "  Generated artifacts:"
echo ""
echo "    Artifact                              Status"
echo "    --------------------------------      ------"
if [[ -f "$TARGET_DIR/.copilot/guardrails/pattern.yml" ]]; then
  echo "    .copilot/guardrails/pattern.yml      ✓ pattern snapshot"
fi
if [[ -f "$TARGET_DIR/.copilot/guardrails/nfr.yml" ]]; then
  echo "    .copilot/guardrails/nfr.yml          ✓ NFR snapshot"
fi
[[ -f "$ORCHESTRATOR_INSTRUCTIONS_FILE" ]] && echo "    $ORCHESTRATOR_INSTRUCTIONS_REL              ✓ orchestrator" || echo "    $ORCHESTRATOR_INSTRUCTIONS_REL              ✗ missing"
spec_count=0
critic_count=0
for ((i=0; i<CHILD_COUNT; i++)); do
  if [[ -f "$(specialist_agent_file_for_repo "${CHILD_NAMES[$i]}" "${CHILD_LOCAL_PATHS[$i]}")" ]]; then
    spec_count=$((spec_count + 1))
  fi
  if [[ -f "$(critic_agent_file_for_repo "${CHILD_NAMES[$i]}" "${CHILD_LOCAL_PATHS[$i]}")" ]]; then
    critic_count=$((critic_count + 1))
  fi
done
echo "    <child>/.github/agents/*.agent.md     ✓ ${spec_count} specialist(s), ${critic_count} critic(s)"
if [[ "${ENABLE_MCP:-false}" == "true" ]]; then
  [[ -f "$MCP_CONFIG_FILE" ]] && echo "    $MCP_CONFIG_REL                     ✓ MCP tools" || echo "    $MCP_CONFIG_REL                     ✗ missing"
else
  [[ -f "$MCP_CONFIG_FILE" ]] && echo "    $MCP_CONFIG_REL                     ✓ present (opt-in)" || echo "    $MCP_CONFIG_REL                     · disabled by config"
fi
if compgen -G "$TARGET_DIR/.contracts/*.yml" > /dev/null 2>&1; then
  contract_count=$(ls "$TARGET_DIR/.contracts/"*.yml 2>/dev/null | wc -l)
  echo "    .contracts/*.yml                      ✓ $contract_count contract(s)"
else
  echo "    .contracts/*.yml                      · none yet (expected for new projects)"
fi
if [[ -f "$TARGET_DIR/.requirements/platform-guardrails.yml" ]]; then
  echo "    .requirements/platform-guardrails.yml ✓ AVM guardrails"
fi
if [[ -f "$TARGET_DIR/.copilot/topology.md" ]]; then
  echo "    .copilot/topology.md                  ✓ project topology / quick reference"
fi
if [[ -d "$TARGET_DIR/.github/skills" ]]; then
  echo "    .github/skills/*                      ✓ installed skills (parent)"
fi
if [[ "$FEATURE_ONBOARDING_DOCS" == "true" ]]; then
  echo "    .copilot/docs/developer-onboarding.md ✓ generated"
else
  echo "    .copilot/docs/developer-onboarding.md · disabled by config"
fi
if [[ "$FEATURE_PORTABILITY_BLUEPRINTS" == "true" ]]; then
  echo "    .copilot/docs/portability-blueprint.md ✓ generated"
else
  echo "    .copilot/docs/portability-blueprint.md · disabled by config"
fi
if [[ "$FEATURE_FLEET_INSTRUMENT" == "true" ]]; then
  echo "    .github/agents/${PROJECT_NAME}-fleet-instrument.agent.md ✓ generated (thin instructions)"
else
  echo "    .github/agents/*-fleet-instrument.agent.md · disabled (delivery flow inline in instructions)"
fi
echo ""
fi

# ─────────────────────────────────────────────────────────────
# Phase 6: Initial Copilot prompt
# ─────────────────────────────────────────────────────────────
if should_run_phase 6; then
set_copilot_stage "Phase 6: Running initial Copilot prompt"
header "Phase 6: Running initial Copilot prompt"

# Ensure every child repo carries the workspace MCP config before dispatch so
# child Copilot runs (cwd=<child repo>) auto-discover .github/mcp.json.
install_child_mcp_configs

if [[ -n "${INITIAL_PROMPT:-}" ]]; then
  run_orchestration_preflight

  # Resolve NFR content
  NFR_CONTENT=""
  if [[ -n "${NFR:-}" ]]; then
    log "Resolving NFR document..."
    NFR_CONTENT=$(resolve_content "$NFR")
  fi

  FULL_PROMPT="$INITIAL_PROMPT"
  if [[ -n "$NFR_CONTENT" ]]; then
    FULL_PROMPT="${FULL_PROMPT}

---
## Non-Functional Requirements

${NFR_CONTENT}"
  fi

  # Append pattern documentation if available
  if [[ -n "${PATTERN_DOCS:-}" ]]; then
    FULL_PROMPT="${FULL_PROMPT}
${PATTERN_DOCS}"
  fi

  log "Running configured initial Copilot prompt..."
  INITIAL_GENERATION_RAN="true"
  copilot_prompt "$FULL_PROMPT"

  if [[ "${ENABLE_MCP:-false}" == "true" && -f "$MCP_CONFIG_FILE" ]]; then
    header "Phase 6a: MCP child dispatch bootstrap"
    log "MCP mode active: child execution must use check_repo_index + check_repo_queues + child-agent-runner dispatch tools."
    log "Watch init output for MCP_CALL / MCP_SUMMARY markers from the orchestrator response."
    log "Running MCP-driven child queue bootstrap..."
    PHASE6_MCP_PROMPT=$(
      TPL_PROJECT_NAME="$PROJECT_NAME" \
      TPL_REPO_SUMMARY="$REPO_SUMMARY" \
      TPL_REPO_DISPATCH_HINTS="$REPO_DISPATCH_HINTS" \
      render_template_stdout "$TEMPLATE_DIR/prompts/phase6-mcp-bootstrap.md.tmpl"
    )
    copilot_prompt "$PHASE6_MCP_PROMPT" || true
  fi
else
  log "No initial prompt configured — skipping"
fi

fi  # end Phase 6

# -------------------------------------------------------------
# Phase 6b: Critique/remediation for generated artifacts
# -------------------------------------------------------------
if should_run_phase 6 && [[ "${INITIAL_GENERATION_RAN:-false}" == "true" ]]; then
  set_copilot_stage "Phase 6b: Critique and remediation"
  header "Phase 6b: Critique and remediation"
  run_init_critique_remediation_loop
fi

if should_run_phase 5; then
  if [[ "${FEATURE_CRITIC_EVALUATOR:-true}" == "true" && "${INITIAL_GENERATION_RAN:-false}" == "true" && "${INIT_CRITIC_GATE_PASSED:-false}" != "true" ]]; then
    echo "ERROR: Critic gate did not pass. Baseline commits are blocked until STATUS: PASS." >&2
    exit 1
  fi
  if unmet_requirements_output="$(evaluate_required_technologies)"; then
    create_post_eval_baseline_commits
  else
    echo "ERROR: Required technology checks failed. Baseline commits were not created." >&2
    echo "UNMET_REQUIREMENTS:" >&2
    echo "$unmet_requirements_output" >&2
    exit 1
  fi
fi

# -------------------------------------------------------------
# Done
# -------------------------------------------------------------
print_copilot_usage_summary
header "✅ Initialization complete"
echo ""
echo "  Project:  $PROJECT_NAME"
echo "  Framework: enterprise-copilot-fleet-controller v$FRAMEWORK_VERSION"
echo "  Location: $TARGET_DIR"
echo ""
echo "  Generated files:"
echo "    .github/copilot-instructions.md — orchestrator (main agent)"
echo "    <child>/.github/agents/*.agent.md — specialist + critic agents in each child repo"
echo "    <child>/work/{todo,ready-for-review,done}/ — child workflow queues"
if [[ "${ENABLE_MCP:-false}" == "true" ]]; then
  echo "    .github/mcp.json                — MCP tools configuration"
  echo "    <child>/.github/mcp.json        — child-scoped MCP config (parent minus orchestration servers)"
else
  echo "    .github/mcp.json                — MCP tools configuration (disabled by config)"
fi
echo "    .contracts/                      — API interface definitions"
echo "    .requirements/                   — acceptance criteria"
echo "    .decisions/log.md                — decision record"
echo "    .repo-index.yml                  — child repo references (external paths)"
echo "    .copilot/topology.md             — project topology / quick reference"
echo "    .github/skills/                  — installed Copilot skills"
echo "    <infra child>/.github/skills/    — MCAPS infra skills (secure-azure-terraform-coder, defender-servers-skill, spoke-skill)"
if [[ "$FEATURE_ONBOARDING_DOCS" == "true" || "$FEATURE_PORTABILITY_BLUEPRINTS" == "true" ]]; then
  echo "    .copilot/docs/                   — optional onboarding/portability docs"
fi
echo ""
echo "  Example command:"
echo "    cd $TARGET_DIR"
echo "    copilot -p 'your task description' --allow-all-tools --autopilot --no-ask-user --no-color --stream on --log-level none --add-dir \"\$(pwd)\""
echo ""
echo "  Example child-repo execution:"
echo "    cd <child-repo-path>"
echo "    copilot -p 'Process the next work/todo request as specialist or critic' --allow-all-tools --autopilot --no-ask-user --no-color --stream on --log-level none --add-dir \"\$(pwd)\""
echo ""
echo "  Workflow behavior:"
echo "    1. Coordinator writes per-repo request files in child work/todo/"
echo "    2. Specialist (child cwd) moves completed requests to work/ready-for-review/"
echo "    3. Critic (child cwd) iterates until PASS, then moves files to work/done/"
echo "    4. Coordinator validates done files against acceptance criteria"
echo ""
