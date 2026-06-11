#!/usr/bin/env python3
"""Python orchestrator entrypoint for framework initialization."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


def resolve_shell_engine() -> Path:
    script_dir = Path(__file__).resolve().parent
    return script_dir / "init-core.sh"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Initialize the enterprise copilot fleet controller project")
    parser.add_argument("-c", "--config", help="Path to init YAML config")
    parser.add_argument("-s", "--start-phase", type=int, default=0, help="Start phase (0-6)")
    parser.add_argument("-e", "--end-phase", type=int, default=6, help="End phase (0-6)")
    parser.add_argument("--auto-delete", action="store_true", help="Skip confirmation on fresh_start deletions")
    parser.add_argument("--shell-arg", action="append", default=[], help="Pass-through arg to shell engine")
    return parser.parse_args(argv)


def run_shell_engine(args: argparse.Namespace) -> int:
    shell_engine = resolve_shell_engine()
    if not shell_engine.exists():
        print(f"ERROR: missing init shell engine: {shell_engine}", file=sys.stderr)
        return 1

    cmd = ["bash", str(shell_engine), "--start-phase", str(args.start_phase), "--end-phase", str(args.end_phase)]
    if args.config:
        cmd.extend(["--config", args.config])
    if args.auto_delete:
        cmd.append("--auto-delete")
    cmd.extend(args.shell_arg)

    env = os.environ.copy()
    try:
        completed = subprocess.run(cmd, env=env, check=False)
    except OSError as exc:
        print(f"ERROR: failed to execute init core: {exc}", file=sys.stderr)
        return 1
    return int(completed.returncode)


def main() -> int:
    args = parse_args(sys.argv[1:])
    if args.start_phase < 0 or args.end_phase > 6 or args.start_phase > args.end_phase:
        print("ERROR: phase range must satisfy 0 <= start-phase <= end-phase <= 6", file=sys.stderr)
        return 1
    return run_shell_engine(args)


if __name__ == "__main__":
    raise SystemExit(main())
