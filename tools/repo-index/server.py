"""Repo Index MCP Server — validates and inspects .repo-index.yml child repo references."""

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml
from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.instrumentation import track_usage, log_usage_direct

mcp = FastMCP("repo-index")


def run_git(args: list[str], cwd: str = ".") -> tuple[int, str]:
    result = subprocess.run(
        ["git"] + args, cwd=cwd, capture_output=True, text=True
    )
    return result.returncode, result.stdout.strip() or result.stderr.strip()


def _repo_index_path(project_dir: str) -> str:
    return os.path.join(project_dir, ".repo-index.yml")


def _resolve_path(project_dir: str, path_value: str) -> str:
    if os.path.isabs(path_value):
        return path_value
    return os.path.normpath(os.path.join(project_dir, path_value))


def _load_repo_index(project_dir: str) -> tuple[dict | None, str | None]:
    path = _repo_index_path(project_dir)
    if not os.path.isfile(path):
        return None, f"Missing .repo-index.yml at {path}"

    try:
        with open(path) as f:
            data = yaml.safe_load(f) or {}
    except yaml.YAMLError as e:
        return None, f"Invalid YAML in .repo-index.yml: {e}"

    repos = data.get("repos")
    if not isinstance(repos, list):
        return None, "Invalid .repo-index.yml: expected top-level 'repos' list"

    return data, None


def _queue_snapshot(queue_dir: Path, max_files: int) -> tuple[int, list[str]]:
    if not queue_dir.is_dir():
        return 0, []
    files = sorted(path.name for path in queue_dir.iterdir() if path.is_file())
    return len(files), files[:max_files]


@mcp.tool()
@track_usage("repo-index")
def sync_repo_index(project_dir: str = ".") -> str:
    """Normalize and validate `.repo-index.yml` entries.

    Ensures each repo entry has required fields and defaults:
    `name`, `role`, `local_path`, `description`, `remote_url`, `default_branch`.
    Writes canonicalized YAML back only when needed.
    """
    data, err = _load_repo_index(project_dir)
    if err:
        return json.dumps({"ok": False, "error": err})

    changed = False
    normalized = []
    warnings = []
    seen_names = set()

    for entry in data.get("repos", []):
        if not isinstance(entry, dict):
            warnings.append("Skipped non-object repo entry")
            continue

        name = str(entry.get("name", "")).strip()
        if not name:
            warnings.append("Skipped repo entry missing name")
            continue
        if name in seen_names:
            warnings.append(f"Skipped duplicate repo entry: {name}")
            continue
        seen_names.add(name)

        local_path = str(entry.get("local_path", "")).strip() or f"../{name}"
        role = str(entry.get("role", "")).strip() or "worker"
        description = str(entry.get("description", "")).strip()
        remote_url = str(entry.get("remote_url", "")).strip()
        default_branch = str(entry.get("default_branch", "")).strip() or "main"

        normalized_entry = {
            "name": name,
            "role": role,
            "local_path": local_path,
            "description": description,
            "remote_url": remote_url,
            "default_branch": default_branch,
        }
        normalized.append(normalized_entry)

        if normalized_entry != entry:
            changed = True

    if normalized != data.get("repos"):
        data["repos"] = normalized
        changed = True

    if changed:
        with open(_repo_index_path(project_dir), "w") as f:
            yaml.safe_dump(data, f, sort_keys=False)

    return json.dumps({
        "ok": True,
        "changed": changed,
        "repo_count": len(normalized),
        "warnings": warnings if warnings else None,
    })


@mcp.tool()
@track_usage("repo-index")
def check_repo_index(project_dir: str = ".") -> str:
    """Check repo index health: local path existence, git status, and HEAD metadata."""
    data, err = _load_repo_index(project_dir)
    if err:
        return json.dumps({"ok": False, "error": err})

    results = []
    for entry in data.get("repos", []):
        if not isinstance(entry, dict):
            continue

        name = str(entry.get("name", "")).strip()
        local_path = str(entry.get("local_path", "")).strip()
        if not name or not local_path:
            continue

        abs_path = _resolve_path(project_dir, local_path)
        exists = os.path.isdir(abs_path)
        git_dir = os.path.isdir(os.path.join(abs_path, ".git")) or os.path.isfile(os.path.join(abs_path, ".git"))

        status = {
            "name": name,
            "local_path": local_path,
            "resolved_path": abs_path,
            "exists": exists,
            "is_git_repo": exists and git_dir,
            "branch": None,
            "head": None,
        }

        if exists and git_dir:
            rc, branch = run_git(["branch", "--show-current"], cwd=abs_path)
            if rc == 0:
                status["branch"] = branch
            rc, head = run_git(["rev-parse", "HEAD"], cwd=abs_path)
            if rc == 0:
                status["head"] = head[:12]

        results.append(status)

    return json.dumps({"ok": True, "repos": results})


@mcp.tool()
@track_usage("repo-index")
def check_repo_queues(
    project_dir: str = ".",
    repos: list[str] | None = None,
    max_files_per_queue: int = 25,
) -> str:
    """Inspect child repo queue state without shell access to sibling repos."""
    if max_files_per_queue < 1 or max_files_per_queue > 200:
        return json.dumps(
            {
                "ok": False,
                "error": {
                    "code": "INVALID_MAX_FILES_PER_QUEUE",
                    "message": "max_files_per_queue must be between 1 and 200",
                },
            }
        )

    data, err = _load_repo_index(project_dir)
    if err:
        return json.dumps({"ok": False, "error": err})

    requested = None
    if repos is not None:
        if not isinstance(repos, list) or any(not isinstance(item, str) or not item.strip() for item in repos):
            return json.dumps({"ok": False, "error": "repos must be a list of non-empty repo names"})
        requested = {item.strip() for item in repos}

    results = []
    for entry in data.get("repos", []):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name", "")).strip()
        local_path = str(entry.get("local_path", "")).strip()
        if not name or not local_path:
            continue
        if requested is not None and name not in requested:
            continue

        resolved = Path(_resolve_path(project_dir, local_path))
        todo_dir = resolved / "work" / "todo"
        rfr_dir = resolved / "work" / "ready-for-review"
        done_dir = resolved / "work" / "done"

        todo_count, todo_files = _queue_snapshot(todo_dir, max_files_per_queue)
        rfr_count, rfr_files = _queue_snapshot(rfr_dir, max_files_per_queue)
        done_count, done_files = _queue_snapshot(done_dir, max_files_per_queue)

        results.append(
            {
                "name": name,
                "local_path": local_path,
                "resolved_path": str(resolved),
                "exists": resolved.is_dir(),
                "queues": {
                    "todo": {
                        "exists": todo_dir.is_dir(),
                        "count": todo_count,
                        "files": todo_files,
                    },
                    "ready_for_review": {
                        "exists": rfr_dir.is_dir(),
                        "count": rfr_count,
                        "files": rfr_files,
                    },
                    "done": {
                        "exists": done_dir.is_dir(),
                        "count": done_count,
                        "files": done_files,
                    },
                },
            }
        )

    return json.dumps({"ok": True, "repos": results})


if __name__ == "__main__":
    mcp.run()
