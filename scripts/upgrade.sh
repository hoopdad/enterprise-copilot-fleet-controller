#!/bin/bash
# scripts/upgrade.sh — Upgrade a project from its current framework version to latest
#
# Usage:
#   scripts/upgrade.sh [--dry-run] [--target-version X.Y.Z]
#
# The script:
#   1. Reads .framework-version from the current project
#   2. Reads VERSION from the framework repo
#   3. Applies migrations sequentially (v1→v2→v3→...)
#   4. Creates a backup branch before any changes
#
# Prerequisites: Must be run from a project root that was initialized by the framework.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR=""
DRY_RUN=false
TARGET_VERSION=""

# ─────────────────────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-n)
      DRY_RUN=true; shift ;;
    --target-version|-t)
      TARGET_VERSION="$2"; shift 2 ;;
    --project-dir|-p)
      PROJECT_DIR="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: scripts/upgrade.sh [--project-dir PATH] [--dry-run] [--target-version X.Y.Z]"
      echo ""
      echo "Options:"
      echo "  --project-dir, -p      Path to the project to upgrade (default: current directory)"
      echo "  --dry-run, -n          Show what would change without applying"
      echo "  --target-version, -t   Upgrade to specific version (default: latest)"
      exit 0 ;;
    *)
      echo "ERROR: Unknown argument: $1"; exit 1 ;;
  esac
done

# Default project dir to cwd if not specified
if [[ -z "$PROJECT_DIR" ]]; then
  PROJECT_DIR="$(pwd)"
fi
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────
log() { echo "  → $*"; }
header() { echo ""; echo "═══ $* ═══"; }
warn() { echo "  ⚠ $*"; }
error() { echo "  ✗ ERROR: $*" >&2; exit 1; }

# Compare semver: returns 0 if $1 < $2
version_lt() {
  local IFS=.
  local i v1=($1) v2=($2)
  for ((i=0; i<3; i++)); do
    local a=${v1[i]:-0} b=${v2[i]:-0}
    if ((a < b)); then return 0; fi
    if ((a > b)); then return 1; fi
  done
  return 1  # equal
}

# Check if versions are equal
version_eq() {
  [[ "$1" == "$2" ]]
}

# ─────────────────────────────────────────────────────────────
# Detect versions
# ─────────────────────────────────────────────────────────────
header "Framework Upgrade"

# Current project version
if [[ -f "$PROJECT_DIR/.framework-version" ]]; then
  CURRENT_VERSION="$(cat "$PROJECT_DIR/.framework-version" | tr -d '[:space:]')"
else
  warn "No .framework-version found — assuming v0.0.0 (pre-versioning project)"
  CURRENT_VERSION="0.0.0"
fi

# Target version
if [[ -n "$TARGET_VERSION" ]]; then
  LATEST_VERSION="$TARGET_VERSION"
else
  if [[ -f "$FRAMEWORK_DIR/VERSION" ]]; then
    LATEST_VERSION="$(cat "$FRAMEWORK_DIR/VERSION" | tr -d '[:space:]')"
  else
    error "Cannot find $FRAMEWORK_DIR/VERSION"
  fi
fi

log "Current project version: v$CURRENT_VERSION"
log "Target framework version: v$LATEST_VERSION"

# Already up to date?
if version_eq "$CURRENT_VERSION" "$LATEST_VERSION"; then
  echo ""
  echo "  ✓ Project is already at v$LATEST_VERSION — nothing to do."
  exit 0
fi

# Validate direction
if ! version_lt "$CURRENT_VERSION" "$LATEST_VERSION"; then
  error "Current version ($CURRENT_VERSION) is newer than target ($LATEST_VERSION). Downgrades are not supported — use git to rollback."
fi

# ─────────────────────────────────────────────────────────────
# Discover migration path
# ─────────────────────────────────────────────────────────────
header "Migration Path"

MIGRATIONS_DIR="$FRAMEWORK_DIR/migrations"
MIGRATION_CHAIN=()

# Build the chain of migrations needed
current="$CURRENT_VERSION"
while version_lt "$current" "$LATEST_VERSION"; do
  # Find migration FROM current version
  migration_file=$(find "$MIGRATIONS_DIR" -name "v${current}_to_v*.sh" -type f 2>/dev/null | sort | head -1)
  if [[ -z "$migration_file" ]]; then
    error "No migration found from v${current}. Cannot proceed.
    Expected: $MIGRATIONS_DIR/v${current}_to_v<next>.sh
    Available migrations: $(ls "$MIGRATIONS_DIR"/*.sh 2>/dev/null | xargs -I{} basename {} || echo 'none')"
  fi

  # Extract target version from filename
  next_version=$(basename "$migration_file" | sed 's/^v.*_to_v\(.*\)\.sh$/\1/')
  MIGRATION_CHAIN+=("$migration_file")
  log "v${current} → v${next_version} ($(basename "$migration_file"))"
  current="$next_version"
done

if [[ ${#MIGRATION_CHAIN[@]} -eq 0 ]]; then
  error "No migration path found from v$CURRENT_VERSION to v$LATEST_VERSION"
fi

echo ""
log "Total migrations to apply: ${#MIGRATION_CHAIN[@]}"

# ─────────────────────────────────────────────────────────────
# Dry run — stop here
# ─────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == true ]]; then
  header "Dry Run Complete"
  echo ""
  echo "  Would apply ${#MIGRATION_CHAIN[@]} migration(s):"
  for m in "${MIGRATION_CHAIN[@]}"; do
    echo "    • $(basename "$m")"
  done
  echo ""
  echo "  No changes were made. Remove --dry-run to apply."
  exit 0
fi

# ─────────────────────────────────────────────────────────────
# Create backup branch
# ─────────────────────────────────────────────────────────────
header "Creating Backup"

BACKUP_BRANCH="pre-upgrade-v${CURRENT_VERSION}-$(date +%Y%m%d%H%M%S)"
if git rev-parse --git-dir &>/dev/null; then
  # Ensure clean working tree
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    error "Working tree has uncommitted changes. Commit or stash before upgrading."
  fi
  git branch "$BACKUP_BRANCH" 2>/dev/null || true
  log "Backup branch created: $BACKUP_BRANCH"
else
  warn "Not a git repo — skipping backup branch (changes cannot be rolled back)"
fi

# ─────────────────────────────────────────────────────────────
# Apply migrations sequentially
# ─────────────────────────────────────────────────────────────
header "Applying Migrations"

for migration_file in "${MIGRATION_CHAIN[@]}"; do
  migration_name=$(basename "$migration_file")
  log "Applying: $migration_name"

  # Each migration receives these env vars:
  # - PROJECT_DIR: the project being upgraded
  # - FRAMEWORK_DIR: the framework repo (for copying new templates/tools)
  # - CURRENT_VERSION: version before this migration
  export PROJECT_DIR FRAMEWORK_DIR

  if ! bash "$migration_file"; then
    echo ""
    error "Migration $migration_name FAILED.
    Your backup branch is: $BACKUP_BRANCH
    To rollback: git checkout $BACKUP_BRANCH && git checkout -B $(git branch --show-current 2>/dev/null || echo main)"
  fi

  # Update the version file after each successful migration
  next_version=$(basename "$migration_file" | sed 's/^v.*_to_v\(.*\)\.sh$/\1/')
  echo "$next_version" > "$PROJECT_DIR/.framework-version"
  log "  ✓ Now at v$next_version"
done

# ─────────────────────────────────────────────────────────────
# Commit the upgrade
# ─────────────────────────────────────────────────────────────
if git rev-parse --git-dir &>/dev/null; then
  git add -A
  git commit -m "chore: upgrade enterprise-copilot-fleet-controller v${CURRENT_VERSION} → v${LATEST_VERSION}

Applied ${#MIGRATION_CHAIN[@]} migration(s) sequentially.
Backup branch: ${BACKUP_BRANCH}" 2>/dev/null || true
fi

# ─────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────
header "✅ Upgrade Complete"
echo ""
echo "  Previous: v$CURRENT_VERSION"
echo "  Current:  v$LATEST_VERSION"
echo "  Backup:   $BACKUP_BRANCH"
echo ""
echo "  Migrations applied:"
for m in "${MIGRATION_CHAIN[@]}"; do
  echo "    ✓ $(basename "$m")"
done
echo ""
echo "  To rollback if something is wrong:"
echo "    git checkout $BACKUP_BRANCH"
echo "    git checkout -B $(git branch --show-current 2>/dev/null || echo main)"
echo ""
