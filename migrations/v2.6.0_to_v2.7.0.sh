#!/usr/bin/env bash
set -euo pipefail
# Migration: v2.6.0 → v2.7.0
# Introduces .repo-index.yml external child repo references and repo-index MCP wiring.
#
# Env provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — path to enterprise-copilot-fleet-controller checkout

[[ -z "${PROJECT_DIR:-}" ]] && echo "ERROR: PROJECT_DIR not set" && exit 1
[[ -z "${FRAMEWORK_DIR:-}" ]] && echo "ERROR: FRAMEWORK_DIR not set" && exit 1

echo "  → Migrating project to repo-index model..."

python3 - "$PROJECT_DIR" "$FRAMEWORK_DIR" <<'PYEOF'
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

project_dir = Path(sys.argv[1])
framework_dir = Path(sys.argv[2])

repo_index_path = project_dir / ".repo-index.yml"
agents_dir = project_dir / ".github" / "agents"


def git_remote_origin(repo_path: Path) -> str:
    try:
        out = subprocess.check_output(
            ["git", "-C", str(repo_path), "remote", "get-url", "origin"],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        return out
    except Exception:
        return ""


def infer_repo_entries() -> list[dict]:
    entries: list[dict] = []
    seen = set()

    if agents_dir.is_dir():
        for agent_file in sorted(agents_dir.glob("*-specialist.agent.md")):
            name = agent_file.name.replace("-specialist.agent.md", "")
            if name in seen:
                continue
            seen.add(name)

            content = agent_file.read_text(encoding="utf-8")
            role_match = re.search(r"You are the ([a-zA-Z0-9_-]+) specialist", content)
            role = role_match.group(1) if role_match else "worker"
            desc_match = re.search(r'^description:\s*"?([^"\n]+)"?', content, flags=re.MULTILINE)
            description = desc_match.group(1).strip() if desc_match else ""

            legacy_path = project_dir / "work" / name
            if legacy_path.exists():
                local_path = f"work/{name}"
                remote_url = git_remote_origin(legacy_path)
            else:
                local_path = f"../{name}"
                remote_url = ""

            entries.append(
                {
                    "name": name,
                    "role": role,
                    "local_path": local_path,
                    "description": description,
                    "remote_url": remote_url,
                    "default_branch": "main",
                }
            )

    if not entries:
        work_dir = project_dir / "work"
        if work_dir.is_dir():
            for child in sorted(work_dir.iterdir()):
                if not child.is_dir():
                    continue
                name = child.name
                if name in seen:
                    continue
                seen.add(name)
                entries.append(
                    {
                        "name": name,
                        "role": "worker",
                        "local_path": f"work/{name}",
                        "description": "",
                        "remote_url": git_remote_origin(child),
                        "default_branch": "main",
                    }
                )

    return entries


if not repo_index_path.exists():
    entries = infer_repo_entries()
    repo_index_path.write_text(
        yaml.safe_dump({"repos": entries}, sort_keys=False),
        encoding="utf-8",
    )
    if entries:
        print("    Created .repo-index.yml")
    else:
        print("    Created empty .repo-index.yml (no child repos discovered)")
else:
    print("    .repo-index.yml already exists")


repo_map: dict[str, str] = {}
if repo_index_path.exists():
    data = yaml.safe_load(repo_index_path.read_text(encoding="utf-8")) or {}
    for entry in data.get("repos", []):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name", "")).strip()
        local_path = str(entry.get("local_path", "")).strip()
        if name and local_path:
            repo_map[name] = local_path


instructions_path = project_dir / ".copilot" / "instructions.md"
if instructions_path.exists():
    content = instructions_path.read_text(encoding="utf-8")
    updated = content

    for name, local_path in repo_map.items():
        updated = updated.replace(f"work/{name}", local_path)

    updated = updated.replace("sync_submodules", "check_repo_index / sync_repo_index")
    updated = updated.replace("update parent refs", "verify/normalize repo references")

    if ".repo-index.yml" not in updated:
        insert_text = (
            "Use `.repo-index.yml` as the source of truth for specialist repo paths.\n"
            "Never assume child repos are mounted under `work/`.\n"
        )
        marker = "## Your Protocol"
        if marker in updated:
            updated = updated.replace(marker, insert_text + "\n" + marker, 1)
        else:
            updated = updated.rstrip() + "\n\n" + insert_text

    if updated != content:
        instructions_path.write_text(updated, encoding="utf-8")
        print("    Updated .copilot/instructions.md")
    else:
        print("    .copilot/instructions.md already aligned")
else:
    print("    .copilot/instructions.md not found — skipping")


if agents_dir.is_dir():
    changed_count = 0
    for agent_file in sorted(agents_dir.glob("*-specialist.agent.md")):
        name = agent_file.name.replace("-specialist.agent.md", "")
        local_path = repo_map.get(name)
        if not local_path:
            continue
        content = agent_file.read_text(encoding="utf-8")
        updated = content.replace(f"work/{name}", local_path)
        if updated != content:
            agent_file.write_text(updated, encoding="utf-8")
            changed_count += 1
    print(f"    Updated {changed_count} specialist agent file(s)")


mcp_path = project_dir / ".copilot" / "mcp.json"
if mcp_path.exists():
    data = json.loads(mcp_path.read_text(encoding="utf-8"))
    servers = data.get("mcpServers", {})

    repo_index_cfg = {
        "description": "Validate and inspect external child-repo references from .repo-index.yml.",
        "command": "python3",
        "args": [str(framework_dir / "tools" / "repo-index" / "server.py")],
        "env": {"PROJECT_DIR": str(project_dir)},
    }

    if "submodule-sync" in servers:
        old = servers.pop("submodule-sync")
        if isinstance(old, dict):
            args = old.get("args", [])
            if isinstance(args, list) and args:
                first = str(args[0]).replace("submodule-sync/server.py", "repo-index/server.py")
                repo_index_cfg["args"] = [first]
            env = old.get("env", {})
            if isinstance(env, dict):
                repo_index_cfg["env"] = env

    servers["repo-index"] = repo_index_cfg
    data["mcpServers"] = servers
    data["_framework_version"] = "2.7.0"
    mcp_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print("    Updated .copilot/mcp.json")
else:
    print("    .copilot/mcp.json not found (MCP disabled) — skipping")
PYEOF

echo "  ✓ Migration complete"
