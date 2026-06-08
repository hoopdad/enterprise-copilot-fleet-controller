"""Git PR Orchestrator MCP Server — automates commit, PR creation, CI monitoring, and merge workflows.

Coordinates multi-repo commits (parent + children), opens PRs, polls GitHub Actions CI,
and auto-merges on success. Designed for orchestrator agents to automate release workflows.
"""

import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage, log_usage_direct

mcp = FastMCP("git-pr-orchestrator")


def run_cmd(args: list[str], cwd: str = ".", timeout: int = 60) -> tuple[int, str]:
    """Run a shell command and return (returncode, output)."""
    try:
        result = subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
        return result.returncode, result.stdout.strip() or result.stderr.strip()
    except subprocess.TimeoutExpired:
        return 124, f"Command timed out after {timeout}s"
    except Exception as e:
        return 1, str(e)


def run_git(args: list[str], cwd: str = ".") -> tuple[int, str]:
    """Run a git command."""
    return run_cmd(["git"] + args, cwd=cwd)


def run_gh(args: list[str], repo: str | None = None) -> tuple[int, str]:
    """Run a gh CLI command."""
    cmd = ["gh"] + args
    if repo:
        cmd += ["-R", repo]
    return run_cmd(cmd, timeout=30)


@mcp.tool()
@track_usage("git-pr-orchestrator")
def commit_and_push(
    repos: list[str],
    parent_dir: str = ".",
    commit_message: str = "feat: complete feature development",
) -> str:
    """Commit changes in parent and child repos, then push to remote.

    Stages all modified files in each repo, commits with the provided message,
    and pushes to the default remote (typically origin). Stops on first error.

    Args:
        repos: List of repo paths relative to parent_dir; first item is parent.
               Example: [".", "../api", "../web"]
        parent_dir: Absolute or relative path to the parent directory
        commit_message: Commit message (use conventional commits for auto-versioning)

    Returns:
        JSON with committed repos, pushed status, and any errors.
    """
    results = {"committed": [], "pushed": [], "errors": []}

    for repo_path in repos:
        full_path = str(Path(parent_dir) / repo_path)

        # Stage all changes
        rc, out = run_git(["add", "-A"], cwd=full_path)
        if rc != 0:
            results["errors"].append({"repo": repo_path, "stage": out})
            break

        # Check if there are staged changes
        rc, diff_out = run_git(["diff", "--cached", "--quiet"], cwd=full_path)
        if rc == 0:
            # No changes
            results["committed"].append({"repo": repo_path, "status": "no_changes"})
            continue

        # Commit
        rc, out = run_git(["commit", "-m", commit_message], cwd=full_path)
        if rc != 0:
            results["errors"].append({"repo": repo_path, "commit": out})
            break

        results["committed"].append({"repo": repo_path, "sha": out.split()[-1][:12] if out else "unknown"})

        # Push
        rc, out = run_git(["push"], cwd=full_path)
        if rc != 0:
            results["errors"].append({"repo": repo_path, "push": out})
            break

        results["pushed"].append({"repo": repo_path, "status": "success"})

    return json.dumps(results)


@mcp.tool()
@track_usage("git-pr-orchestrator")
def create_prs(
    repos: list[str],
    base_branch: str = "main",
    head_branch: str | None = None,
    pr_title: str = "Complete feature development",
    pr_body: str = "",
) -> str:
    """Create pull requests for each repo on GitHub.

    For each repo, infers the current branch and creates a PR against base_branch.
    Requires authenticated `gh` CLI. If head_branch is specified, uses that for all repos;
    otherwise auto-detects from git.

    Args:
        repos: List of repo identifiers in owner/name format (e.g., ["myorg/api", "myorg/web"])
        base_branch: Target branch for PRs (default: main)
        head_branch: Source branch (if None, uses current branch from git)
        pr_title: PR title
        pr_body: PR body/description

    Returns:
        JSON with created PR numbers, URLs, and any errors.
    """
    results = {"created_prs": [], "errors": []}

    for repo in repos:
        # Auto-detect current branch if not specified
        current_branch = head_branch
        if not current_branch:
            rc, out = run_gh(["branch", "--show-current"], repo=repo)
            if rc != 0:
                results["errors"].append({"repo": repo, "branch_detect": out})
                continue
            current_branch = out.strip()

        # Skip if already on base branch
        if current_branch == base_branch:
            results["created_prs"].append({
                "repo": repo,
                "status": "skipped",
                "reason": f"Already on {base_branch}"
            })
            continue

        # Create PR
        cmd = [
            "pr", "create",
            "--base", base_branch,
            "--head", current_branch,
            "--title", pr_title,
        ]
        if pr_body:
            cmd += ["--body", pr_body]

        rc, out = run_gh(cmd, repo=repo)
        if rc != 0:
            results["errors"].append({"repo": repo, "pr_create": out})
            continue

        # Parse PR URL to extract number
        pr_url = out.strip()
        pr_num = pr_url.split("/")[-1] if "/" in pr_url else "unknown"
        results["created_prs"].append({
            "repo": repo,
            "pr_number": pr_num,
            "pr_url": pr_url,
            "head_branch": current_branch,
            "base_branch": base_branch,
        })

    return json.dumps(results)


@mcp.tool()
@track_usage("git-pr-orchestrator")
def wait_for_ci(
    repos: list[str],
    max_wait_seconds: int = 600,
    poll_interval_seconds: int = 10,
    base_branch: str = "main",
) -> str:
    """Poll GitHub Actions CI status for PRs until pass/fail.

    Checks the latest workflow run for each repo's base_branch. Blocks until all
    repos either pass, fail, or timeout is reached.

    Args:
        repos: List of repos in owner/name format
        max_wait_seconds: Maximum time to wait (default: 10 minutes)
        poll_interval_seconds: Poll frequency (default: 10s)
        base_branch: Branch to check CI status for

    Returns:
        JSON with final status per repo, total elapsed time, and any errors.
    """
    results = {
        "repo_statuses": {},
        "all_passed": False,
        "any_failed": False,
        "elapsed_seconds": 0,
        "errors": []
    }

    start_time = time.time()

    while time.time() - start_time < max_wait_seconds:
        all_done = True
        passed_count = 0
        failed_count = 0

        for repo in repos:
            if repo in results["repo_statuses"]:
                status = results["repo_statuses"][repo].get("conclusion")
                if status in ("success", "failure", "cancelled"):
                    if status == "success":
                        passed_count += 1
                    elif status == "failure":
                        failed_count += 1
                    continue

            all_done = False

            # Get latest run
            rc, out = run_gh([
                "run", "list", "-b", base_branch, "--limit", "1",
                "--json", "databaseId,status,conclusion,name,createdAt"
            ], repo=repo)

            if rc != 0:
                results["errors"].append({"repo": repo, "list_runs": out})
                continue

            try:
                runs = json.loads(out)
                if runs:
                    run = runs[0]
                    conclusion = run.get("conclusion", "pending")
                    results["repo_statuses"][repo] = {
                        "conclusion": conclusion,
                        "status": run.get("status", "unknown"),
                        "workflow": run.get("name"),
                    }

                    # Get failure details if failed
                    if conclusion == "failure":
                        rc2, jobs_out = run_gh([
                            "run", "view", str(run.get("databaseId")), "--json", "jobs"
                        ], repo=repo)

                        if rc2 == 0:
                            try:
                                jobs_data = json.loads(jobs_out)
                                for job in jobs_data.get("jobs", []):
                                    if job.get("conclusion") == "failure":
                                        results["repo_statuses"][repo]["failed_job"] = job.get("name")
                                        for step in job.get("steps", []):
                                            if step.get("conclusion") == "failure":
                                                results["repo_statuses"][repo]["failed_step"] = step.get("name")
                                                break
                                        break
                            except json.JSONDecodeError:
                                pass

                        # Get log tail
                        rc3, log_out = run_gh([
                            "run", "view", str(run.get("databaseId")), "--log-failed"
                        ], repo=repo)

                        if rc3 == 0 and log_out:
                            log_lines = log_out.strip().split('\n')
                            error_lines = [
                                l for l in log_lines[-30:]
                                if any(kw in l.lower() for kw in ['error', 'failed', 'assert', 'exception'])
                            ]
                            results["repo_statuses"][repo]["error_snippet"] = (
                                '\n'.join(error_lines[-5:]) if error_lines else '\n'.join(log_lines[-3:])
                            )

                    if conclusion in ("success", "failure", "cancelled"):
                        passed_count += 1 if conclusion == "success" else 0
                        failed_count += 1 if conclusion == "failure" else 0
                else:
                    results["repo_statuses"][repo] = {"conclusion": "no_runs"}
            except json.JSONDecodeError:
                results["errors"].append({"repo": repo, "parse_runs": "Invalid JSON response"})

        elapsed = time.time() - start_time
        results["elapsed_seconds"] = int(elapsed)

        # Check exit conditions
        if all_done:
            results["all_passed"] = failed_count == 0 and passed_count == len(repos)
            results["any_failed"] = failed_count > 0
            break

        time.sleep(poll_interval_seconds)

    if time.time() - start_time >= max_wait_seconds:
        results["timed_out"] = True
        results["message"] = f"CI check timed out after {max_wait_seconds}s"

    return json.dumps(results)


@mcp.tool()
@track_usage("git-pr-orchestrator")
def auto_merge_prs(
    repos: list[str],
    base_branch: str = "main",
    merge_method: str = "squash",
) -> str:
    """Auto-merge pull requests on base_branch for each repo.

    Uses `gh pr merge` with the specified strategy. Only merges if PR exists and
    is ready (CI passed, no conflicts, etc.). Requires authenticated `gh` CLI.

    Args:
        repos: List of repos in owner/name format
        base_branch: The branch PRs target (to find and merge them)
        merge_method: Merge strategy: 'squash' (default), 'merge', 'rebase'

    Returns:
        JSON with merged PRs and any errors.
    """
    results = {"merged": [], "errors": []}

    for repo in repos:
        # Find open PR for this branch
        rc, out = run_gh([
            "pr", "list", "--base", base_branch, "--state", "open",
            "--limit", "1", "--json", "number"
        ], repo=repo)

        if rc != 0:
            results["errors"].append({"repo": repo, "list_prs": out})
            continue

        try:
            prs = json.loads(out)
            if not prs:
                results["merged"].append({
                    "repo": repo,
                    "status": "no_pr",
                    "reason": f"No open PR to {base_branch}"
                })
                continue

            pr_num = prs[0]["number"]

            # Merge the PR
            cmd = ["pr", "merge", str(pr_num), f"--{merge_method}", "--auto"]
            rc, out = run_gh(cmd, repo=repo)

            if rc == 0:
                results["merged"].append({
                    "repo": repo,
                    "pr_number": pr_num,
                    "method": merge_method,
                    "status": "success"
                })
            else:
                # Check if it's already merged
                if "already merged" in out.lower():
                    results["merged"].append({
                        "repo": repo,
                        "pr_number": pr_num,
                        "status": "already_merged"
                    })
                else:
                    results["errors"].append({
                        "repo": repo,
                        "merge_pr": out,
                        "pr_number": pr_num
                    })
        except json.JSONDecodeError:
            results["errors"].append({"repo": repo, "parse_prs": "Invalid JSON response"})

    return json.dumps(results)


@mcp.tool()
@track_usage("git-pr-orchestrator")
def orchestrate_release(
    repos: list[str],
    parent_dir: str = ".",
    commit_message: str = "feat: release",
    pr_title: str = "Release",
    pr_body: str = "",
    base_branch: str = "main",
    wait_ci: bool = True,
    max_wait_seconds: int = 600,
    auto_merge: bool = True,
    merge_method: str = "squash",
) -> str:
    """End-to-end release orchestration: commit → push → PR → wait CI → merge.

    Coordinates the full workflow across parent and child repos. Commits, creates PRs,
    optionally waits for CI, and optionally auto-merges on success.

    Args:
        repos: List of repo paths (parent first), e.g., [".", "../api", "../web"]
        parent_dir: Path to parent directory
        commit_message: Commit message (use conventional commits for auto-versioning)
        pr_title: PR title
        pr_body: PR description
        base_branch: Target branch for PRs
        wait_ci: If True, poll CI until pass/fail
        max_wait_seconds: Max time to wait for CI
        auto_merge: If True and CI passes, auto-merge the PR
        merge_method: Merge strategy if auto_merge=True

    Returns:
        JSON with full workflow status: commits, PRs created, CI results, merge status.
    """
    workflow = {
        "phase": "starting",
        "repos": repos,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "results": {}
    }

    # Phase 1: Commit and push
    workflow["phase"] = "commit_and_push"
    commit_result = commit_and_push(repos, parent_dir, commit_message)
    workflow["results"]["commit"] = json.loads(commit_result)

    if workflow["results"]["commit"].get("errors"):
        workflow["phase"] = "failed_at_commit"
        return json.dumps(workflow)

    # Phase 2: Create PRs (use parent repo name for full owner/name format)
    # For this, we need to map repo paths to GitHub owner/name
    # For now, we'll require repos to be in owner/name format for PR creation
    workflow["phase"] = "create_prs"
    pr_result = create_prs(repos, base_branch, pr_title=pr_title, pr_body=pr_body)
    workflow["results"]["prs"] = json.loads(pr_result)

    if workflow["results"]["prs"].get("errors"):
        workflow["phase"] = "failed_at_pr_creation"
        return json.dumps(workflow)

    # Phase 3: Wait for CI
    if wait_ci:
        workflow["phase"] = "wait_for_ci"
        ci_result = wait_for_ci(repos, max_wait_seconds, base_branch=base_branch)
        workflow["results"]["ci"] = json.loads(ci_result)

        ci_status = workflow["results"]["ci"]
        if ci_status.get("any_failed"):
            workflow["phase"] = "failed_ci"
            return json.dumps(workflow)

        if ci_status.get("timed_out"):
            workflow["phase"] = "ci_timeout"
            return json.dumps(workflow)

    # Phase 4: Auto-merge
    if auto_merge:
        workflow["phase"] = "auto_merge"
        merge_result = auto_merge_prs(repos, base_branch, merge_method)
        workflow["results"]["merge"] = json.loads(merge_result)

        if workflow["results"]["merge"].get("errors"):
            workflow["phase"] = "failed_at_merge"
            return json.dumps(workflow)

    workflow["phase"] = "complete"
    workflow["status"] = "success"
    return json.dumps(workflow)


if __name__ == "__main__":
    mcp.run()
