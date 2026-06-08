"""Deployment Verifier MCP Server — confirms deployments are live and healthy."""

import json
import sys
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage, log_usage_direct

mcp = FastMCP("deploy-verifier")


@mcp.tool()
@track_usage("deploy-verifier")
def verify_deployment(
    url: str,
    checks: list[str] | None = None,
    timeout_seconds: int = 10,
    expected_version: str | None = None,
) -> str:
    """Use right after deploy to confirm a single service is reachable and healthy.

    Probes one or more endpoints (default `/health` and `/version`) and returns
    status, response time, and optional version-match checks.

    Args:
        url: Base URL of the service (e.g., https://team-brain-api.azurecontainerapps.io)
        checks: List of endpoints to check (default: ["/health", "/version"])
        timeout_seconds: Request timeout per check
        expected_version: If provided, verify /version returns this build number
    """
    if not checks:
        checks = ["/health", "/version"]

    results = []
    all_healthy = True

    for endpoint in checks:
        check_url = f"{url.rstrip('/')}{endpoint}"
        try:
            with httpx.Client(timeout=timeout_seconds) as client:
                response = client.get(check_url)
                result = {
                    "endpoint": endpoint,
                    "status_code": response.status_code,
                    "response_time_ms": int(response.elapsed.total_seconds() * 1000),
                    "healthy": 200 <= response.status_code < 300,
                }

                # Parse response body
                try:
                    body = response.json()
                    result["body"] = body

                    # Check version if expected
                    if expected_version and endpoint == "/version":
                        actual_version = body.get("build") or body.get("version") or str(body)
                        result["version_match"] = str(expected_version) in str(actual_version)
                        if not result["version_match"]:
                            result["healthy"] = False
                            result["note"] = f"Expected version '{expected_version}', got '{actual_version}'"
                except (json.JSONDecodeError, ValueError):
                    result["body"] = response.text[:200]

                if not result["healthy"]:
                    all_healthy = False

        except httpx.TimeoutException:
            result = {"endpoint": endpoint, "healthy": False, "error": "Timeout"}
            all_healthy = False
        except httpx.ConnectError as e:
            result = {"endpoint": endpoint, "healthy": False, "error": f"Connection failed: {e}"}
            all_healthy = False
        except Exception as e:
            result = {"endpoint": endpoint, "healthy": False, "error": str(e)}
            all_healthy = False

        results.append(result)

    return json.dumps({
        "url": url,
        "healthy": all_healthy,
        "checks": results,
    })


@mcp.tool()
@track_usage("deploy-verifier")
def verify_all_services(
    services: list[dict],
    timeout_seconds: int = 10,
) -> str:
    """Use for release gates that require cross-service health checks.

    Runs `verify_deployment` over a service list and returns per-service details
    plus a concise fleet health summary.

    Args:
        services: List of {"name": "api", "url": "https://...", "checks": ["/health"]}
        timeout_seconds: Request timeout per check
    """
    results = []
    all_healthy = True

    for svc in services:
        name = svc.get("name", "unknown")
        url = svc.get("url", "")
        checks = svc.get("checks", ["/health"])

        if not url:
            results.append({"name": name, "healthy": False, "error": "No URL provided"})
            all_healthy = False
            continue

        # Reuse single-service check
        result = json.loads(verify_deployment(url, checks, timeout_seconds))
        result["name"] = name
        if not result.get("healthy"):
            all_healthy = False
        results.append(result)

    passing = sum(1 for r in results if r.get("healthy"))
    return json.dumps({
        "summary": f"{passing}/{len(results)} services healthy",
        "all_healthy": all_healthy,
        "services": results,
    })


if __name__ == "__main__":
    mcp.run()
