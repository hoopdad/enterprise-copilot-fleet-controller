"""Local deployment MCP Server — wraps azd provision + service deployment for word-game."""

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

DEFAULT_TIMEOUT_SECONDS = 600
OUTPUT_SNIPPET_CHARS = 2000
VALID_SERVICES = {"api", "agent", "web", "waf"}

mcp = FastMCP("deploy-local")


def _error_payload(code: str, message: str, details: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    if details:
        payload["error"]["details"] = details
    return json.dumps(payload)


def _dict_or_empty(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _list_or_empty(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def _truncate_output(value: str) -> tuple[str, bool]:
    if len(value) <= OUTPUT_SNIPPET_CHARS:
        return value, False
    return value[-OUTPUT_SNIPPET_CHARS:], True


def _workspace_root() -> Path:
    project_dir = os.environ.get("PROJECT_DIR", "").strip()
    if not project_dir:
        raise ValueError("PROJECT_DIR environment variable is required")

    root = Path(project_dir).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"PROJECT_DIR not found: {root}")
    return root


def _command_payload(
    *,
    command: list[str],
    cwd: Path,
    returncode: int,
    stdout: str,
    stderr: str,
    timed_out: bool = False,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    stdout_snippet, stdout_truncated = _truncate_output(stdout)
    stderr_snippet, stderr_truncated = _truncate_output(stderr)
    return {
        "command": command,
        "cwd": str(cwd),
        "exit_code": returncode,
        "success": returncode == 0 and not timed_out,
        "timed_out": timed_out,
        "timeout_seconds": timeout_seconds,
        "stdout": stdout_snippet,
        "stderr": stderr_snippet,
        "stdout_truncated": stdout_truncated,
        "stderr_truncated": stderr_truncated,
        "stdout_length": len(stdout),
        "stderr_length": len(stderr),
    }


def _run_command(command: list[str], cwd: Path, timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        return _command_payload(
            command=command,
            cwd=cwd,
            returncode=result.returncode,
            stdout=result.stdout or "",
            stderr=result.stderr or "",
            timeout_seconds=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
        stderr = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr or b"").decode(errors="replace")
        return _command_payload(
            command=command,
            cwd=cwd,
            returncode=-1,
            stdout=stdout,
            stderr=stderr or f"Command timed out after {timeout_seconds} seconds.",
            timed_out=True,
            timeout_seconds=timeout_seconds,
        )
    except FileNotFoundError as exc:
        return {
            "command": command,
            "cwd": str(cwd),
            "exit_code": -1,
            "success": False,
            "timed_out": False,
            "timeout_seconds": timeout_seconds,
            "stdout": "",
            "stderr": str(exc),
            "stdout_truncated": False,
            "stderr_truncated": False,
            "stdout_length": 0,
            "stderr_length": len(str(exc)),
        }


def _run_filtered_service_deploy(project_dir: Path, service: str) -> dict[str, Any]:
    # Delegate to the canonical deploy script (single source of truth) so that
    # per-service config never drifts. Running it as a real file keeps
    # ${BASH_SOURCE[0]} self-location working under `set -euo pipefail`.
    return _run_command(["bash", "scripts/azd-deploy.sh", service], cwd=project_dir)


def _resolve_resource_group(project_dir: Path) -> str:
    env_rg = os.environ.get("AZURE_RESOURCE_GROUP", "").strip()
    if env_rg:
        return env_rg

    tf_outputs = project_dir / ".azure" / "tf-outputs.json"
    if tf_outputs.is_file():
        try:
            payload = json.loads(tf_outputs.read_text())
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid tf outputs JSON at {tf_outputs}: {exc}") from exc
        resource_group = _dict_or_empty(payload.get("resource_group_name")).get("value")
        if isinstance(resource_group, str) and resource_group.strip():
            return resource_group.strip()

    env_result = _run_command(["azd", "env", "get-values"], cwd=project_dir, timeout_seconds=30)
    if env_result["success"]:
        for line in env_result["stdout"].splitlines():
            normalized = line.removeprefix("export ").strip()
            if normalized.startswith("AZURE_RESOURCE_GROUP="):
                value = normalized.split("=", 1)[1].strip().strip("'").strip('"')
                if value:
                    return value

    raise ValueError("Unable to resolve Azure resource group from tf outputs, azd env, or AZURE_RESOURCE_GROUP")


@mcp.tool()
@track_usage("deploy-local")
def deploy_all() -> str:
    """Run full azd deployment (provision + deploy) from word-game-harness."""
    try:
        project_dir = _workspace_root()
    except Exception as exc:
        return _error_payload("INVALID_PROJECT_DIR", str(exc))

    provision = _run_command(["azd", "provision", "--no-prompt"], cwd=project_dir)
    if not provision["success"]:
        return json.dumps(
            {
                "ok": False,
                "project_dir": str(project_dir),
                "step_failed": "provision",
                "provision": provision,
            }
        )

    deploy = _run_command(["bash", "scripts/azd-deploy.sh"], cwd=project_dir)
    return json.dumps(
        {
            "ok": deploy["success"],
            "project_dir": str(project_dir),
            "provision": provision,
            "deploy": deploy,
        }
    )


@mcp.tool()
@track_usage("deploy-local")
def deploy_provision_only() -> str:
    """Run only the infrastructure provisioning (terraform) step."""
    try:
        project_dir = _workspace_root()
    except Exception as exc:
        return _error_payload("INVALID_PROJECT_DIR", str(exc))

    result = _run_command(["azd", "provision", "--no-prompt"], cwd=project_dir)
    return json.dumps({"ok": result["success"], "project_dir": str(project_dir), "provision": result})


@mcp.tool()
@track_usage("deploy-local")
def deploy_services_only(service: str | None = None) -> str:
    """Run only the service deployment step (all services or one of api/agent/web/waf)."""
    try:
        project_dir = _workspace_root()
    except Exception as exc:
        return _error_payload("INVALID_PROJECT_DIR", str(exc))

    normalized_service = service.strip().lower() if isinstance(service, str) and service.strip() else None
    if normalized_service and normalized_service not in VALID_SERVICES:
        return _error_payload(
            "INVALID_SERVICE",
            f"service must be one of {sorted(VALID_SERVICES)}",
            {"service": service},
        )

    try:
        if normalized_service:
            result = _run_filtered_service_deploy(project_dir, normalized_service)
        else:
            result = _run_command(["bash", "scripts/azd-deploy.sh"], cwd=project_dir)
    except Exception as exc:
        return _error_payload("DEPLOY_SCRIPT_ERROR", str(exc), {"service": normalized_service})

    return json.dumps(
        {
            "ok": result["success"],
            "project_dir": str(project_dir),
            "service": normalized_service,
            "deploy": result,
        }
    )


@mcp.tool()
@track_usage("deploy-local")
def deploy_status() -> str:
    """Check current deployment status of all services."""
    try:
        project_dir = _workspace_root()
        resource_group = _resolve_resource_group(project_dir)
    except Exception as exc:
        return _error_payload("RESOURCE_GROUP_RESOLUTION_FAILED", str(exc))

    try:
        result = subprocess.run(
            ["az", "containerapp", "list", "--resource-group", resource_group, "-o", "json", "--only-show-errors"],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return _error_payload(
            "AZURE_STATUS_TIMEOUT",
            "az containerapp list timed out after 60 seconds",
            {"resource_group": resource_group},
        )
    except FileNotFoundError:
        return _error_payload("AZURE_CLI_NOT_FOUND", "az command not found")

    if result.returncode != 0:
        return json.dumps(
            {
                "ok": False,
                "project_dir": str(project_dir),
                "resource_group": resource_group,
                "command": _command_payload(
                    command=["az", "containerapp", "list", "--resource-group", resource_group, "-o", "json", "--only-show-errors"],
                    cwd=project_dir,
                    returncode=result.returncode,
                    stdout=result.stdout or "",
                    stderr=result.stderr or "",
                    timeout_seconds=60,
                ),
            }
        )

    try:
        payload = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as exc:
        stdout_snippet, _ = _truncate_output(result.stdout or "")
        stderr_snippet, _ = _truncate_output(result.stderr or "")
        return _error_payload(
            "INVALID_AZURE_RESPONSE",
            f"Unable to parse az containerapp list output: {exc}",
            {"resource_group": resource_group, "stdout": stdout_snippet, "stderr": stderr_snippet},
        )

    apps: list[dict[str, Any]] = []
    for item in _list_or_empty(payload):
        if not isinstance(item, dict):
            continue
        properties = _dict_or_empty(item.get("properties"))
        configuration = _dict_or_empty(properties.get("configuration"))
        ingress = _dict_or_empty(configuration.get("ingress"))
        template = _dict_or_empty(properties.get("template"))
        containers = _list_or_empty(template.get("containers"))
        first_container = containers[0] if containers and isinstance(containers[0], dict) else {}
        running_status = properties.get("runningStatus")
        running_state = (
            running_status.get("state")
            if isinstance(running_status, dict)
            else running_status
        )
        apps.append(
            {
                "name": item.get("name"),
                "resource_group": item.get("resourceGroup"),
                "provisioning_state": properties.get("provisioningState"),
                "running_state": running_state,
                "latest_revision": properties.get("latestRevisionName"),
                "latest_ready_revision": properties.get("latestReadyRevisionName"),
                "fqdn": ingress.get("fqdn"),
                "external": ingress.get("external"),
                "target_port": ingress.get("targetPort"),
                "image": first_container.get("image") if isinstance(first_container, dict) else None,
            }
        )

    return json.dumps(
        {
            "ok": True,
            "project_dir": str(project_dir),
            "resource_group": resource_group,
            "services": apps,
            "service_count": len(apps),
        }
    )


if __name__ == "__main__":
    mcp.run()
