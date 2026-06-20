# enterprise-copilot-fleet-controller

I created **enterprise-copilot-fleet-controller** to enable disciplined multi-repo delivery with Copilot CLI using an orchestrator/specialist model, role-scoped tools, and deterministic upgrades.

Enterprise Copilot Fleet Controller is an opinionated scaffolding and operations layer for coordinator-driven multi-repo workflows. It bootstraps projects from one config file, structures implementation around contracts/requirements/decisions, and supports safe versioned evolution with sequential migrations.

## Why teams evaluate this quickly

- **Fast startup**: one `init.yml` drives orchestrator instructions, specialist agents, child repo mapping, and optional MCP wiring.
- **Clear multi-repo ownership**: orchestrator coordinates while specialists stay scoped to their assigned repos and roles.
- **Operational leverage**: built-in MCP servers cover scaffolding, contract drift checks, lint/security, CI/deploy checks, and infra diagnostics.
- **Durable delivery artifacts**: `.requirements`, `.contracts`, and `.decisions` make acceptance criteria and design intent explicit.
- **Safe upgrades**: `.framework-version` + deterministic sequential migrations keep framework changes auditable and reversible.

## Implementation Characteristics

- **Two layers**: Orchestrator in the parent repo (`.github/copilot-instructions.md`) + specialist/critic agents in each child repo (`<child>/.github/agents/*.agent.md`)
- **Three file types**: `.contracts/` (YAML interfaces), `.requirements/` (acceptance criteria), `.decisions/` (one-line ADRs)
- **Queue-based execution**: coordinator writes child requests; specialist and critic iterate `work/todo → work/ready-for-review → work/done`
- **Token-efficient**: Prefer structured YAML over free-form prose to keep context focused.
- **Instruction layout**: default to one repo-wide `.github/copilot-instructions.md`; add `.github/instructions/**/*.instructions.md` only when path-specific policies diverge.
- **Initialize with one config file**: `scripts/init.sh --config init.yml` (shell wrapper) → `scripts/init.py` (Python entrypoint) → `scripts/init-core.sh` (core generator)

### Philosophy

- **Token optimization as a practical driver:** Lower prompt overhead and faster iteration.
- **Use LLMs for their strengths:** AI-generated code, smart tool use, and selective artifact reuse.
- **Manage context by managing scope:** Smaller repo boundaries with orchestrator coordination and child-repo specialist/critic execution.
- **Write things down in file-based artifacts:** Durable memory and handoff docs for flows, contracts, and decisions.
- **Use token-efficient languages pragmatically:** Prefer concise, performant stacks where they fit; use Python when ecosystem depth is needed.
- **Codify operations, not ad hoc commands:** Prefer reusable scripts and IaC over one-off terminal sequences.
- **Favor deterministic, auditable controls for trust:** Template-first paths, guarded LLM fallback, sequential migrations, explicit governance layers, and role-scoped tools.
- **Use keywords to reduce prompt turns when helpful:** TDD mindset, red-team thinking, and instruction-following.

## Tips for Use

- **Keep infra codified:** Use Terraform or Bicep for Azure deployments, but go one step further. Use Azure Verified Modules as opinionated TF/Bicep modules to minimize the amount of requirements tokens to use. 
- **Bias to reusable artifacts:** Encode recurring workflows in contracts, requirements, and decision logs for faster future turns. Deployments are via scripts that you have AI write and store, preferably executed by MCP tools.
- **Remind the agent:** If you see it not following your workflow, tell it to follow its instructions.

## Structure After Init

```
your-project/
├── .framework-version          ← tracks which framework version initialized this
├── .contracts/              ← API/interface definitions (YAML)
├── .requirements/           ← acceptance criteria per feature (YAML)
├── .decisions/log.md        ← append-only one-line ADRs
├── .copilot/
│   ├── guardrails/
│   │   ├── pattern.yml      ← snapshot of the active pattern used at init
│   │   └── nfr.yml          ← snapshot of the active NFRs used at init
│   └── topology.md          ← project topology / quick reference (file locations, resource IDs, request flow)
├── .github/
│   ├── copilot-instructions.md ← orchestrator (main agent reads this)
│   ├── skills/                 ← scoped skills installed from the framework skills/ library
│   └── mcp.json                ← MCP tools configuration (optional, opt-in)
├── scripts/
│   └── predeploy-gate.sh       ← commit + push + version-tag every repo before `azd` deploy
├── .repo-index.yml             ← child repo references (name, role, local_path, visibility, remote)
├── children live in sibling/external paths from .repo-index.yml
│
├── ../repo-api/
│   ├── .github/agents/
│   │   ├── repo-api-specialist.agent.md
│   │   └── repo-api-critic.agent.md
│   ├── .github/skills/      ← child-scoped + role-scoped skills
│   └── work/{todo,ready-for-review,done}/
└── ../repo-web/...
```

## Deployment Model

Patterns declare a `deployment_model`. The `azure-fullstack` pattern uses **`local-azd`**:
deployments run locally via the **Azure Developer CLI (`azd`)** from the harness repo — there are
**no generated GitHub Actions pipelines**. Before any deploy, `scripts/predeploy-gate.sh` enforces a
commit + push + version-tag gate across every repo in `.repo-index.yml`. Regional Azure resources
default to **Central US** (`region: centralus`).

## Skills

The framework ships a `skills/` library (vendored Azure infra + full-stack skills). `pattern.yml`
maps each skill to a scope — `parent`, `child`, or `role:<role>` — and `init.sh` installs the
scoped skills into the matching repo's `.github/skills/`. Skills are tokenized
(`__PROJECT_NAME__`, `__REGION__`, `__RESOURCE_GROUP__`, …) and rendered at init time. See
`skills/README.md` for the catalog and token table.

## How Coordinator Workflow Works

1. **Coordinator** (parent repo) reads `.github/copilot-instructions.md`, writes `.requirements/.contracts`, and creates per-repo request files in child `work/todo/`.
   - MCP-first orchestration is mandatory for child execution: use `check_repo_index` + `check_repo_queues` + async child-agent-runner dispatch tools (`start_child_agents_batch`/`start_child_agent`) with polling (`get_child_agent_job`/`list_child_agent_jobs`), not background sub-agents or `task`.
   - Init runs a deterministic preflight before Phase 6 to validate executable/tooling and expected child repo paths (`repo_dir`, `.github/agents`, and `work/*` queues).
   - During init-time parent Copilot phases, child access is scoped from `.repo-index.yml` to `<child>/work` and `<child>/.github/agents` (not full child repo roots), so queue/agent files are readable without broad discovery scans.
2. **Specialist** (child repo cwd) processes one request, implements + validates, then moves it to `work/ready-for-review/`.
3. **Critic** (child repo cwd) reviews and iterates with specialist until PASS, then moves request to `work/done/`.
4. **Coordinator** validates done items against acceptance criteria before final acceptance.

## Usage

```bash
# New project (creates repos for you):
cd ~/projects/my-app
../enterprise-copilot-fleet-controller/scripts/init.sh --config init.yml

# MCP is OFF by default unless project.enable_mcp: true
# To opt in, set project.enable_mcp: true in init.yml, then run init.sh

# Existing project with code (LLM-powered agent generation):
cd ~/projects/existing-project
../path/to/enterprise-copilot-fleet-controller/scripts/init.sh --config init.yml

# Direct entrypoint variants (equivalent):
python3 ../enterprise-copilot-fleet-controller/scripts/init.py --config init.yml
bash ../enterprise-copilot-fleet-controller/scripts/init-core.sh --config init.yml

# Upgrade from v1.x:
cd ~/projects/my-app
../enterprise-copilot-fleet-controller/scripts/upgrade.sh

# Preview upgrade without applying:
../enterprise-copilot-fleet-controller/scripts/upgrade.sh --dry-run
```

## After Init

```bash
cd your-project

# Coordinator run (parent repo):
copilot -p "the create button fails with 'resume_text cannot be empty'" --allow-all-tools --autopilot --no-ask-user --add-dir "$(pwd)"

# Child specialist/critic run (child repo cwd):
copilot -p "Process the next work/todo request as specialist or critic" --allow-all-tools --autopilot --no-ask-user --add-dir "$(pwd)"
```

Parent orchestrator runs should stay MCP-first for child work; background sub-agents are the wrong path for child execution.

## init.yml Format

```yaml
project:
  name: "my-app"
  description: "What this system does"
  create_repos: true          # optional: create GitHub repos if they don't exist
  visibility: "private"       # optional: public | private | local (defaults to private)
  fresh_start: true           # optional: remove framework files and re-init
  enable_mcp: false           # optional: default OFF, set true to generate .github/mcp.json
  pattern: "azure-fullstack"  # optional: use a predefined pattern for children
  initial_prompt: "Set up the project with a REST API and React frontend."
  nfr: |                      # optional: literal text, file path, or URL
    - Response time: < 200ms p95
    - Security: OWASP Top 10 compliance
    - Testing: minimum 80% coverage

optional_features:            # optional: defaults shown
  mobile_ci_cd: false         # generate mobile workflow templates in .copilot/workflow-templates/
  runner_self_heal: false     # prerequisite self-healing blocks in templates (requires mobile_ci_cd=true)
  semantic_release: false     # semver release job in mobile CI template (requires mobile_ci_cd=true)
  onboarding_docs: false      # generate .copilot/docs/developer-onboarding.md
  portability_blueprints: false # generate .copilot/docs/portability-blueprint.md
  critic_evaluator: true      # optional critic PASS/FAIL gate for generated artifacts (default enabled)

critic:                       # optional: scope the critic evaluator review inputs
  scope:
    repos:
      - "../my-app-api"       # optional: repo paths/names to prioritize (default: all repos in .repo-index.yml)
    requirements:
      - ".requirements/platform-guardrails.yml" # optional: requirement files/labels to prioritize (default: all active requirements)

copilot_usage_metrics:        # optional: defaults shown
  enforcement_mode: warn      # strict | warn (warn continues when token metrics are missing/zero)
  retry_attempts: 2           # retry count before strict fail or warn continuation

children:
  - url: "https://github.com/org/my-app-api.git"
    local_path: "../my-app-api" # optional: defaults to ../<repo-name>
    role: "backend"           # backend | frontend | infra | agent | worker | waf
    description: "REST API service"

  - name: "web-client"        # optional: overrides URL-derived name
    url: "https://github.com/org/my-app-web.git"
    local_path: "../my-app-web"
    role: "frontend"
    description: "React frontend"
```

When `project.enable_mcp` is omitted or `false`, init skips `.github/mcp.json` and specialists are generated without scoped MCP tools.  
Set `project.enable_mcp: true` to generate `.github/mcp.json` and add role-based MCP tool scoping in specialist frontmatter.

Set `visibility: "local"` to create local git repos on disk and skip GitHub repo creation for that repo.

When `optional_features` flags are omitted, init leaves those artifacts out except `critic_evaluator`, which defaults to `true`.
`runner_self_heal` and `semantic_release` require `mobile_ci_cd: true`.
`copilot_usage_metrics.enforcement_mode: warn` lets production runs continue when token metrics are intermittently missing while still reporting `metrics_anomalies` in the usage summary.
Set `optional_features.critic_evaluator: false` to disable the critic PASS/FAIL gate for initialization.  
Use `critic.scope.repos` and `critic.scope.requirements` to narrow what the critic evaluator prioritizes during review.

## Agent Generation Strategy

- **Empty repos**: Deterministic templates — fast, predictable, no LLM dependency
- **Non-empty repos**: LLM analyzes existing code → generates `.agent.md` → reasonableness check validates structure → if check fails, retries once with error feedback → falls back to deterministic template if retry also fails

## Governance Chain

```
.github/copilot-instructions.md        → governs the orchestrator (main agent)
<child>/.github/agents/<name>-specialist.agent.md → governs each specialist subagent
<child>/.github/agents/<name>-critic.agent.md     → governs each critic subagent
.github/mcp.json                        → MCP tools available to all (optional, only when enable_mcp=true)
tools: [...] in each .agent.md          → restricts which tools each specialist sees
```

## Communication Flow

```
Human (natural language)
  → Orchestrator (reads .github/copilot-instructions.md)
    → writes .requirements/*.yml (structured acceptance criteria)
    → writes .contracts/*.yml (API shapes, if changed)
    → [tool: check_contract_compliance] — verify existing code still matches
    → [tool: run_local_lint] — run quick lint checks before deeper validation/delegation
    → red team review (for non-trivial changes)
    → writes per-repo request files under child work/todo/
      → child specialist implements + validates, then moves request to work/ready-for-review/
      → child critic evaluates; FAIL returns request to work/todo/, PASS moves request to work/done/
    → [tool: check_repo_index/sync_repo_index] — verify child repo references
    → [tool: check_ci_status] — monitor CI
    → [tool: verify_deployment] — confirm deploy
    → [tool: get_usage_quality_report] — inspect usage quality when loops/anomalies appear
    → Orchestrator verifies acceptance criteria from work/done artifacts
    → When `optional_features.critic_evaluator=true`, acceptance is blocked until critic returns STATUS: PASS
```

## MCP Tools

Tools handle mechanics so the LLM can focus on intelligence. MCP is opt-in (`project.enable_mcp: true`), and tools are registered via `.github/mcp.json`.

| Tool | Purpose | Scoped To |
|------|---------|-----------|
| `repo-index` | Validate/inspect `.repo-index.yml`, local repo health, and child queue state (`check_repo_queues`) | Orchestrator |
| `child-agent-runner` | Start scoped async child-repo Copilot sessions (`start_child_agent`/`start_child_agents_batch`) and poll completion (`get_child_agent_job`/`list_child_agent_jobs`) | Orchestrator |
| `contract-compliance` | Compare implemented routes to `.contracts/*.yml` endpoint definitions | Orchestrator + backend specialists |
| `scaffold-generator` | Generate non-overwriting FastAPI/TypeScript stubs from contracts | backend specialists |
| `azure-inspector` | Read Container Apps, Cosmos DB, and ACR state via Azure CLI | infra specialists |
| `container-app-diagnostics` | Deep Container Apps troubleshooting — activation failures, logs, revisions/replicas, image pulls | Orchestrator + infra specialists |
| `azure-resource-status` | Inventory Azure resources and inspect status/error events for troubleshooting | infra specialists |
| `ci-monitor` | Summarize recent GitHub Actions runs and key failure hints (framework-repo CI only) | Orchestrator |
| `deploy-verifier` | Probe service endpoints like `/health` and `/version` after deploy | Orchestrator |
| `deploy-local` | Deploy services locally via `azd` and custom scripts (no GitHub Actions) | Orchestrator |
| `quick-deploy` | Commit, build image, deploy container app, and verify health for a single service in one call | Orchestrator |
| `security-scanner` | Run available scanners and normalize findings into one report | All specialists |
| `lint-local` | Run safe local lint commands (ruff/eslint/golangci-lint/shellcheck) | specialists |
| `terraform-local` | Run deterministic local terraform fmt/init/validate/plan checks | infra specialists |
| `usage-tracker` | Append usage events, summarize recent workflow activity, and report usage quality/anomalies | All agents |
| `git-pr-orchestrator` | Automate multi-repo release workflows: commit, PR creation, CI monitoring, auto-merge | Orchestrator |

### Tool Scoping Per Role

| Role | Tools Available |
|------|----------------|
| backend | scaffold-generator, lint-local, contract-compliance, security-scanner, usage-tracker |
| frontend | lint-local, security-scanner, usage-tracker |
| infra | terraform-local, azure-resource-status, azure-inspector, lint-local, security-scanner, usage-tracker |
| agent/worker | lint-local, security-scanner, usage-tracker |

### Prerequisites

```bash
pip install -r enterprise-copilot-fleet-controller/tools/requirements.txt
```

## Versioning & Upgrades

Projects track their framework version in `.framework-version`. When the framework
evolves, upgrade projects safely:

```bash
# Check what would change
scripts/upgrade.sh --dry-run

# Apply (creates backup branch automatically)
scripts/upgrade.sh

# Rollback if needed
git checkout pre-upgrade-v<old>-<timestamp>
```

Upgrades are **sequential** — v1→v4 means applying v1→v2, v2→v3, v3→v4 in order.
Each migration is a deterministic bash script (no LLM calls), making upgrades
fast, repeatable, and auditable.

Version scheme: `MAJOR.MINOR.PATCH`
- **MAJOR**: Breaking changes to generated file structure (requires migration)
- **MINOR**: New features in generated files (requires migration)
- **PATCH**: Bug fixes in tools only (no project changes needed)
