"""Azure Resource Status MCP Server — inventory, status checks, and error context."""

from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage

mcp = FastMCP("azure-resource-status")

_LOCAL_DIR = Path(__file__).resolve().parent / ".local"
_RESOURCE_FILE = _LOCAL_DIR / "azure-resources.json"


def _strip_az_warnings(text: str) -> str:
    """Remove leading warning/info lines emitted by az before JSON."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            return "\n".join(lines[i:])
    return text


def _run_az(args: list[str], timeout: int = 90) -> Any:
    """Run az CLI and parse JSON output."""
    cmd = ["az", *args, "-o", "json"]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        error_text = (proc.stderr or proc.stdout).strip()
        raise RuntimeError(error_text or f"az command failed: {' '.join(cmd)}")

    output = (proc.stdout or proc.stderr).strip()
    if not output:
        return {}

    try:
        return json.loads(output)
    except json.JSONDecodeError:
        stripped = _strip_az_warnings(output)
        try:
            return json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Failed to parse az output as JSON: {output[:400]}") from exc


def _ensure_local_dir() -> None:
    _LOCAL_DIR.mkdir(parents=True, exist_ok=True)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_resource(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item.get("id"),
        "name": item.get("name"),
        "type": item.get("type"),
        "resource_group": item.get("resourceGroup"),
        "location": item.get("location"),
    }


def _dict_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list_or_empty(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _error_payload(code: str, message: str, details: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
        },
    }
    if details:
        payload["error"]["details"] = details
    return json.dumps(payload)


def _load_resource_inventory() -> list[dict[str, Any]]:
    if not _RESOURCE_FILE.exists():
        raise RuntimeError(
            f"Resource list file not found at {_RESOURCE_FILE}. Run list_azure_resources first."
        )
    payload = json.loads(_RESOURCE_FILE.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError(f"Invalid resource inventory format in {_RESOURCE_FILE}")
    resources = payload.get("resources", [])
    if not isinstance(resources, list):
        raise RuntimeError(f"Invalid resource inventory format in {_RESOURCE_FILE}")
    return [resource for resource in resources if isinstance(resource, dict)]


def _select_resources(resource_ids: list[str] | None, all_resources: bool) -> list[dict[str, Any]]:
    resources = _load_resource_inventory()
    if all_resources or not resource_ids:
        return resources
    requested = set(resource_ids)
    return [r for r in resources if r.get("id") in requested]


def _nested_or_root(raw: dict[str, Any], key: str) -> Any:
    return raw.get(key) or (raw.get("properties") or {}).get(key)


def _resource_group(resource: dict[str, Any]) -> str | None:
    resource_group = resource.get("resource_group")
    if isinstance(resource_group, str) and resource_group:
        return resource_group
    resource_id = resource.get("id")
    if not isinstance(resource_id, str):
        return None
    parts = resource_id.split("/")
    if "resourceGroups" not in parts:
        return None
    index = parts.index("resourceGroups")
    if index + 1 >= len(parts):
        return None
    return parts[index + 1]


def _resource_name(resource: dict[str, Any]) -> str | None:
    resource_name = resource.get("name")
    if isinstance(resource_name, str) and resource_name:
        return resource_name
    resource_id = resource.get("id")
    if not isinstance(resource_id, str):
        return None
    return resource_id.rstrip("/").split("/")[-1] or None


def _status_for_resource(resource: dict[str, Any] | str, resource_type: str | None = None) -> dict[str, Any]:
    if isinstance(resource, str):
        resource = {"id": resource, "type": resource_type}
    elif not isinstance(resource, dict):
        return {"status": "unknown", "error": f"Invalid resource entry: expected object, got {type(resource).__name__}"}

    resource_id = resource.get("id")
    resource_type = resource.get("type")
    resource_type_lc = (resource_type or "").lower()
    resource_group = _resource_group(resource)
    resource_name = _resource_name(resource)

    try:
        if resource_type_lc == "microsoft.app/containerapps":
            raw = _run_az(["containerapp", "show", "--ids", resource_id])
            raw = _dict_or_empty(raw)
            props = _dict_or_empty(raw.get("properties"))
            configuration = _dict_or_empty(props.get("configuration"))
            ingress = _dict_or_empty(configuration.get("ingress"))
            running_status = props.get("runningStatus")
            if isinstance(running_status, dict):
                running_status = running_status.get("state")
            return {
                "status": running_status,
                "provisioning_state": props.get("provisioningState"),
                "latest_revision": props.get("latestRevisionName"),
                "fqdn": ingress.get("fqdn"),
            }

        if resource_type_lc == "microsoft.documentdb/databaseaccounts":
            raw = _run_az(["cosmosdb", "show", "--ids", resource_id])
            raw = _dict_or_empty(raw)
            return {
                "status": _nested_or_root(raw, "provisioningState"),
                "document_endpoint": _nested_or_root(raw, "documentEndpoint"),
                "public_network_access": _nested_or_root(raw, "publicNetworkAccess"),
            }

        if resource_type_lc == "microsoft.cognitiveservices/accounts":
            raw = _run_az(
                [
                    "cognitiveservices",
                    "account",
                    "show",
                    "--name",
                    resource_name or "",
                    "--resource-group",
                    resource_group or "",
                ]
            )
            raw = _dict_or_empty(raw)
            return {
                "status": _nested_or_root(raw, "provisioningState"),
                "kind": _nested_or_root(raw, "kind"),
                "endpoint": _nested_or_root(raw, "endpoint"),
            }

        if resource_type_lc == "microsoft.keyvault/vaults":
            raw = _run_az(
                [
                    "keyvault",
                    "show",
                    "--name",
                    resource_name or "",
                    "--resource-group",
                    resource_group or "",
                ]
            )
            raw = _dict_or_empty(raw)
            props = _dict_or_empty(raw.get("properties"))
            return {
                "status": _nested_or_root(raw, "provisioningState") or "unknown",
                "vault_uri": props.get("vaultUri"),
                "enabled_for_deployment": props.get("enabledForDeployment"),
            }

        if resource_type_lc == "microsoft.storage/storageaccounts":
            raw = _run_az(["storage", "account", "show", "--ids", resource_id])
            raw = _dict_or_empty(raw)
            return {
                "status": _nested_or_root(raw, "statusOfPrimary"),
                "primary_location": _nested_or_root(raw, "primaryLocation"),
                "public_network_access": _nested_or_root(raw, "publicNetworkAccess"),
            }

        if resource_type_lc == "microsoft.containerregistry/registries":
            raw = _run_az(
                [
                    "acr",
                    "show",
                    "--name",
                    resource_name or "",
                    "--resource-group",
                    resource_group or "",
                ]
            )
            raw = _dict_or_empty(raw)
            return {
                "status": _nested_or_root(raw, "provisioningState"),
                "login_server": _nested_or_root(raw, "loginServer"),
                "public_network_access": _nested_or_root(raw, "publicNetworkAccess"),
            }

        if resource_type_lc == "microsoft.operationalinsights/workspaces":
            raw = _run_az(["monitor", "log-analytics", "workspace", "show", "--ids", resource_id])
            raw = _dict_or_empty(raw)
            return {
                "status": _nested_or_root(raw, "provisioningState"),
                "customer_id": _nested_or_root(raw, "customerId"),
            }

        if resource_type_lc == "microsoft.insights/components":
            raw = _run_az(["monitor", "app-insights", "component", "show", "--ids", resource_id])
            raw = _dict_or_empty(raw)
            return {
                "status": _nested_or_root(raw, "provisioningState"),
                "app_id": _nested_or_root(raw, "appId"),
                "application_type": _nested_or_root(raw, "applicationType"),
            }

        if resource_type_lc == "microsoft.compute/virtualmachines":
            raw = _run_az(
                [
                    "vm",
                    "show",
                    "--name",
                    resource_name or "",
                    "--resource-group",
                    resource_group or "",
                ]
            )
            raw = _dict_or_empty(raw)
            props = _dict_or_empty(raw.get("properties"))
            hardware_profile = _dict_or_empty(props.get("hardwareProfile"))
            return {
                "status": props.get("provisioningState") or raw.get("provisioningState", "unknown"),
                "vm_id": raw.get("vmId"),
                "vm_size": hardware_profile.get("vmSize"),
            }

        try:
            raw = _run_az(["resource", "show", "--ids", resource_id])
        except RuntimeError as exc:
            err_lower = str(exc).lower()
            if (
                "api-version" in err_lower
                or "no registered resource provider" in err_lower
                or "noregisteredproviderfound" in err_lower
                or "no registered provider found" in err_lower
            ):
                return {"status": "unknown", "error": f"provider/api-version issue: {exc}"}
            raise

        raw = _dict_or_empty(raw)
        props = _dict_or_empty(raw.get("properties"))
        return {
            "status": props.get("provisioningState") or raw.get("provisioningState") or "unknown",
            "resource_state": props.get("state"),
        }
    except Exception as exc:
        return {"status": "unknown", "error": str(exc)}


def _event_summary(event: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(event, dict):
        return {"error": f"Invalid event entry: expected object, got {type(event).__name__}"}
    return {
        "timestamp": event.get("eventTimestamp") or event.get("submissionTimestamp"),
        "level": event.get("level"),
        "operation": _dict_or_empty(event.get("operationName")).get("value"),
        "status": _dict_or_empty(event.get("status")).get("value"),
        "sub_status": _dict_or_empty(event.get("subStatus")).get("value"),
        "correlation_id": event.get("correlationId"),
        "caller": event.get("caller"),
        "description": _dict_or_empty(event.get("properties")).get("statusMessage"),
    }


def _is_error_event(event: dict[str, Any]) -> bool:
    if not isinstance(event, dict):
        return False
    level = str(event.get("level") or "").lower()
    status = str(_dict_or_empty(event.get("status")).get("value") or "").lower()
    sub_status = str(_dict_or_empty(event.get("subStatus")).get("value") or "").lower()
    return "error" in level or "critical" in level or "failed" in status or "failed" in sub_status


@mcp.tool()
@track_usage("azure-resource-status")
def list_azure_resources(resource_group: str | None = None, subscription: str | None = None) -> str:
    """List deployed Azure resources and store IDs to a local-only inventory file."""
    try:
        args = ["resource", "list"]
        if resource_group:
            args.extend(["--resource-group", resource_group])
        if subscription:
            args.extend(["--subscription", subscription])

        resources_raw = _run_az(args, timeout=120)
        if not isinstance(resources_raw, list):
            return _error_payload(
                "AZURE_LIST_FAILED",
                f"Expected az resource list to return a list, got {type(resources_raw).__name__}",
            )
        resources = [_normalize_resource(item) for item in resources_raw if isinstance(item, dict) and item.get("id")]
        by_type = Counter((r.get("type") or "unknown") for r in resources)

        _ensure_local_dir()
        _RESOURCE_FILE.write_text(
            json.dumps(
                {
                    "generated_at": _now_iso(),
                    "subscription": subscription,
                    "resource_group": resource_group,
                    "resource_count": len(resources),
                    "resources": resources,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        return json.dumps(
            {
                "ok": True,
                "resource_file": str(_RESOURCE_FILE),
                "resource_count": len(resources),
                "by_type": dict(by_type),
            }
        )
    except Exception as exc:
        return _error_payload("AZURE_LIST_FAILED", str(exc))


@mcp.tool()
@track_usage("azure-resource-status")
def get_azure_status(resource_ids: list[str] | None = None, all_resources: bool = True) -> str:
    """Get status for one/more/all resources from the local inventory file."""
    try:
        resources = _select_resources(resource_ids=resource_ids, all_resources=all_resources)
        statuses: list[dict[str, Any]] = []

        for resource in resources:
            if not isinstance(resource, dict):
                statuses.append(
                    {
                        "id": None,
                        "name": None,
                        "type": None,
                        "resource_group": None,
                        "status": {
                            "status": "unknown",
                            "error": f"Invalid resource entry: expected object, got {type(resource).__name__}",
                        },
                    }
                )
                continue

            resource_id = resource.get("id")
            if not isinstance(resource_id, str) or not resource_id:
                statuses.append(
                    {
                        "id": None,
                        "name": resource.get("name"),
                        "type": resource.get("type"),
                        "resource_group": resource.get("resource_group"),
                        "status": {
                            "status": "unknown",
                            "error": "Invalid resource entry: missing id",
                        },
                    }
                )
                continue
            statuses.append(
                {
                    "id": resource_id,
                    "name": resource.get("name"),
                    "type": resource.get("type"),
                    "resource_group": resource.get("resource_group"),
                    "status": _status_for_resource(resource),
                }
            )

        return json.dumps(
            {
                "ok": True,
                "checked_at": _now_iso(),
                "checked_count": len(statuses),
                "results": statuses,
            }
        )
    except Exception as exc:
        return _error_payload("AZURE_STATUS_FAILED", str(exc))


@mcp.tool()
@track_usage("azure-resource-status")
def find_error(
    resource_ids: list[str] | None = None,
    all_resources: bool = True,
    max_entries: int = 100,
    context_window: int = 1,
) -> str:
    """Inspect Azure Activity Logs and return error events with nearby context."""
    if max_entries < 1:
        return _error_payload("INVALID_MAX_ENTRIES", "max_entries must be >= 1")
    if context_window < 0:
        return _error_payload("INVALID_CONTEXT_WINDOW", "context_window must be >= 0")

    try:
        resources = _select_resources(resource_ids=resource_ids, all_resources=all_resources)
        findings: list[dict[str, Any]] = []

        for resource in resources:
            if not isinstance(resource, dict):
                findings.append(
                    {
                        "id": None,
                        "name": None,
                        "type": None,
                        "error": f"Invalid resource entry: expected object, got {type(resource).__name__}",
                    }
                )
                continue

            resource_id = resource.get("id")
            if not isinstance(resource_id, str) or not resource_id:
                findings.append(
                    {
                        "id": None,
                        "name": resource.get("name"),
                        "type": resource.get("type"),
                        "error": "Invalid resource entry: missing id",
                    }
                )
                continue

            try:
                entries = _run_az(
                    [
                        "monitor",
                        "activity-log",
                        "list",
                        "--resource-id",
                        resource_id,
                        "--max-events",
                        str(max_entries),
                    ],
                    timeout=120,
                )
                if not isinstance(entries, list):
                    entries = []
            except Exception as exc:
                findings.append(
                    {
                        "id": resource_id,
                        "name": resource.get("name"),
                        "type": resource.get("type"),
                        "error": str(exc),
                    }
                )
                continue

            summaries = [_event_summary(event) for event in entries]
            error_indices = [idx for idx, event in enumerate(entries) if _is_error_event(event)]

            errors_with_context: list[dict[str, Any]] = []
            for idx in error_indices:
                start = max(0, idx - context_window)
                end = min(len(entries), idx + context_window + 1)
                errors_with_context.append(
                    {
                        "error_event": summaries[idx],
                        "context": summaries[start:end],
                    }
                )

            findings.append(
                {
                    "id": resource_id,
                    "name": resource.get("name"),
                    "type": resource.get("type"),
                    "inspected_entries": len(entries),
                    "error_count": len(errors_with_context),
                    "errors": errors_with_context,
                }
            )

        return json.dumps(
            {
                "ok": True,
                "checked_at": _now_iso(),
                "resource_count": len(findings),
                "max_entries": max_entries,
                "results": findings,
            }
        )
    except Exception as exc:
        return _error_payload("AZURE_FIND_ERROR_FAILED", str(exc))


if __name__ == "__main__":
    mcp.run()
