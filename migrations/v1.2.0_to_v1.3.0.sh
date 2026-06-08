#!/usr/bin/env bash
set -euo pipefail
# Migration: v1.2.0 → v1.3.0
# Fixes: Add PROJECT_DIR env to all MCP server entries so metrics are written correctly.
#
# Env provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — path to enterprise-copilot-fleet-controller checkout

echo "  → Ensuring all MCP servers have PROJECT_DIR env for metrics..."

# Patch mcp.json: add PROJECT_DIR env to servers that are missing it
if [[ -f "$PROJECT_DIR/.copilot/mcp.json" ]]; then
  python3 - "$PROJECT_DIR/.copilot/mcp.json" "$PROJECT_DIR" << 'PYEOF'
import json
import sys

mcp_path = sys.argv[1]
project_dir = sys.argv[2]

with open(mcp_path) as f:
    data = json.load(f)

servers = data.get("mcpServers", {})
changed = False

for name, config in servers.items():
    env = config.get("env", {})
    if "PROJECT_DIR" not in env:
        env["PROJECT_DIR"] = project_dir
        config["env"] = env
        changed = True

if changed:
    with open(mcp_path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"    Added PROJECT_DIR to MCP servers missing it")
else:
    print(f"    All MCP servers already have PROJECT_DIR")
PYEOF
fi

# Also patch child repo mcp configs if they exist
if [[ -d "$PROJECT_DIR/work" ]]; then
  for child_mcp in "$PROJECT_DIR"/work/*/.copilot/mcp-config.json "$PROJECT_DIR"/work/*/.copilot/mcp.json; do
    [[ -f "$child_mcp" ]] || continue
    child_dir="$(cd "$(dirname "$child_mcp")/.." && pwd)"
    python3 - "$child_mcp" "$child_dir" << 'PYEOF'
import json
import sys

mcp_path = sys.argv[1]
project_dir = sys.argv[2]

with open(mcp_path) as f:
    data = json.load(f)

servers = data.get("mcpServers", data.get("servers", {}))
changed = False

for name, config in servers.items():
    env = config.get("env", {})
    if "PROJECT_DIR" not in env:
        env["PROJECT_DIR"] = project_dir
        config["env"] = env
        changed = True

if changed:
    with open(mcp_path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"    Patched {mcp_path}")
PYEOF
  done
fi

echo "  ✓ Metrics env fix applied"
