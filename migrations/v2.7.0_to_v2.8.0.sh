#!/usr/bin/env bash
set -euo pipefail
# Migration: v2.7.0 → v2.8.0
# Adds local-only repo guidance to orchestrator instructions and refreshes MCP metadata.
#
# Env provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — path to enterprise-copilot-fleet-controller checkout

[[ -z "${PROJECT_DIR:-}" ]] && echo "ERROR: PROJECT_DIR not set" && exit 1
[[ -z "${FRAMEWORK_DIR:-}" ]] && echo "ERROR: FRAMEWORK_DIR not set" && exit 1

echo "  → Refreshing orchestrator instructions for local-only repos..."

python3 - "$PROJECT_DIR" <<'PYEOF'
from pathlib import Path
import json
import sys

project_dir = Path(sys.argv[1])
instructions = project_dir / ".copilot" / "instructions.md"
if not instructions.exists():
    print("    .copilot/instructions.md not found — skipping")
    sys.exit(0)

content = instructions.read_text(encoding="utf-8")
updated = content

old_block = """## MCP Tools

MCP is disabled for this project (`project.enable_mcp: false`).
Set `project.enable_mcp: true` and run init again to generate `.copilot/mcp.json`.
"""
if old_block in updated:
    updated = updated.replace(old_block, "")

local_note = "Repos in `.repo-index.yml` may be local-only; when `visibility: local` is used, `remote_url` can be empty and the repo lives only on disk."
marker = "Each specialist is defined in `.github/agents/` and gets its own context window via /fleet.\n"
if local_note not in updated:
    if marker in updated:
        updated = updated.replace(marker, marker + "\n" + local_note + "\n", 1)
    else:
        updated = updated.rstrip() + "\n\n" + local_note + "\n"

if updated != content:
    instructions.write_text(updated, encoding="utf-8")
    print("    Updated .copilot/instructions.md")
else:
    print("    .copilot/instructions.md already up to date")

mcp_path = project_dir / ".copilot" / "mcp.json"
if mcp_path.exists():
    data = json.loads(mcp_path.read_text(encoding="utf-8"))
    if data.get("_framework_version") != "2.8.0":
        data["_framework_version"] = "2.8.0"
        mcp_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        print("    Updated .copilot/mcp.json")
PYEOF

echo "  ✓ Migration complete"
