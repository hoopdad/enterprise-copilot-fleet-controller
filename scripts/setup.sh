#!/bin/bash
# scripts/setup.sh — bash entrypoint for the cross-platform venv bootstrap.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="${PYTHON:-python3}"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || PYTHON_BIN="python"
exec "$PYTHON_BIN" "$SCRIPT_DIR/setup.py" "$@"
