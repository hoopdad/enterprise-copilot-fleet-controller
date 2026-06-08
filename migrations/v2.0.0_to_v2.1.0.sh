#!/usr/bin/env bash
set -euo pipefail
# Migration: v2.0.0 → v2.1.0
# Refreshes MCP metadata in existing projects and stamps the new framework version.
#
# Env provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — path to enterprise-copilot-fleet-controller checkout

echo "  → Refreshing MCP metadata..."

if [[ -f "$PROJECT_DIR/.copilot/mcp.json" ]]; then
  python3 - "$PROJECT_DIR/.copilot/mcp.json" <<'PYEOF'
import json
import sys

mcp_path = sys.argv[1]

descriptions = {
    "submodule-sync": "Sync/check parent work/* submodule SHAs after child repo changes.",
    "contract-compliance": "Compare implemented routes to .contracts/*.yml endpoint definitions.",
    "scaffold-generator": "Generate non-overwriting FastAPI/TypeScript stubs from contracts.",
    "azure-inspector": "Read Container Apps, Cosmos DB, and ACR state via Azure CLI.",
    "ci-monitor": "Summarize recent GitHub Actions runs and key failure hints.",
    "deploy-verifier": "Probe service endpoints like /health and /version after deploy.",
    "security-scanner": "Run available scanners and normalize findings into one report.",
    "usage-tracker": "Append usage events and summarize recent workflow activity.",
}

with open(mcp_path) as f:
    data = json.load(f)

servers_key = "mcpServers" if isinstance(data.get("mcpServers"), dict) else "servers"
servers = data.get(servers_key, {})
if not isinstance(servers, dict):
    servers = {}
    data[servers_key] = servers

changed = False
for name, description in descriptions.items():
    config = servers.get(name)
    if isinstance(config, dict) and config.get("description") != description:
        config["description"] = description
        changed = True

if data.get("_framework_version") != "2.1.0":
    data["_framework_version"] = "2.1.0"
    changed = True

if changed:
    with open(mcp_path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("    Updated MCP descriptions and framework version")
else:
    print("    MCP metadata already up to date")
PYEOF
fi

echo "  ✓ Migration complete"
