"""Azure Resource Inspector MCP Server — queries Azure resource state via az CLI."""

import json
import subprocess
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage, log_usage_direct

mcp = FastMCP("azure-inspector")


def run_az(args: list[str]) -> tuple[int, str]:
    """Run an az CLI command and return (returncode, output)."""
    result = subprocess.run(
        ["az"] + args + ["-o", "json"],
        capture_output=True, text=True, timeout=30
    )
    return result.returncode, result.stdout.strip() or result.stderr.strip()


def _dict_or_empty(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _nested_dict(value: object, *keys: str) -> dict[str, object]:
    current: object = value
    for key in keys:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


def _list_or_empty(value: object) -> list[object]:
    return value if isinstance(value, list) else []


@mcp.tool()
@track_usage("azure-inspector")
def inspect_container_app(name: str, resource_group: str | None = None) -> str:
    """Use for quick live-state checks on one Azure Container App.

    Returns runtime/deployment metadata (revision, replicas, image, FQDN) from
    Azure CLI output; requires `az` auth and subscription access.

    Args:
        name: Container App name
        resource_group: Resource group (auto-detected if not provided)
    """
    # Find resource group if not provided
    if not resource_group:
        rc, out = run_az(["containerapp", "list", "--query", f"[?name=='{name}'].resourceGroup", "-o", "json"])
        if rc != 0:
            return json.dumps({"error": f"Failed to find container app: {out}"})
        try:
            groups = json.loads(out)
            if not groups:
                return json.dumps({"error": f"Container app '{name}' not found"})
            resource_group = groups[0]
        except json.JSONDecodeError:
            return json.dumps({"error": f"Invalid response: {out}"})

    # Get container app details
    rc, out = run_az(["containerapp", "show", "-n", name, "-g", resource_group])
    if rc != 0:
        return json.dumps({"error": f"Failed to get container app: {out}"})

    try:
        app = json.loads(out)
    except json.JSONDecodeError:
        return json.dumps({"error": f"Invalid JSON: {out[:200]}"})

    if not isinstance(app, dict):
        return json.dumps({"error": f"Invalid response shape: expected object, got {type(app).__name__}"})

    # Extract key info
    properties = _dict_or_empty(app.get("properties"))
    template = _dict_or_empty(properties.get("template"))
    containers = _list_or_empty(template.get("containers"))
    scale = _dict_or_empty(template.get("scale"))
    ingress = _dict_or_empty(_dict_or_empty(properties.get("configuration")).get("ingress"))

    return json.dumps({
        "name": name,
        "resource_group": resource_group,
        "provisioning_state": properties.get("provisioningState"),
        "running_state": (
            properties.get("runningStatus", {}).get("state")
            if isinstance(properties.get("runningStatus"), dict)
            else properties.get("runningStatus")
        ),
        "latest_revision": properties.get("latestRevisionName"),
        "fqdn": ingress.get("fqdn"),
        "external": ingress.get("external", False),
        "image": containers[0].get("image") if containers and isinstance(containers[0], dict) else None,
        "min_replicas": scale.get("minReplicas"),
        "max_replicas": scale.get("maxReplicas"),
    })


@mcp.tool()
@track_usage("azure-inspector")
def inspect_cosmos_db(account_name: str, resource_group: str | None = None) -> str:
    """Use when validating Cosmos SQL account structure after infra/app changes.

    Returns databases and container partition-key metadata via Azure CLI; this
    is inventory-focused and does not execute data-plane queries.

    Args:
        account_name: Cosmos DB account name
        resource_group: Resource group (auto-detected if not provided)
    """
    if not resource_group:
        rc, out = run_az(["cosmosdb", "list", "--query", f"[?name=='{account_name}'].resourceGroup"])
        if rc != 0:
            return json.dumps({"error": f"Failed to find Cosmos account: {out}"})
        try:
            groups = json.loads(out)
            if not groups:
                return json.dumps({"error": f"Cosmos account '{account_name}' not found"})
            resource_group = groups[0]
        except json.JSONDecodeError:
            return json.dumps({"error": f"Invalid response: {out}"})

    # Get databases
    rc, out = run_az(["cosmosdb", "sql", "database", "list", "-a", account_name, "-g", resource_group])
    if rc != 0:
        return json.dumps({"error": f"Failed to list databases: {out}"})

    try:
        databases = json.loads(out)
    except json.JSONDecodeError:
        databases = []

    if not isinstance(databases, list):
        return json.dumps({"error": f"Invalid response shape: expected list, got {type(databases).__name__}"})

    db_info = []
    for db in databases:
        if not isinstance(db, dict):
            db_info.append({"name": None, "error": f"Invalid database entry: expected object, got {type(db).__name__}"})
            continue
        db_name = db.get("name")
        if not isinstance(db_name, str) or not db_name:
            db_info.append({"name": None, "error": "Invalid database entry: missing name"})
            continue
        # Get containers in this database
        rc, cont_out = run_az([
            "cosmosdb", "sql", "container", "list",
            "-a", account_name, "-g", resource_group, "-d", db_name
        ])
        containers = []
        if rc == 0:
            try:
                container_payload = json.loads(cont_out)
                if not isinstance(container_payload, list):
                    container_payload = []
                for c in container_payload:
                    if not isinstance(c, dict):
                        continue
                    resource = _dict_or_empty(c.get("resource"))
                    partition_key = _nested_dict(resource, "partitionKey").get("paths", [])
                    if not isinstance(partition_key, list):
                        partition_key = []
                    containers.append({
                        "name": c.get("name"),
                        "partition_key": partition_key,
                    })
            except json.JSONDecodeError:
                pass

        db_info.append({"name": db_name, "containers": containers})

    return json.dumps({
        "account": account_name,
        "resource_group": resource_group,
        "databases": db_info,
    })


@mcp.tool()
@track_usage("azure-inspector")
def inspect_acr(name: str | None = None, resource_group: str | None = None) -> str:
    """Use to inspect what images/tags are currently available in ACR.

    Lists repositories and recent tags (top 3 for up to 10 repos) to keep
    calls fast; requires Azure CLI access to the target registry.

    Args:
        name: ACR name (auto-detected if not provided)
        resource_group: Resource group
    """
    if not name:
        rc, out = run_az(["acr", "list", "--query", "[0]"])
        if rc != 0:
            return json.dumps({"error": f"Failed to list ACRs: {out}"})
        try:
            acr = json.loads(out)
            if not isinstance(acr, dict):
                return json.dumps({"error": "No ACR found in subscription"})
            name = acr.get("name")
            resource_group = acr.get("resourceGroup")
        except (json.JSONDecodeError, TypeError):
            return json.dumps({"error": "No ACR found in subscription"})

    # List repositories
    rc, out = run_az(["acr", "repository", "list", "-n", name])
    if rc != 0:
        return json.dumps({"error": f"Failed to list repos: {out}"})

    try:
        repos = json.loads(out)
    except json.JSONDecodeError:
        repos = []
    if not isinstance(repos, list):
        repos = []

    # Get latest tag for each repo
    images = []
    for repo in repos[:10]:  # Limit to avoid timeouts
        rc, tags_out = run_az([
            "acr", "repository", "show-tags", "-n", name,
            "--repository", repo, "--orderby", "time_desc", "--top", "3"
        ])
        tags = []
        if rc == 0:
            try:
                tags = json.loads(tags_out)
                if not isinstance(tags, list):
                    tags = []
            except json.JSONDecodeError:
                pass
        images.append({"repository": repo, "latest_tags": tags})

    return json.dumps({
        "acr_name": name,
        "login_server": f"{name}.azurecr.io",
        "images": images,
    })


if __name__ == "__main__":
    mcp.run()
