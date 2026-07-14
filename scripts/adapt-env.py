#!/usr/bin/env python3
"""Adapt a fleet-controller project to the current host environment.

When a project that was initialized on one OS (e.g. Linux/bash) is cloned onto a
different OS (e.g. Windows/PowerShell), the generated ``.github/mcp.json`` files
still point at the *old* framework location and the *old* venv interpreter
layout (``.venv/bin/python`` vs ``.venv/Scripts/python.exe``). Copilot CLI then
fails to spawn the MCP servers.

Run this once after cloning to re-root every MCP server entry at:

* **this** framework checkout (the repo that contains this script), and
* **this** OS's venv interpreter,

while preserving each server's identity, env, and description.

Usage::

    python scripts/adapt-env.py                 # fix ./.github/mcp.json (+ children)
    python scripts/adapt-env.py --project-dir /path/to/project
    python scripts/adapt-env.py --commit        # fix, then commit each repo
    python scripts/adapt-env.py --dry-run       # show changes, write nothing
    python scripts/adapt-env.py --check         # exit 1 if anything would change

The re-rooting matches each server-script argument by its ``tools/<name>/...``
suffix, so it works regardless of the old absolute path or OS separators.

Parent and child repos are *separate* git repositories. Writing the files is not
enough — each repo must be committed on its own. Pass ``--commit`` to do this, or
heed the per-repo reminder printed after a plain run.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "init"))
from envinfo import venv_python  # noqa: E402


def _framework_dir() -> Path:
    # adapt-env.py lives at <framework>/scripts/adapt-env.py
    return Path(__file__).resolve().parents[1]


def _git_toplevel(path: Path) -> Path | None:
    """Return the git repository root that contains ``path``, or None.

    Child repos in a fleet-controller project are *separate* git repositories, so
    a commit in the parent repo does NOT capture changes written into a child's
    ``.github/mcp.json``. This lets us group written files by their owning repo.
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(path.parent), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    top = out.stdout.strip()
    return Path(top).resolve() if top else None


def _reroot_tool_arg(arg: str, framework_dir: Path) -> str:
    """Re-root a framework path argument (e.g. a ``tools/x/server.py`` path).

    Matches by the ``tools/`` suffix so the old absolute prefix and separator
    style are irrelevant. Non-framework args are returned unchanged.
    """
    normalized = arg.replace("\\", "/")
    marker = "/tools/"
    if normalized.startswith("tools/"):
        suffix = normalized
    elif marker in normalized:
        suffix = normalized[normalized.rindex(marker) + 1 :]
    else:
        return arg
    return (framework_dir / suffix).as_posix()


def adapt_mcp_config(
    path: Path,
    framework_dir: Path,
    project_dir: Path | None,
    interpreter: str,
) -> tuple[dict, bool]:
    """Return (new_config, changed) for a single mcp.json file."""
    cfg = json.loads(path.read_text(encoding="utf-8"))
    servers = cfg.get("mcpServers") or cfg.get("servers") or {}
    changed = False

    for name, server in servers.items():
        if not isinstance(server, dict):
            continue
        # Only rewrite entries that launch a framework tool via the venv python.
        args = server.get("args") or []
        looks_like_tool = any("tools/" in str(a).replace("\\", "/") for a in args)
        if not looks_like_tool:
            continue

        if server.get("command") != interpreter:
            server["command"] = interpreter
            changed = True

        new_args = [_reroot_tool_arg(str(a), framework_dir) for a in args]
        if new_args != args:
            server["args"] = new_args
            changed = True

        if project_dir is not None:
            env = server.get("env")
            if isinstance(env, dict) and "PROJECT_DIR" in env:
                new_project = project_dir.as_posix()
                if env["PROJECT_DIR"] != new_project:
                    env["PROJECT_DIR"] = new_project
                    changed = True

    return cfg, changed


def _find_child_mcp_configs(project_dir: Path) -> list[Path]:
    """Discover child-repo mcp.json files referenced by .repo-index.yml."""
    index = project_dir / ".repo-index.yml"
    if not index.exists():
        return []
    try:
        import yaml  # local import; optional dependency

        data = yaml.safe_load(index.read_text(encoding="utf-8")) or {}
    except Exception:
        return []
    repos = data.get("repos") or data.get("children") or []
    found: list[Path] = []
    for repo in repos:
        if not isinstance(repo, dict):
            continue
        local = repo.get("local_path") or repo.get("path")
        if not local:
            continue
        candidate = (project_dir / local).resolve() / ".github" / "mcp.json"
        if candidate.exists():
            found.append(candidate)
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Adapt an mcp.json-based project to this host environment")
    parser.add_argument("--project-dir", type=Path, default=Path.cwd(), help="Project root (default: cwd)")
    parser.add_argument("--framework-dir", type=Path, default=None, help="Framework checkout (default: this repo)")
    parser.add_argument("--dry-run", action="store_true", help="Show changes but do not write")
    parser.add_argument("--check", action="store_true", help="Exit non-zero if anything would change (implies dry-run)")
    parser.add_argument("--no-children", action="store_true", help="Do not adapt child-repo mcp.json files")
    parser.add_argument(
        "--commit",
        action="store_true",
        help="git-commit each written mcp.json in its OWN repo (parent and each child are separate repos)",
    )
    args = parser.parse_args(argv)

    framework_dir = (args.framework_dir or _framework_dir()).resolve()
    project_dir = args.project_dir.resolve()
    interpreter = venv_python(framework_dir)
    dry_run = args.dry_run or args.check

    targets: list[tuple[Path, Path | None]] = []
    parent_cfg = project_dir / ".github" / "mcp.json"
    if parent_cfg.exists():
        targets.append((parent_cfg, project_dir))
    if not args.no_children:
        for child_cfg in _find_child_mcp_configs(project_dir):
            targets.append((child_cfg, child_cfg.parent.parent))

    if not targets:
        print(f"No mcp.json found under {project_dir} (nothing to adapt).")
        return 0

    print(f"Framework:   {framework_dir.as_posix()}")
    print(f"Interpreter: {interpreter}")
    print("")

    any_changed = False
    written: list[Path] = []
    for cfg_path, proj in targets:
        try:
            new_cfg, changed = adapt_mcp_config(cfg_path, framework_dir, proj, interpreter)
        except Exception as exc:  # pragma: no cover - defensive
            print(f"  [error] {cfg_path}: failed to parse ({exc})")
            continue
        rel = cfg_path
        if changed:
            any_changed = True
            if dry_run:
                print(f"  [would update] {rel}")
            else:
                cfg_path.write_text(json.dumps(new_cfg, indent=2) + "\n", encoding="utf-8")
                written.append(cfg_path)
                print(f"  [updated] {rel}")
        else:
            print(f"  [ok] {rel}")

    if args.check and any_changed:
        print("\nStale mcp.json detected. Run: python scripts/adapt-env.py")
        return 1
    if not any_changed:
        print("\nAll MCP configs already match this environment.")
        return 0
    if dry_run:
        return 0

    print("\nDone. MCP servers now point at this framework + this OS interpreter.")
    _finalize_written(written, commit=args.commit)
    return 0


def _finalize_written(written: list[Path], commit: bool) -> None:
    """Commit each written mcp.json in its own repo, or remind the operator to.

    Child repos are independent git repositories, so a single parent-repo commit
    never captures their changes. Without this, adapting an environment leaves
    child mcp.json files modified-but-uncommitted, which looks like "nothing was
    updated" once the working tree is inspected or reset.
    """
    if not written:
        return

    by_repo: dict[Path | None, list[Path]] = defaultdict(list)
    for path in written:
        by_repo[_git_toplevel(path)].append(path)

    tracked = {repo: paths for repo, paths in by_repo.items() if repo is not None}
    untracked = by_repo.get(None, [])

    if commit:
        print("\nCommitting mcp.json changes (one commit per repo):")
        for repo, paths in tracked.items():
            rels = [str(p.relative_to(repo)) for p in paths]
            try:
                subprocess.run(["git", "-C", str(repo), "add", *rels], check=True)
                subprocess.run(
                    ["git", "-C", str(repo), "commit", "-m", "chore: adapt mcp.json to host environment"],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                print(f"  [committed] {repo} ({len(rels)} file(s))")
            except subprocess.CalledProcessError as exc:
                detail = (exc.stderr or exc.stdout or str(exc)).strip()
                print(f"  [commit failed] {repo}: {detail}")
        for path in untracked:
            print(f"  [skipped, not a git repo] {path}")
        return

    print(
        "\nNOTE: these files are modified but NOT committed. Parent and each child are\n"
        "SEPARATE git repositories, so they must be committed individually. Re-run with\n"
        "--commit to do this automatically, or commit each repo below:"
    )
    for repo, paths in tracked.items():
        rels = " ".join(str(p.relative_to(repo)) for p in paths)
        print(f"  git -C {repo} add {rels} && git -C {repo} commit -m 'chore: adapt mcp.json to host environment'")
    for path in untracked:
        print(f"  [not a git repo] {path}")


if __name__ == "__main__":
    raise SystemExit(main())
