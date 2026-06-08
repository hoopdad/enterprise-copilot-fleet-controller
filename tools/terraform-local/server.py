"""Terraform Local MCP Server — safe local init/validate/fmt/plan checks."""

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

mcp = FastMCP("terraform-local")


def _error_payload(code: str, message: str, details: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    if details:
        payload["error"]["details"] = details
    return json.dumps(payload)


def _workspace_root() -> Path:
    project_dir = os.environ.get("PROJECT_DIR")
    return Path(project_dir).resolve() if project_dir else Path.cwd().resolve()


def _resolve_dir(terraform_dir: str) -> Path:
    root = _workspace_root()
    directory = (root / terraform_dir).resolve() if not Path(terraform_dir).is_absolute() else Path(terraform_dir).resolve()
    if os.path.commonpath([str(root), str(directory)]) != str(root):
        raise ValueError("terraform_dir must resolve inside the workspace")
    if not directory.is_dir():
        raise FileNotFoundError(f"terraform_dir not found: {directory}")
    if not list(directory.glob("*.tf")):
        raise ValueError(f"No .tf files found in {directory}")
    return directory


def _run_terraform(args: list[str], cwd: Path, timeout_seconds: int = 180) -> tuple[int, str, str]:
    result = subprocess.run(
        ["terraform", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


@mcp.tool()
@track_usage("terraform-local")
def terraform_init_validate(terraform_dir: str = ".", timeout_seconds: int = 240) -> str:
    """Run deterministic terraform init (backend disabled) followed by validate."""
    if timeout_seconds < 1 or timeout_seconds > 1800:
        return _error_payload("INVALID_TIMEOUT", "timeout_seconds must be between 1 and 1800")

    try:
        directory = _resolve_dir(terraform_dir)
    except Exception as exc:
        return _error_payload("INVALID_TERRAFORM_DIR", str(exc), {"terraform_dir": terraform_dir})

    try:
        init_rc, init_out, init_err = _run_terraform(
            ["init", "-backend=false", "-input=false", "-no-color"],
            cwd=directory,
            timeout_seconds=timeout_seconds,
        )
        if init_rc != 0:
            return _error_payload(
                "TERRAFORM_INIT_FAILED",
                "terraform init failed",
                {"exit_code": init_rc, "stdout": init_out, "stderr": init_err},
            )

        val_rc, val_out, val_err = _run_terraform(
            ["validate", "-no-color"],
            cwd=directory,
            timeout_seconds=timeout_seconds,
        )
        return json.dumps(
            {
                "ok": True,
                "terraform_dir": str(directory),
                "init": {"exit_code": init_rc, "stdout": init_out, "stderr": init_err},
                "validate": {
                    "exit_code": val_rc,
                    "valid": val_rc == 0,
                    "stdout": val_out,
                    "stderr": val_err,
                },
            }
        )
    except FileNotFoundError:
        return _error_payload("TERRAFORM_NOT_FOUND", "terraform command not found")
    except subprocess.TimeoutExpired:
        return _error_payload("TERRAFORM_TIMEOUT", f"terraform command timed out after {timeout_seconds}s")
    except Exception as exc:
        return _error_payload("TERRAFORM_EXECUTION_FAILED", str(exc))


@mcp.tool()
@track_usage("terraform-local")
def terraform_fmt_check(terraform_dir: str = ".", timeout_seconds: int = 120) -> str:
    """Run non-mutating terraform fmt checks."""
    try:
        directory = _resolve_dir(terraform_dir)
    except Exception as exc:
        return _error_payload("INVALID_TERRAFORM_DIR", str(exc), {"terraform_dir": terraform_dir})

    try:
        rc, out, err = _run_terraform(
            ["fmt", "-check", "-recursive", "-diff", "-no-color"],
            cwd=directory,
            timeout_seconds=timeout_seconds,
        )
        return json.dumps(
            {
                "ok": True,
                "terraform_dir": str(directory),
                "exit_code": rc,
                "properly_formatted": rc == 0,
                "stdout": out,
                "stderr": err,
            }
        )
    except FileNotFoundError:
        return _error_payload("TERRAFORM_NOT_FOUND", "terraform command not found")
    except subprocess.TimeoutExpired:
        return _error_payload("TERRAFORM_TIMEOUT", f"terraform fmt timed out after {timeout_seconds}s")
    except Exception as exc:
        return _error_payload("TERRAFORM_EXECUTION_FAILED", str(exc))


@mcp.tool()
@track_usage("terraform-local")
def terraform_plan_check(terraform_dir: str = ".", timeout_seconds: int = 300) -> str:
    """Run local terraform plan with refresh disabled for deterministic checks."""
    try:
        directory = _resolve_dir(terraform_dir)
    except Exception as exc:
        return _error_payload("INVALID_TERRAFORM_DIR", str(exc), {"terraform_dir": terraform_dir})

    try:
        rc, out, err = _run_terraform(
            [
                "plan",
                "-input=false",
                "-refresh=false",
                "-lock=false",
                "-detailed-exitcode",
                "-no-color",
            ],
            cwd=directory,
            timeout_seconds=timeout_seconds,
        )

        if rc not in (0, 1, 2):
            return _error_payload(
                "UNEXPECTED_PLAN_EXIT",
                "terraform plan returned an unexpected exit code",
                {"exit_code": rc, "stdout": out, "stderr": err},
            )

        return json.dumps(
            {
                "ok": True,
                "terraform_dir": str(directory),
                "exit_code": rc,
                "changes_present": rc == 2,
                "plan_succeeded": rc in (0, 2),
                "stdout": out,
                "stderr": err,
            }
        )
    except FileNotFoundError:
        return _error_payload("TERRAFORM_NOT_FOUND", "terraform command not found")
    except subprocess.TimeoutExpired:
        return _error_payload("TERRAFORM_TIMEOUT", f"terraform plan timed out after {timeout_seconds}s")
    except Exception as exc:
        return _error_payload("TERRAFORM_EXECUTION_FAILED", str(exc))


if __name__ == "__main__":
    mcp.run()
