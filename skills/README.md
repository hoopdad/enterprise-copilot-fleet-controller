# Skills library

Reusable GitHub Copilot CLI skills installed into generated repos by `scripts/init.sh`
(`install_skills`). Each pattern's `pattern.yml` declares a `skills:` list that maps a skill
to a **scope** (`parent`, `child`, or `role:<role>`). At init time the skill folder is rendered
(token-substituted) into `<repo>/.github/skills/<name>/`.

## Tokens

`SKILL.md` and template assets may contain `__TOKEN__` placeholders that are substituted at init
from project config (via `TPL_*` env vars in `install_skills`). Common tokens:

| Token | Source | Notes |
|-------|--------|-------|
| `__PROJECT_NAME__` | `project.name` | e.g. `my-app` (service names become `my-app-web`, …) |
| `__REGION__` | `project.region` (default `centralus`) | Azure region |
| `__RESOURCE_GROUP__` | `<project>-<env>-rg` | resource group |
| `__ACR_NAME__`, `__COSMOS_ACCOUNT__`, `__ACA_ENV_SUFFIX__` | runtime | default to `<set-after-provision>` |
| `__WEB_CLIENT_ID__`, `__API_CLIENT_ID__`, `__TENANT_ID__` | runtime | default to `<set-after-provision>` |

Unknown tokens render to an explicit `<set-after-provision>` marker so generated skills carry obvious
TODOs rather than another project's stale values. The orchestrator fills these from `.copilot/topology.md`
after the first provision.

## Skills

### Infra (Terraform / Azure) — vendored from `hoopdad/mcaps-infra-skills`
- `hub-skill` — scaffold an Azure hub network foundation (AVM-first).
- `spoke-skill` — scaffold a hub-and-spoke workload VNet (AVM-first).
- `defender-servers-skill` — Microsoft Defender for Servers Terraform scaffolding.
- `secure-azure-terraform-coder` — AVM-first / private-first / identity-first Terraform coder (`appliesTo: **/*.tf`).

### azure-fullstack troubleshooting (parameterized from the word-game fleet)
- `container-app-troubleshoot` — Azure Container Apps deployment/activation triage.
- `cosmos-db-troubleshoot` — read-only Cosmos DB diagnostics.
- `e2e-test` — authenticated end-to-end API tests through the WAF.
- `entra-vite-spa-auth` — Entra/MSAL auth diagnostics for Vite+React SPAs.
- `route-flow-debug` — request-flow mismatch diagnostics across WAF→Web/API.

## Provenance

The four infra skills are vendored from <https://github.com/hoopdad/mcaps-infra-skills>. Refresh them
by re-copying `skills/<name>/` from that repo (or run its `scripts/install-skills.sh`).
