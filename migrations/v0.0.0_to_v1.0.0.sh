#!/bin/bash
# Migration: v0.0.0 → v1.0.0
# Purpose: Bring pre-versioning projects up to v1.0.0 baseline
#
# This migration handles projects that were initialized before the versioning
# system was added. It adds the missing version stamp and ensures the mcp.json
# includes the _framework_version field.
#
# Environment variables provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — the framework repo root

set -euo pipefail

log() { echo "    $*"; }

# 1. Ensure .framework-version exists (upgrade.sh will write the final value)
log "Adding .framework-version file"

# 2. Add _framework_version to mcp.json if it exists but lacks it
if [[ -f "$PROJECT_DIR/.copilot/mcp.json" ]]; then
  if ! grep -q "_framework_version" "$PROJECT_DIR/.copilot/mcp.json"; then
    log "Adding _framework_version to .copilot/mcp.json"
    # Insert version field after opening brace
    if command -v python3 &>/dev/null; then
      python3 - "$PROJECT_DIR/.copilot/mcp.json" "1.0.0" << 'PYEOF'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data = {"_framework_version": version, **data}
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PYEOF
    else
      log "  (skipped — python3 not available for JSON manipulation)"
    fi
  else
    log ".copilot/mcp.json already has version field"
  fi
fi

# 3. Add version comment to orchestrator.md if missing
if [[ -f "$PROJECT_DIR/.agents/orchestrator.md" ]]; then
  if ! grep -q "enterprise-copilot-fleet-controller v" "$PROJECT_DIR/.agents/orchestrator.md"; then
    log "Adding version stamp to orchestrator.md"
    sed -i '1i <!-- enterprise-copilot-fleet-controller v1.0.0 -->' "$PROJECT_DIR/.agents/orchestrator.md"
  fi
fi

# 4. Add version comment to specialist files if missing
if [[ -d "$PROJECT_DIR/.agents/specialists" ]]; then
  for spec_file in "$PROJECT_DIR/.agents/specialists"/*.yml; do
    [[ -f "$spec_file" ]] || continue
    if ! grep -q "enterprise-copilot-fleet-controller v" "$spec_file"; then
      log "Adding version stamp to $(basename "$spec_file")"
      sed -i '1i # enterprise-copilot-fleet-controller v1.0.0' "$spec_file"
    fi
  done
fi

log "Migration v0.0.0 → v1.0.0 complete"
