---
name: secure-azure-terraform-coder
description: Generate and update Terraform for Azure with strict AVM-first, private connectivity-first, and managed identity-first controls, using per-resource fallback to azurerm then azapi only.
appliesTo: "**/*.tf"
---

# Secure Azure Terraform Coder

## Purpose

Use this skill to generate or modify Azure Terraform safely and consistently.

Core goals:

- Prefer Azure Verified Modules (AVM) per resource type.
- Fall back to `azurerm` per resource type only when no AVM path exists.
- Fall back to `azapi` per resource type only when no AVM or `azurerm` path exists.
- Prefer private connectivity and identity-based authentication.
- Keep versions pinned and reproducible.
- Validate generated Terraform in the feature folder only.
- Force redesign when secure patterns are not possible.

## Invoke When

Use this skill when the user asks to:

- create or modify Azure Terraform
- scaffold infrastructure for an Azure feature in Terraform
- migrate Terraform resources toward AVM-first patterns
- enforce AVM/`azurerm`/`azapi` fallback behavior

## Planner Contract

Planner must provide:

- `feature_folder_path` (for example `infra/`)
- `is_last_file_in_feature_group` as `true` or `false`
- version constraints when stricter than defaults

If `feature_folder_path` is missing, stop and ask once.

## Decision Order (Required)

For each resource type independently, apply this order:

1. AVM metadata lookup first.
2. Terraform Registry lookup second.
3. If AVM is available and usable, use AVM.
4. If no AVM path exists, use `azurerm`.
5. If no `azurerm` support exists, use `azapi`.

Do not apply fallback at whole-stack level. Fallback is per resource type.

Required evidence for each resource type:

- AVM metadata lookup result
- Terraform Registry lookup result
- chosen implementation path and reason

Mixed mode is allowed and expected. One feature can combine AVM, `azurerm`, and `azapi` by resource type.

## Versioning Rules

Use pinned lower-bound constraints in `> x.y` style as requested.

- Terraform: `> 1.9`
- `azurerm`: `> 4.50`
- `azapi`: `> 2.0`
- AVM module versions: pin explicit module versions and avoid floating latest.

If planner-provided constraints are present, they override these defaults.

Always use current stable releases at authoring time, but keep constraints pinned and reproducible.

If versions cannot be resolved to stable releases, stop and report blockers.

## Identity and Auth Defaults

For connecting Azure resources to each other, prefer in this order:

1. User-assigned managed identity
2. System-assigned managed identity
3. Service principal
4. Keys or shared secrets only as a last resort and only when no other architecture can satisfy the requirement

Provider authentication decisions are external to this skill.

If managed identity cannot be used:

1. try an alternate architecture pattern first
2. if still blocked, try another pattern
3. only then evaluate service principal
4. evaluate keys only if every other pattern is impossible

When not using managed identity, emit a short rationale and alternatives tried in generated docs/comments.

If keys are blocked by policy or forbidden by user constraints, do not weaken security. Stop and require a redesign.

## Networking Defaults

- Prefer Private Link and private endpoints.

Public network exposure is not acceptable unless it is the only technically possible path.

Before allowing any public network path:

1. try at least two private-first architecture patterns
2. document why each pattern failed
3. proceed only if no private design can work

If public network is still required, include a mandatory exception record with justification and compensating controls.

## Formatting, Init, and Validate

Always run Terraform formatting after file writes:

- `terraform fmt -recursive`

When planner indicates the current write is the last Terraform file in a feature group,
run in that feature folder only:

- `terraform init -backend=false`
- `terraform validate`

Never run these at repo root unless the feature folder is repo root.

If `terraform init` or `terraform validate` fails:

1. attempt one automated fix pass
2. rerun format and validation
3. if still failing, stop and report exact blockers

## Skill-Scoped Repo Hygiene Assets

This skill stores starter hygiene files under `templates/` and does not write root repo controls by default.

Use these assets when asked to scaffold project hygiene:

- `templates/.gitignore`
- `templates/.pre-commit-config.yaml`

Merge behavior is mandatory:

- never overwrite an existing `.gitignore`
- never overwrite an existing `.pre-commit-config.yaml`
- append only missing entries and preserve existing user order/comments
- keep updates idempotent (re-running should not duplicate entries)

Deterministic merge algorithm:

1. parse existing file as text and preserve all original lines
2. detect presence using exact line match after trimming right-side whitespace only
3. do not rewrite or reorder existing lines, blocks, or comments
4. for `.gitignore`, append only missing ignore patterns at end of file under one new heading block
5. for `.pre-commit-config.yaml`, append only missing repo or hook blocks without modifying existing hook args
6. when a repo exists but required hook is missing, append only the hook under that repo
7. never remove user-defined entries, even if they conflict with recommended defaults
8. if YAML structure is ambiguous or invalid, stop and ask user before editing

Recommended ignore patterns:

- `.terraform/`
- `*.tfstate`
- `*.tfstate.*`
- `.terraform.lock.hcl`

Note: excluding `.terraform.lock.hcl` reduces deterministic reproducibility but matches the current policy request.

## Security Defaults (Required)

Generated Terraform should default to:

- no public IPs unless explicitly required and approved by exception rule
- private endpoints where supported
- `public_network_access_enabled = false` where supported
- managed identities over secrets
- least-privilege role assignments
- no plaintext secrets in `.tf` or variable defaults
- Key Vault references or external secret injection for sensitive values

## CI and Policy Gates (Required)

Every feature must support CI checks with at least:

- `terraform validate`
- one static security scanner (`tfsec` or `checkov`)
- fail-on-severity policy defined by planner or repo defaults

If CI controls are missing, emit a required follow-up action.

## PR Security Notes (Required)

For any change that weakens security posture, add a short PR note that includes:

- what changed
- risk introduced
- mitigation applied
- planned hardening follow-up

Mandatory triggers for PR note:

- identity downgrade (for example UAMI to SAMI or SP)
- public network enablement
- key or shared secret adoption

## Module Provenance Rules (Required)

- use trusted registries only
- pin module versions and avoid floating latest
- reject untrusted or unverifiable module sources

If trusted module provenance cannot be established, stop and report blocker.

## Drift Detection and Breaking-Change Awareness

Require scheduled drift detection with alerting and review workflow.

During drift or plan review, explicitly flag replacement-class changes, including semantic-value
normalization that still forces replace in provider logic.

Examples to flag:

- size or unit string normalization such as `4.0GiB` to `4GiB` when provider marks ForceNew
- SKU/tier transitions that recreate resources
- identity mode transitions that trigger replacement
- subnet or address space mutations requiring replacement

When replacement is detected, propose safer alternate pattern before accepting replace.

## Sensitive Data Controls

- mark sensitive variables with `sensitive = true`
- mark sensitive outputs with `sensitive = true`
- do not emit secret values in outputs by default

If a secret output is required for bootstrapping, mark as temporary and add removal guidance.

## Secure Pattern Library Lifecycle

Maintain reusable secure Terraform patterns in `templates/security-pattern-library.yaml`.

Library rules:

- continuously add proven secure patterns
- deprecate weak patterns with migration notes
- prune obsolete patterns on review cadence
- include owner, last-reviewed date, and status for each pattern

## Output Requirements

Final response should include:

- resource-by-resource implementation path (AVM vs `azurerm` vs `azapi`)
- where and why fallback was used
- evidence of AVM metadata and registry checks
- identity choices made
- architecture alternatives tried before any exception
- any public networking exceptions
- any key-based exceptions
- formatting/init/validate results and executed folder path
