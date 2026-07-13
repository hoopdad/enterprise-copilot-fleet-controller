#!/usr/bin/env python3
"""Cross-platform install/bootstrap for the fleet controller.

Creates the framework virtual environment (``.venv``) and installs the MCP tool
dependencies, using the correct interpreter layout for the current OS. Run this
once after cloning the framework, on either bash or PowerShell::

    python scripts/setup.py

It is safe to re-run: an existing venv is reused and dependencies are upgraded.
The thin wrappers ``scripts/setup.sh`` (bash) and ``scripts/setup.ps1``
(PowerShell) just call this file so there is one implementation to maintain.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import venv
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "init"))
from envinfo import detect, venv_dir, venv_python  # noqa: E402


def _framework_dir() -> Path:
    return Path(__file__).resolve().parents[1]


def ensure_venv(framework_dir: Path) -> Path:
    vdir = venv_dir(framework_dir)
    interpreter = Path(venv_python(framework_dir, posix=False))
    if not interpreter.exists():
        print(f"Creating virtual environment: {vdir.as_posix()}")
        venv.EnvBuilder(with_pip=True, clear=False, upgrade=False).create(str(vdir))
    else:
        print(f"Reusing virtual environment: {vdir.as_posix()}")
    if not interpreter.exists():
        raise SystemExit(f"ERROR: venv interpreter not found after creation: {interpreter}")
    return interpreter


def pip_install(interpreter: Path, requirements: Path) -> None:
    if not requirements.exists():
        print(f"WARNING: requirements file not found: {requirements}")
        return
    print(f"Installing dependencies from {requirements.name} ...")
    subprocess.run([str(interpreter), "-m", "pip", "install", "--upgrade", "pip"], check=True)
    subprocess.run([str(interpreter), "-m", "pip", "install", "-r", str(requirements)], check=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bootstrap the fleet-controller virtual environment")
    parser.add_argument("--framework-dir", type=Path, default=None)
    parser.add_argument("--no-deps", action="store_true", help="Create the venv but skip dependency install")
    args = parser.parse_args(argv)

    framework_dir = (args.framework_dir or _framework_dir()).resolve()

    print("Environment:")
    for key, value in detect(framework_dir).items():
        print(f"  {key} = {value}")
    print("")

    interpreter = ensure_venv(framework_dir)
    if not args.no_deps:
        pip_install(interpreter, framework_dir / "tools" / "requirements.txt")

    print("")
    print("Setup complete.")
    print(f"  Interpreter: {venv_python(framework_dir)}")
    print("Generated mcp.json files will use this interpreter automatically.")
    print("If you cloned a project from another OS, run: python scripts/adapt-env.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
