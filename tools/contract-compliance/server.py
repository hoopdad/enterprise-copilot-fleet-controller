"""Contract Compliance Checker MCP Server — validates implementations match .contracts/*.yml."""

import json
import os
import re
import sys
from pathlib import Path

import yaml
from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage, log_usage_direct

mcp = FastMCP("contract-compliance")


def find_fastapi_routes(repo_path: str) -> list[dict]:
    """Scan a FastAPI repo for route definitions, resolving router prefixes."""
    routes = []
    src_dir = os.path.join(repo_path, "src")
    if not os.path.isdir(src_dir):
        src_dir = repo_path

    # First pass: find router prefixes from main.py include_router calls
    # and from APIRouter(prefix=...) declarations
    file_prefixes: dict[str, str] = {}

    for root, _, files in os.walk(src_dir):
        for fname in files:
            if not fname.endswith(".py"):
                continue
            filepath = os.path.join(root, fname)
            try:
                content = Path(filepath).read_text()
            except (OSError, UnicodeDecodeError):
                continue

            # Detect APIRouter(prefix="/api/events") in router files
            prefix_match = re.search(r'APIRouter\([^)]*prefix\s*=\s*["\']([^"\']+)["\']', content)
            if prefix_match:
                file_prefixes[filepath] = prefix_match.group(1)

            # Detect include_router(..., prefix="/api/events") in main files
            for inc_match in re.finditer(
                r'include_router\(\s*(\w+)[^)]*prefix\s*=\s*["\']([^"\']+)["\']', content
            ):
                # Try to resolve which file this router came from
                router_var = inc_match.group(1)
                prefix = inc_match.group(2)
                # Look for import of this router variable
                import_match = re.search(
                    rf'from\s+[.\w]+\.(\w+)\s+import\s+.*{router_var}', content
                )
                if import_match:
                    module_name = import_match.group(1)
                    # Find the file matching this module
                    for r2, _, f2 in os.walk(src_dir):
                        candidate = os.path.join(r2, f"{module_name}.py")
                        if os.path.isfile(candidate):
                            file_prefixes[candidate] = prefix
                            break

    # Second pass: find actual route decorators
    for root, _, files in os.walk(src_dir):
        for fname in files:
            if not fname.endswith(".py"):
                continue
            filepath = os.path.join(root, fname)
            try:
                content = Path(filepath).read_text()
            except (OSError, UnicodeDecodeError):
                continue

            # Match @router.get("/path"), @app.post("/path"), etc.
            pattern = r'@(?:router|app)\.(get|post|put|patch|delete)\(\s*["\']([^"\']+)["\']'
            prefix = file_prefixes.get(filepath, "")
            for match in re.finditer(pattern, content, re.IGNORECASE):
                method = match.group(1).upper()
                route_path = match.group(2)
                full_path = prefix + route_path if not route_path.startswith("/api") else route_path
                routes.append({
                    "method": method,
                    "path": full_path,
                    "file": os.path.relpath(filepath, repo_path),
                })

    return routes


def find_express_routes(repo_path: str) -> list[dict]:
    """Scan a Node/Express/Next repo for route definitions."""
    routes = []
    src_dir = os.path.join(repo_path, "src")
    if not os.path.isdir(src_dir):
        src_dir = repo_path

    for root, _, files in os.walk(src_dir):
        for fname in files:
            if not fname.endswith((".ts", ".js")):
                continue
            filepath = os.path.join(root, fname)
            try:
                content = Path(filepath).read_text()
            except (OSError, UnicodeDecodeError):
                continue

            # Match router.get('/path'), app.post('/path'), etc.
            pattern = r'(?:router|app)\.(get|post|put|patch|delete)\(\s*["\'/]([^"\']+)["\']'
            for match in re.finditer(pattern, content, re.IGNORECASE):
                method = match.group(1).upper()
                path = match.group(2)
                if not path.startswith("/"):
                    path = "/" + path
                routes.append({
                    "method": method,
                    "path": path,
                    "file": os.path.relpath(filepath, repo_path),
                })

    return routes


def normalize_path(path: str) -> str:
    """Normalize path parameters for comparison: /api/events/{id} == /api/events/{event_id}."""
    return re.sub(r'\{[^}]+\}', '{*}', path)


def resolve_provider_repo_path(project_dir: str, provider: str) -> tuple[str, str]:
    """Resolve provider repo path from .repo-index.yml, falling back to legacy work/<provider>."""
    repo_index = os.path.join(project_dir, ".repo-index.yml")
    if os.path.isfile(repo_index):
        try:
            with open(repo_index) as f:
                data = yaml.safe_load(f) or {}
            repos = data.get("repos", [])
            if isinstance(repos, list):
                for entry in repos:
                    if not isinstance(entry, dict):
                        continue
                    if str(entry.get("name", "")).strip() != provider:
                        continue
                    local_path = str(entry.get("local_path", "")).strip()
                    if not local_path:
                        continue
                    if os.path.isabs(local_path):
                        return local_path, local_path
                    return os.path.join(project_dir, local_path), local_path
        except (yaml.YAMLError, OSError):
            pass

    fallback_rel = f"work/{provider}"
    return os.path.join(project_dir, fallback_rel), fallback_rel


@mcp.tool()
@track_usage("contract-compliance")
def check_contract_compliance(
    contract_path: str,
    repo_path: str,
    framework: str = "auto",
) -> str:
    """Use to verify one provider repo still matches one contract.

    Compares contract endpoints to discovered FastAPI/Express routes and reports
    compliant, missing, and extra routes; route-shape only (not payload semantics).

    Args:
        contract_path: Path to the .contracts/*.yml file
        repo_path: Path to the implementation repo (e.g., ../team-brain-api)
        framework: "fastapi", "express", or "auto" (detect from repo)
    """
    # Load contract
    if not os.path.isfile(contract_path):
        return json.dumps({"error": f"Contract file not found: {contract_path}"})

    try:
        with open(contract_path) as f:
            contract = yaml.safe_load(f)
    except yaml.YAMLError as e:
        return json.dumps({"error": f"Invalid YAML in contract: {e}"})

    if not contract or "endpoints" not in contract:
        return json.dumps({"error": "Contract has no 'endpoints' section"})

    # Auto-detect framework
    if framework == "auto":
        if os.path.isfile(os.path.join(repo_path, "requirements.txt")):
            framework = "fastapi"
        elif os.path.isfile(os.path.join(repo_path, "package.json")):
            framework = "express"
        else:
            framework = "fastapi"

    # Find implemented routes
    if framework == "fastapi":
        impl_routes = find_fastapi_routes(repo_path)
    else:
        impl_routes = find_express_routes(repo_path)

    # Build lookup of implemented routes
    impl_lookup = {}
    for route in impl_routes:
        key = f"{route['method']} {normalize_path(route['path'])}"
        impl_lookup[key] = route

    # Check each contract endpoint
    compliant = []
    missing = []
    contract_endpoints = contract.get("endpoints", [])

    for endpoint in contract_endpoints:
        method = endpoint.get("method", "GET").upper()
        path = endpoint.get("path", "")
        key = f"{method} {normalize_path(path)}"

        if key in impl_lookup:
            compliant.append({
                "endpoint": f"{method} {path}",
                "file": impl_lookup[key]["file"],
            })
        else:
            missing.append({
                "endpoint": f"{method} {path}",
                "expected_in": framework,
            })

    # Find extra routes not in contract (informational)
    contract_keys = set()
    for endpoint in contract_endpoints:
        method = endpoint.get("method", "GET").upper()
        path = endpoint.get("path", "")
        contract_keys.add(f"{method} {normalize_path(path)}")

    extra = []
    for key, route in impl_lookup.items():
        if key not in contract_keys:
            extra.append({
                "endpoint": f"{route['method']} {route['path']}",
                "file": route["file"],
            })

    total = len(contract_endpoints)
    return json.dumps({
        "contract": os.path.basename(contract_path),
        "repo": os.path.basename(repo_path),
        "framework": framework,
        "summary": f"{len(compliant)}/{total} endpoints implemented",
        "compliant": compliant,
        "missing": missing,
        "extra_routes": extra if extra else None,
    })


@mcp.tool()
@track_usage("contract-compliance")
def check_all_contracts(project_dir: str = ".") -> str:
    """Use for project-wide contract drift checks.

    Iterates `.contracts/*.yml`, resolves each provider repo from `.repo-index.yml`
    (or legacy `work/<provider>`), and runs `check_contract_compliance`.

    Args:
        project_dir: Path to the parent project root
    """
    contracts_dir = os.path.join(project_dir, ".contracts")
    if not os.path.isdir(contracts_dir):
        return json.dumps({"error": "No .contracts/ directory found"})

    results = []
    for fname in sorted(os.listdir(contracts_dir)):
        if not fname.endswith((".yml", ".yaml")):
            continue

        contract_path = os.path.join(contracts_dir, fname)
        try:
            with open(contract_path) as f:
                contract = yaml.safe_load(f)
        except (yaml.YAMLError, OSError):
            continue

        if not contract or "provider" not in contract:
            continue

        provider = contract["provider"]
        repo_path, repo_ref = resolve_provider_repo_path(project_dir, provider)
        if not os.path.isdir(repo_path):
            results.append({"contract": fname, "error": f"Provider repo not found: {repo_ref}"})
            continue

        result = json.loads(
            check_contract_compliance(contract_path, repo_path, _usage_origin="nested")
        )
        results.append(result)

    return json.dumps({"results": results})


if __name__ == "__main__":
    mcp.run()
