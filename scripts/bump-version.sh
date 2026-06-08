#!/bin/bash
# scripts/bump-version.sh — Manually bump the framework version
#
# Usage:
#   scripts/bump-version.sh patch   (1.0.0 → 1.0.1)
#   scripts/bump-version.sh minor   (1.0.0 → 1.1.0)
#   scripts/bump-version.sh major   (1.0.0 → 2.0.0)
#   scripts/bump-version.sh set 2.3.1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAMEWORK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION_FILE="$FRAMEWORK_DIR/VERSION"

CURRENT=$(cat "$VERSION_FILE" | tr -d '[:space:]')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "${1:-}" in
  major)
    MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor)
    MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch)
    PATCH=$((PATCH + 1)) ;;
  set)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: bump-version.sh set X.Y.Z"; exit 1
    fi
    echo "$2" > "$VERSION_FILE"
    echo "Version set to $2"
    exit 0 ;;
  *)
    echo "Usage: bump-version.sh [major|minor|patch|set X.Y.Z]"
    echo "  Current version: $CURRENT"
    exit 1 ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
echo "$NEW_VERSION" > "$VERSION_FILE"
echo "Bumped: $CURRENT → $NEW_VERSION"
echo ""
echo "Next steps:"
echo "  git add VERSION"
echo "  git commit -m 'chore: bump version to v${NEW_VERSION}'"
echo "  git tag -a v${NEW_VERSION} -m 'v${NEW_VERSION}'"
echo "  git push origin main --follow-tags"
