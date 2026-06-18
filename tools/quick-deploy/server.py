"""Quick Deploy MCP Server — commit, build, deploy, verify a single service in one call.

Replaces the repetitive manual cycle:
  git add + commit + push → az acr build → az containerapp update → revision health check
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import sys
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage

mcp = FastMCP("quick-deploy")

DEFAULT_TIMEOUT = 300  # 5 min for ACR builds
HEALTH_POLL_INTERVAL = 10
HEALTH_POLL_MAX = 60  # wait up to 60s for healthy

SERVICES = {
    "web": {
        "repo": "word-game-web",
        "container_app": "word-game-web",
        "dockerfile": "Dockerfile",
        "target_port": 80,
    },
    "api": {
        "repo": "word-game-api",
        "container_app": "word-game-api",
        "dockerfile": "Dockerfile",
        "target_port": 8000,
    },
    "agent": {
        "repo": "word-game-agent",
        "container_app": "word-game-agent",
        "dockerfile": "Dockerfile",
        "target_port": 8000,
    },
    "waf": {
        "repo": "word-game-waf",
        "container_app": "word-game-waf",
        "dockerfile": "docker/Dockerfile",
        "target_port": 443,
    },
}

# Build args per service (web needs MSAL + Vite vars baked in)
WEB_BUILD_ARGS = [
    "VITE_API_BASE_URL=/api",
    "VITE_WS_URL=",
    "VITE_MSAL_CLIENT_ID=b4d29652-ff30-43ea-90f6-830cc340f866",
    "VITE_MSAL_AUTHORITY=https://login.microsoftonline.com/d52a6857-5f44-4f8f-bcc8-420952d3225d",
    "VITE_MSAL_API_CLIENT_ID=16f3fd41-cddd-44fb-a149-14314e62f7a8",
]


def _workspace_root() -> Path:
    project_dir = os.environ.get("PROJECT_DIR", "").strip()
    if not project_dir:
        raise ValueError("PROJECT_DIR environment variable is required")
    root = Path(project_dir).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"PROJECT_DIR not found: {root}")
    return root


def _run(cmd: list[str], cwd: Path, timeout: int = DEFAULT_TIMEOUT) -> dict[str, Any]:
    try:
        result = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)
        return {"ok": result.returncode == 0, "stdout": result.stdout[-2000:], "stderr": result.stderr[-2000:], "code": result.returncode}
    except subprocess.TimeoutExpired:
        return {"ok": False, "stdout": "", "stderr": f"Timed out after {timeout}s", "code": -1}
    except FileNotFoundError as e:
        return {"ok": False, "stdout": "", "stderr": str(e), "code": -1}


def _resolve_config(project_dir: Path) -> dict[str, str]:
    """Load ACR and resource group from terraform outputs."""
    tf_file = project_dir / ".azure" / "tf-outputs.json"
    if not tf_file.is_file():
        raise FileNotFoundError(f"tf-outputs.json not found at {tf_file}")
    data = json.loads(tf_file.read_text())
    return {
        "rg": data["resource_group_name"]["value"],
        "acr": data["acr_login_server"]["value"].split(".")[0],
        "acr_server": data["acr_login_server"]["value"],
    }


@mcp.tool()
@track_usage("quick-deploy")
def quick_deploy(
    service: str,
    commit_message: str | None = None,
    skip_commit: bool = False,
    skip_push: bool = False,
) -> str:
    """Commit, build, deploy, and verify a single service in one shot.

    Args:
        service: One of web, api, agent, waf
        commit_message: Git commit message (required unless skip_commit=True)
        skip_commit: Skip git commit (use existing HEAD)
        skip_push: Skip git push (already pushed)
    """
    if service not in SERVICES:
        return json.dumps({"ok": False, "error": f"service must be one of {list(SERVICES.keys())}"})

    svc = SERVICES[service]
    steps: list[dict[str, Any]] = []

    try:
        project_dir = _workspace_root()
        config = _resolve_config(project_dir)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})

    repo_dir = project_dir.parent / svc["repo"]
    if not repo_dir.is_dir():
        return json.dumps({"ok": False, "error": f"Repo not found: {repo_dir}"})

    # Step 1: Commit
    if not skip_commit:
        if not commit_message:
            return json.dumps({"ok": False, "error": "commit_message required (or set skip_commit=True)"})

        # Add all changes
        add_result = _run(["git", "add", "-A"], cwd=repo_dir, timeout=30)
        if not add_result["ok"]:
            return json.dumps({"ok": False, "step": "git_add", "detail": add_result})

        # Check if there's anything to commit
        status = _run(["git", "status", "--porcelain"], cwd=repo_dir, timeout=10)
        if status["ok"] and not status["stdout"].strip():
            steps.append({"step": "commit", "status": "skipped", "reason": "nothing to commit"})
        else:
            full_msg = f"{commit_message}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
            commit_result = _run(["git", "commit", "-m", full_msg], cwd=repo_dir, timeout=30)
            if not commit_result["ok"]:
                return json.dumps({"ok": False, "step": "commit", "detail": commit_result})
            steps.append({"step": "commit", "status": "done"})

    # Step 2: Push
    if not skip_push:
        branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo_dir, timeout=10)
        branch_name = branch["stdout"].strip() if branch["ok"] else "feature/azd-deploy"
        push_result = _run(["git", "push", "origin", branch_name], cwd=repo_dir, timeout=60)
        if not push_result["ok"]:
            return json.dumps({"ok": False, "step": "push", "detail": push_result})
        steps.append({"step": "push", "status": "done", "branch": branch_name})

    # Get image tag from HEAD
    tag_result = _run(["git", "rev-parse", "--short", "HEAD"], cwd=repo_dir, timeout=10)
    if not tag_result["ok"]:
        return json.dumps({"ok": False, "step": "get_tag", "detail": tag_result})
    image_tag = tag_result["stdout"].strip()
    image_ref = f"{config['acr_server']}/{svc['repo']}:{image_tag}"

    # Step 3: Build image in ACR
    build_cmd = [
        "az", "acr", "build",
        "--registry", config["acr"],
        "--image", f"{svc['repo']}:{image_tag}",
        "--file", str(repo_dir / svc["dockerfile"]),
    ]

    # Add build args for web service
    if service == "web":
        for arg in WEB_BUILD_ARGS:
            build_cmd.extend(["--build-arg", arg])

    build_cmd.append(str(repo_dir))

    build_result = _run(build_cmd, cwd=project_dir, timeout=DEFAULT_TIMEOUT)
    if not build_result["ok"]:
        return json.dumps({"ok": False, "step": "acr_build", "image": image_ref, "detail": build_result})
    steps.append({"step": "acr_build", "status": "done", "image": image_ref})

    # Step 4: Deploy to Container App
    deploy_cmd = [
        "az", "containerapp", "update",
        "--name", svc["container_app"],
        "--resource-group", config["rg"],
        "--image", image_ref,
        "--query", "properties.latestRevisionName",
        "-o", "tsv",
    ]
    deploy_result = _run(deploy_cmd, cwd=project_dir, timeout=120)
    if not deploy_result["ok"]:
        return json.dumps({"ok": False, "step": "deploy", "detail": deploy_result})
    revision = deploy_result["stdout"].strip()
    steps.append({"step": "deploy", "status": "done", "revision": revision})

    # Step 5: Wait for healthy
    healthy = False
    for _ in range(HEALTH_POLL_MAX // HEALTH_POLL_INTERVAL):
        time.sleep(HEALTH_POLL_INTERVAL)
        check = _run([
            "az", "containerapp", "revision", "show",
            "--name", svc["container_app"],
            "--resource-group", config["rg"],
            "--revision", revision,
            "--query", "properties.runningState",
            "-o", "tsv",
        ], cwd=project_dir, timeout=30)
        state = check["stdout"].strip()
        if state == "Running":
            healthy = True
            break
        if state == "Failed":
            break

    steps.append({"step": "health_check", "status": "healthy" if healthy else "unhealthy", "revision": revision})

    # Step 6: Run verification scripts (non-blocking)
    if healthy and service == "web":
        verify = _run(["bash", "scripts/check-msal-config.sh"], cwd=project_dir, timeout=60)
        steps.append({"step": "msal_verify", "status": "pass" if verify["ok"] else "fail"})

    return json.dumps({
        "ok": healthy,
        "service": service,
        "image": image_ref,
        "revision": revision,
        "steps": steps,
    })


@mcp.tool()
@track_usage("quick-deploy")
def quick_deploy_status(service: str) -> str:
    """Check current deployment status of a single service.

    Args:
        service: One of web, api, agent, waf
    """
    if service not in SERVICES:
        return json.dumps({"ok": False, "error": f"service must be one of {list(SERVICES.keys())}"})

    svc = SERVICES[service]
    try:
        project_dir = _workspace_root()
        config = _resolve_config(project_dir)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})

    result = _run([
        "az", "containerapp", "show",
        "--name", svc["container_app"],
        "--resource-group", config["rg"],
        "-o", "json", "--only-show-errors",
    ], cwd=project_dir, timeout=30)

    if not result["ok"]:
        return json.dumps({"ok": False, "error": "Failed to query container app", "detail": result})

    try:
        app = json.loads(result["stdout"])
    except json.JSONDecodeError:
        return json.dumps({"ok": False, "error": "Invalid JSON from az CLI"})

    props = app.get("properties", {})
    config_data = props.get("configuration", {})
    ingress = config_data.get("ingress", {})
    containers = props.get("template", {}).get("containers", [])
    image = containers[0].get("image") if containers else None

    return json.dumps({
        "ok": True,
        "service": service,
        "container_app": svc["container_app"],
        "provisioning_state": props.get("provisioningState"),
        "latest_revision": props.get("latestRevisionName"),
        "fqdn": ingress.get("fqdn"),
        "external": ingress.get("external", False),
        "image": image,
    })


if __name__ == "__main__":
    mcp.run()
