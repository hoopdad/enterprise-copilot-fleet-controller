# Autonomous product delivery with Copilot dynamic workflows

An opt-in, code-defined delivery workflow for a product specification, architecture
specification, or feature request against an existing codebase. Humans supply the
goal, acceptance criteria, workspace, baseline/test/build commands, and an authorized
nonproduction target. Agents do the analysis, implementation, review, repair, and
deployment-adapter preparation; the coordinator deploys and runs real verification
and smoke checks without a routine human checkpoint.

This is a **Copilot extension**, not a GitHub Actions workflow and not an executable
interpretation of `loops.yml`. The orchestration translates its release/sprint
owner-and-reviewer loops into executable gates. See [RESEARCH.md](RESEARCH.md) for
the source analysis, role mapping, references, and preview limitations.

**Start here: [PowerShell quickstart — four copy-and-paste steps](QUICKSTART.md).**
**Ask Copilot to install it: [copy/paste installation prompt and manual Windows equivalent](QUICKSTART.md#copypaste-installation-prompt-for-github-copilot).**
Bring an existing project, specification, working baseline/test/build toolchain,
and an authorized existing nonproduction target; these are not sample applications.

## Install

Use a current Copilot CLI with experimental features enabled, a supported
authenticated account, and Node.js 22 or newer. The SDK is supplied by Copilot;
there is no `npm install` step. Public preview eligibility can differ from the
original announcement; see [the research](RESEARCH.md#reconciling-availability-and-execution-eligibility).

All distributable sources, examples, tests, and registration/agent templates live
under `gh-dynamic-workflows`. This framework repository does **not** auto-register
the extension from its root. From the framework root, install once into a
**different, existing project** (not this source checkout):

```powershell
$target = (Resolve-Path -LiteralPath (Read-Host 'Existing product repository folder')).Path
node .\gh-dynamic-workflows\install.mjs $target
if ($LASTEXITCODE) { throw 'Installation failed; stop here.' }
Set-Location -LiteralPath $target
copilot --experimental
```

In that target session, complete initial project trust/permission setup and ask:
**"Reload extensions and list registered dynamic workflows."** Confirm that
`autonomous-delivery` is registered and the extension has no startup error.
Loading an extension does not run a delivery workflow.

The installer copies runtime modules into the target's `gh-dynamic-workflows`,
`templates/extension.mjs` into `.github\extensions\autonomous-delivery\extension.mjs`,
and `templates/delivery-reader.agent.md` into `.github\agents`. The agent is
read/search-only. The installer refuses existing destination files and symlink
destinations rather than overwriting user
configuration. Review the extension before trusting a project. Run installation
once; upgrading an existing copy requires reviewing and deliberately replacing
the specific installed files.

## Supply the inputs

Copy and adapt one of the examples into your target project:

| Starting input | Example | Initial behavior |
| --- | --- | --- |
| Product specification | [product.json](examples/product.json) | Build, deploy to the named test target, verify, smoke |
| Architecture specification | [architecture.json](examples/architecture.json) | Build, deploy to the named test target, verify, smoke |
| Existing application plus feature goal | [brownfield.json](examples/brownfield.json) | Baseline regression gate, implement, deploy, verify, smoke |

These are **templates**, not runnable sample applications: their specification,
baseline/test/build scripts, toolchain, and target must exist in your project. The
workflow can generate deployment, verification, smoke, and reconciliation scripts;
you do not need to write those first. Replace
generic acceptance text with separately testable criteria. For an empty project,
first supply a minimal toolchain and reviewed baseline/test/build scripts; the
workflow does not guess package installation commands or provision infrastructure.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Currently `1` |
| `projectRoot` | Target project directory, resolved relative to Copilot's working directory; normally `"."` |
| `input` | `kind`: `product`, `architecture`, or `brownfield`; `path`: spec file or existing source directory; `goal`: requested outcome |
| `scope` | Explicit repository-relative paths that proposed changes may write |
| `generatedPaths` | Optional build-output directories excluded from source-drift checks; must not overlap write scope, input, or `.github` |
| `acceptance` | Nonempty, unique, concrete criteria that planning and final review must each cover |
| `attempts` | Human-selected `planning` and `implementation` attempts (at least one), and `repair` attempts (zero or more) |
| `commands` | Nonempty `baseline`, `test`, and `build` lists of reviewed commands |
| `execution` | Explicit local command authorization and exact acknowledgement from the examples |
| `deployment` | Named authorized nonproduction target; unattended deployment is the default. `build-only` and `pause-before-deploy` are explicit alternatives |

Use top-level `acceptance` for requirements that local tests/build and source
review can establish, and `deployment.acceptance` for live-target criteria. The
adapter must verify the latter after deployment; do not ask a predeploy reviewer
to certify an event that has not happened.

Repository-relative paths inside JSON use `/` for portability, e.g.
`"specs/product.md"`; terminal filesystem paths use the host's syntax. Do not use
absolute paths, `..`, symlinks, or secret paths inside the write scope. Git metadata,
agent/extension definitions, dependency directories, and workflow records are
protected from proposed writes. Each planned task must own disjoint paths,
including tasks ordered by dependencies; put related edits to the same files in
one task.

Each command is an object with `executable`, `args`, `cwd` (relative to the target
root), and positive `timeoutMs`. Commands run **without a shell**. On Windows,
`.cmd` / `.bat` executables such as `npm.cmd` are rejected; use a reviewed native
executable or Node script entrypoint instead. Put lint, type checks, security
scans, and E2E commands into `test` as appropriate for the product, not just a
trivial placeholder test.

By default, subprocess output is not sent to agents or durable reports. For
actionable test-failure repair, you may explicitly add this to `execution` after
reviewing what the commands can print:

```json
{
  "shareDiagnostics": true,
  "diagnosticsAcknowledgement": "I authorize redacted diagnostics to be shared with workflow agents"
}
```

This captures bounded output and redacts common credential forms; redaction is
best-effort, not a guarantee that arbitrary sensitive data is removed. Keep
diagnostics disabled for commands that can print sensitive data. Without it,
repair has command/exit information and source inspection, but not failure text.

## Run

After reviewing the input and granting only the needed agent read/search paths,
run from the target project directory:

```powershell
copilot --experimental workflow run autonomous-delivery --args '@delivery-input.json'
```

For machine-readable output:

```powershell
copilot --experimental workflow run autonomous-delivery --args '@delivery-input.json' --silent --output-format json --result-file .delivery-runs\delivery-result.json
```

Keep result/log files outside the target workspace, or in `.delivery-runs`, so
their changes do not invalidate source fingerprints. Inspect the **current run
envelope and returned delivery status**, not merely process completion or the
existence of a result file. The CLI can leave a previous result file unchanged
when a later attempt pauses or fails. A workflow envelope marked `completed`
can contain an application-level `blocked` or `failed` result.

You can also ask in an interactive session: **"Run autonomous-delivery with the
JSON arguments in delivery-input.json."** For a limit policy, explicitly provide
your own concurrency, total-subagent, timeout, or AI-credit limits to the workflow
invocation. The extension declares no guessed resource ceilings. Repair attempt
counts are separate from runtime resource limits; credit caps are soft, post-paid
limits rather than exact spending guarantees.

The direct terminal runner does not prompt for missing agent permissions; denied
reads can block the workflow. Prefer a small interactive pilot to establish narrow
permissions. Do not globally authorize all tools to hide a permission failure.
Extension subprocesses run directly, outside agent tool approvals; the explicit
input authorization is therefore important.

## Delivery and resume

The normal path is **implement -> test/build -> deploy -> verify -> smoke**,
with no manual pause between steps. Specify the target once:

```json
{
  "deployment": {
    "environment": "test",
    "target": "my-existing-test-target",
    "acceptance": ["Target serves the expected built revision and feature smoke checks pass"],
    "authorized": true,
    "idempotent": true,
    "allowedExecutables": ["node"]
  }
}
```

Omitting `mode` selects `nonproduction`; omitting the deployment target/config
does **not** silently select build-only. `authorized: true` grants authority for
this target and its deployment/check scripts for the run, without an additional
magic deployment acknowledgement or human approval at each stage. Repository
instructions must give the agent enough information to find the named target,
its endpoint, and the existing deployment mechanism.

Deployment and check subprocesses receive `DELIVERY_TARGET`, `DELIVERY_RUN_ID`,
`DELIVERY_SOURCE_FINGERPRINT`, and `DELIVERY_BUILD_FINGERPRINT`. Use those identities
to stamp the deployed artifact and compare the target's reported revision with
the exact build being delivered. Do not use an arbitrary "latest" revision as
verification evidence.

If `command`, `verify`, and `smoke` are absent, the workflow has a DevOps agent
prepare the adapter and scripts inside your authorized write scope, independently
reviews them, and includes them in validation before deployment. Include a path
such as `scripts/delivery` in `scope`, as the examples do. Generated adapters write
only under `deployment.adapterPaths`, which defaults to `["scripts/delivery"]`;
set it explicitly to use another scoped directory. A generated adapter
may use only `allowedExecutables` (default `["node"]`); add native tools your
approved deployment mechanism requires. Alternatively, supply an explicit
`command`, `verify`, and nonempty `smoke` list to reuse existing automation.

The verify/check scripts must probe the actual target and expected built revision,
not just check whether a server returns HTTP 200. Smoke scripts exercise deployed
behavior. The coordinator, not an agent's claim, decides success from real command
results. Local acceptance review is not evidence of a completed deployment.

Transient readiness or smoke failures receive bounded automatic retries.
Deployment recovery uses the adapter's reconciliation check: exit `0` means the
expected revision is already present, exit `10` positively confirms absence and
safe retry, and any other result means unknown state. Unknown state stops the run;
failed deployment commands are never blindly repeated just because they returned
nonzero. Attempt expenditure is persisted so resume cannot replenish the budget.

The default retry policy is:

```json
{
  "retry": {
    "deployAttempts": 3,
    "verifyAttempts": 3,
    "smokeAttempts": 3,
    "delayMs": 1000
  }
}
```

Place this under `deployment` to override it. Attempt counts must be integers
from 1 to 10; delay must be an integer from 0 to 60000 milliseconds. These are
application retry bounds, not workflow subagent/credit limits. Retry waits honor
cancellation, and automatic redeployment still requires positive reconciliation.
Successful checks also consume the cumulative budget. Resume revalidates live
state but does not reset spent attempts; after exhaustion, investigate the failure
and start a new run rather than repeatedly resuming.

For intentionally local-only work, set `"deployment": {"mode": "build-only"}`.
It returns `built` only after real test/build commands and independent acceptance
review, and never claims deployment. Set `mode` to `pause-before-deploy` only when
you explicitly want a review checkpoint. There is no default deployment pause.

The workflow does not establish cloud credentials, create paid infrastructure,
promote to production, commit, push, or automatically roll back. Secret-bearing
environment variables are filtered from command subprocesses; use an already
authenticated, appropriately scoped local CLI or credential broker, not inline
credentials. Target classification and command behavior must be reviewed by the
operator; a JSON label cannot prove that a command is nonproduction.

In the owning Copilot session, ask to inspect the run by ID and **resume that same
run** after reviewing the checkpoint. Use workflow run/detail/progress APIs, not
ordinary background-agent inspection. A pause is one-shot: resuming passes it,
but does not grant new deployment authority. Input authorization must already
cover the target and the permitted adapter preparation/execution. Do not edit the input mid-run; start a new
run for changed scope or policy.

Records live in `.delivery-runs\<run-id>`, including input identity, loop mapping,
plan, generated adapter and preparation progress, preparation fingerprint,
deployment receipt and attempt log when applicable, and
`closeout.json`. Keep this directory local and out of version control. Source and
build fingerprints guard against drift; verification and smoke checks rerun
rather than trusting a cached success. An ambiguous deployment receipt triggers
automatic reconciliation; only an inconclusive result or an exhausted budget
requires intervention. Journaling is not
an exactly-once transaction, and run history is not copied by the installer.
The unattended deployment upgrade versions its durable keys; start a new run
instead of resuming an older run under changed execution semantics.
When installing into another project, add `.delivery-runs/` to that project's
`.gitignore`; the installer deliberately does not modify existing project policy.

## Implemented loop and limitations

The coded flow is intake/baseline -> reviewed architecture/UX/requirements/DAG
plan -> parallel read-only implementation proposals and independent critics ->
coordinator-owned file writes -> real test/build and bounded repair ->
independent local criterion coverage -> autonomous nonproduction deploy/verify/smoke
-> closeout. Build-only is an explicit alternative, not the delivery default.

Planning compresses the reference release/sprint planning roles into one reviewed
artifact. Backlog expansion, separate sprint retrospectives, and release-document
generation are **deferred**, not silently claimed as implemented source loops.
Post-deployment recovery handles transient failures and safe reconciliation; it
does not rewrite product code after a persistent smoke failure or automatically
roll back. Such a failure is reported honestly instead of repeatedly mutating a
live target.
Agents propose complete UTF-8 file contents; this version does not delete files,
handle binary edits, or isolate arbitrary untrusted build scripts. Large legacy
applications should be scoped to a feature-sized increment.

To run the dependency-free implementation tests from this repository:

```powershell
node --test .\gh-dynamic-workflows\test\*.test.mjs
```

## Autonomy and trust boundary

The workflow aims to minimize human intervention after a sufficiently precise
input. It cannot guarantee that an arbitrary specification produces a correct
product. Missing requirements, failed agents, exhausted repair attempts, unavailable
credentials, or failed checks must block delivery rather than count as success.

Start in a disposable branch or dedicated worktree. For brownfield projects,
provide the existing regression commands and compatibility requirements; do not
replace the existing application wholesale. Review the resulting diff before
merging.

Deployment is a separate, explicitly scoped capability. Local build/test completion
is not a deployed release. A deploy command must target an authorized non-production
environment, followed by real post-deployment checks. A resumed checkpoint is not
new permission, and a journal entry is not proof that external state remains healthy.
Never supply production credentials or put secrets in input files, prompts, command
arguments, or workflow reports.

Agent role and file-ownership instructions are coordination mechanisms, **not an
OS sandbox**. Likewise, supplied commands execute code with the extension process's
local permissions. Only run reviewed commands and trusted repositories. Keep
Copilot's tool approvals and directory grants narrow; this workflow does not require
blanket `--allow-all` or removal of user approvals.

## Relationship to the fleet controller

This is an optional standalone workflow. It does not alter `init.sh`, generated
projects, migrations, or the parent/child queue protocol. Existing generated fleet
projects must continue using their MCP child-agent runner, scoped tools, and
predeploy gate; do not use this extension to bypass those controls. Invoke their
approved deployment scripts rather than replacing the framework's gate.

## Opt-in companion: lab-delivery

`lab-delivery` is a **separate, explicitly authorized Azure nonproduction
profile**, not a change to the `autonomous-delivery` behavior described above.
It adds declared multi-repository roots, independent capability grants, all
13 release/sprint role loops, and reviewed deterministic scripts executed by
operation agents through admitted tickets.

Read [LAB-DESIGN.md](LAB-DESIGN.md), the exact input/native execution
[LAB-CONTRACT.md](LAB-CONTRACT.md), and the
[companion quickstart](QUICKSTART.md#optional-lab-delivery-companion) before opting in.
[examples/lab.json](examples/lab.json) is a **placeholder input template**, not a
runnable sample app. Its default is local-only with provisioning, provider
registration, publication, repository creation, and paid model tests all disabled.
It still needs actual Azure identity/topology observations and working local
scripts; it does not simulate a cloud environment.

### Adoption and installation

The same standalone installer now also places `lab-policy.mjs`,
`lab-executor.mjs`, `lab-loops.mjs`, `lab-workflow.mjs`, `lab-scratch.mjs`,
`lab-preflight.mjs`, `LAB-CONTRACT.md`, and
`LAB-DESIGN.md` alongside the original modules, and installs `lab-reader`,
`lab-author`, and `lab-operator` under `.github\agents`.
The existing extension registers both workflows; installation/loading does not
authorize or execute lab delivery. Every destination is preflighted before copying:
existing files and symlink destinations are refused, including the new profiles.
Existing instructions are never overwritten.

Install only into a separate project. Repeat installation deliberately fails
without overwriting files; it is not an upgrade command. Review/back up installed
files and deliberately replace the relevant modules/profiles when upgrading.
Version/input changes need fresh journal identity after pending effects have been
reconciled; do not delete old journals or steal a lease to bypass unresolved work.
No generated fleet templates, version markers, or migrations are changed.

An owner must **explicitly opt into direct SDK lab dispatch** when adopting this
execution model in a project that requires MCP child queues. The extension cannot
automatically override those instructions. If there is no such authority, stop
and use the existing fleet workflow.

### Authority and execution

Select read/write/create repositories and exact write scopes. Roots can be
siblings but must be nonlinked and disjoint. Declare `bootstrapPaths`,
`documentationPaths` (exact Markdown files), `maxSprints`, and all four
`attempts` budgets, including `recovery`. Preserve unrelated and initially dirty
work. Full tracked/nonignored source monitoring is default; shared writable roots
may explicitly choose dependency-scoped `sourceScope`/`instructionPaths`, while
keeping all assigned paths, instructions, specification, scripts, and dependencies
monitored.
Narrow read monitoring/dependency declarations may use an immediate `infra/*.tf`
selector: membership and file bytes are pinned, so additions invalidate identity.
No recursive globs or wildcard write scopes are allowed. Public SSH keys may be
monitored; private keys, state, secrets, and authentication material stay excluded.

Choose **independent** boolean grants for provisioning, provider registration,
publication, repository creation, and paid model tests. Deployment is separately
selected through `target.deploy`. Public and private publication both require
exact owner/name/visibility/branch and create/tag policy. Local-only completion is
valid when the target does not require publication; it returns `built`, not a
cloud claim. Production, destructive changes, access/credential changes, quota
requests, and trust bypass are not authorized.
The sole optional IAM exception is the independently granted, exact runtime
identity-to-model assignment described below; provisioning alone never grants it.

Publication has a mandatory reviewed two-step artifact:
`{prepare:{command,reconcile},command,reconcile}`. Prepare creates only a task-scoped
**local commit**, without pushing or creating a remote. The coordinator
deterministically checks committed paths before admitting the publish command.
Preserve unrelated staged index entries through explicit path-only commits or an
isolated index. Initially dirty paths require explicit
`publication.includeInitialDirtyPaths` authority (default `[]`), even when they are
inside writable scope. The later push/remote creation remains limited by the exact
public/private target and independent creation grant.

Existing shared infrastructure additionally needs monitored owner-contract bytes
with exact `sourcePaths`, `addressPrefixes`, `resourceTypes`, `actions`,
`stateOwner`, `subscriptionId`, and `tenantId`. Native plan checks enforce resource
type and actual resource location against the admitted owner; a matching region or
address prefix alone does not authorize arbitrary resources.

`terraformPolicy` separates requirement from preference. The default
`{requirement:"any",preference:"avm"}` permits any valid Terraform; AVM is preferred,
**not enforced**. Only explicit `requirement:"avm"` makes it mandatory.
Architecture and every Release Plan/revision artifact preserve the exact policy.
Provisioning also requires a monitored nonsecret `infrastructureProfile` JSON
reference containing `{policy:{...},metadata:{...}}`. `policy` holds immutable
adopter-approved rules/limits/types/IDs; intake identity pins it as
`infrastructureCeiling`. Source authoring/resume cannot enlarge those approvals.
`metadata` is separately finalizable registry state, not the intake permission
ceiling. After implementation/build, snapshot
`{terraform,profile:{repository,path,sha256},rules:profile.policy,
metadata:profile.metadata,ownerContracts}` and independently review the exact
policy/adapter/build identity before admission. Reserved-to-finalized metadata
changes within unchanged rules are valid; resume uses the frozen accepted
snapshot, not an earlier reservation or replacement permissions.

### Optional identity-before-post-provision ordering

`deploymentOrder` defaults to `"provision-first"`; existing delivery ordering is
unchanged. Opt-in `"identity-before-post-provision"` permits a monotonic ordered
stage list with `phase:"before-deploy"` (default) followed by `phase:"after-deploy"`.
The sequence is pre-provision -> deploy and positively reconcile physical identity
-> pin its actual native receipt -> post-provision Terraform -> verify/smoke/model.
It avoids demanding model access before the deployment's identity exists.

Post-stage context adds `phase` and
`runtimeIdentity:{identity,operationId,receipt,path,evidenceHash,binding}`.
Deployment reconciliation returns actual
`runtimeIdentity:{principalId,resourceId,tenantId,subscriptionId,evidence}`;
`principalId` is a GUID. Canonical guards echo `runtimeIdentityHash` from the pinned
receipt's `evidenceHash`. Before dependent effects/resume, a fresh read-only
observer checks the **original** deployment and identity. Principal drift blocks;
never redeploy or retarget to manufacture matching identity.

`authorization.runtimeIdentityModelAccess:true` is a separate narrow exception,
requiring provisioning, deployment, opt-in ordering, and immutable
`infrastructureProfile.policy.runtimeIdentityModelAccess` with exact
`deploymentResourceId` plus `assignments:[{scope,roleDefinitionId}]`.
Every scope is an exact model ARM resource in the authorized subscription and
every role is a full exact role-definition UUID ARM ID. Only known AzureRM/AzAPI
role-assignment **creates** for the observed principal, exact scope/role, and
`ServicePrincipal` are allowed—no updates, condition/delegation properties, or
other IAM authority. The guard additionally needs
`checks.runtimeIdentityModelAccess:{pass:true,evidence:[actual refs]}`.
Source/build freeze, saved-plan admission, positive reconciliation, and no-replay
rules remain in force; opting into ordering alone grants no model/IAM permission.

Stage-specific roles share only these profiles:

* `lab-reader`: `read`, `search`; planners and independent reviewers.
* `lab-author`: `read`, `search`, `edit`; scoped source/docs, DevOps operational
  scripts, and Git Publisher publication scripts. No terminal/executor.
* `lab-operator`: `read`, `search`, `lab_execute_ticket` only; the responsible
  operation agent executes one admitted ticket, without raw terminal or edits.

The coordinator freezes exact native script/dependency bytes, source/build,
arguments, target, stage order, and saved-plan identities. Independent reviewers
inspect actual bytes before admission. Tickets are single-use; mutation intent
is durably recorded **before** spawning. The coordinator consumes actual persisted
native receipts rather than agent summaries. Tool profiles and application checks
are **not an OS sandbox**; trusted scripts run with local process permissions.

Architecture, UX, Release Plan, Sprint Design, Sprint Architecture, Sprint Plan,
UI Work, Developer Work, End-to-End Test, DevOps Work, Sprint Review, Retrospective,
and Release Closeout retain their full independent owner/reviewer sets.
Each sprint has separate source/build freeze and delivery. Every required reviewer
must PASS; a Stakeholder agent is not human signoff.

Sprint Review returns
`{coverage,backlog:[{id,requirementIds,description,blocking}],resolvedBacklogIds?:[]}`.
Blocked criterion coverage is allowed there only with a matching blocking,
in-scope correction and actual evidence; it is not final release acceptance.
Unknown/new goals are deferred. Open in-scope blocking corrections trigger an
independently reviewed Release Plan revision that preserves the completed sprint
prefix/order and assigns every correction's ID via `backlogIds` to remaining
sprints within the user's `maxSprints`. An exhausted bound blocks. Retrospective
returns reviewed improvements, and the next sprint's design, architecture, and
plan actually consume retained backlog/improvements. Resolution requires retained
IDs and actual evidence; closeout still requires every criterion verified.

### Evidence, recovery, and validation boundaries

Bootstrap observes exact identity -> authorized providers -> relevant numeric model
capacity -> complete topology -> actual baseline. Ordered provisioning stages
plan only after prior positive application/reconciliation. Apply consumes saved,
reviewed native plan bytes; it never replans. Late-bound origins/evidence stay
ignored and bind actual HTTPS origin, source/build/revision, target, and stage.
Local tests, native plans, applied state, live revision, scripted product
acceptance, browser acceptance, and paid model acceptance remain separate claims.

Canonical saved-plan guards are version 2, bind the accepted policy and every
plan-stage identity, and provide actual evidence for resource semantics, parent/
remote IDs, permitted properties, dependency closure, cumulative scope, Terraform
policy, and accepted metadata. Reviewed canonical helpers check actual AzureRM/
AzAPI ARM semantics; the generic engine retains destructive/action/address/owner
bounds without imposing provider identity. Cross-region read/no-op inputs are
allowed. The engine independently checks the sorted unique cumulative
`stateOwner:Terraform-address` create/update union across prior stages/sprints.
`DELIVERY_PLAN_CONTEXT` identifies private `{policy,policyIdentity,priorAdmissions}`
JSON during provisioning and binds `planContext`; `DELIVERY_PLAN_EVIDENCE` remains the exact saved binary
at apply, never the context file. All 20 approved native environment names,
including run-owned `DELIVERY_EVIDENCE_DIRECTORY`, retain validation/filtering.

Closeout README and release notes are local changes **after** the deployed freeze,
not automatically published/deployed final documentation. Final closeout tests
revalidate those changes. Results explicitly distinguish `documentationPublication`
and `closeoutSourceFingerprint` from the earlier frozen delivery revision/build.

Native scripts write actual bound PASS evidence to `DELIVERY_EVIDENCE_PATH`;
zero exit or a local receipt is not cloud proof. Reconciliation distinguishes
`completed`, positively `absent` with `safeToRetry:true`, and `unknown`.
Unknown effects block and survive run completion/new run IDs in the workspace
target ledger. Bounded read-only investigation and reviewed original-observer
argument refinement do not authorize replaying a mutation.
Resume retained original work before new authoring. The local workspace lease is
not a distributed Azure lock; do not share a target/state across workspaces.

### Optional standalone offline preflight

Preflight is **explicit opt-in**, not an automatic workflow gate:

```powershell
node .\gh-dynamic-workflows\lab-preflight.mjs .\lab-input.json
node .\gh-dynamic-workflows\lab-preflight.mjs .\lab-input.json --resume RUN-ID
```

It uses local input/root/inventory/scratch checks and shared retained-plan resume
integrity validation, without framework agents, model calls, or cloud operations.
Optional `commands.preflight` helpers must themselves be reviewed offline-only
native scripts; although optional for workflow inputs, explicit helpers are required
to invoke standalone preflight. Each emits actual PASS evidence bound to run/source, with
`data.offline:true`, all `prerequisites`/`dependencyInventory`/`scratchOwnership`
checks true, and `consumedSources` exactly matching its own pinned inventory
including entry script and expanded collection members. This is **not cloud
certification** or plan admission.

For this offline invocation, `DELIVERY_PLAN_CONTEXT` identifies the helper's private
command/dependency inventory, not a cloud-policy admission.

`/.delivery-runs/` must actually be Git-ignored. Helpers use `withScratch` from
`lab-scratch.mjs` with the supplied `DELIVERY_EVIDENCE_DIRECTORY`; it creates unique
marked children and cleans those children in `finally`, preserving unrelated
files. Invalid supplied paths fail, without fallback to source-adjacent fixtures.
The example's preflight script is a placeholder, just like its baseline/build:
replace it with an actual reviewed helper, or omit the optional command array.
If omitted, skip standalone preflight; the workflow does not require it.

Run `node --test gh-dynamic-workflows/test/lab-install.test.mjs` from the framework
root for installer coverage. Companion unit/native regression tests are separate
from live validation. An actual installed-extension CLI probe completed with
`failures=0`: both workflows and `lab_execute_ticket` registered. That probe did
**not** execute a delivery or establish cloud/live acceptance.
Foundry model calls may be validated only against an already
usable, explicitly approved endpoint; package validation must not provision,
register providers, deploy, publish, or create access. Without an available approved
endpoint, report live Foundry validation **unverified**, not simulated success.
