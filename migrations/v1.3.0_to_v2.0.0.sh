#!/bin/bash
# migrations/v1.3.0_to_v2.0.0.sh — Migrate from v1.x to v2.0.0
#
# Converts:
#   .agents/orchestrator.md → .copilot/instructions.md
#   .agents/specialists/*.yml → .github/agents/*.agent.md
#   Removes .agents/ directory
#
# Environment variables provided by upgrade.sh:
#   PROJECT_DIR — the project being upgraded
#   FRAMEWORK_DIR — the framework repo

set -euo pipefail

log() { echo "  → $*"; }
warn() { echo "  ⚠ $*"; }

[[ -z "${PROJECT_DIR:-}" ]] && echo "ERROR: PROJECT_DIR not set" && exit 1
[[ -z "${FRAMEWORK_DIR:-}" ]] && echo "ERROR: FRAMEWORK_DIR not set" && exit 1

cd "$PROJECT_DIR"

# ─────────────────────────────────────────────────────────────
# Step 1: Create .github/agents/ directory
# ─────────────────────────────────────────────────────────────
mkdir -p "$PROJECT_DIR/.github/agents"
log "Created .github/agents/"

# ─────────────────────────────────────────────────────────────
# Step 2: Convert .agents/specialists/*.yml → .github/agents/*.agent.md
# ─────────────────────────────────────────────────────────────
if [[ -d "$PROJECT_DIR/.agents/specialists" ]]; then
  for yml_file in "$PROJECT_DIR/.agents/specialists"/*.yml; do
    [[ ! -f "$yml_file" ]] && continue

    base_name=$(basename "$yml_file" .yml)
    agent_file="$PROJECT_DIR/.github/agents/${base_name}-specialist.agent.md"

    if [[ -f "$agent_file" ]]; then
      log "Agent $agent_file already exists, skipping"
      continue
    fi

    log "Converting $base_name.yml → ${base_name}-specialist.agent.md"

    # Extract fields from YAML using python3 or yq
    if command -v python3 &>/dev/null; then
      read -r spec_name spec_role spec_repo spec_stack lint_cmd test_cmd build_cmd < <(python3 - "$yml_file" <<'PYEOF'
import yaml, sys
with open(sys.argv[1]) as f:
    data = yaml.safe_load(f)
name = data.get('name', '')
role = data.get('role', '')
repo = data.get('repo', '')
stack = data.get('stack', '')
validate = data.get('validate', {})
lint = validate.get('lint', 'echo no linter') if isinstance(validate, dict) else 'echo no linter'
test = validate.get('test', 'echo no tests') if isinstance(validate, dict) else 'echo no tests'
build = validate.get('build', 'echo no build') if isinstance(validate, dict) else 'echo no build'
print(f"{name}\t{role}\t{repo}\t{stack}\t{lint}\t{test}\t{build}")
PYEOF
      ) || {
        warn "Failed to parse $yml_file — skipping"
        continue
      }
    elif command -v yq &>/dev/null; then
      spec_name=$(yq eval '.name // ""' "$yml_file")
      spec_role=$(yq eval '.role // ""' "$yml_file")
      spec_repo=$(yq eval '.repo // ""' "$yml_file")
      spec_stack=$(yq eval '.stack // ""' "$yml_file")
      lint_cmd=$(yq eval '.validate.lint // "echo no linter"' "$yml_file")
      test_cmd=$(yq eval '.validate.test // "echo no tests"' "$yml_file")
      build_cmd=$(yq eval '.validate.build // "echo no build"' "$yml_file")
    else
      warn "Need python3 or yq to parse YAML — skipping $yml_file"
      continue
    fi

    # Determine tools based on role
    case "$spec_role" in
      *backend*|*API*|*api*)
        tools='"scaffold-generator", "security-scanner", "usage-tracker"' ;;
      *frontend*|*web*|*Frontend*)
        tools='"security-scanner", "usage-tracker"' ;;
      *infra*|*Infrastructure*|*terraform*)
        tools='"azure-inspector", "security-scanner", "usage-tracker"' ;;
      *)
        tools='"security-scanner", "usage-tracker"' ;;
    esac

    # Write the .agent.md file
    cat > "$agent_file" << AGENTEOF
---
name: ${base_name}-specialist
description: "${spec_role} specialist for ${spec_name}. Handles implementation, testing, and validation."
tools: [${tools}]
---

You are the specialist for ${spec_name} (${spec_repo}).

## Your Scope
- Repository: ${spec_repo}
- Stack: ${spec_stack}
- Validation: \`cd ${spec_repo} && ${lint_cmd} && ${test_cmd}\`

## Protocol
1. Read .requirements/*.yml for acceptance criteria relevant to your repo
2. Read .contracts/*.yml for interface definitions you must match
3. Implement ONLY in ${spec_repo}
4. Run validation before committing:
   - Lint: \`cd ${spec_repo} && ${lint_cmd}\`
   - Test: \`cd ${spec_repo} && ${test_cmd}\`
   - Build: \`cd ${spec_repo} && ${build_cmd}\`
5. Commit with conventional commit messages (feat:, fix:, refactor:, etc.)

## Anti-Patterns
- Never modify other repos (only ${spec_repo})
- Never change .contracts/ without orchestrator approval
- Never skip validation
- Never make architectural decisions — ask the orchestrator
AGENTEOF

    log "  ✓ ${base_name}-specialist.agent.md"
  done
else
  log "No .agents/specialists/ found — nothing to convert"
fi

# ─────────────────────────────────────────────────────────────
# Step 3: Merge orchestrator content into .copilot/instructions.md
# ─────────────────────────────────────────────────────────────
INSTRUCTIONS_FILE="$PROJECT_DIR/.copilot/instructions.md"

if [[ -f "$PROJECT_DIR/.agents/orchestrator.md" ]]; then
  if [[ -f "$INSTRUCTIONS_FILE" ]]; then
    # Append orchestrator content below existing instructions
    log "Merging .agents/orchestrator.md into existing .copilot/instructions.md"
    echo "" >> "$INSTRUCTIONS_FILE"
    echo "<!-- Migrated from .agents/orchestrator.md (v1.x → v2.0.0) -->" >> "$INSTRUCTIONS_FILE"
    echo "" >> "$INSTRUCTIONS_FILE"
    cat "$PROJECT_DIR/.agents/orchestrator.md" >> "$INSTRUCTIONS_FILE"
  else
    # No existing instructions — orchestrator becomes instructions
    log "Moving .agents/orchestrator.md → .copilot/instructions.md"
    mkdir -p "$(dirname "$INSTRUCTIONS_FILE")"
    cp "$PROJECT_DIR/.agents/orchestrator.md" "$INSTRUCTIONS_FILE"
  fi
  log "  ✓ Orchestrator content merged into .copilot/instructions.md"
else
  log "No .agents/orchestrator.md found"
fi

# ─────────────────────────────────────────────────────────────
# Step 4: Remove .agents/ directory
# ─────────────────────────────────────────────────────────────
if [[ -d "$PROJECT_DIR/.agents" ]]; then
  log "Removing .agents/ (replaced by .github/agents/ + .copilot/instructions.md)"
  rm -rf "$PROJECT_DIR/.agents"
  # Also remove from git tracking if applicable
  git rm -rf .agents 2>/dev/null || true
  log "  ✓ .agents/ removed"
fi

# ─────────────────────────────────────────────────────────────
# Step 5: Update .copilot/mcp.json framework version
# ─────────────────────────────────────────────────────────────
if [[ -f "$PROJECT_DIR/.copilot/mcp.json" ]]; then
  if command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('$PROJECT_DIR/.copilot/mcp.json', 'r') as f:
    data = json.load(f)
data['_framework_version'] = '2.0.0'
with open('$PROJECT_DIR/.copilot/mcp.json', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" 2>/dev/null && log "Updated mcp.json framework version" || warn "Could not update mcp.json version"
  fi
fi

# ─────────────────────────────────────────────────────────────
# Step 6: Add fleet usage note
# ─────────────────────────────────────────────────────────────
if [[ -f "$INSTRUCTIONS_FILE" ]]; then
  # Check if fleet instructions already present
  if ! grep -q "/fleet" "$INSTRUCTIONS_FILE" 2>/dev/null; then
    cat >> "$INSTRUCTIONS_FILE" << 'FLEETEOF'

## Fleet Usage (v2.0.0)

Use `/fleet` to decompose multi-repo tasks. Fleet will:
1. Read this file (orchestrator protocol)
2. Spawn @<name>-specialist subagents from .github/agents/
3. Each specialist gets its own context window
4. Orchestrator coordinates dependencies and verifies results
FLEETEOF
    log "Added fleet usage instructions"
  fi
fi

log ""
log "Migration complete: v1.3.0 → v2.0.0"
log ""
log "New structure:"
log "  .copilot/instructions.md       ← orchestrator (was .agents/orchestrator.md)"
log "  .github/agents/*.agent.md      ← specialists (was .agents/specialists/*.yml)"
log "  .copilot/mcp.json              ← MCP tools (unchanged)"
log ""
log "Usage: /fleet <multi-repo task description>"
