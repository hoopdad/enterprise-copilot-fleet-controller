#!/usr/bin/env bash
set -euo pipefail
# Migration: v2.2.0 → v2.3.0
# Refreshes usage-tracker metadata and guidance for usage quality reporting.
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
    "Append usage events, summarize recent workflow activity, and report usage quality/anomalies."
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

if data.get("_framework_version") != "2.3.0":
    data["_framework_version"] = "2.3.0"
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

schema_section = """## Usage Metrics Schema (v2.3.0+)

When using `log_usage`, include enriched fields whenever known:
- `status`: `"success"` or `"failure"` for task/tool outcomes
- `duration_ms`: elapsed time for completed operations
- `run_id`/`event_id`/`parent_event_id`: keep correlation across delegations
- `origin`: use `"top_level"` for root work and `"nested"` for delegated flows
"""

quality_section = """## Usage Quality Reporting (v2.3.0+)

Use `get_usage_quality_report(days=7, min_events=20)` to review whether tool usage
looks correct and valuable. Pay attention to duplicate bursts, high failure rates,
nested-vs-top-level balance, and redacted evidence/examples.
"""

schema_pattern = r"\n## Usage Metrics Schema \(v2\.3\.0\+\)\n.*?(?=\n## |\Z)"
quality_pattern = r"\n## Usage Quality Reporting \(v2\.3\.0\+\)\n.*?(?=\n## |\Z)"

updated = content
if re.search(schema_pattern, updated, flags=re.DOTALL):
    updated = re.sub(schema_pattern, "\n" + schema_section.rstrip() + "\n", updated, flags=re.DOTALL)
else:
    anchor = "## Anti-Patterns"
    idx = updated.find(anchor)
    if idx >= 0:
        updated = updated[:idx].rstrip() + "\n\n" + schema_section.rstrip() + "\n\n" + updated[idx:]
    else:
        updated = updated.rstrip() + "\n\n" + schema_section.rstrip() + "\n"

if re.search(quality_pattern, updated, flags=re.DOTALL):
    updated = re.sub(quality_pattern, "\n" + quality_section.rstrip() + "\n", updated, flags=re.DOTALL)
else:
    anchor = "## Anti-Patterns"
    idx = updated.find(anchor)
    if idx >= 0:
        insert = "\n\n" + quality_section.rstrip() + "\n\n"
        if schema_section.rstrip() in updated[:idx]:
            updated = updated[:idx].rstrip() + "\n\n" + schema_section.rstrip() + insert + updated[idx:]
        else:
            updated = updated[:idx].rstrip() + "\n\n" + quality_section.rstrip() + "\n\n" + updated[idx:]
    else:
        updated = updated.rstrip() + "\n\n" + quality_section.rstrip() + "\n"

if updated != content:
    instructions_path.write_text(updated)
    print("    Updated .copilot/instructions.md usage guidance")
else:
    print("    Usage guidance already up to date")
PYEOF
fi

echo "  ✓ Migration complete"
