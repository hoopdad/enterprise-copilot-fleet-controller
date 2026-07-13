# Maintaining the Enterprise Copilot Fleet Controller

## Quick Reference

| Task | Command |
|------|---------|
| Bump version manually | `scripts/bump-version.sh [major\|minor\|patch]` |
| Bootstrap venv (any OS) | `python scripts/setup.py` (bash: `scripts/setup.sh`, PowerShell: `scripts\setup.ps1`) |
| Adapt a cloned project's mcp.json | `python scripts/adapt-env.py --project-dir <proj>` |
| Host/venv detection facts | `python scripts/init/envinfo.py detect` |
| Test init on a new project | `cd ./scratch/test && ../enterprise-copilot-fleet-controller/scripts/init.sh --config init.yml` |
| Test upgrade path | `scripts/upgrade.sh --dry-run` (from a project dir) |
| Run integration tests | `bash tests/test-init.sh` |
| Run usage metrics scenarios | `bash tests/test-usage-metrics-scenarios.sh` |
| Syntax-check scripts | `bash -n scripts/init.sh && bash -n scripts/upgrade.sh` |
| Verify tools import | `for f in tools/*/server.py; do .venv/bin/python -c "import importlib.util; s=importlib.util.spec_from_file_location('m','$f'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)"; done` |

## Commit Conventions

Use **conventional commits** — the GitHub Action auto-bumps versions on merge to `main`:

| Prefix | Version Bump | Example |
|--------|-------------|---------|
| `feat:` | minor (1.0→1.1) | `feat: add new MCP tool for X` |
| `fix:` / `refactor:` / `perf:` | patch (1.0.0→1.0.1) | `fix: router prefix detection` |
| `feat!:` or body has `BREAKING CHANGE:` | major (1→2) | `feat!: restructure to .github/agents/` |
| `chore:` / `docs:` | none | `docs: update README examples` |

## When You Change Generated Files

If your change affects what `init.sh` generates into projects (.github/agents/*.agent.md, .github/copilot-instructions.md, .github/mcp.json, directory structure):

1. **Bump at least MINOR** version
2. **Write a migration** in `migrations/v{OLD}_to_v{NEW}.sh`
3. Migration rules:
   - Must be idempotent (check before applying)
   - Must be deterministic (bash only, no LLM calls)
   - Must exit 0 on success
   - Receives `$PROJECT_DIR` and `$FRAMEWORK_DIR` env vars
4. **Test the upgrade path**: create a fake v(old) project, run `scripts/upgrade.sh`

## When You Add/Change MCP Tools

1. Update/create `tools/<name>/server.py`
2. Update `templates/init/mcp.json.tmpl` — new server entries must use `"command": "__VENV_PYTHON__"` (the OS-aware interpreter placeholder) and `__FRAMEWORK_DIR__/tools/<name>/server.py` for args
3. Update the `tools_for_role()` function in `scripts/init-core.sh` if the tool should be scoped
4. Update `tools/README.md`
5. If adding a new tool, this is a **MINOR** bump (existing projects need migration to get new mcp.json entry)

MCP servers must be launched with the framework venv interpreter (`.venv/bin/python` on
POSIX, `.venv/Scripts/python.exe` on Windows), including preflight and smoke tests. Resolve
it via the single source `scripts/init/envinfo.py` (`venv-python`) rather than hardcoding the
path, so bash, PowerShell, and generated `mcp.json` never drift. Bare `python3` may load
incompatible user-site dependencies. Child processes spawned by MCP servers must set
`stdin=subprocess.DEVNULL`;
inheriting stdio can consume or hold open the JSON-RPC transport.

## When You Add/Change Skills

1. Add the skill folder under `skills/<name>/` (tokenize project-specific literals — see `skills/README.md` token table)
2. Map it to scopes (`parent` / `child` / `role:<role>`) in the relevant `patterns/*/pattern.yml` `skills:` list
3. `install_skills()` in `scripts/init-core.sh` renders scoped skills into each repo's `.github/skills/`
4. This is a **MINOR** bump; the migration should copy the new skill into existing projects

## Deployment Model & Region

- Patterns declare `deployment_model` (`local-azd` for `azure-fullstack`) and `region` (`centralus`).
- `local-azd` means **no generated GitHub Actions** — deploys run via `azd` from the harness, gated by `scripts/predeploy-gate.sh` (commit + push + version-tag every repo).
- The framework's OWN repo CI (`.github/workflows/auto-version.yml`, `tests.yml`) is maintenance CI and is intentionally retained.

## When You Add a New Template Section

1. Edit `generate_agent_md()` in `scripts/init-core.sh` or templates under `templates/init/`
2. If it changes structure, write a migration
3. Test with `bash tests/test-init.sh`

## Release Checklist

- [ ] All changes use conventional commit prefixes
- [ ] Migrations written for any generated-file changes
- [ ] `bash tests/test-init.sh` passes
- [ ] Tools import cleanly
- [ ] README updated if user-facing behavior changed
- [ ] PR merged to main → Action auto-bumps + tags

## Architecture Reminders (v2.10.0)

- **Philosophy**: Parent orchestrator (.github/copilot-instructions.md) + child-repo specialists/critics (<child>/.github/agents/*.agent.md) with work queues (`work/todo → ready-for-review → done`)
- **Agent generation**: Deterministic templates for empty repos, LLM + reasonableness check for existing code
- **Tools principle**: Tools handle mechanics, LLM handles decisions. Scoped per role via `tools:` frontmatter.
- **Version chain**: `VERSION` file → git tag → `.framework-version` in projects → stamps in generated files
- **Upgrade path**: Always sequential (v1→v2→v3), never skip versions
- **fresh_start**: Deletes only framework-installed files (tracked in `.framework-manifest`), never project source. Backs up every file to `.framework-backups/<timestamp>/` before deleting, previews, and confirms. Projects predating the manifest fall back to the known framework-path set (still backed up).

## File Map

```
enterprise-copilot-fleet-controller/
├── VERSION                          ← semver source of truth
├── README.md                        ← user-facing docs
├── MAINTAINING.md                   ← this file
├── .github/workflows/
│   └── auto-version.yml             ← bumps version on merge to main
├── scripts/
│   ├── init.sh                      ← shell wrapper entrypoint
│   ├── init.py                      ← Python orchestrator/entrypoint
│   ├── init-core.sh                 ← core workflow + phase orchestration
│   ├── upgrade.sh                   ← sequential migration runner
│   ├── bump-version.sh              ← manual version bump helper
│   └── init/
│       └── helpers.py               ← shared YAML/metrics/validation helpers
├── templates/init/
│   ├── agents/                     ← specialist/critic agent templates
│   ├── docs/                       ← optional onboarding/portability templates
│   ├── prompts/                    ← copilot prompt templates for phase orchestration
│   ├── requirements/               ← generated requirement templates
│   ├── workflows/                  ← optional mobile workflow templates
│   ├── instructions.md.tmpl         ← orchestrator instructions template
│   ├── mcp.json.tmpl                ← MCP server config template
│   └── copilot-allow-urls.txt       ← init Copilot URL allowlist
├── migrations/
│   ├── README.md                    ← migration writing guide
│   ├── v0.0.0_to_v1.0.0.sh
│   ├── v1.0.0_to_v1.1.0.sh
│   ├── v1.1.0_to_v1.2.0.sh
│   ├── v1.2.0_to_v1.3.0.sh
│   ├── v1.3.0_to_v2.0.0.sh         ← .agents/ → .github/agents/ migration
│   ├── v2.0.0_to_v2.1.0.sh         ← MCP metadata/version refresh migration
│   ├── v2.1.0_to_v2.2.0.sh         ← usage metrics schema guidance + metadata refresh
│   ├── v2.5.0_to_v2.6.0.sh         ← optional feature guidance refresh
│   ├── v2.6.0_to_v2.7.0.sh         ← repo-index migration + MCP tool refresh
│   ├── v2.7.0_to_v2.8.0.sh         ← local-only guidance + MCP metadata refresh
│   ├── v2.8.0_to_v2.9.0.sh         ← child workflow queue/agent migration
│   └── v2.9.0_to_v2.10.0.sh        ← child-agent-runner MCP tool + guidance refresh
├── tools/
│   ├── README.md                    ← tool documentation
│   ├── requirements.txt             ← mcp, pyyaml, httpx
│   ├── repo-index/server.py
│   ├── contract-compliance/server.py
│   ├── scaffold-generator/server.py
│   ├── azure-inspector/server.py
│   ├── ci-monitor/server.py
│   ├── deploy-verifier/server.py
│   ├── security-scanner/server.py
│   └── usage-tracker/server.py
├── patterns/
│   └── azure-fullstack/             ← predefined pattern with children + stack + NFR
├── tests/
│   ├── test-init.sh                 ← integration tests for init.sh
│   ├── test-mcp-tools.sh            ← MCP tool tests
│   └── test-usage-metrics-scenarios.sh ← init + upgrade usage schema scenarios
└── templates/
    ├── init-example.yml             ← example config for new projects
    └── init-pattern-example.yml     ← example config using patterns
```
