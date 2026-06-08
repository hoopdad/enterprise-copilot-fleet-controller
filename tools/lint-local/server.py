"""Lint Local MCP Server — safe, deterministic lint command execution."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage

mcp = FastMCP("lint-local")

_ALLOWED_LINTERS: dict[str, list[str]] = {
    "ruff": ["ruff", "check", "--output-format", "json"],
    "eslint": ["eslint", "--format", "json"],
    "golangci-lint": ["golangci-lint", "run", "--out-format", "json"],
    "shellcheck": ["shellcheck", "--format", "json1"],
}


def _error_payload(code: str, message: str, details: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    if details:
        payload["error"]["details"] = details
    return json.dumps(payload)


def _workspace_root() -> Path:
    project_dir = os.environ.get("PROJECT_DIR")
    return Path(project_dir).resolve() if project_dir else Path.cwd().resolve()


def _resolve_target(target: str) -> Path:
    root = _workspace_root()
    candidate = (root / target).resolve() if not Path(target).is_absolute() else Path(target).resolve()
    if os.path.commonpath([str(root), str(candidate)]) != str(root):
        raise ValueError("target must resolve inside the workspace")
    if not candidate.exists():
        raise FileNotFoundError(f"target not found: {candidate}")
    return candidate


def _run_command(command: list[str], timeout_seconds: int) -> tuple[int, str, str]:
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds)
    return result.returncode, result.stdout.strip(), result.stderr.strip()


@mcp.tool()
@track_usage("lint-local")
def run_local_lint(
    linter: str,
    target: str = ".",
    timeout_seconds: int = 120,
) -> str:
    """Run a supported linter locally with deterministic command construction."""
    if linter not in _ALLOWED_LINTERS:
        return _error_payload(
            "UNSUPPORTED_LINTER",
            f"Unsupported linter '{linter}'",
            {"allowed_linters": sorted(_ALLOWED_LINTERS.keys())},
        )

    if timeout_seconds < 1 or timeout_seconds > 600:
        return _error_payload("INVALID_TIMEOUT", "timeout_seconds must be between 1 and 600")

    try:
        resolved_target = _resolve_target(target)
    except Exception as exc:
        return _error_payload("INVALID_TARGET", str(exc), {"target": target})

    command = [*_ALLOWED_LINTERS[linter], str(resolved_target)]

    try:
        rc, stdout, stderr = _run_command(command, timeout_seconds=timeout_seconds)
    except FileNotFoundError:
        return _error_payload("LINTER_NOT_FOUND", f"Command not found: {command[0]}")
    except subprocess.TimeoutExpired:
        return _error_payload(
            "LINT_TIMEOUT",
            f"Linter timed out after {timeout_seconds}s",
            {"linter": linter},
        )
    except Exception as exc:
        return _error_payload("LINT_EXECUTION_FAILED", str(exc), {"linter": linter})

    return json.dumps(
        {
            "ok": True,
            "linter": linter,
            "target": str(resolved_target),
            "command": command,
            "exit_code": rc,
            "passed": rc == 0,
            "stdout": stdout,
            "stderr": stderr,
        }
    )


if __name__ == "__main__":
    mcp.run()
