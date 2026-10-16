# Research: reusable autonomous product delivery

**Verified:** October 15, 2026. This document separates documented platform behavior
from the delivery design recommended for this repository. Dynamic workflows remain
in public preview; verify the installed CLI/SDK before relying on these interfaces.

## Findings

A **project Copilot extension containing a dynamic workflow** is the appropriate
reusable orchestration primitive. Put phase order, dependencies, review gates,
bounded repair loops, and completion rules in executable code; use agents for
analysis, design, implementation, and evaluation. A long prompt or a YAML role
description alone does not provide those controls.

“Fully autonomous” should mean **unattended execution inside an explicitly
authorized scope**, not unlimited authority or guaranteed successful delivery.
The workflow must return an honest blocked or failed outcome when credentials,
permissions, acceptance evidence, or safe remediation are unavailable. It should
not silently reinterpret a blocked deployment as a successful product release.

## Sources and provenance

All remote sources below were retrieved on October 15, 2026. GitHub repository
content and commit metadata were inspected through `gh api`.

| Source | Verified reference | Why it matters |
| --- | --- | --- |
| GitHub announcement, October 1, 2026 | [Dynamic workflows in Copilot CLI and the Copilot app][announcement] | Public-preview announcement, code-defined orchestration, CLI experimental prerequisite, original all-plans statement |
| Current official conceptual documentation | [Dynamic workflows][concepts]; [immutable source][concepts-source] at `6965ff418b339edaf8a8657062598ff00a66c411`, last changed October 15, 2026 at 09:34:27 UTC | Current eligibility exception, permissions, limits, lifecycle, and differences from autopilot/fleet |
| Current official operating instructions | [Using dynamic workflows][howto]; [immutable source][howto-source] at the same `6965ff418b339edaf8a8657062598ff00a66c411` | Creation, project/personal reuse, terminal invocation, permissions, result files, pause/resume |
| Requested role-loop source | [`hoopdad/thought-connections/loops.yml`][loops-source] at `503f3f8b487827014f30c3d23b8f14c86141ffa0`, last changed June 30, 2026 at 00:26:24 UTC | Release/sprint role model and artifact handoffs |
| Reference repository HEAD when checked | [`7904b4566a2b01c0d2cf6bf6cbfe7d081b5fb7d3`][loops-head], July 7, 2026 at 02:31:23 UTC | Distinguishes the latest repository revision from the last revision changing root `loops.yml` |
| Installed SDK authoring guide | Local package `1.0.99-1`, `copilot-sdk\docs\workflows.md`; SHA-256 `248189DBCDC1DF390D9C72D206990BE87BC3D3380844A1EC827CDB99EC2E0B91` | Exact locally installed API, journaling, failure, authentication, and replay behavior |
| This repository's conventions | `README.md` and `MAINTAINING.md`, baseline `347516d0cb88c506314bf9cb6bba3b0db2cf0e73` | MCP-first child dispatch, scoped ownership, local `azd` deployment, generated-output migration policy |

The installed SDK guide was read at:

```text
C:\Users\mikeolivieri\AppData\Local\copilot\pkg\win32-arm64\1.0.99-1\copilot-sdk\docs\workflows.md
```

This is a machine-local, versioned source, not a portable public URL or a promise
about future SDK versions. The CLI's installed help was also checked through its
documentation tool; its README lookup failed, so no claim depends on that missing
README. Public documentation supplies the user-facing commands.

### Reconciling availability and execution eligibility

The October 1 announcement says dynamic workflows are available on all Copilot
plans. The **newer official conceptual documentation is more specific**: existing
annual Pro/Pro+ subscribers still on legacy premium-request billing are excluded.
Do not repeat “all plans” without that qualification.

Separately, the installed SDK states that execution requires eligible credentials:
**token-based billing or trusted HMAC authentication**. Starting, resuming,
pausing, cancelling, and workflow agent/journal/progress operations can fail with
JSON-RPC `-32601`, `data.code: "dynamic_workflows_unavailable"`. Observation may
remain available for existing runs without restoring execution eligibility.
“Token-based billing” does not mean that an arbitrary GitHub token is sufficient.
HMAC is a trusted integration mechanism, not an authentication bypass to implement.

These statements describe different layers: advertised product availability,
current billing eligibility, and the installed runtime's credential gate.
Preflight the actual authenticated installation before a long delivery run.
The announcement alone cannot prove that a particular account can execute one.

## Autopilot, fleet, and dynamic workflows

| Mechanism | Controls | Does not establish |
| --- | --- | --- |
| Autopilot | Continuation without asking the user after each ordinary step; the agent chooses next actions | A reusable coded state machine, objective proof of completion, or permission bypass |
| `/fleet` | Encourages agent-selected decomposition and parallel subagents | A fixed, repeatable dependency graph or stable acceptance rules |
| Dynamic workflow | Author-defined sequencing, branches, fan-out, structured handoffs, checkpoints, and limits | Deterministic model answers, automatically safe side effects, or an unconditional right to run |

These are not synonyms. The reusable process belongs in a dynamic workflow.
Autonomous behavior can be designed into that process without relying on a
chat agent to improvise the entire release. Simple edits still belong in normal
chat rather than a potentially expensive workflow. Copilot creates/runs a workflow
only when explicitly requested or instructed by a skill/slash command.[concepts]

## What the reference `loops.yml` actually defines

The requested **root** `loops.yml` is a human-edited, version `1.0` domain
specification, not a Copilot extension, SDK program, or GitHub Actions workflow.
Its header mentions a compaction command involving `docs/runbooks/loops.yml`;
that comment does not change the identity of the root file inspected here.

Its artifact vocabulary comprises Architecture, UserExperience, ReleasePlan,
SprintDesign, SprintArchitecture, SprintPlan, UIWork, DeveloperWork, and
Deployments. Roles are Product Owner, Architect, Scrum Master, Developer,
Designer, DevOps Engineer, Stakeholder, Critic, and Red Team. The UI implementation
loop is owned by **Developer**, not a separately declared UI Developer role.

The following table summarizes the source rather than reproducing it. “Code
mapping” is the recommended implementation, not an API exported by the YAML.

| Source loop | Owner → reviewers | Main artifact/outcome | Practical code mapping |
| --- | --- | --- | --- |
| Architecture | Architect → Product Owner, Red Team, Critic | Release-wide principles, stack, end-to-end design | Analyze input/brownfield evidence; produce architecture and risk decisions; review and repair |
| User Experience | Designer → Product Owner, Critic | UX principles, flows, screens | Produce experience and accessibility plan; explicitly mark non-UI scope not applicable |
| Release Plan | Product Owner → Stakeholder, Architect, Designer, Critic | Sprints with goals and acceptance criteria | Convert requirements into traceable, dependency-aware increments |
| Sprint Design | Designer → Product Owner, Critic | Current-sprint flows/screens and design-blocker decisions | Refine only the selected increment; revisit blocked design questions |
| Sprint Architecture | Architect → Product Owner, Critic, Red Team | Cumulative tier-level design and resolved blockers | Refine contracts/migrations; preserve prior-sprint compatibility |
| Sprint Plan | Scrum Master → Product Owner, Architect, Critic | Assignments including UI, backend, DevOps, design | Validate a task DAG and file/repository ownership; dispatch ready independent tasks |
| Assigned Work — UI | Developer → Architect, Designer, Critic | Built and tested UI | Implement isolated UI tasks; validate against design and acceptance evidence |
| Assigned Work — Developer | Developer → Architect, Critic | Built and tested backend/business logic | Implement isolated non-UI tasks; validate interfaces and focused tests |
| End-to-End Test | Developer → Architect, Critic, Product Owner | Accurate PASS or actionable failure feedback | Run deterministic integration/E2E commands; send concrete failures to bounded repair |
| DevOps Work | DevOps Engineer → Architect, Critic, Developer | Scan/build/deploy scripts, deployments | Build and scan; deploy through an authorized adapter; run deployed-system checks |
| Sprint Review | Product Owner → Scrum Master, Critic, Architect, Red Team | Demo validation and new/blocked backlog items | Evaluate evidence against sprint criteria; record additions without silently expanding scope |
| Sprint Retrospective | Product Owner → Scrum Master, Critic, Architect, Red Team, Designer, Developer | Process observations and artifact improvements | Persist metrics, decisions, and proposed process improvements for subsequent work |
| Release Closeout | Product Owner → Stakeholder, Architect, Critic | Requirement completion status, release notes, README | Reconcile every requirement to evidence; return delivery status and remaining risks |

The source repeats an owner/reviewer agreement condition. It also requires all
sprint tasks assigned and independent work dispatched in parallel, and requires
the cloud-deployed system to pass tests for DevOps completion. Those conditions
must become explicit machine-readable checks, not merely reassuring prose.

## Recommended reusable delivery phases

This is a translation of the source model into an implementable process, with
additional controls required for unattended execution.

1. **Preflight and discovery.** Validate workflow arguments, credentials, working
   roots, trusted extension code, branch/worktree ownership, toolchain, permitted
   operations, and available budget policy. Record the input spec and source
   revision. For brownfield, inspect instructions, manifests, architecture,
   contracts, existing tests, and a baseline run before proposing changes.
2. **Requirements and release design.** Normalize product/architecture inputs
   into requirement IDs and executable acceptance criteria. Brownfield inference
   must label facts, assumptions, and missing product decisions separately.
   Produce architecture, UX or justified non-UI scope, risks, and a release plan.
3. **Sprint refinement.** Select a bounded increment; refine UX, contracts,
   tier-level architecture, dependency graph, ownership, and test plan. Validate
   that dependencies exist, the graph is acyclic, and no parallel writers overlap.
4. **Implementation and review.** Dispatch only ready independent tasks.
   Give each owner specific files/repositories, constraints, acceptance IDs,
   and validation commands. Separate implementer and critic calls. Fan in before
   integration; review actual diffs and evidence, not just an implementer summary.
5. **Integration, repair, and acceptance.** Run the repository's commands for
   lint, tests, type/build checks, security checks, and E2E as applicable.
   Repair relevant failures with a finite iteration policy. Distinguish baseline
   failures from regressions without treating baseline failures as automatic PASS.
6. **Delivery.** Produce scripts and release artifacts. Execute remote writes,
   pushes, PRs, migrations, and deployments only where specifically authorized.
   If deployment is in scope, validate the deployed revision and health rather
   than merely accepting a successful deployment command.
7. **Review, retrospective, closeout.** Record per-criterion evidence, blocked
   work, residual risks, changed files/commits, test commands and exit codes,
   deployment state, and next action. Preserve the agreed release boundary;
   do not keep generating sprints indefinitely from newly discovered ideas.

Suggested structured results include `status`, `requirementIds`, `artifacts`,
`evidence`, `findings`, `blockers`, and `assumptions`. Code should reject missing
evidence, invalid paths, nonexistent dependencies, and contradictory outcomes.
An agent's `pass: true` is a review opinion, not a substitute for successful
tests or a user-granted production authorization.

All role agents may operate unattended, but an agent playing Stakeholder is not
an actual stakeholder approval. Where a requirement demands real business,
security, or production signoff, record that approval as absent unless it was
explicitly granted. UX, deployment, or cloud-specific work can be not applicable
only when the selected scope justifies that outcome.

### Fit with this repository

This repository already separates deterministic tools from agent judgment,
stores requirements/contracts/decisions, and moves child work through specialist
and critic queues. A new reusable workflow should preserve those boundaries.

In a generated multi-repository project, child execution must remain
**MCP-first through the child-agent-runner and queue protocol**, not silently
replace that execution path with generic workflow subagents. Workflow-owned
agents can perform orchestration-level design/review; an execution adapter must
respect the actual repository topology and its child dispatch requirements.

For the Azure full-stack pattern, deployment is local through `azd`, with the
existing commit/push/version-tag predeploy gate. Do not invent a generated
GitHub Actions deployment pipeline or bypass that gate. Conversely, do not
impose Azure/`azd` on every arbitrary brownfield repository: discover its
documented deployment mechanism. This research does not change generated
templates, MCP servers, or migration requirements.

## SDK facts that affect implementation

### Nonproduction autonomy in this implementation

The reference DevOps loop includes deployment and requires the deployed system
to pass tests. Accordingly, this repository's unattended delivery path includes
**deploy -> verify exact revision -> smoke**, not just local build completion.
The human supplies the authorized existing nonproduction target once; a routine
approval pause is optional. Missing target information blocks the run rather
than silently downgrading it to build-only.

When deployment commands are not supplied, a DevOps agent proposes scoped
deployment/check scripts and a separate critic reviews the adapter before the
coordinator executes it. Local acceptance evidence and live deployment evidence
are distinct: a predeploy critic cannot establish that a target is already healthy.
Bounded automatic check retries accommodate readiness delays. Reconciliation must
positively identify either the expected revision or a safe-to-retry absence;
unknown remote state is not permission to blindly repeat deployment.

These are implementation decisions for the requested low-risk nonproduction
scope, not additional APIs or promises in GitHub's documentation. They do not
authorize production deployment, new paid resources, or unrestricted operations.

The following details are grounded in the installed `1.0.99-1` authoring guide.
They are particularly important when moving from a role-loop description to code.

- **Packaging:** use `defineWorkflow` and register through
  `joinSession({ workflows: [...] })`. The workflow body has `ctx.args`,
  `ctx.agent`, `ctx.step`, `ctx.parallel`, `ctx.pipeline`, `ctx.pause`,
  `ctx.phase`, `ctx.log`, `ctx.signal`, and a stable `ctx.runId`.
  `ctx.workflow(...)` rejects: nested workflows are not supported.
- **Input/output validation:** declare `meta.argsSchema` and agent result
  schemas, but also validate values in ordinary code. The supported structural
  subset does not enforce constraints such as path patterns, string lengths,
  numeric ranges, or `additionalProperties`. Agent-output `oneOf` is treated
  as at-least-one matching branch, not exclusive matching. SDK-initiated
  `session.workflow.run(...)` is not checked against `argsSchema`.
- **Failure is not success:** ordinary agent failure or unparseable/schema-invalid
  output after one retry resolves to `null`. Check for it explicitly. The retry
  can count as a second subagent. Cancellation, reached limits, and hard runtime
  failures reject rather than appearing as ordinary `null` results.
- **Independent reviewers need independent calls:** identical agent
  prompt/options, including `label`, share a memoized result. Give distinct roles,
  tasks, and repair attempts unique labels/prompts. Otherwise a “second opinion”
  or “retry” can just return the first result.
- **Parallelism has semantics:** `parallel` waits at a barrier; an ordinary
  thrown item yields `null`. `pipeline` advances each item through its stages
  independently and skips remaining stages after an ordinary item failure.
  Both propagate cancellation/hard runtime failures and reject above 4096 items.
  Use a barrier when integration actually needs all prior outputs.
- **Progress:** `ctx.phase` is run-global, so set it at top-level phase
  transitions rather than racing from concurrent workers; identify workers
  with labels. Log omissions when limiting scope.
- **Run envelopes:** inspect `status` for `completed`, `error`, `halted`,
  `paused`, or `cancelled`; read `result` as delivery output only on completion.
  A paused attempt is settled but the durable run is not finished.
- **Observation:** use workflow list/detail/progress APIs, not
  `read_agent`/`write_agent`, for workflow-owned agents. Runs are visible through
  their owning session. A `workflow.run_updated` event is an invalidation hint:
  re-read durable state instead of treating the event as a complete record.

### Durability is replay, not exactly-once execution

`ctx.step(key, producer)` journals a JSON result. **The key alone identifies the
cached value**: changing inputs or implementation does not invalidate that key.
Use semantic/versioned keys and bind recorded artifacts to their source revision
and content digest. Do not reuse an old acceptance result for changed code.

On resume, the workflow body begins again; completed journaled steps and matching
agent calls can be reused. Code outside durable steps can run again. A
`ctx.pause(key)` checkpoint pauses once and returns on the resumed attempt.
Only call it in the main workflow flow, not parallel/pipeline work.

Journaled producers are **best-effort at-least-once**, including crash and
same-key concurrency scenarios. A step wrapping a push, deployment, or migration
can execute the side effect and crash before saving its result. Use operation
identities, remote-state checks, idempotent scripts, and compensation/reconciliation
where required. A journal is not a transaction across GitHub, Git, and a cloud.

Persistent artifacts need the same care: a cached “file written” result does not
prove the file still exists or matches. Reconcile durable manifests against disk,
Git, and remote state on resume. `{ volatile: true }` reruns a producer instead
of replaying it; it is not a durability fix for unsafe side effects.

The custom session filesystem must support SQLite or workflow storage fails
explicitly. Sharing an extension copies its definition, **not** run history or
saved progress. The docs do not promise portable cross-machine recovery,
always-on hosted execution, or guaranteed completion after arbitrary process
termination. Cancellation is cooperative: propagate `ctx.signal` into subprocess
and external-work handling, and do not assume cancellation reverses side effects.
Aborting `waitForRun` stops waiting, not the workflow itself.

## Permissions, limits, and unattended safety

- Workflow subagents inherit the starting session's permissions. Interactive
  requests can wait for approval; the terminal `copilot workflow run` command
  does **not** show approval prompts, and unapproved requests are denied.
  Pregrant narrow required permissions for unattended runs.[concepts][howto]
- **Extension code itself can execute outside agent permission prompts.**
  Agent tool allowlists are not a sandbox for JavaScript orchestration.
  Review extension code and constrain direct subprocess, filesystem, and network
  operations in the implementation. Only load trusted project extensions.
- Do not equate autopilot, `--no-ask-user`, or broad tool grants with authorization
  to delete data, expose secrets, spend cloud budget, merge, or deploy production.
  Prefer explicit operation policy and scoped directories/domains. Treat
  repository text, downloaded specs, logs, and agent output as untrusted data.
- Support the platform limits `maxConcurrentSubagents`, `maxTotalSubagents`,
  `timeoutSeconds`, and `maxAiCredits`. Concurrency queues work; the other limits
  can stop it. AI-credit accounting is post-paid and can overshoot; timeout and
  cancellation are also not instantaneous. Limits are not exact spending caps.
- Public docs recommend limits and a small pilot; the installed guide cautions
  against inventing ceilings without user approval or measured cost knowledge.
  Use a deliberately small pilot scope, report actual cost, and configure
  user-specified or empirically justified limits. Application-level finite repair
  counts still prevent endless owner/critic disagreement.
- Resume a limit-stopped run with a raised **cumulative** total, not a fresh
  allowance. Previous usage remains counted. Do not automatically raise an
  approved spending limit. Cancelled runs cannot be resumed.[howto]
- Neither reviewer consensus nor all-green local tests guarantees absence of
  defects. Require traceability, appropriate independent evaluation, tested
  rollback/migration behavior, and honest residual-risk reporting.

## Reuse and operation

This repository keeps the entire distributable in `gh-dynamic-workflows/`,
including the extension and read-only agent templates. The installer reads only
that directory and writes the discovery files into a separate target project's
`.github/` directory. Merely cloning this repository no longer auto-registers
the delivery workflow. See [QUICKSTART.md](QUICKSTART.md) for installation and
copy-and-paste invocation steps.

By default, chat-authored workflows are session-scoped. For repository reuse,
publish the extension directory containing `extension.mjs` under
`.github\extensions\`; personal reuse uses the user's `.copilot\extensions\`.
Loading/reloading the extension registers the definition; **registration is not
execution**. Verify the registered workflow before invocation.[howto]

Enable CLI experimental features with `--experimental` or `/experimental on`.
Current official docs support a direct terminal invocation:

```powershell
copilot --experimental workflow run WORKFLOW-NAME --args @workflow-input.json
```

Replace the name and arguments with the extension's actual contract and supply
only its required permissions. In scripted/CI use, configure authentication
beforehand. When the working directory is not already trusted,
`GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true` permits project extension loading;
this explicitly authorizes repository code execution, not agent tool permissions.

For automation, `--silent --output-format json` provides the run record, while
`--result-file` writes only a successful returned result. A paused, failed, or
interrupted run leaves an existing result file unchanged, so a caller must check
the current run status/ID rather than mistake a stale file for fresh success.
Monitor/resume through `/workflows` or the owning session's workflow APIs.
Copilot app monitoring is documented for local sessions only.[howto]

## Acceptance checklist for the eventual implementation

- Greenfield specs and brownfield discovery enter one explicit input contract.
- Runtime/authentication preflight distinguishes unavailable capability from
  implementation/test failure; no fabricated successful execution.
- Requirements, architecture, UX applicability, task DAG, ownership, and
  acceptance evidence are durable, validated artifacts.
- Role review loops have independent identities, bounded repair, and fail-closed
  handling of `null`, malformed results, missing evidence, and hard failures.
- Tests and deployed-state checks use real commands/evidence; unsupported or
  unexecuted checks are reported, not labeled PASS.
- Parallel writers cannot collide, and existing multi-repo dispatch conventions
  remain intact.
- Resume rechecks artifact/source identity and reconciles side effects; it does
  not rely on exactly-once behavior.
- Remote writes and deployment require explicit operation authority; otherwise
  return a truthful local-complete or blocked status, not deployed success.
- Final results identify implemented, verified, deployed, deferred, blocked,
  and failed requirements separately, with residual risk and next action.

[announcement]: https://github.blog/changelog/2026-10-01-dynamic-workflows-in-copilot-cli-and-the-copilot-app/
[concepts]: https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/dynamic-workflows
[howto]: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-dynamic-workflows
[concepts-source]: https://github.com/github/docs/blob/6965ff418b339edaf8a8657062598ff00a66c411/content/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/dynamic-workflows.md
[howto-source]: https://github.com/github/docs/blob/6965ff418b339edaf8a8657062598ff00a66c411/content/copilot/how-tos/use-copilot-agents/use-dynamic-workflows.md
[loops-source]: https://github.com/hoopdad/thought-connections/blob/503f3f8b487827014f30c3d23b8f14c86141ffa0/loops.yml
[loops-head]: https://github.com/hoopdad/thought-connections/commit/7904b4566a2b01c0d2cf6bf6cbfe7d081b5fb7d3
