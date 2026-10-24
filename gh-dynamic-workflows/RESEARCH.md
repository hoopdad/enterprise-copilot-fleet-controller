# Source fidelity and Dynamic Workflow boundaries

## Authoritative process

The user's source is the **root**
[`hoopdad/thought-connections/loops.yml`](https://github.com/hoopdad/thought-connections/blob/503f3f8b487827014f30c3d23b8f14c86141ffa0/loops.yml),
last changed by revision `503f3f8b487827014f30c3d23b8f14c86141ffa0`.
The installed copy is [loops.yml](loops.yml), parsed as data at runtime.
It has 13 do-er/reviewer loops within a release and repeated Sprint Loop.
Owners, reviewers, inputs, outputs and completeWhen are taken from that source.

Most completion conditions are "Owner and reviewers agree." Sprint planning also
requires assigned todos and parallel independent work. E2E agreement concerns
accurate actionable test outcomes, including FAIL. DevOps explicitly writes and
runs azd-wrapped scripts and requires cloud-deployed tests passing. Sprint Review
adds backlog; Retro improves Architecture, UX and ReleasePlan. Those are retained.

## Correction to the prior implementation

The earlier research described additional controls as "required for unattended
execution." That was a design choice, **not an SDK requirement or a requirement
from this YAML**. It changed the user's risk tolerance and is superseded.

Removed engine policy includes source/script/dependency fingerprints and freezes,
exact tool-profile enforcement, workspace leases, ticket-only execution, native
receipts and intent ledgers; discovery/bootstrap/publication/infrastructure-policy/
exact-plan/recovery/reconciliation review stages; split author/operator roles,
zero-findings approval, clean/pushed-source admission, forced later harvest/
redeployment stages, a separate native-resume transport and mandatory finite
default budgets. Research/repair/publication stay within original authorized
work loops. Only user-selected limits are applied.

Minimal structured report and task-DAG checks are needed to transport/schedule
the YAML work, not additional risk or approval gates. Format corrections go back
to the same original do-er/reviewers. Reviewer agreement may contain feedback.

The user subsequently authorized runtime feedback coordination: mandatory
read-only Scrum Master triage before unresolved work returns to its owner,
Architect advice and Product Owner decisions for ambiguous scope, then one
reconciled instruction set for the original owner and reviewers. This is an
explicit exception to earlier no-added-gate prose, not a new YAML stage or
permission expansion. Actual defects remain blockers; deferred/declined
enhancements do not. See LAB-CONTRACT.md for structured decision validation.

On 2026-10-20 the user also authorized work-conserving release traversal:
localize blockers, retain partial sprints and continue all feasible approved
construction before waiting. Existing Architect/Scrum Master loops assess
source/component/flow readiness, splits and later backlog; exact evidence-backed
reassessments preserve original acceptance. This explicitly supersedes the old
runtime's first-incomplete-sprint/stage return, not YAML roles, real prerequisites,
DevOps cloud-test requirements or permissions. See DELIVERY-PRINCIPLES.md.

## Platform versus project policy

The installed CLI `1.0.100-1` SDK `docs/workflows.md` documents `defineWorkflow`,
`joinSession`, `ctx.agent`, `ctx.parallel`, `ctx.phase`, `ctx.step`, metadata,
optional limits and owner-session observation/resume. It does not mandate this
engine's retired guards. Dynamic Workflows are experimental and need eligible
authenticated execution. Ordinary tool/path/URL permissions and actual user
approvals still apply; a YAML role cannot grant cloud or third-party authority.

SDK steps are best-effort at-least-once and their keys alone identify journaled
results. This engine versions its keys with `yaml-loops-v1`; it cannot reinterpret
old native journals. Do not claim exactly-once commands or continue unknown
external effects blindly. Genuine product telemetry, corpus hashes, scientific
controls and actual resource permissions are separate from removed engine policy.

Workflow-owned agents cannot be read through ordinary agent tools. SDK
observation is session-scoped. Workflow Studio uses scoped, read-only local
storage observation for cross-session live/history and static parsing for design;
it neither changes running source nor controls run state.

This optional extension does not change generated fleet instructions, MCP child
dispatch or other projects' risk policies.
