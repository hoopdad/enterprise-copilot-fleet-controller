#!/usr/bin/env bash
set -euo pipefail
# Migration: v2.1.0 → v2.2.0
# Refreshes usage-tracker metadata and guidance for enhanced usage metrics schema.
#
# Env provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — path to enterprise-copilot-fleet-controller checkout

[[ -z "${PROJECT_DIR:-}" ]] && echo "ERROR: PROJECT_DIR not set" && exit 1
[[ -z "${FRAMEWORK_DIR:-}" ]] && echo "ERROR: FRAMEWORK_DIR not set" && exit 1

echo "  → Refreshing usage-tracker metadata..."

if [[ -f "$PROJECT_DIR/.copilot/mcp.json" ]]; then
  python3 - "$PROJECT_DIR/.copilot/mcp.json" "$PROJECT_DIR" <<'PYEOF'
import json
import sys
from pathlib import Path

mcp_path = Path(sys.argv[1])
project_dir = Path(sys.argv[2])
project_name = project_dir.name

usage_description = (
    "Append usage events with correlation/status fields and summarize recent workflow activity."
)

with mcp_path.open() as f:
    data = json.load(f)

servers_key = "mcpServers" if isinstance(data.get("mcpServers"), dict) else "servers"
servers = data.get(servers_key, {})
if not isinstance(servers, dict):
    servers = {}
    data[servers_key] = servers

changed = False
usage_tracker = servers.get("usage-tracker")
if isinstance(usage_tracker, dict):
    if usage_tracker.get("description") != usage_description:
        usage_tracker["description"] = usage_description
        changed = True

    env = usage_tracker.get("env")
    if not isinstance(env, dict):
        env = {}
        usage_tracker["env"] = env
        changed = True

    if env.get("PROJECT_DIR") != str(project_dir):
        env["PROJECT_DIR"] = str(project_dir)
        changed = True
    if env.get("PROJECT_NAME") != project_name:
        env["PROJECT_NAME"] = project_name
        changed = True

if data.get("_framework_version") != "2.2.0":
    data["_framework_version"] = "2.2.0"
    changed = True

if changed:
    with mcp_path.open("w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("    Updated mcp.json usage-tracker metadata and framework stamp")
else:
    print("    mcp.json already up to date")
PYEOF
fi

echo "  → Refreshing orchestrator usage guidance..."

if [[ -f "$PROJECT_DIR/.copilot/instructions.md" ]]; then
  python3 - "$PROJECT_DIR/.copilot/instructions.md" <<'PYEOF'
import re
import sys
from pathlib import Path

instructions_path = Path(sys.argv[1])
content = instructions_path.read_text()

section = """## Usage Metrics Schema (v2.2.0+)

When using `log_usage`, include enriched fields whenever known:
- `status`: `"success"` or `"failure"` for task/tool outcomes
- `duration_ms`: elapsed time for completed operations
- `run_id`/`event_id`/`parent_event_id`: keep correlation across delegations
- `origin`: use `"top_level"` for root work and `"nested"` for delegated flows
"""

pattern = r"\n## Usage Metrics Schema \(v2\.2\.0\+\)\n.*?(?=\n## |\Z)"
new_block = "\n" + section.rstrip() + "\n"

if re.search(pattern, content, flags=re.DOTALL):
    updated = re.sub(pattern, new_block, content, flags=re.DOTALL)
else:
    anchor = "## Anti-Patterns"
    idx = content.find(anchor)
    if idx >= 0:
        updated = content[:idx].rstrip() + "\n\n" + section.rstrip() + "\n\n" + content[idx:]
    else:
        updated = content.rstrip() + "\n\n" + section.rstrip() + "\n"

if updated != content:
    instructions_path.write_text(updated)
    print("    Updated .copilot/instructions.md usage metrics schema guidance")
else:
    print("    Usage metrics schema guidance already up to date")
PYEOF
fi

echo "  ✓ Migration complete"
