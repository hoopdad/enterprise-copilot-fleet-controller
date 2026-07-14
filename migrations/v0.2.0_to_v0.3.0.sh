#!/usr/bin/env bash
# Migration v0.2.0 → v0.3.0
# Makes existing projects cross-platform (bash + PowerShell) ready:
#   1. Re-root .github/mcp.json (parent + children) at THIS framework checkout and
#      THIS OS's venv interpreter via scripts/adapt-env.py. This fixes projects
#      that were initialized on one OS and are now used on another (e.g. the
#      Linux `.venv/bin/python` path -> Windows `.venv/Scripts/python.exe`).
#
# Idempotent + deterministic. Receives $PROJECT_DIR and $FRAMEWORK_DIR.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:?PROJECT_DIR is required}"
FRAMEWORK_DIR="${FRAMEWORK_DIR:?FRAMEWORK_DIR is required}"

info() { printf '[migrate 0.2.0→0.3.0] %s\n' "$*"; }

# Pick an available Python interpreter (python3 preferred, then python).
PY=""
command -v python3 >/dev/null 2>&1 && PY="python3"
[[ -z "$PY" ]] && command -v python >/dev/null 2>&1 && PY="python"

ADAPT="$FRAMEWORK_DIR/scripts/adapt-env.py"
if [[ -n "$PY" && -f "$ADAPT" && -f "$PROJECT_DIR/.github/mcp.json" ]]; then
  info "adapting .github/mcp.json to this environment (framework + OS interpreter)"
  # --commit: parent and each child are separate git repos, so a later parent-only
  # upgrade commit would leave child mcp.json changes uncommitted. Commit each here.
  "$PY" "$ADAPT" --project-dir "$PROJECT_DIR" --framework-dir "$FRAMEWORK_DIR" --commit || \
    info "adapt-env reported an issue; review .github/mcp.json manually"
else
  info "skipped mcp.json adapt (no Python or no mcp.json present)"
fi

info "migration complete"
exit 0
