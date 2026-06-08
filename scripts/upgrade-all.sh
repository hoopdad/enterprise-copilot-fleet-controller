#!/bin/bash
# scripts/upgrade-all.sh — Find and upgrade all framework-managed projects
#
# Usage:
#   scripts/upgrade-all.sh [--dry-run] [--search-dir PATH]
#
# The script:
#   1. Scans for directories containing .framework-version
#   2. Reports each project's current version vs latest
#   3. Upgrades each one sequentially (or dry-run to preview)
#
# Default search paths: ~/repos, ~/projects, ~/src, current directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LATEST_VERSION="$(cat "$FRAMEWORK_DIR/VERSION" | tr -d '[:space:]')"
DRY_RUN=false
SEARCH_DIRS=()

# ─────────────────────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n)
      DRY_RUN=true; shift ;;
    --search-dir|-s)
      SEARCH_DIRS+=("$2"); shift 2 ;;
    --help|-h)
      echo "Usage: scripts/upgrade-all.sh [--dry-run] [--search-dir PATH]..."
      echo ""
      echo "Finds all projects with .framework-version and upgrades them."
      echo ""
      echo "Options:"
      echo "  --search-dir, -s   Directory to search (repeatable; default: ~/repos ~/projects ~/src .)"
      echo "  --dry-run, -n      Show what would be upgraded without applying"
      exit 0 ;;
    *)
      echo "ERROR: Unknown argument: $1"; exit 1 ;;
  esac
done

# Default search directories
if [[ ${#SEARCH_DIRS[@]} -eq 0 ]]; then
  for dir in "$HOME/repos" "$HOME/projects" "$HOME/src" "."; do
    [[ -d "$dir" ]] && SEARCH_DIRS+=("$dir")
  done
fi

# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────
header() { echo ""; echo "═══ $* ═══"; }
log() { echo "  → $*"; }

# ─────────────────────────────────────────────────────────────
# Discover projects
# ─────────────────────────────────────────────────────────────
header "Scanning for framework-managed projects"
log "Framework version: v$LATEST_VERSION"
log "Search paths: ${SEARCH_DIRS[*]}"
echo ""

PROJECTS=()
for search_dir in "${SEARCH_DIRS[@]}"; do
  while IFS= read -r version_file; do
    project_dir="$(dirname "$version_file")"
    # Skip the framework repo itself
    [[ "$project_dir" == "$FRAMEWORK_DIR" ]] && continue
    PROJECTS+=("$project_dir")
  done < <(find "$search_dir" -maxdepth 4 -name ".framework-version" -type f 2>/dev/null)
done

if [[ ${#PROJECTS[@]} -eq 0 ]]; then
  echo "  No projects found with .framework-version"
  echo ""
  echo "  Searched: ${SEARCH_DIRS[*]}"
  echo "  Projects are detected by the presence of a .framework-version file."
  exit 0
fi

# ─────────────────────────────────────────────────────────────
# Report status
# ─────────────────────────────────────────────────────────────
header "Projects Found (${#PROJECTS[@]})"

NEEDS_UPGRADE=()
for project_dir in "${PROJECTS[@]}"; do
  current="$(cat "$project_dir/.framework-version" | tr -d '[:space:]')"
  name="$(basename "$project_dir")"
  if [[ "$current" == "$LATEST_VERSION" ]]; then
    echo "  ✓ $name — v$current (up to date)"
  else
    echo "  ⬆ $name — v$current → v$LATEST_VERSION"
    NEEDS_UPGRADE+=("$project_dir")
  fi
done

if [[ ${#NEEDS_UPGRADE[@]} -eq 0 ]]; then
  echo ""
  echo "  All projects are up to date!"
  exit 0
fi

# ─────────────────────────────────────────────────────────────
# Upgrade each project
# ─────────────────────────────────────────────────────────────
header "Upgrading ${#NEEDS_UPGRADE[@]} project(s)"

UPGRADE_FLAGS=()
[[ "$DRY_RUN" == true ]] && UPGRADE_FLAGS+=("--dry-run")

SUCCEEDED=0
FAILED=0

for project_dir in "${NEEDS_UPGRADE[@]}"; do
  name="$(basename "$project_dir")"
  echo ""
  echo "  ┌─ $name ($project_dir)"

  set +e
  output=$(bash "$SCRIPT_DIR/upgrade.sh" --project-dir "$project_dir" "${UPGRADE_FLAGS[@]}" 2>&1)
  rc=$?
  set -e
  echo "$output" | sed 's/^/  │ /'

  if [[ $rc -eq 0 ]]; then
    echo "  └─ ✓ $name upgraded successfully"
    ((SUCCEEDED++)) || true
  else
    echo "  └─ ✗ $name FAILED"
    ((FAILED++)) || true
  fi
done

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
header "Summary"
echo ""
echo "  Upgraded: $SUCCEEDED"
[[ $FAILED -gt 0 ]] && echo "  Failed:   $FAILED"
echo "  Skipped:  $((${#PROJECTS[@]} - ${#NEEDS_UPGRADE[@]})) (already up to date)"
echo ""
[[ $FAILED -gt 0 ]] && exit 1
exit 0
