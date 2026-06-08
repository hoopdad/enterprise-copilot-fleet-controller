#!/bin/bash
# Migration: v1.1.0 → v1.2.0
# Purpose: Add auto-instrumentation to MCP tools for reliable usage tracking
#
# Changes:
#   - Updates orchestrator.md with stronger usage tracking instructions
#   - Updates .copilot/instructions.md to mention auto-instrumentation
#   - Adds .metrics/usage.jsonl to .gitignore (data is local, not committed)
#
# Environment variables provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — the framework repo root

set -euo pipefail

log() { echo "    $*"; }

# 1. Update orchestrator.md with improved usage tracking section
if [[ -f "$PROJECT_DIR/.agents/orchestrator.md" ]]; then
  if grep -q "## Usage Tracking" "$PROJECT_DIR/.agents/orchestrator.md"; then
    log "Updating usage tracking section in orchestrator.md"
    # Replace existing usage tracking section with improved version
    python3 - "$PROJECT_DIR/.agents/orchestrator.md" << 'PYEOF'
import sys, re

path = sys.argv[1]
with open(path) as f:
    content = f.read()

new_section = """## Usage Tracking

All MCP tool invocations are **automatically logged** via instrumentation (no manual calls needed).

Call `log_usage` manually only for meta-events the tools can't detect:
- **Task start**: agent="orchestrator", action="task_start", skill=<skill-name>, detail=<task description>
- **Delegation**: agent="orchestrator", action="delegation", detail=<specialist + repo>
- **Tool call** (when invoking MCP tools): agent="orchestrator", action="tool_call", tool=<tool-name>
- **Task complete**: agent="orchestrator", action="task_complete", detail=<summary>

> **Rule**: Every delegation and every MCP tool call MUST be logged. Automatic instrumentation
> handles tool-side logging; you handle orchestration-level events."""

# Replace from "## Usage Tracking" to next ## or end of file
pattern = r'## Usage Tracking.*?(?=\n## |\Z)'
content = re.sub(pattern, new_section, content, flags=re.DOTALL)

with open(path, 'w') as f:
    f.write(content)
PYEOF
  else
    log "Adding usage tracking section to orchestrator.md"
    cat >> "$PROJECT_DIR/.agents/orchestrator.md" << 'EOF'

## Usage Tracking

All MCP tool invocations are **automatically logged** via instrumentation (no manual calls needed).

Call `log_usage` manually only for meta-events the tools can't detect:
- **Task start**: agent="orchestrator", action="task_start", skill=<skill-name>, detail=<task description>
- **Delegation**: agent="orchestrator", action="delegation", detail=<specialist + repo>
- **Tool call** (when invoking MCP tools): agent="orchestrator", action="tool_call", tool=<tool-name>
- **Task complete**: agent="orchestrator", action="task_complete", detail=<summary>

> **Rule**: Every delegation and every MCP tool call MUST be logged. Automatic instrumentation
> handles tool-side logging; you handle orchestration-level events.
EOF
  fi
fi

# 2. Update .copilot/instructions.md to mention auto-instrumentation
if [[ -f "$PROJECT_DIR/.copilot/instructions.md" ]]; then
  if ! grep -q "auto-instrumented" "$PROJECT_DIR/.copilot/instructions.md"; then
    log "Adding auto-instrumentation note to .copilot/instructions.md"
    cat >> "$PROJECT_DIR/.copilot/instructions.md" << 'EOF'

## Usage Tracking (v1.2.0+)

All MCP tool calls are **auto-instrumented** — every invocation is logged to `.metrics/usage.jsonl`
without manual action. Additionally, call `log_usage` for orchestration meta-events:
- `task_start` / `task_complete` — bookend every task
- `delegation` — when handing off to a specialist
- `tool_call` — when you invoke an MCP tool (provides agent attribution the auto-log lacks)
EOF
  fi
fi

# 3. Ensure .metrics/usage.jsonl is in .gitignore (data file, not tracked)
if [[ -f "$PROJECT_DIR/.gitignore" ]]; then
  if ! grep -q ".metrics/usage.jsonl" "$PROJECT_DIR/.gitignore"; then
    log "Adding .metrics/usage.jsonl to .gitignore"
    echo "" >> "$PROJECT_DIR/.gitignore"
    echo "# Usage metrics (auto-generated, local only)" >> "$PROJECT_DIR/.gitignore"
    echo ".metrics/usage.jsonl" >> "$PROJECT_DIR/.gitignore"
  fi
else
  log "Creating .gitignore with .metrics/usage.jsonl"
  cat > "$PROJECT_DIR/.gitignore" << 'EOF'
# Usage metrics (auto-generated, local only)
.metrics/usage.jsonl
EOF
fi

# 4. Ensure .metrics directory exists
if [[ ! -d "$PROJECT_DIR/.metrics" ]]; then
  log "Creating .metrics/ directory"
  mkdir -p "$PROJECT_DIR/.metrics"
  touch "$PROJECT_DIR/.metrics/.gitkeep"
fi

# 5. Add usage-tracker to child repo MCP configs (work/*/.copilot/mcp-config.json)
if [[ -d "$PROJECT_DIR/work" ]]; then
  for child_mcp in "$PROJECT_DIR"/work/*/.copilot/mcp-config.json; do
    [[ -f "$child_mcp" ]] || continue
    child_name="$(basename "$(dirname "$(dirname "$child_mcp")")")"
    if ! grep -q "usage-tracker" "$child_mcp"; then
      log "Adding usage-tracker to $child_name/.copilot/mcp-config.json"
      python3 - "$child_mcp" "$FRAMEWORK_DIR" "$PROJECT_DIR" << 'PYEOF'
import json, sys

path, framework_dir, project_dir = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    data = json.load(f)

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
    fi
  done
fi

# 6. Add usage tracking awareness to Squad agent files in child repos
if [[ -d "$PROJECT_DIR/work" ]]; then
  for squad_file in "$PROJECT_DIR"/work/*/.github/agents/squad.agent.md; do
    [[ -f "$squad_file" ]] || continue
    child_name="$(basename "$(dirname "$(dirname "$(dirname "$squad_file")")")")"
    if ! grep -q "log_usage" "$squad_file"; then
      log "Adding usage tracking note to $child_name squad.agent.md"
      cat >> "$squad_file" << 'EOF'

---

## Usage Tracking

The `usage-tracker` MCP tool is available. Log key events:
- When starting work: `log_usage(agent="specialist/<your-role>", action="task_start", detail="<what>")`
- When calling other MCP tools: `log_usage(agent="specialist/<your-role>", action="tool_call", tool="<name>")`
- When completing work: `log_usage(agent="specialist/<your-role>", action="task_complete", detail="<summary>")`
EOF
    fi
  done
fi

log "Migration complete — auto-instrumentation enabled"
