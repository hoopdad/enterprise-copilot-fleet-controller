# Migrations

Sequential migration scripts for upgrading projects between framework versions.

## Naming Convention

```
v{FROM}_to_v{TO}.sh
```

Example: `v1.0.0_to_v2.0.0.sh`

## How It Works

1. `scripts/upgrade.sh` reads the project's `.framework-version`
2. Finds the migration chain from current → target version
3. Applies each migration sequentially
4. Updates `.framework-version` after each successful step

## Writing a Migration

Each migration script receives these environment variables:
- `PROJECT_DIR` — the project being upgraded
- `FRAMEWORK_DIR` — the framework repo (for accessing new templates/tools)

Rules:
- Must be idempotent (safe to re-run if partially applied)
- Must be deterministic (no LLM calls — use sed, python3, jq for transforms)
- Must exit 0 on success, non-zero on failure
- Should log what it's doing with `echo "    ..."`
- Should check if changes are already applied before applying (guards)

## Version Scheme

- **MAJOR** (1.0.0 → 2.0.0): Breaking changes to generated file structure
- **MINOR** (1.0.0 → 1.1.0): New features in generated files (additive)
- **PATCH** (1.0.0 → 1.0.1): Bug fixes in templates or tools

Only MAJOR and MINOR versions need migrations. PATCH upgrades update framework
tools in-place without changing generated project files.

## Testing a Migration

```bash
# Dry run first
scripts/upgrade.sh --dry-run

# Apply
scripts/upgrade.sh

# Rollback if needed
git checkout pre-upgrade-v<old>-<timestamp>
```
