#!/usr/bin/env bash
set -euo pipefail
# Migration: v2.8.0 → v2.9.0
# Moves specialist/critic workflow artifacts into child repos and refreshes metadata.
#
# Env provided by upgrade.sh:
#   PROJECT_DIR   — the project being upgraded
#   FRAMEWORK_DIR — path to enterprise-copilot-fleet-controller checkout

[[ -z "${PROJECT_DIR:-}" ]] && echo "ERROR: PROJECT_DIR not set" && exit 1
[[ -z "${FRAMEWORK_DIR:-}" ]] && echo "ERROR: FRAMEWORK_DIR not set" && exit 1

echo "  → Migrating child workflow artifacts into child repositories..."

python3 - "$PROJECT_DIR" <<'PYEOF'
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

project_dir = Path(sys.argv[1]).resolve()
repo_index_path = project_dir / ".repo-index.yml"
parent_agents_dir = project_dir / ".github" / "agents"


def resolve_repo_path(local_path: str) -> Path:
    candidate = Path(local_path)
    if candidate.is_absolute():
        return candidate
    return (project_dir / candidate).resolve()


def move_tree_contents(src: Path, dst: Path) -> int:
    moved = 0
    if not src.is_dir():
        return moved
    dst.mkdir(parents=True, exist_ok=True)
    for item in sorted(src.iterdir(), key=lambda p: p.name):
        target = dst / item.name
        if target.exists():
            continue
        shutil.move(str(item), str(target))
        moved += 1
    return moved


def remove_if_empty(path: Path) -> None:
    current = path
    while current != project_dir.parent and current.exists():
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def parse_repo_index(path: Path) -> list[dict[str, str]]:
    repos: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        name_match = re.match(r'^\s*-\s*name:\s*"(.*)"\s*$', line)
        if name_match:
            if current:
                repos.append(current)
            current = {"name": name_match.group(1)}
            continue
        if current is None:
            continue
        for key in ("role", "local_path", "description"):
            key_match = re.match(rf'^\s*{key}:\s*"(.*)"\s*$', line)
            if key_match:
                current[key] = key_match.group(1)
                break
    if current:
        repos.append(current)
    return repos


if not repo_index_path.exists():
    print("    .repo-index.yml not found — skipping child artifact migration")
    sys.exit(0)

repos = parse_repo_index(repo_index_path)

repo_names: list[str] = []
moved_agent_sources: list[Path] = []
queue_files_moved = 0
generated_agents = 0
copied_agents = 0

for entry in repos:
    if not isinstance(entry, dict):
        continue
    name = str(entry.get("name", "")).strip()
    local_path = str(entry.get("local_path", "")).strip()
    role = str(entry.get("role", "worker")).strip() or "worker"
    description = str(entry.get("description", "")).strip()
    if not name or not local_path:
        continue
    repo_names.append(name)
    repo_dir = resolve_repo_path(local_path)

    child_agents_dir = repo_dir / ".github" / "agents"
    child_work_dir = repo_dir / "work"
    child_agents_dir.mkdir(parents=True, exist_ok=True)
    (child_work_dir / "todo").mkdir(parents=True, exist_ok=True)
    (child_work_dir / "ready-for-review").mkdir(parents=True, exist_ok=True)
    (child_work_dir / "done").mkdir(parents=True, exist_ok=True)

    legacy_work_dir = project_dir / "work" / name
    queue_files_moved += move_tree_contents(legacy_work_dir / "todo", child_work_dir / "todo")
    queue_files_moved += move_tree_contents(legacy_work_dir / "ready-for-review", child_work_dir / "ready-for-review")
    queue_files_moved += move_tree_contents(legacy_work_dir / "done", child_work_dir / "done")
    remove_if_empty(legacy_work_dir / "todo")
    remove_if_empty(legacy_work_dir / "ready-for-review")
    remove_if_empty(legacy_work_dir / "done")
    remove_if_empty(legacy_work_dir)

    for kind in ("specialist", "critic"):
        child_agent = child_agents_dir / f"{name}-{kind}.agent.md"
        parent_agent = parent_agents_dir / f"{name}-{kind}.agent.md"
        if child_agent.exists():
            continue
        if parent_agent.exists():
            content = parent_agent.read_text(encoding="utf-8")
            content = re.sub(rf"\bwork/{re.escape(name)}/(todo|ready-for-review|done)\b", r"work/\1", content)
            content = content.replace(f"work/{name}", local_path)
            child_agent.write_text(content, encoding="utf-8")
            moved_agent_sources.append(parent_agent)
            copied_agents += 1
            continue

        if kind == "specialist":
            body = f"""---
name: {name}-specialist
description: "{description}. Handles implementation, testing, and validation for {local_path}."
tools: []
---

You are the {role} specialist for {name} ({local_path}).
Run this workflow from the child repo root.

## Protocol
1. Pick the next change request file from `work/todo/`
2. Implement only in this repository using referenced requirements/contracts
3. Run lint/test/build before commit
4. Append implementation notes, then move the request to `work/ready-for-review/`
"""
        else:
            body = f"""---
name: {name}-critic
description: "{description}. Reviews completed specialist requests for {local_path} and enforces PASS before done."
tools: []
---

You are the {role} critic for {name} ({local_path}).
Run this workflow from the child repo root.

## Protocol
1. Pick the next request from `work/ready-for-review/`
2. Validate requirements/contracts and run checks
3. If changes are required, move back to `work/todo/` with concrete feedback
4. When acceptable, append PASS rationale and move to `work/done/`
"""
        child_agent.write_text(body, encoding="utf-8")
        generated_agents += 1

for src in moved_agent_sources:
    if src.exists():
        src.unlink()
if parent_agents_dir.exists():
    remove_if_empty(parent_agents_dir)
    remove_if_empty(parent_agents_dir.parent)

instructions_path = project_dir / ".copilot" / "instructions.md"
if instructions_path.exists():
    content = instructions_path.read_text(encoding="utf-8")
    updated = content
    for name in repo_names:
        updated = re.sub(rf"\bwork/{re.escape(name)}/(todo|ready-for-review|done)\b", r"work/\1", updated)

    workflow_note = "Specialist and critic agents live inside each child repo under `.github/agents/`."
    if workflow_note not in updated:
        marker = "### Child Repo Workflow\n"
        if marker in updated:
            updated = updated.replace(marker, marker + "\n" + workflow_note + "\n", 1)
        else:
            updated = updated.rstrip() + "\n\n" + workflow_note + "\n"

    protocol_marker = "## Your Protocol"
    protocol_note = (
        "6. **Create child change request files** in each affected child repo under `work/todo/` (one file per request)\n"
        "7. **Start NEW Copilot CLI calls per child repo** (cwd = child repo root) so specialists execute request files from `work/todo/`\n"
        "8. **Wait for critic-approved completion** in child repo `work/done/` (critic iterates with specialist via `work/ready-for-review/`)\n"
        "9. **Validate done items** against acceptance criteria, then log novel decisions to .decisions/log.md\n"
    )
    if "work/ready-for-review" not in updated and protocol_marker in updated:
        updated = updated.replace(protocol_marker, protocol_marker + "\n\n" + protocol_note, 1)
    elif "work/ready-for-review" not in updated:
        updated = updated.rstrip() + "\n\n## Child Repo Protocol\n\n" + protocol_note

    if updated != content:
        instructions_path.write_text(updated, encoding="utf-8")
        print("    Updated .copilot/instructions.md")
    else:
        print("    .copilot/instructions.md already aligned")
else:
    print("    .copilot/instructions.md not found — skipping")

mcp_path = project_dir / ".copilot" / "mcp.json"
if mcp_path.exists():
    mcp_data = json.loads(mcp_path.read_text(encoding="utf-8"))
    if mcp_data.get("_framework_version") != "2.9.0":
        mcp_data["_framework_version"] = "2.9.0"
        mcp_path.write_text(json.dumps(mcp_data, indent=2) + "\n", encoding="utf-8")
        print("    Updated .copilot/mcp.json")

print(f"    Queue files moved: {queue_files_moved}")
print(f"    Agents copied from parent: {copied_agents}")
print(f"    Agents generated: {generated_agents}")
PYEOF

echo "  ✓ Migration complete"
