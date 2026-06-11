log() { echo "  → $*"; }
header() { echo ""; echo "═══ $* ═══"; }
warn() { echo "  ⚠ $*"; }

should_run_phase() { [[ "$1" -ge "$START_PHASE" && "$1" -le "$END_PHASE" ]]; }

run_phase() {
  local number="$1" title="$2"
  shift 2
  if should_run_phase "$number"; then
    set_copilot_stage "$title"
    header "$title"
    "$@"
  fi
}

render_template_file() {
  local template_path="$1" output_path="$2"
  python3 - "$template_path" "$output_path" <<'PYEOF'
import os
import sys
from pathlib import Path

template = Path(sys.argv[1])
output = Path(sys.argv[2])
text = template.read_text(encoding="utf-8")
for key, value in os.environ.items():
    if not key.startswith("TPL_"):
        continue
    text = text.replace(f"__{key[4:]}__", value)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(text, encoding="utf-8")
PYEOF
}

render_template_stdout() {
  local template_path="$1"
  python3 - "$template_path" <<'PYEOF'
import os
import sys
from pathlib import Path

template = Path(sys.argv[1])
text = template.read_text(encoding="utf-8")
for key, value in os.environ.items():
    if not key.startswith("TPL_"):
        continue
    text = text.replace(f"__{key[4:]}__", value)
print(text, end="")
PYEOF
}

write_from_template() {
  local template_rel="$1" output_path="$2"
  local template_path="$TEMPLATE_DIR/$template_rel"
  [[ -f "$template_path" ]] || { echo "ERROR: missing template $template_path" >&2; exit 1; }
  render_template_file "$template_path" "$output_path"
}

append_template_file() {
  local template_rel="$1" output_path="$2"
  local template_path="$TEMPLATE_DIR/$template_rel"
  [[ -f "$template_path" ]] || { echo "ERROR: missing template $template_path" >&2; exit 1; }
  cat "$template_path" >> "$output_path"
}

write_mcp_config() {
  local output_path="$1"
  TPL_FRAMEWORK_VERSION="$FRAMEWORK_VERSION" \
  TPL_FRAMEWORK_DIR="$FRAMEWORK_DIR" \
  TPL_TARGET_DIR="$TARGET_DIR" \
  TPL_PROJECT_NAME="$PROJECT_NAME" \
  write_from_template "mcp.json.tmpl" "$output_path"
}

write_orchestrator_instructions() {
  local output_path="$1" child_workflow_list="$2" mcp_section="$3" usage_schema_section="$4" usage_quality_section="$5"
  TPL_FRAMEWORK_VERSION="$FRAMEWORK_VERSION" \
  TPL_PROJECT_NAME="$PROJECT_NAME" \
  TPL_PROJECT_DESC="$PROJECT_DESC" \
  TPL_CHILD_WORKFLOW_LIST="$child_workflow_list" \
  TPL_CRITIC_PROTOCOL_SECTION="$CRITIC_PROTOCOL_SECTION" \
  TPL_MCP_SECTION="$mcp_section" \
  TPL_USAGE_SCHEMA_SECTION="$usage_schema_section" \
  TPL_USAGE_QUALITY_SECTION="$usage_quality_section" \
  write_from_template "instructions.md.tmpl" "$output_path"
}

append_copilot_allow_urls() {
  local -n args_ref="$1"
  local allowlist="$TEMPLATE_DIR/copilot-allow-urls.txt"
  [[ -f "$allowlist" ]] || return 0
  while IFS= read -r url; do
    [[ -z "$url" ]] && continue
    [[ "$url" =~ ^# ]] && continue
    args_ref+=(--allow-url "$url")
  done < "$allowlist"
}

require_role() {
  local value="${1,,}" field="${2:-role}"
  case "$value" in
    backend|frontend|infra|agent|worker|waf)
      return 0
      ;;
    "")
      echo "ERROR: $field is required" >&2
      exit 1
      ;;
    *)
      echo "ERROR: invalid role '$1' for $field (allowed: backend, frontend, infra, agent, worker, waf)" >&2
      exit 1
      ;;
  esac
}

format_scope_for_prompt() {
  local values="${1:-}" default_value="${2:-}"
  local line
  if [[ -z "$values" ]]; then
    echo "- ${default_value}"
    return
  fi
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    echo "- ${line}"
  done <<< "$values"
}

normalize_requirement_text() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')"
  printf '%s' "$value"
}

yaml_escape_double() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

build_critic_protocol_section() {
  local repos_scope_text requirements_scope_text
  repos_scope_text="$(format_scope_for_prompt "$CRITIC_SCOPE_REPOS_RAW" "All repositories in .repo-index.yml")"
  requirements_scope_text="$(format_scope_for_prompt "$CRITIC_SCOPE_REQUIREMENTS_RAW" "All active requirement and guardrail sources")"
  CRITIC_SCOPE_REPOS_PROMPT="$repos_scope_text"
  CRITIC_SCOPE_REQUIREMENTS_PROMPT="$requirements_scope_text"
  if [[ "${FEATURE_CRITIC_EVALUATOR:-true}" == "true" ]]; then
    CRITIC_PROTOCOL_SECTION=$(cat <<'EOF2'
10. **Critic Gate (optional feature)**: when `optional_features.critic_evaluator=true`, run evaluation-only review before acceptance
11. **Accept only PASS**: merge/close only when critic returns explicit `STATUS: PASS`; `STATUS: FAIL` blocks acceptance until remediated
EOF2
)
  else
    CRITIC_PROTOCOL_SECTION=$(cat <<'EOF2'
10. **Critic Gate (optional feature)**: disabled for this init run (`optional_features.critic_evaluator=false`)
11. **Acceptance**: proceed without critic PASS/FAIL blocking, but still enforce required technology checks
EOF2
)
  fi
  CRITIC_PROTOCOL_SECTION="${CRITIC_PROTOCOL_SECTION}
12. **Critic Scope (repos)**:
${repos_scope_text}
13. **Critic Scope (requirements)**:
${requirements_scope_text}"
}
