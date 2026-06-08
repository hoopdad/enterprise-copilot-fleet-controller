#!/usr/bin/env bash
set -euo pipefail
# Migration: v2.4.0 → v2.5.0
# Adds new MCP tool registrations and refreshes orchestrator tool guidance.
#
# Env provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — path to enterprise-copilot-fleet-controller checkout

[[ -z "${PROJECT_DIR:-}" ]] && echo "ERROR: PROJECT_DIR not set" && exit 1
[[ -z "${FRAMEWORK_DIR:-}" ]] && echo "ERROR: FRAMEWORK_DIR not set" && exit 1

echo "  → Refreshing MCP tool registrations..."

if [[ -f "$PROJECT_DIR/.copilot/mcp.json" ]]; then
  python3 - "$PROJECT_DIR/.copilot/mcp.json" "$PROJECT_DIR" "$FRAMEWORK_DIR" <<'PYEOF'
import json
import sys
from pathlib import Path

mcp_path = Path(sys.argv[1])
project_dir = Path(sys.argv[2])
framework_dir = Path(sys.argv[3])
project_name = project_dir.name

with mcp_path.open() as f:
    data = json.load(f)

servers_key = "mcpServers" if isinstance(data.get("mcpServers"), dict) else "servers"
servers = data.get(servers_key, {})
if not isinstance(servers, dict):
    servers = {}
    data[servers_key] = servers

expected = {
    "azure-resource-status": {
        "description": "Inventory Azure resources and inspect status/error events for troubleshooting.",
        "command": "python3",
        "args": [f"{framework_dir}/tools/azure-resource-status/server.py"],
        "env": {"PROJECT_DIR": str(project_dir)},
    },
    "lint-local": {
        "description": "Run safe local lint commands (ruff/eslint/golangci-lint/shellcheck).",
        "command": "python3",
        "args": [f"{framework_dir}/tools/lint-local/server.py"],
        "env": {"PROJECT_DIR": str(project_dir)},
    },
    "terraform-local": {
        "description": "Run deterministic local terraform fmt/init/validate/plan checks.",
        "command": "python3",
        "args": [f"{framework_dir}/tools/terraform-local/server.py"],
        "env": {"PROJECT_DIR": str(project_dir)},
    },
}

changed = False
for name, definition in expected.items():
    current = servers.get(name)
    if current != definition:
        servers[name] = definition
        changed = True
        print(f"    Upserted {name}")

usage_tracker = servers.get("usage-tracker")
if isinstance(usage_tracker, dict):
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

if data.get("_framework_version") != "2.5.0":
    data["_framework_version"] = "2.5.0"
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
  echo "    mcp.json not found (MCP disabled) — skipping"
fi

echo "  → Refreshing orchestrator MCP guidance..."

if [[ -f "$PROJECT_DIR/.copilot/instructions.md" ]]; then
  python3 - "$PROJECT_DIR/.copilot/instructions.md" <<'PYEOF'
import re
import sys
from pathlib import Path

instructions_path = Path(sys.argv[1])
content = instructions_path.read_text()

mcp_section = """## MCP Tools

| Tool | When to Use |
|------|-------------|
| `check_all_contracts` | Before merge to catch contract drift across all providers |
| `check_contract_compliance` | Validate one provider repo against one contract's routes |
| `run_local_lint` | Fast local lint pass before test/build or before delegating a fix back |
| `terraform_fmt_check` / `terraform_init_validate` / `terraform_plan_check` | Infra changes: formatting, validation, and plan safety checks before PR |
| `list_azure_resources` / `get_azure_status` / `find_error` | Infra incidents: inspect Azure inventory, runtime status, and recent failure events |
| `inspect_container_app` / `inspect_cosmos` / `inspect_acr` | Deep Azure diagnostics when one service needs focused investigation |
| `sync_submodules` | After child repo commits to update parent gitlink SHAs |
| `check_ci_status` | After push/PR update to inspect failing workflows quickly |
| `verify_deployment` | After CD to verify health/version endpoints are reachable |
| `security_scan` | Before final merge/deploy to consolidate security findings from available scanners |
| `orchestrate_release` / `create_prs` / `wait_for_ci` / `auto_merge_prs` | Multi-repo release flow when coordinating commit→PR→CI→merge handoff |
| `log_usage` | Record orchestration events with status + timing metadata for correlation |
| `get_usage_quality_report` | Review usage quality, anomalies, and value signals from `.metrics/usage.jsonl` |
"""

usage_schema_section = """## Usage Metrics Schema (v2.5.0+)

When using `log_usage`, include enriched fields whenever known:
- `status`: `"success"` or `"failure"` for task/tool outcomes
- `duration_ms`: elapsed time for completed operations
- `run_id`/`event_id`/`parent_event_id`: keep correlation across delegations
- `origin`: use `"top_level"` for root work and `"nested"` for delegated flows
"""

usage_quality_section = """## Usage Quality Reporting (v2.5.0+)

Use `get_usage_quality_report(days=7, min_events=20)` to review whether tool usage
looks correct and valuable. Pay attention to duplicate bursts, high failure rates,
nested-vs-top-level balance, and redacted evidence/examples.
"""

def upsert_section(text: str, heading_regex: str, replacement: str) -> str:
    pattern = rf"\n{heading_regex}\n.*?(?=\n## |\Z)"
    if re.search(pattern, text, flags=re.DOTALL):
        return re.sub(pattern, "\n" + replacement.rstrip() + "\n", text, flags=re.DOTALL)
    anchor = "## Anti-Patterns"
    idx = text.find(anchor)
    if idx >= 0:
        return text[:idx].rstrip() + "\n\n" + replacement.rstrip() + "\n\n" + text[idx:]
    return text.rstrip() + "\n\n" + replacement.rstrip() + "\n"

updated = content
updated = upsert_section(updated, r"## MCP Tools", mcp_section)
updated = upsert_section(updated, r"## Usage Metrics Schema \(v[0-9]+\.[0-9]+\.[0-9]+\+\)", usage_schema_section)
updated = upsert_section(updated, r"## Usage Quality Reporting \(v[0-9]+\.[0-9]+\.[0-9]+\+\)", usage_quality_section)

if updated != content:
    instructions_path.write_text(updated)
    print("    Updated orchestrator tool guidance")
else:
    print("    Orchestrator guidance already up to date")
PYEOF
else
  echo "    .copilot/instructions.md not found — skipping"
fi

echo "  ✓ Migration complete"
