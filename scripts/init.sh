#!/bin/bash
# scripts/init.sh — thin wrapper for Python init entrypoint

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="${PYTHON:-python3}"

exec "$PYTHON_BIN" "$SCRIPT_DIR/init.py" "$@"
