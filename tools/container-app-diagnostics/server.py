"""Container App Diagnostics MCP Server — deep troubleshooting for Azure Container Apps.

Provides tools to diagnose activation failures, pull container logs, inspect
revisions/replicas, and verify image accessibility.  All read-only az CLI calls.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage

mcp = FastMCP("container-app-diagnostics")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_az(args: list[str], timeout: int = 60) -> Any:
    """Run an az CLI command, parse JSON output, raise on failure."""
    cmd = ["az", *args, "-o", "json", "--only-show-errors"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        error_text = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(error_text or f"az command failed: {' '.join(cmd)}")
    output = (proc.stdout or "").strip()
    if not output:
        return {}
    return json.loads(output)


def _run_az_tsv(args: list[str], timeout: int = 30) -> str:
    """Run an az CLI command expecting tsv output."""
    cmd = ["az", *args, "-o", "tsv", "--only-show-errors"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        error_text = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(error_text or f"az command failed: {' '.join(cmd)}")
    return (proc.stdout or "").strip()


def _run_az_raw(args: list[str], timeout: int = 60) -> str:
    """Run az CLI and return raw text output (for logs)."""
    cmd = ["az", *args, "--only-show-errors"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        error_text = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(error_text or f"az command failed: {' '.join(cmd)}")
    return (proc.stdout or "").strip()


def _dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _lst(v: Any) -> list[Any]:
    return v if isinstance(v, list) else []


def _error(code: str, message: str, details: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    if details:
        payload["error"]["details"] = details
    return json.dumps(payload)


def _resolve_rg(name: str, resource_group: str | None) -> str:
    """Auto-detect resource group if not supplied."""
    if resource_group:
        return resource_group
    groups = _run_az(["containerapp", "list", "--query", f"[?name=='{name}'].resourceGroup"])
    if not _lst(groups):
        raise RuntimeError(f"Container app '{name}' not found")
    return _lst(groups)[0]


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool()
@track_usage("container-app-diagnostics")
def diagnose_container_app(name: str, resource_group: str | None = None) -> str:
    """Run a comprehensive diagnostic on one Container App.

    Checks provisioning state, running status, latest revision health,
    replica status, image reference, ingress config, environment variables,
    secrets, health probes, and recent system log lines.  Use this as the
    first tool when a container app shows 'Activation failed'.

    Args:
        name: Container App name (e.g. word-game-waf)
        resource_group: Resource group (auto-detected if omitted)
    """
    try:
        rg = _resolve_rg(name, resource_group)
    except Exception as exc:
        return _error("RESOLVE_RG_FAILED", str(exc))

    findings: dict[str, Any] = {"name": name, "resource_group": rg, "checked_at": datetime.now(UTC).isoformat()}
    issues: list[str] = []

    # --- Full app show ---
    try:
        app = _dict(_run_az(["containerapp", "show", "-n", name, "-g", rg]))
    except Exception as exc:
        return _error("APP_SHOW_FAILED", str(exc))

    props = _dict(app.get("properties"))
    config = _dict(props.get("configuration"))
    template = _dict(props.get("template"))
    containers = _lst(template.get("containers"))
    ingress = _dict(config.get("ingress"))
    scale = _dict(template.get("scale"))

    prov_state = props.get("provisioningState")
    running_status = props.get("runningStatus")
    running_state = running_status.get("state") if isinstance(running_status, dict) else running_status

    findings["provisioning_state"] = prov_state
    findings["running_state"] = running_state
    findings["latest_revision"] = props.get("latestRevisionName")
    findings["latest_ready_revision"] = props.get("latestReadyRevisionName")

    if prov_state and prov_state.lower() != "succeeded":
        issues.append(f"Provisioning state is '{prov_state}' (expected Succeeded)")
    if running_state and running_state.lower() not in ("running", "runningstate", ""):
        issues.append(f"Running state is '{running_state}'")

    # --- Container image & resources ---
    if containers:
        c0 = _dict(containers[0])
        findings["image"] = c0.get("image")
        findings["container_resources"] = _dict(c0.get("resources"))
        findings["container_env_vars"] = [
            {"name": e.get("name"), "has_value": bool(e.get("value")), "secret_ref": e.get("secretRef")}
            for e in _lst(c0.get("env"))
            if isinstance(e, dict)
        ]
        probes = _lst(c0.get("probes"))
        findings["health_probes"] = [
            {
                "type": _dict(p).get("type"),
                "path": _dict(_dict(p).get("httpGet")).get("path"),
                "port": _dict(_dict(p).get("httpGet")).get("port"),
                "period": _dict(p).get("periodSeconds"),
                "failure_threshold": _dict(p).get("failureThreshold"),
            }
            for p in probes
            if isinstance(p, dict)
        ]
    else:
        issues.append("No containers defined in template")

    # --- Ingress ---
    findings["ingress"] = {
        "external": ingress.get("external"),
        "target_port": ingress.get("targetPort"),
        "transport": ingress.get("transport"),
        "allow_insecure": ingress.get("allowInsecure"),
        "fqdn": ingress.get("fqdn"),
    }

    # --- Scale ---
    findings["scale"] = {
        "min_replicas": scale.get("minReplicas"),
        "max_replicas": scale.get("maxReplicas"),
        "rules": [
            {"name": _dict(r).get("name"), "type": list(_dict(r).keys() - {"name"})}
            for r in _lst(scale.get("rules"))
            if isinstance(r, dict)
        ],
    }

    # --- Secrets (names only) ---
    secrets = _lst(config.get("secrets"))
    findings["secrets"] = [_dict(s).get("name") for s in secrets if isinstance(s, dict)]

    # --- Registries ---
    registries = _lst(config.get("registries"))
    findings["registries"] = [
        {"server": _dict(r).get("server"), "identity": _dict(r).get("identity")}
        for r in registries
        if isinstance(r, dict)
    ]

    # --- Revision details ---
    try:
        revisions = _lst(_run_az([
            "containerapp", "revision", "list", "-n", name, "-g", rg,
        ]))
        rev_summaries = []
        for rev in revisions[:5]:
            rev = _dict(rev)
            rev_props = _dict(rev.get("properties"))
            health = rev_props.get("healthState")
            active = rev_props.get("active")
            running = rev_props.get("runningState")
            replicas = rev_props.get("replicas")
            created = rev_props.get("createdTime")
            rev_summaries.append({
                "name": rev.get("name"),
                "active": active,
                "health_state": health,
                "running_state": running,
                "replicas": replicas,
                "created": created,
            })
            if health and str(health).lower() != "healthy":
                issues.append(f"Revision '{rev.get('name')}' health is '{health}'")
            if running and str(running).lower() not in ("running", "processingstopped"):
                issues.append(f"Revision '{rev.get('name')}' running state is '{running}'")
        findings["revisions"] = rev_summaries
    except Exception as exc:
        findings["revisions_error"] = str(exc)
        issues.append(f"Failed to list revisions: {exc}")

    # --- Replica status for latest revision ---
    latest_rev = props.get("latestRevisionName")
    if latest_rev:
        try:
            replicas = _lst(_run_az([
                "containerapp", "replica", "list",
                "-n", name, "-g", rg,
                "--revision", latest_rev,
            ]))
            replica_summaries = []
            for rep in replicas:
                rep = _dict(rep)
                rep_props = _dict(rep.get("properties"))
                rep_containers = _lst(rep_props.get("containers"))
                rep_init_containers = _lst(rep_props.get("initContainers"))
                container_states = []
                for rc in rep_containers:
                    rc = _dict(rc)
                    container_states.append({
                        "name": rc.get("name"),
                        "ready": rc.get("ready"),
                        "started": rc.get("started"),
                        "restart_count": rc.get("restartCount"),
                        "state": rc.get("runningState"),
                        "reason": rc.get("runningStateDetails"),
                        "last_exit_code": rc.get("lastExitCode"),
                    })
                replica_summaries.append({
                    "name": rep.get("name"),
                    "created": rep_props.get("createdTime"),
                    "running_state": rep_props.get("runningState"),
                    "containers": container_states,
                    "init_containers_count": len(rep_init_containers),
                })
                for cs in container_states:
                    if cs.get("restart_count") and int(cs["restart_count"]) > 0:
                        issues.append(f"Container '{cs['name']}' in replica '{rep.get('name')}' has {cs['restart_count']} restarts")
                    if cs.get("last_exit_code") and int(cs["last_exit_code"]) != 0:
                        issues.append(f"Container '{cs['name']}' last exit code: {cs['last_exit_code']}")
            findings["replicas"] = replica_summaries
        except Exception as exc:
            findings["replicas_error"] = str(exc)

    # --- Recent system logs ---
    try:
        log_lines = _run_az_raw([
            "containerapp", "logs", "show",
            "-n", name, "-g", rg,
            "--type", "system",
            "--tail", "30",
            "-o", "table",
        ])
        findings["recent_system_logs"] = log_lines[-3000:] if len(log_lines) > 3000 else log_lines
    except Exception as exc:
        findings["system_logs_error"] = str(exc)

    # --- Recent console logs ---
    try:
        console_lines = _run_az_raw([
            "containerapp", "logs", "show",
            "-n", name, "-g", rg,
            "--type", "console",
            "--tail", "30",
            "-o", "table",
        ])
        findings["recent_console_logs"] = console_lines[-3000:] if len(console_lines) > 3000 else console_lines
    except Exception as exc:
        findings["console_logs_error"] = str(exc)

    findings["issues_detected"] = issues
    findings["issue_count"] = len(issues)
    findings["ok"] = len(issues) == 0

    return json.dumps(findings)


@mcp.tool()
@track_usage("container-app-diagnostics")
def get_container_logs(
    name: str,
    resource_group: str | None = None,
    log_type: str = "console",
    tail: int = 100,
    revision: str | None = None,
    follow: bool = False,
) -> str:
    """Pull container app logs (console or system).

    Use 'system' logs to see platform events (image pulls, scaling, crashes).
    Use 'console' logs to see application stdout/stderr.

    Args:
        name: Container App name
        resource_group: Resource group (auto-detected if omitted)
        log_type: 'console' for app output, 'system' for platform events
        tail: Number of recent log lines (default 100, max 300)
        revision: Specific revision name (latest if omitted)
        follow: Not used in MCP context, kept for compatibility
    """
    try:
        rg = _resolve_rg(name, resource_group)
    except Exception as exc:
        return _error("RESOLVE_RG_FAILED", str(exc))

    if log_type not in ("console", "system"):
        return _error("INVALID_LOG_TYPE", "log_type must be 'console' or 'system'")
    tail = min(max(tail, 1), 300)

    args = [
        "containerapp", "logs", "show",
        "-n", name, "-g", rg,
        "--type", log_type,
        "--tail", str(tail),
        "-o", "table",
    ]
    if revision:
        args.extend(["--revision", revision])

    try:
        output = _run_az_raw(args, timeout=30)
    except Exception as exc:
        return _error("LOGS_FAILED", str(exc))

    truncated = len(output) > 5000
    if truncated:
        output = output[-5000:]

    return json.dumps({
        "ok": True,
        "name": name,
        "resource_group": rg,
        "log_type": log_type,
        "tail": tail,
        "revision": revision,
        "truncated": truncated,
        "logs": output,
    })


@mcp.tool()
@track_usage("container-app-diagnostics")
def list_revisions(name: str, resource_group: str | None = None) -> str:
    """List all revisions for a Container App with status details.

    Shows active/inactive state, health, running state, replicas, creation
    time, and traffic weight for each revision.

    Args:
        name: Container App name
        resource_group: Resource group (auto-detected if omitted)
    """
    try:
        rg = _resolve_rg(name, resource_group)
    except Exception as exc:
        return _error("RESOLVE_RG_FAILED", str(exc))

    try:
        revisions = _lst(_run_az([
            "containerapp", "revision", "list", "-n", name, "-g", rg,
        ]))
    except Exception as exc:
        return _error("REVISION_LIST_FAILED", str(exc))

    summaries = []
    for rev in revisions:
        rev = _dict(rev)
        rev_props = _dict(rev.get("properties"))
        template = _dict(rev_props.get("template"))
        containers = _lst(template.get("containers"))
        c0 = _dict(containers[0]) if containers else {}
        summaries.append({
            "name": rev.get("name"),
            "active": rev_props.get("active"),
            "health_state": rev_props.get("healthState"),
            "running_state": rev_props.get("runningState"),
            "provisioning_state": rev_props.get("provisioningState"),
            "replicas": rev_props.get("replicas"),
            "traffic_weight": rev_props.get("trafficWeight"),
            "created": rev_props.get("createdTime"),
            "image": c0.get("image"),
        })

    return json.dumps({
        "ok": True,
        "name": name,
        "resource_group": rg,
        "revision_count": len(summaries),
        "revisions": summaries,
    })


@mcp.tool()
@track_usage("container-app-diagnostics")
def check_image_accessibility(
    name: str,
    resource_group: str | None = None,
    acr_name: str | None = None,
) -> str:
    """Verify the container image referenced by a Container App exists in ACR.

    Cross-references the image tag in the app config with ACR repository tags.
    Also checks registry credential configuration on the container app.

    Args:
        name: Container App name
        resource_group: Resource group (auto-detected if omitted)
        acr_name: ACR name (auto-detected from app registry config if omitted)
    """
    try:
        rg = _resolve_rg(name, resource_group)
    except Exception as exc:
        return _error("RESOLVE_RG_FAILED", str(exc))

    try:
        app = _dict(_run_az(["containerapp", "show", "-n", name, "-g", rg]))
    except Exception as exc:
        return _error("APP_SHOW_FAILED", str(exc))

    props = _dict(app.get("properties"))
    config = _dict(props.get("configuration"))
    template = _dict(props.get("template"))
    containers = _lst(template.get("containers"))
    registries = _lst(config.get("registries"))

    if not containers:
        return _error("NO_CONTAINERS", "No containers defined in app template")

    c0 = _dict(containers[0])
    image_ref = c0.get("image", "")

    # Parse image reference
    parts = image_ref.split("/", 1)
    if len(parts) == 2:
        registry_server = parts[0]
        repo_and_tag = parts[1]
    else:
        registry_server = ""
        repo_and_tag = parts[0]

    if ":" in repo_and_tag:
        repo, tag = repo_and_tag.rsplit(":", 1)
    else:
        repo = repo_and_tag
        tag = "latest"

    # Registry config on the app
    registry_configs = [
        {"server": _dict(r).get("server"), "identity": _dict(r).get("identity")}
        for r in registries
        if isinstance(r, dict)
    ]

    # Resolve ACR name
    if not acr_name and registry_server and ".azurecr.io" in registry_server:
        acr_name = registry_server.split(".")[0]

    findings: dict[str, Any] = {
        "ok": True,
        "name": name,
        "image_ref": image_ref,
        "registry_server": registry_server,
        "repository": repo,
        "tag": tag,
        "registry_configs": registry_configs,
    }
    issues: list[str] = []

    if not registry_configs:
        issues.append("No registry credentials configured on the container app")

    # Check if image exists in ACR
    if acr_name:
        try:
            tags = _lst(_run_az([
                "acr", "repository", "show-tags",
                "-n", acr_name,
                "--repository", repo,
                "--orderby", "time_desc",
                "--top", "10",
            ]))
            findings["acr_tags"] = tags
            if tag not in tags:
                issues.append(f"Tag '{tag}' not found in ACR repository '{repo}'. Available: {tags[:5]}")
        except Exception as exc:
            err_msg = str(exc)
            findings["acr_error"] = err_msg
            if "not found" in err_msg.lower() or "does not exist" in err_msg.lower():
                issues.append(f"Repository '{repo}' not found in ACR '{acr_name}'")
            else:
                issues.append(f"Failed to check ACR: {err_msg}")

        # Check ACR accessibility
        try:
            acr_info = _dict(_run_az(["acr", "show", "-n", acr_name]))
            findings["acr_login_server"] = acr_info.get("loginServer")
            findings["acr_public_access"] = _dict(acr_info.get("properties", acr_info)).get("publicNetworkAccess")
            findings["acr_network_rule_bypass"] = _dict(acr_info.get("properties", acr_info)).get("networkRuleBypassOptions")
        except Exception as exc:
            findings["acr_info_error"] = str(exc)
    else:
        issues.append(f"Could not determine ACR name from image ref '{image_ref}'")

    findings["issues"] = issues
    findings["issue_count"] = len(issues)
    if issues:
        findings["ok"] = False

    return json.dumps(findings)


@mcp.tool()
@track_usage("container-app-diagnostics")
def compare_container_apps(
    names: list[str],
    resource_group: str | None = None,
) -> str:
    """Compare configuration of multiple Container Apps side by side.

    Useful when some apps work and others don't — highlights differences
    in image, env vars, ingress, scale, and health between apps.

    Args:
        names: List of Container App names to compare
        resource_group: Resource group (auto-detected from first app if omitted)
    """
    if not names or len(names) < 2:
        return _error("INVALID_INPUT", "Provide at least 2 container app names to compare")

    results = []
    for app_name in names:
        try:
            rg = _resolve_rg(app_name, resource_group)
            app = _dict(_run_az(["containerapp", "show", "-n", app_name, "-g", rg]))
            props = _dict(app.get("properties"))
            config = _dict(props.get("configuration"))
            template = _dict(props.get("template"))
            containers = _lst(template.get("containers"))
            ingress = _dict(config.get("ingress"))
            scale = _dict(template.get("scale"))
            registries = _lst(config.get("registries"))
            c0 = _dict(containers[0]) if containers else {}

            running_status = props.get("runningStatus")
            running_state = running_status.get("state") if isinstance(running_status, dict) else running_status

            results.append({
                "name": app_name,
                "provisioning_state": props.get("provisioningState"),
                "running_state": running_state,
                "latest_revision": props.get("latestRevisionName"),
                "image": c0.get("image"),
                "cpu": _dict(c0.get("resources")).get("cpu"),
                "memory": _dict(c0.get("resources")).get("memory"),
                "env_vars": sorted([_dict(e).get("name") for e in _lst(c0.get("env")) if isinstance(e, dict)]),
                "ingress_external": ingress.get("external"),
                "target_port": ingress.get("targetPort"),
                "transport": ingress.get("transport"),
                "min_replicas": scale.get("minReplicas"),
                "max_replicas": scale.get("maxReplicas"),
                "probes": [_dict(p).get("type") for p in _lst(c0.get("probes")) if isinstance(p, dict)],
                "registries": [_dict(r).get("server") for r in registries if isinstance(r, dict)],
                "secrets_count": len(_lst(config.get("secrets"))),
            })
        except Exception as exc:
            results.append({"name": app_name, "error": str(exc)})

    return json.dumps({
        "ok": True,
        "compared_count": len(results),
        "apps": results,
    })


if __name__ == "__main__":
    mcp.run()
