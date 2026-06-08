"""Submodule Sync MCP Server — syncs child repo commits to parent .gitmodules."""

import json
import subprocess
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage, log_usage_direct

mcp = FastMCP("submodule-sync")


def run_git(args: list[str], cwd: str = ".") -> tuple[int, str]:
    result = subprocess.run(
        ["git"] + args, cwd=cwd, capture_output=True, text=True
    )
    return result.returncode, result.stdout.strip() or result.stderr.strip()


@mcp.tool()
@track_usage("submodule-sync")
def sync_submodules(
    repos: list[str] | None = None,
    push: bool = False,
    project_dir: str = ".",
) -> str:
    """Use after child repos change to update parent submodule pointers.

    Stages `work/<repo>` submodule refs, commits if needed, and optionally pushes;
    operates only on gitlinks (no child code changes).

    Args:
        repos: List of child repo names to sync (default: all in work/)
        push: Whether to push the parent after committing
        project_dir: Path to the parent project root
    """
    import os

    work_dir = os.path.join(project_dir, "work")
    if not os.path.isdir(work_dir):
        return json.dumps({"error": "No work/ directory found", "project_dir": project_dir})

    # Discover repos if not specified
    if not repos:
        repos = [
            d for d in os.listdir(work_dir)
            if os.path.isdir(os.path.join(work_dir, d, ".git"))
            or os.path.isfile(os.path.join(work_dir, d, ".git"))
        ]

    if not repos:
        return json.dumps({"error": "No submodules found in work/"})

    synced = []
    errors = []

    for name in repos:
        repo_path = os.path.join(work_dir, name)
        if not os.path.exists(repo_path):
            errors.append({"repo": name, "error": "Directory not found"})
            continue

        # Get current HEAD of child
        rc, sha = run_git(["rev-parse", "HEAD"], cwd=repo_path)
        if rc != 0:
            errors.append({"repo": name, "error": f"Failed to get HEAD: {sha}"})
            continue

        # Update submodule reference in parent
        rc, out = run_git(["add", f"work/{name}"], cwd=project_dir)
        if rc != 0:
            errors.append({"repo": name, "error": f"Failed to stage: {out}"})
            continue

        synced.append({"repo": name, "sha": sha[:12]})

    # Check if there are staged changes
    rc, diff = run_git(["diff", "--cached", "--name-only"], cwd=project_dir)
    if not diff:
        return json.dumps({"synced": synced, "committed": False, "message": "Already up to date"})

    # Commit
    repo_list = ", ".join(s["repo"] for s in synced)
    commit_msg = f"chore: sync submodule refs ({repo_list})"
    rc, out = run_git(["commit", "-m", commit_msg], cwd=project_dir)
    committed = rc == 0

    # Push if requested
    pushed = False
    if push and committed:
        rc, out = run_git(["push"], cwd=project_dir)
        pushed = rc == 0

    return json.dumps({
        "synced": synced,
        "committed": committed,
        "pushed": pushed,
        "errors": errors if errors else None,
    })


@mcp.tool()
@track_usage("submodule-sync")
def check_submodule_status(project_dir: str = ".") -> str:
    """Use to see whether parent-pinned SHAs match child repo HEADs.

    Compares each `work/*` repo's local HEAD to the SHA pinned in parent `HEAD`
    to highlight sync gaps before release or handoff.

    Args:
        project_dir: Path to the parent project root
    """
    import os

    work_dir = os.path.join(project_dir, "work")
    if not os.path.isdir(work_dir):
        return json.dumps({"error": "No work/ directory found"})

    results = []
    for name in sorted(os.listdir(work_dir)):
        repo_path = os.path.join(work_dir, name)
        if not os.path.isdir(repo_path):
            continue

        rc, local_sha = run_git(["rev-parse", "HEAD"], cwd=repo_path)
        if rc != 0:
            continue

        # Check what parent thinks the submodule should be at
        rc, expected = run_git(["ls-tree", "HEAD", f"work/{name}"], cwd=project_dir)
        expected_sha = expected.split()[2] if expected and len(expected.split()) > 2 else "unknown"

        results.append({
            "repo": name,
            "local_head": local_sha[:12],
            "parent_expects": expected_sha[:12] if expected_sha != "unknown" else expected_sha,
            "in_sync": local_sha.startswith(expected_sha[:12]) if expected_sha != "unknown" else False,
        })

    return json.dumps({"submodules": results})


if __name__ == "__main__":
    mcp.run()
