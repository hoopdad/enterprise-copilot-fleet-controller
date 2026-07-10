#!/usr/bin/env python3
"""Python orchestrator entrypoint for framework initialization."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def resolve_shell_engine() -> Path:
    script_dir = Path(__file__).resolve().parent
    return script_dir / "init-core.sh"


def snapshot_shell_engine(shell_engine: Path) -> tuple[Path, Path]:
    """Copy the shell engine and its helper library into a throwaway temp dir.

    An init run can take many minutes while it drives Copilot orchestrations.
    Bash reads a script incrementally by byte offset, so editing the source on
    disk mid-run (e.g. a ``git pull`` or an editor save) desynchronizes the
    parser and produces spurious "syntax error near unexpected token" failures.
    Running from an immutable snapshot makes an in-flight run immune to that.

    Returns ``(snapshot_engine_path, snapshot_root)``.
    """
    src_dir = shell_engine.parent
    snapshot_root = Path(tempfile.mkdtemp(prefix="fleet-init-core-"))
    shutil.copy2(shell_engine, snapshot_root / shell_engine.name)
    init_lib = src_dir / "init"
    if init_lib.is_dir():
        shutil.copytree(init_lib, snapshot_root / "init")
    return snapshot_root / shell_engine.name, snapshot_root


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

    # Framework assets (VERSION, templates/, skills/, patterns/) live at the repo
    # root; the snapshot only carries the executable scripts.
    framework_dir = shell_engine.parent.parent
    snapshot_engine, snapshot_root = snapshot_shell_engine(shell_engine)
    try:
        cmd = ["bash", str(snapshot_engine), "--start-phase", str(args.start_phase), "--end-phase", str(args.end_phase)]
        if args.config:
            cmd.extend(["--config", args.config])
        if args.auto_delete:
            cmd.append("--auto-delete")
        cmd.extend(args.shell_arg)

        env = os.environ.copy()
        env["INIT_FRAMEWORK_DIR"] = str(framework_dir)
        try:
            completed = subprocess.run(cmd, env=env, check=False)
        except OSError as exc:
            print(f"ERROR: failed to execute init core: {exc}", file=sys.stderr)
            return 1
        return int(completed.returncode)
    finally:
        shutil.rmtree(snapshot_root, ignore_errors=True)


def main() -> int:
    args = parse_args(sys.argv[1:])
    if args.start_phase < 0 or args.end_phase > 6 or args.start_phase > args.end_phase:
        print("ERROR: phase range must satisfy 0 <= start-phase <= end-phase <= 6", file=sys.stderr)
        return 1
    return run_shell_engine(args)


if __name__ == "__main__":
    raise SystemExit(main())
