"""Scaffold Generator MCP Server — generates code stubs from .contracts/*.yml."""

import json
import os
import sys
from pathlib import Path

import yaml
from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage, log_usage_direct

mcp = FastMCP("scaffold-generator")


def path_to_param_name(path: str) -> str:
    """Extract parameter names from path like /api/events/{id} -> id."""
    import re
    params = re.findall(r'\{(\w+)\}', path)
    return params


def path_to_function_name(method: str, path: str) -> str:
    """Convert endpoint to function name: GET /api/events/{id} -> get_event."""
    import re
    # Remove /api/ prefix and parameters
    clean = re.sub(r'/api/?', '', path)
    clean = re.sub(r'/\{[^}]+\}', '', clean)
    clean = re.sub(r'[/-]', '_', clean).strip('_')

    # Singularize for single-resource endpoints
    if '{' in path and clean.endswith('s'):
        clean = clean[:-1]

    return f"{method.lower()}_{clean}"


def generate_fastapi_scaffold(contract: dict, output_dir: str) -> list[str]:
    """Generate FastAPI route stubs from contract."""
    files_created = []
    endpoints = contract.get("endpoints", [])
    if not endpoints:
        return files_created

    # Group endpoints by path prefix for router organization
    routers: dict[str, list] = {}
    for ep in endpoints:
        path = ep.get("path", "")
        # Get first meaningful path segment after /api/
        parts = [p for p in path.split("/") if p and p != "api"]
        group = parts[0] if parts else "main"
        routers.setdefault(group, []).append(ep)

    routers_dir = os.path.join(output_dir, "src", "routers")
    tests_dir = os.path.join(output_dir, "tests")
    os.makedirs(routers_dir, exist_ok=True)
    os.makedirs(tests_dir, exist_ok=True)

    for group, eps in routers.items():
        # Generate router file
        router_file = os.path.join(routers_dir, f"{group}.py")
        if os.path.exists(router_file):
            continue  # Don't overwrite existing code

        lines = [
            f'"""Routes for /{group} endpoints — scaffolded from contract."""',
            '',
            'from fastapi import APIRouter, Depends, HTTPException',
            'from pydantic import BaseModel',
            '',
            f'router = APIRouter(prefix="/api/{group}", tags=["{group}"])',
            '',
            '',
        ]

        # Generate Pydantic models for request/response
        for ep in eps:
            method = ep.get("method", "GET").upper()
            path = ep.get("path", "")
            func_name = path_to_function_name(method, path)
            params = path_to_param_name(path)

            # Request model
            request_fields = ep.get("request", {})
            if request_fields and method in ("POST", "PUT", "PATCH"):
                model_name = f"{func_name.title().replace('_', '')}Request"
                lines.append(f'class {model_name}(BaseModel):')
                for field_name, field_def in request_fields.items():
                    if isinstance(field_def, dict):
                        ftype = field_def.get("type", "str")
                        py_type = {"string": "str", "integer": "int", "boolean": "bool", "array": "list"}.get(ftype, "str")
                        required = field_def.get("required", True)
                        if not required:
                            lines.append(f'    {field_name}: {py_type} | None = None')
                        else:
                            lines.append(f'    {field_name}: {py_type}')
                    else:
                        lines.append(f'    {field_name}: str')
                lines.append('')
                lines.append('')

            # Route decorator and function
            # Convert contract path to FastAPI path format
            route_path = path.replace(f"/api/{group}", "") or "/"
            param_str = ", ".join(f"{p}: str" for p in params)
            if param_str:
                param_str = ", " + param_str

            lines.append(f'@router.{method.lower()}("{route_path}")')

            if request_fields and method in ("POST", "PUT", "PATCH"):
                model_name = f"{func_name.title().replace('_', '')}Request"
                lines.append(f'async def {func_name}(body: {model_name}{param_str}):')
            else:
                lines.append(f'async def {func_name}({param_str.lstrip(", ")}):')

            lines.append(f'    """TODO: Implement {method} {path}."""')
            lines.append('    raise HTTPException(status_code=501, detail="Not implemented")')
            lines.append('')
            lines.append('')

        Path(router_file).write_text('\n'.join(lines))
        files_created.append(os.path.relpath(router_file, output_dir))

        # Generate test file
        test_file = os.path.join(tests_dir, f"test_{group}.py")
        if os.path.exists(test_file):
            continue

        test_lines = [
            f'"""Tests for /{group} endpoints — scaffolded from contract."""',
            '',
            'import pytest',
            'from httpx import AsyncClient, ASGITransport',
            '',
            'from src.main import app',
            '',
            '',
            '@pytest.fixture',
            'async def client():',
            '    transport = ASGITransport(app=app)',
            '    async with AsyncClient(transport=transport, base_url="http://test") as ac:',
            '        yield ac',
            '',
            '',
        ]

        for ep in eps:
            method = ep.get("method", "GET").upper()
            path = ep.get("path", "")
            func_name = path_to_function_name(method, path)
            responses = ep.get("response", {})

            # Replace path params with test values
            test_path = path
            for param in path_to_param_name(path):
                test_path = test_path.replace(f"{{{param}}}", "test-id-123")

            test_lines.append('@pytest.mark.asyncio')
            test_lines.append(f'async def test_{func_name}(client):')
            test_lines.append(f'    """Test {method} {path}."""')

            if method in ("POST", "PUT", "PATCH"):
                request_fields = ep.get("request", {})
                body = {}
                for field_name, field_def in request_fields.items():
                    if isinstance(field_def, dict):
                        ftype = field_def.get("type", "string")
                        if ftype == "string":
                            body[field_name] = f"test-{field_name}"
                        elif ftype == "integer":
                            body[field_name] = 1
                        elif ftype == "boolean":
                            body[field_name] = True
                        elif ftype == "array":
                            body[field_name] = []
                    else:
                        body[field_name] = f"test-{field_name}"
                test_lines.append(f'    response = await client.{method.lower()}("{test_path}", json={json.dumps(body)})')
            else:
                test_lines.append(f'    response = await client.{method.lower()}("{test_path}")')

            # Assert first success status code
            success_codes = [c for c in responses.keys() if isinstance(c, int) and 200 <= c < 300]
            if success_codes:
                test_lines.append(f'    assert response.status_code == {success_codes[0]}')
            else:
                test_lines.append('    assert response.status_code in (200, 201)')
            test_lines.append('')
            test_lines.append('')

        Path(test_file).write_text('\n'.join(test_lines))
        files_created.append(os.path.relpath(test_file, output_dir))

    return files_created


def generate_typescript_client(contract: dict, output_dir: str) -> list[str]:
    """Generate TypeScript API client from contract."""
    files_created = []
    endpoints = contract.get("endpoints", [])
    if not endpoints:
        return files_created

    api_dir = os.path.join(output_dir, "src", "api")
    os.makedirs(api_dir, exist_ok=True)

    contract_name = contract.get("name", "api")
    client_file = os.path.join(api_dir, f"{contract_name}.ts")
    if os.path.exists(client_file):
        return files_created

    lines = [
        f'/** API client for {contract_name} — scaffolded from contract. */',
        '',
        'const BASE_URL = import.meta.env.VITE_API_URL || "";',
        '',
        'async function request<T>(method: string, path: string, body?: unknown): Promise<T> {',
        '  const response = await fetch(`${BASE_URL}${path}`, {',
        '    method,',
        '    headers: { "Content-Type": "application/json" },',
        '    body: body ? JSON.stringify(body) : undefined,',
        '  });',
        '  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);',
        '  return response.json();',
        '}',
        '',
    ]

    # Generate TypeScript interfaces and functions for each endpoint
    for ep in endpoints:
        method = ep.get("method", "GET").upper()
        path = ep.get("path", "")
        func_name = path_to_function_name(method, path)
        # Convert snake_case to camelCase
        camel_name = ''.join(
            word.capitalize() if i > 0 else word
            for i, word in enumerate(func_name.split('_'))
        )

        params = path_to_param_name(path)
        request_fields = ep.get("request", {})

        # Function signature
        param_parts = []
        for p in params:
            param_parts.append(f"{p}: string")
        if request_fields and method in ("POST", "PUT", "PATCH"):
            body_type = "{ " + "; ".join(f"{k}: string" for k in request_fields.keys()) + " }"
            param_parts.append(f"body: {body_type}")

        params_str = ", ".join(param_parts)

        # Build path with template literals
        ts_path = path
        for p in params:
            ts_path = ts_path.replace(f"{{{p}}}", f"${{{p}}}")
        if params:
            ts_path = f'`{ts_path}`'
        else:
            ts_path = f'"{ts_path}"'

        lines.append(f'export async function {camel_name}({params_str}) {{')
        if method in ("POST", "PUT", "PATCH"):
            lines.append(f'  return request("{method}", {ts_path}, body);')
        else:
            lines.append(f'  return request("{method}", {ts_path});')
        lines.append('}')
        lines.append('')

    Path(client_file).write_text('\n'.join(lines))
    files_created.append(os.path.relpath(client_file, output_dir))
    return files_created


@mcp.tool()
@track_usage("scaffold-generator")
def scaffold_from_contract(
    contract_path: str,
    target_dir: str,
    framework: str = "auto",
) -> str:
    """Use when starting a new API surface from a contract.

    Generates non-overwriting FastAPI route/test stubs or a TypeScript API
    client from `.contracts/*.yml`; it scaffolds structure only (no business logic).

    Args:
        contract_path: Path to the .contracts/*.yml file
        target_dir: Path to the target repo (e.g., ../team-brain-api)
        framework: "fastapi", "typescript", or "auto" (detect from repo)
    """
    if not os.path.isfile(contract_path):
        return json.dumps({"error": f"Contract file not found: {contract_path}"})

    try:
        with open(contract_path) as f:
            contract = yaml.safe_load(f)
    except yaml.YAMLError as e:
        return json.dumps({"error": f"Invalid YAML: {e}"})

    if not contract or "endpoints" not in contract:
        return json.dumps({"error": "Contract has no 'endpoints' section"})

    # Auto-detect framework
    if framework == "auto":
        if os.path.isfile(os.path.join(target_dir, "requirements.txt")):
            framework = "fastapi"
        elif os.path.isfile(os.path.join(target_dir, "package.json")):
            framework = "typescript"
        else:
            return json.dumps({"error": "Cannot detect framework. Specify 'fastapi' or 'typescript'."})

    # Generate scaffolding
    if framework == "fastapi":
        files = generate_fastapi_scaffold(contract, target_dir)
    elif framework == "typescript":
        files = generate_typescript_client(contract, target_dir)
    else:
        return json.dumps({"error": f"Unsupported framework: {framework}"})

    return json.dumps({
        "contract": os.path.basename(contract_path),
        "target": os.path.basename(target_dir),
        "framework": framework,
        "files_created": files,
        "note": "Scaffolded stubs — fill in business logic and remove 501 placeholders.",
    })


if __name__ == "__main__":
    mcp.run()
