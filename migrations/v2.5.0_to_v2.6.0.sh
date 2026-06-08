#!/usr/bin/env bash
set -euo pipefail
# Migration: v2.5.0 → v2.6.0
# Adds optional feature guidance to orchestrator instructions.
#
# Env provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — path to enterprise-copilot-fleet-controller checkout

[[ -z "${PROJECT_DIR:-}" ]] && echo "ERROR: PROJECT_DIR not set" && exit 1

echo "  → Refreshing optional feature guidance..."

if [[ -f "$PROJECT_DIR/.copilot/mcp.json" ]]; then
  python3 - "$PROJECT_DIR/.copilot/mcp.json" <<'PYEOF'
import json
import sys
from pathlib import Path

mcp_path = Path(sys.argv[1])
with mcp_path.open() as f:
    data = json.load(f)

if data.get("_framework_version") != "2.6.0":
    data["_framework_version"] = "2.6.0"
    with mcp_path.open("w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print("    Updated .copilot/mcp.json framework metadata")
else:
    print("    MCP framework metadata already up to date")
PYEOF
else
  echo "    .copilot/mcp.json not found (MCP disabled) — skipping"
fi

if [[ -f "$PROJECT_DIR/.copilot/instructions.md" ]]; then
  python3 - "$PROJECT_DIR/.copilot/instructions.md" <<'PYEOF'
import re
import sys
from pathlib import Path

instructions_path = Path(sys.argv[1])
content = instructions_path.read_text()

optional_section = """## Optional Features

These features are configured in `optional_features` in `init.yml`.

| Feature | Enabled | Notes |
|---------|---------|-------|
| mobile_ci_cd | false | Generate mobile CI/CD workflow templates under `.copilot/workflow-templates/` |
| runner_self_heal | false | Add prerequisite self-healing blocks in workflow templates |
| semantic_release | false | Add semantic versioning release job in CI template |
| onboarding_docs | false | Generate `.copilot/docs/developer-onboarding.md` |
| portability_blueprints | false | Generate `.copilot/docs/portability-blueprint.md` |

Do not assume artifacts for disabled features exist.
- If `mobile_ci_cd: false`, do not reference CI/CD workflow templates.
- If `onboarding_docs: false`, do not reference `.copilot/docs/developer-onboarding.md`.
- If `portability_blueprints: false`, do not reference `.copilot/docs/portability-blueprint.md`.
"""

pattern = r"\n## Optional Features\n.*?(?=\n## |\Z)"
if re.search(pattern, content, flags=re.DOTALL):
    updated = re.sub(pattern, "\n" + optional_section.rstrip() + "\n", content, flags=re.DOTALL)
else:
    anchor = "## Your Protocol"
    idx = content.find(anchor)
    if idx >= 0:
        updated = content[:idx].rstrip() + "\n\n" + optional_section.rstrip() + "\n\n" + content[idx:]
    else:
        updated = content.rstrip() + "\n\n" + optional_section.rstrip() + "\n"

if updated != content:
    instructions_path.write_text(updated)
    print("    Updated .copilot/instructions.md")
else:
    print("    Optional feature guidance already up to date")
PYEOF
else
  echo "    .copilot/instructions.md not found — skipping"
fi

echo "  ✓ Migration complete"
