#!/usr/bin/env python3
"""Python entrypoint for framework initialization."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def resolve_legacy_script() -> Path:
    script_dir = Path(__file__).resolve().parent
    return script_dir / "init-core.sh"


def run_legacy_init(argv: list[str]) -> int:
    legacy_script = resolve_legacy_script()
    if not legacy_script.exists():
        print(f"ERROR: missing legacy init script: {legacy_script}", file=sys.stderr)
        return 1

    cmd = ["bash", str(legacy_script), *argv]
    env = os.environ.copy()
    try:
        completed = subprocess.run(cmd, env=env, check=False)
    except OSError as exc:
        print(f"ERROR: failed to execute init core: {exc}", file=sys.stderr)
        return 1
    return int(completed.returncode)


def main() -> int:
    return run_legacy_init(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
