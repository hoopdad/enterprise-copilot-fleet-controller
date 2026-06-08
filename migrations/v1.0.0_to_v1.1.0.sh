#!/bin/bash
# Migration: v1.0.0 → v1.1.0
# Purpose: Add usage-tracker MCP tool to existing projects
#
# Changes:
#   - Adds usage-tracker server to .copilot/mcp.json
#   - Creates .metrics/ directory with .gitkeep
#   - Adds usage tracking instructions to orchestrator
#
# Environment variables provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — the framework repo root

set -euo pipefail

log() { echo "    $*"; }

# 1. Add usage-tracker to mcp.json
if [[ -f "$PROJECT_DIR/.copilot/mcp.json" ]]; then
  if ! grep -q "usage-tracker" "$PROJECT_DIR/.copilot/mcp.json"; then
    log "Adding usage-tracker to .copilot/mcp.json"
    if command -v python3 &>/dev/null; then
      python3 - "$PROJECT_DIR/.copilot/mcp.json" "$FRAMEWORK_DIR" "$PROJECT_DIR" << 'PYEOF'
import json, sys

path, framework_dir, project_dir = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    data = json.load(f)

# Derive project name from directory
project_name = project_dir.rstrip("/").split("/")[-1]

data.setdefault("mcpServers", {})["usage-tracker"] = {
    "description": "Append usage events and summarize recent workflow activity.",
    "command": "python3",
    "args": [f"{framework_dir}/tools/usage-tracker/server.py"],
    "env": {"PROJECT_DIR": project_dir, "PROJECT_NAME": project_name}
}

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
    else
      log "WARN: python3 not available, skipping mcp.json update"
    fi
  else
    log "usage-tracker already in mcp.json, skipping"
  fi
fi

# 2. Create .metrics directory
if [[ ! -d "$PROJECT_DIR/.metrics" ]]; then
  log "Creating .metrics/ directory"
  mkdir -p "$PROJECT_DIR/.metrics"
  touch "$PROJECT_DIR/.metrics/.gitkeep"
fi

# 3. Append usage tracking guidance to orchestrator if present
if [[ -f "$PROJECT_DIR/.agents/orchestrator.md" ]]; then
  if ! grep -q "log_usage" "$PROJECT_DIR/.agents/orchestrator.md"; then
    log "Adding usage tracking section to orchestrator.md"
    cat >> "$PROJECT_DIR/.agents/orchestrator.md" << 'EOF'

## Usage Tracking
Call `log_usage` at these moments:
- **Task start**: agent="orchestrator", action="task_start", detail=<brief task description>
- **Delegation**: agent="orchestrator", action="delegation", detail=<specialist name>
- **Task complete**: agent="orchestrator", action="task_complete"

| Tool | When to Use |
|------|-------------|
| `log_usage` | Log usage event at task start, tool calls, and task completion |
| `get_usage_summary` | Review recent usage metrics for the project |
EOF
  fi
fi

log "Migration complete — usage-tracker enabled"
