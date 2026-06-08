"""Security Scan Aggregator MCP Server — runs security tools and returns structured findings."""

import json
import os
import subprocess
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage, log_usage_direct

mcp = FastMCP("security-scanner")


def run_tool(args: list[str], cwd: str = ".") -> tuple[int, str]:
    """Run a security tool and capture output."""
    try:
        result = subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, timeout=120
        )
        return result.returncode, result.stdout + result.stderr
    except FileNotFoundError:
        return -1, f"Tool not found: {args[0]}"
    except subprocess.TimeoutExpired:
        return -2, "Tool timed out after 120s"


def parse_bandit_output(output: str) -> list[dict]:
    """Parse bandit JSON output into structured findings."""
    try:
        data = json.loads(output)
        findings = []
        for result in data.get("results", []):
            findings.append({
                "tool": "bandit",
                "file": result.get("filename", ""),
                "line": result.get("line_number", 0),
                "severity": result.get("issue_severity", "unknown").lower(),
                "confidence": result.get("issue_confidence", "unknown").lower(),
                "issue": result.get("issue_text", ""),
                "test_id": result.get("test_id", ""),
            })
        return findings
    except json.JSONDecodeError:
        return []


def parse_pip_audit_output(output: str) -> list[dict]:
    """Parse pip-audit JSON output."""
    try:
        data = json.loads(output)
        findings = []
        for vuln in data:
            findings.append({
                "tool": "pip-audit",
                "package": vuln.get("name", ""),
                "version": vuln.get("version", ""),
                "severity": "high",
                "issue": vuln.get("description", vuln.get("id", "Vulnerable dependency")),
                "fix_version": vuln.get("fix_versions", [None])[0] if vuln.get("fix_versions") else None,
            })
        return findings
    except json.JSONDecodeError:
        return []


def parse_npm_audit_output(output: str) -> list[dict]:
    """Parse npm audit JSON output."""
    try:
        data = json.loads(output)
        findings = []
        vulns = data.get("vulnerabilities", {})
        for name, info in vulns.items():
            findings.append({
                "tool": "npm-audit",
                "package": name,
                "severity": info.get("severity", "unknown"),
                "issue": info.get("title", info.get("via", [{}])[0] if isinstance(info.get("via"), list) else str(info.get("via", ""))),
                "fix_available": info.get("fixAvailable", False),
            })
        return findings
    except json.JSONDecodeError:
        return []


def parse_ruff_output(output: str) -> list[dict]:
    """Parse ruff JSON output for security-relevant rules."""
    try:
        data = json.loads(output)
        findings = []
        security_prefixes = ("S", "B")  # Security and Bandit rules in ruff
        for item in data:
            code = item.get("code", "")
            if code and code[0] in security_prefixes:
                findings.append({
                    "tool": "ruff",
                    "file": item.get("filename", ""),
                    "line": item.get("location", {}).get("row", 0),
                    "severity": "medium",
                    "issue": f"{code}: {item.get('message', '')}",
                })
        return findings
    except json.JSONDecodeError:
        return []


@mcp.tool()
@track_usage("security-scanner")
def security_scan(
    repo_path: str,
    tools: list[str] | None = None,
) -> str:
    """Use before merge/release to collect dependency and static security signals.

    Runs available scanners (bandit, pip-audit, npm-audit, ruff) and normalizes
    findings into one JSON payload; output quality depends on installed CLIs.

    Args:
        repo_path: Path to the repository to scan
        tools: List of tools to run. Options: bandit, pip-audit, npm-audit, ruff.
               Default: auto-detect based on repo type.
    """
    if not os.path.isdir(repo_path):
        return json.dumps({"error": f"Repository not found: {repo_path}"})

    # Auto-detect which tools to run
    if not tools:
        tools = []
        if os.path.isfile(os.path.join(repo_path, "requirements.txt")):
            tools.extend(["bandit", "pip-audit", "ruff"])
        if os.path.isfile(os.path.join(repo_path, "package.json")):
            tools.append("npm-audit")

    if not tools:
        return json.dumps({"error": "No applicable security tools detected for this repo"})

    all_findings = []
    tool_results = []

    for tool_name in tools:
        if tool_name == "bandit":
            src_dir = os.path.join(repo_path, "src")
            target = src_dir if os.path.isdir(src_dir) else repo_path
            rc, output = run_tool(["bandit", "-r", target, "-f", "json", "-q"], cwd=repo_path)
            findings = parse_bandit_output(output)
            tool_results.append({"tool": "bandit", "ran": rc != -1, "findings_count": len(findings)})
            all_findings.extend(findings)

        elif tool_name == "pip-audit":
            rc, output = run_tool(["pip-audit", "-f", "json", "-r", "requirements.txt"], cwd=repo_path)
            findings = parse_pip_audit_output(output)
            tool_results.append({"tool": "pip-audit", "ran": rc != -1, "findings_count": len(findings)})
            all_findings.extend(findings)

        elif tool_name == "npm-audit":
            rc, output = run_tool(["npm", "audit", "--json"], cwd=repo_path)
            findings = parse_npm_audit_output(output)
            tool_results.append({"tool": "npm-audit", "ran": rc != -1, "findings_count": len(findings)})
            all_findings.extend(findings)

        elif tool_name == "ruff":
            src_dir = os.path.join(repo_path, "src")
            target = src_dir if os.path.isdir(src_dir) else repo_path
            rc, output = run_tool(["ruff", "check", target, "--select", "S,B", "--output-format", "json"], cwd=repo_path)
            findings = parse_ruff_output(output)
            tool_results.append({"tool": "ruff", "ran": rc != -1, "findings_count": len(findings)})
            all_findings.extend(findings)

    # Summarize by severity
    critical = sum(1 for f in all_findings if f.get("severity") == "critical")
    high = sum(1 for f in all_findings if f.get("severity") == "high")
    medium = sum(1 for f in all_findings if f.get("severity") == "medium")
    low = sum(1 for f in all_findings if f.get("severity") == "low")

    return json.dumps({
        "repo": os.path.basename(repo_path),
        "tools_run": tool_results,
        "summary": {
            "total": len(all_findings),
            "critical": critical,
            "high": high,
            "medium": medium,
            "low": low,
        },
        "findings": all_findings,
    })


if __name__ == "__main__":
    mcp.run()
