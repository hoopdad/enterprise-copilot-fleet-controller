#!/bin/bash
# scripts/adapt-env.sh — bash entrypoint to adapt a cloned project's mcp.json
# files to the current host environment (framework location + venv interpreter).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="${PYTHON:-python3}"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || PYTHON_BIN="python"
exec "$PYTHON_BIN" "$SCRIPT_DIR/adapt-env.py" "$@"
