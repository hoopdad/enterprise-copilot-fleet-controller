#!/usr/bin/env bash
set -euo pipefail
# Migration: v2.3.0 → v2.4.0
# Adds git-pr-orchestrator MCP tool to .copilot/mcp.json for multi-repo release workflows.
#
# Env provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — path to enterprise-copilot-fleet-controller checkout

[[ -z "${PROJECT_DIR:-}" ]] && echo "ERROR: PROJECT_DIR not set" && exit 1
[[ -z "${FRAMEWORK_DIR:-}" ]] && echo "ERROR: FRAMEWORK_DIR not set" && exit 1

echo "  → Adding git-pr-orchestrator MCP tool to mcp.json..."

if [[ -f "$PROJECT_DIR/.copilot/mcp.json" ]]; then
  python3 - "$PROJECT_DIR/.copilot/mcp.json" "$FRAMEWORK_DIR" <<'PYEOF'
import json
import sys
from pathlib import Path

mcp_path = Path(sys.argv[1])
framework_dir = Path(sys.argv[2])

with mcp_path.open() as f:
    data = json.load(f)

servers_key = "mcpServers" if isinstance(data.get("mcpServers"), dict) else "servers"
servers = data.get(servers_key, {})
if not isinstance(servers, dict):
    servers = {}
    data[servers_key] = servers

# Add git-pr-orchestrator if not already present
git_pr_tool = {
    "description": "Automate multi-repo releases: commit → push → PR → CI monitor → auto-merge.",
    "command": "python3",
    "args": [f"{framework_dir}/tools/git-pr-orchestrator/server.py"],
    "env": { "PROJECT_DIR": str(Path(sys.argv[1]).parent.parent.parent) }
}

if "git-pr-orchestrator" not in servers:
    servers["git-pr-orchestrator"] = git_pr_tool
    data[servers_key] = servers
    changed = True
    print("    Added git-pr-orchestrator tool")
else:
    changed = False
    print("    git-pr-orchestrator already present")

# Update framework version stamp
if data.get("_framework_version") != "2.4.0":
    data["_framework_version"] = "2.4.0"
    changed = True

if changed:
    with mcp_path.open("w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("    Updated mcp.json")
else:
    print("    mcp.json already up to date")
PYEOF
else
  echo "    mcp.json not found (MCP disabled in this project) — skipping"
fi

echo "  ✓ Migration complete"
