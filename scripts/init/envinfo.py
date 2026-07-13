#!/usr/bin/env python3
"""Single source of truth for host-environment detection and venv layout.

The framework runs on both POSIX (bash) and Windows (PowerShell). The one
detail that differs between the two — and that must never drift between the
bash engine, the generated ``mcp.json``, and the PowerShell wrappers — is the
location of the project virtual-environment interpreter:

* POSIX:   ``<framework>/.venv/bin/python``
* Windows: ``<framework>/.venv/Scripts/python.exe``

Every consumer (init-core.sh preflight, common.sh mcp generation, adapt-env,
setup, and the PowerShell entrypoints) resolves the interpreter through this
module so there is exactly one implementation to maintain.

Usage as a library::

    from envinfo import venv_python, is_windows

Usage as a CLI (for bash/PowerShell callers)::

    python envinfo.py venv-python --framework-dir /path/to/framework
    python envinfo.py detect            # prints KEY=VALUE lines
    python envinfo.py venv-dir --framework-dir /path/to/framework
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from pathlib import Path


def is_windows() -> bool:
    """True when running on native Windows (not WSL/Cygwin/MSYS bash)."""
    return os.name == "nt"


def venv_bindir_name() -> str:
    """Name of the venv directory that holds executables for this OS."""
    return "Scripts" if is_windows() else "bin"


def python_exe_name() -> str:
    """Bare interpreter filename for this OS."""
    return "python.exe" if is_windows() else "python"


def venv_dir(framework_dir: Path | str) -> Path:
    """Absolute path to the framework's virtual environment root."""
    return Path(framework_dir).resolve() / ".venv"


def venv_python(framework_dir: Path | str, *, posix: bool | None = None) -> str:
    """Absolute path to the venv interpreter for this OS.

    ``posix=True`` forces forward-slash output (used for JSON like mcp.json so
    the value never needs backslash escaping and stays diff-friendly). Windows
    accepts forward slashes when a process is spawned, so this is safe.
    """
    interpreter = venv_dir(framework_dir) / venv_bindir_name() / python_exe_name()
    if posix is None:
        posix = True
    return interpreter.as_posix() if posix else str(interpreter)


def detect(framework_dir: Path | str | None = None) -> dict[str, str]:
    """Return a flat dict describing the current host environment."""
    info: dict[str, str] = {
        "os_name": os.name,
        "platform": platform.system(),
        "is_windows": "true" if is_windows() else "false",
        "venv_bindir": venv_bindir_name(),
        "python_exe": python_exe_name(),
        "shell": "powershell" if is_windows() else "bash",
    }
    if framework_dir is not None:
        fw = Path(framework_dir).resolve()
        info["framework_dir"] = fw.as_posix()
        info["venv_dir"] = venv_dir(fw).as_posix()
        info["venv_python"] = venv_python(fw)
        info["venv_python_exists"] = "true" if Path(venv_python(fw, posix=False)).exists() else "false"
    return info


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────
def _default_framework_dir() -> Path:
    # envinfo.py lives at <framework>/scripts/init/envinfo.py
    return Path(__file__).resolve().parents[2]


def cmd_venv_python(args: argparse.Namespace) -> int:
    fw = args.framework_dir or _default_framework_dir()
    print(venv_python(fw, posix=not args.native))
    return 0


def cmd_venv_dir(args: argparse.Namespace) -> int:
    fw = args.framework_dir or _default_framework_dir()
    print(venv_dir(fw).as_posix() if not args.native else str(venv_dir(fw)))
    return 0


def cmd_detect(args: argparse.Namespace) -> int:
    info = detect(args.framework_dir or _default_framework_dir())
    if args.json:
        print(json.dumps(info, indent=2))
    else:
        for key, value in info.items():
            print(f"{key}={value}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="envinfo", description="Host environment detection for the fleet controller")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("venv-python", help="Print the venv interpreter path for this OS")
    p.add_argument("--framework-dir", type=Path, default=None)
    p.add_argument("--native", action="store_true", help="Use native (backslash) separators instead of posix")
    p.set_defaults(func=cmd_venv_python)

    p = sub.add_parser("venv-dir", help="Print the venv root path")
    p.add_argument("--framework-dir", type=Path, default=None)
    p.add_argument("--native", action="store_true")
    p.set_defaults(func=cmd_venv_dir)

    p = sub.add_parser("detect", help="Print environment facts as KEY=VALUE lines")
    p.add_argument("--framework-dir", type=Path, default=None)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_detect)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
