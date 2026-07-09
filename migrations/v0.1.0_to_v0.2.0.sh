#!/usr/bin/env bash
# Migration v0.1.0 → v0.2.0
# Brings existing projects up to the azd + skills revision:
#   1. Refresh .github/mcp.json with the +3 deploy/diagnostic tools.
#   2. Install scoped skills into parent + child .github/skills/.
#   3. Scaffold .copilot/topology.md (if missing).
#   4. Create scripts/predeploy-gate.sh (commit+push+version gate).
#   5. De-stale child copilot-instructions: strip GitHub Actions deploy refs.
#
# Idempotent + deterministic (bash only). Receives $PROJECT_DIR and $FRAMEWORK_DIR.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:?PROJECT_DIR is required}"
FRAMEWORK_DIR="${FRAMEWORK_DIR:?FRAMEWORK_DIR is required}"

info() { printf '[migrate 0.1.0→0.2.0] %s\n' "$*"; }

TEMPLATE_DIR="$FRAMEWORK_DIR/templates/init"

# Resolve project metadata for token substitution.
PROJECT_NAME="$(basename "$PROJECT_DIR")"
if [[ -f "$PROJECT_DIR/.project.yml" ]]; then
  pn="$(grep -E '^\s*name:' "$PROJECT_DIR/.project.yml" | head -n1 | sed -E 's/^\s*name:\s*"?([^"]+)"?\s*$/\1/')"
  [[ -n "$pn" ]] && PROJECT_NAME="$pn"
fi
REGION="centralus"

subst() {
  # Replace common __TOKENS__ on stdin.
  sed -e "s|__PROJECT_NAME__|$PROJECT_NAME|g" \
      -e "s|__REGION__|$REGION|g" \
      -e "s|__RESOURCE_GROUP__|${PROJECT_NAME}-dev-rg|g" \
      -e "s|__FRAMEWORK_DIR__|$FRAMEWORK_DIR|g" \
      -e "s|__TARGET_DIR__|$PROJECT_DIR|g"
}

# 1. mcp.json: add deploy-local, quick-deploy, container-app-diagnostics if absent.
MCP="$PROJECT_DIR/.github/mcp.json"
if [[ -f "$MCP" ]] && command -v python3 >/dev/null 2>&1; then
  FRAMEWORK_DIR="$FRAMEWORK_DIR" PROJECT_DIR="$PROJECT_DIR" python3 - "$MCP" <<'PY'
import json, os, sys
path = sys.argv[1]
fw = os.environ["FRAMEWORK_DIR"]; pd = os.environ["PROJECT_DIR"]
with open(path) as f: cfg = json.load(f)
servers = cfg.setdefault("mcpServers", {})
add = {
  "container-app-diagnostics": "Deep troubleshooting for Container Apps — diagnose activation failures, pull logs, inspect revisions/replicas, verify image pulls, compare app configs.",
  "deploy-local": "Deploy services locally via azd and custom scripts (no GitHub Actions).",
  "quick-deploy": "Commit, build image, deploy container app, and verify health for a single service in one call.",
}
changed = False
for name, desc in add.items():
    if name not in servers:
        servers[name] = {
            "description": desc,
            "command": f"{fw}/.venv/bin/python",
            "args": [f"{fw}/tools/{name}/server.py"],
            "env": {"PROJECT_DIR": pd},
        }
        changed = True
if changed:
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2); f.write("\n")
    print("[migrate 0.1.0→0.2.0] mcp.json: added deploy/diagnostic tools")
else:
    print("[migrate 0.1.0→0.2.0] mcp.json: deploy/diagnostic tools already present")
PY
fi

# 2. Install scoped skills (parent always gets the pattern's parent-scoped skills).
#    Defer the authoritative scoping to init-core's install_skills; here we copy the
#    full library so nothing is missing, only if .github/skills is empty/absent.
if [[ -d "$FRAMEWORK_DIR/skills" ]]; then
  mkdir -p "$PROJECT_DIR/.github/skills"
  for skill in "$FRAMEWORK_DIR"/skills/*/; do
    sname="$(basename "$skill")"
    dest="$PROJECT_DIR/.github/skills/$sname"
    if [[ ! -d "$dest" ]]; then
      mkdir -p "$dest"
      # Render every file through token substitution (verbatim skills are unaffected).
      (cd "$skill" && find . -type f | while IFS= read -r rel; do
        mkdir -p "$dest/$(dirname "$rel")"
        subst < "$skill/$rel" > "$dest/$rel"
      done)
      info "installed skill: $sname"
    fi
  done
fi

# 3. Scaffold .copilot/topology.md if missing.
if [[ ! -f "$PROJECT_DIR/.copilot/topology.md" && -f "$TEMPLATE_DIR/topology.md.tmpl" ]]; then
  mkdir -p "$PROJECT_DIR/.copilot"
  subst < "$TEMPLATE_DIR/topology.md.tmpl" > "$PROJECT_DIR/.copilot/topology.md"
  info "scaffolded .copilot/topology.md"
fi

# 4. Pre-deploy gate script.
if [[ ! -f "$PROJECT_DIR/scripts/predeploy-gate.sh" && -f "$TEMPLATE_DIR/scripts/predeploy-gate.sh.tmpl" ]]; then
  mkdir -p "$PROJECT_DIR/scripts"
  subst < "$TEMPLATE_DIR/scripts/predeploy-gate.sh.tmpl" > "$PROJECT_DIR/scripts/predeploy-gate.sh"
  chmod +x "$PROJECT_DIR/scripts/predeploy-gate.sh"
  info "created scripts/predeploy-gate.sh"
fi

# 5. Flag stale GitHub Actions deployment references in child instructions (non-destructive).
while IFS= read -r ci; do
  [[ -n "$ci" ]] || continue
  if grep -qiE 'github actions|self-hosted runner|oidc' "$ci" 2>/dev/null; then
    info "NOTE: $ci still references GitHub Actions/OIDC — review and migrate to azd manually."
  fi
done < <(find "$PROJECT_DIR" -maxdepth 4 -name copilot-instructions.md -path '*/.github/*' 2>/dev/null)

info "migration complete"
exit 0
