"""CI/CD Monitor MCP Server — checks GitHub Actions status and extracts failure info."""

import json
import subprocess
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage, log_usage_direct

mcp = FastMCP("ci-monitor")


def run_gh(args: list[str], repo: str | None = None) -> tuple[int, str]:
    """Run a gh CLI command."""
    cmd = ["gh"] + args
    if repo:
        cmd += ["-R", repo]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return result.returncode, result.stdout.strip() or result.stderr.strip()


@mcp.tool()
@track_usage("ci-monitor")
def check_ci_status(repo: str, branch: str = "main") -> str:
    """Use after a push/PR update to inspect recent runs for one repo branch.

    Summarizes latest GitHub Actions runs and, for failures, pulls failed job/step
    hints and error-log snippets; requires authenticated `gh` CLI.

    Args:
        repo: Repository in owner/name format (e.g., hoopdad/team-brain-api)
        branch: Branch to check (default: main)
    """
    # Get latest workflow runs
    rc, out = run_gh([
        "run", "list", "-b", branch, "--limit", "5", "--json",
        "databaseId,name,status,conclusion,headSha,createdAt,updatedAt"
    ], repo=repo)

    if rc != 0:
        return json.dumps({"error": f"Failed to list runs: {out}"})

    try:
        runs = json.loads(out)
    except json.JSONDecodeError:
        return json.dumps({"error": f"Invalid response: {out[:200]}"})

    if not runs:
        return json.dumps({"repo": repo, "branch": branch, "runs": [], "message": "No workflow runs found"})

    results = []
    for run in runs:
        entry = {
            "id": run.get("databaseId"),
            "workflow": run.get("name"),
            "status": run.get("status"),
            "conclusion": run.get("conclusion"),
            "sha": run.get("headSha", "")[:12],
            "created": run.get("createdAt"),
        }

        # If failed, get failure details
        if run.get("conclusion") == "failure":
            rc2, jobs_out = run_gh([
                "run", "view", str(run["databaseId"]), "--json",
                "jobs"
            ], repo=repo)

            if rc2 == 0:
                try:
                    jobs_data = json.loads(jobs_out)
                    for job in jobs_data.get("jobs", []):
                        if job.get("conclusion") == "failure":
                            entry["failed_job"] = job.get("name")
                            # Get failed steps
                            for step in job.get("steps", []):
                                if step.get("conclusion") == "failure":
                                    entry["failed_step"] = step.get("name")
                                    break
                            break
                except json.JSONDecodeError:
                    pass

            # Get log tail for the failed run
            rc3, log_out = run_gh([
                "run", "view", str(run["databaseId"]), "--log-failed"
            ], repo=repo)

            if rc3 == 0 and log_out:
                # Extract last meaningful lines (skip timestamps, get errors)
                log_lines = log_out.strip().split('\n')
                # Filter for error-like lines
                error_lines = [
                    l for l in log_lines[-50:]
                    if any(kw in l.lower() for kw in ['error', 'failed', 'assert', 'exception', 'traceback'])
                ]
                entry["error_summary"] = '\n'.join(error_lines[-10:]) if error_lines else '\n'.join(log_lines[-5:])

        results.append(entry)

    # Overall status
    latest = results[0] if results else {}
    return json.dumps({
        "repo": repo,
        "branch": branch,
        "latest_status": latest.get("conclusion") or latest.get("status"),
        "runs": results,
    })


@mcp.tool()
@track_usage("ci-monitor")
def check_all_repos_ci(repos: list[str], branch: str = "main") -> str:
    """Use for fleet-level CI snapshots across multiple repos.

    Fetches the latest run per repo and returns a compact pass/fail/other summary
    for quick orchestration decisions.

    Args:
        repos: List of repos in owner/name format
        branch: Branch to check
    """
    results = []
    for repo in repos:
        rc, out = run_gh([
            "run", "list", "-b", branch, "--limit", "1", "--json",
            "name,status,conclusion,headSha"
        ], repo=repo)

        if rc != 0:
            results.append({"repo": repo, "error": out})
            continue

        try:
            runs = json.loads(out)
            if runs:
                latest = runs[0]
                results.append({
                    "repo": repo,
                    "workflow": latest.get("name"),
                    "status": latest.get("conclusion") or latest.get("status"),
                    "sha": latest.get("headSha", "")[:12],
                })
            else:
                results.append({"repo": repo, "status": "no_runs"})
        except json.JSONDecodeError:
            results.append({"repo": repo, "error": "Invalid response"})

    # Summary
    passing = sum(1 for r in results if r.get("status") == "success")
    failing = sum(1 for r in results if r.get("status") == "failure")

    return json.dumps({
        "summary": f"{passing} passing, {failing} failing, {len(results) - passing - failing} other",
        "repos": results,
    })


if __name__ == "__main__":
    mcp.run()
