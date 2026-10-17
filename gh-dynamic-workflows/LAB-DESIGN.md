# Autonomous Azure lab delivery design

Status: implemented; independently critiqued, including the downstream v6
integration amendments. Validation outcomes are recorded below.

## Agreed boundary

Add opt-in `lab-delivery`; preserve `autonomous-delivery` and its reader policy.
This package is standalone, not a replacement for generated fleet MCP queues.
An adopting project must explicitly authorize this execution model where its
instructions would otherwise require fleet dispatch. Never overwrite those
instructions. Nonproduction only; no implied production, destructive-change,
credential, access-grant, quota-request, or trust-bypass permission.

Support declared read, scoped-write, and creatable Git roots. Root declarations
may resolve siblings; repository-relative file paths may not traverse. Reject
linked roots, nested/overlapping roots, and linked source/command paths. Use
Git-aware tracked/nonignored source censuses. Preserve initially dirty bytes;
never claim, stage, revert, or publish unrelated changes.

Provisioning, provider registration, publication, repository creation, and paid
model tests are independent grants. Public and private GitHub targets require
exact owner/name/visibility authorization. Local-only delivery is valid unless
the project's deployment policy requires publication or tags.

## Ownership and execution

The coordinator owns stage ordering, admissions, private artifacts, source/build
identity, and durable mutation intent. Source specialists implement within their
assigned scopes. A DevOps agent writes deterministic infrastructure/deployment
scripts; a separate publication agent writes deterministic Git scripts. Their
respective independent reviewers inspect actual script bytes, inputs, native
plan evidence, target identity, and operation authority before execution.

The responsible operation agent invokes the installed `lab_execute_ticket`
extension tool. Its operator profile has read/search and that tool only, without
terminal/edit tools. A separate author-stage profile writes scripts; independent
reviewers are read/search-only. The tool validates an unguessable, active,
single-use ticket, durably writes pre-effect intent BEFORE spawning, and persists
native results. The coordinator does not execute deployment/publication in its
place. A ticket binds exact script/dependency hashes, command arguments, source,
build, target, stage order, plan, authority, and intent. The executor checks the
ticket and persists actual process outcomes. Agent summaries never substitute
for execution receipts. Changed script bytes invalidate admission.

Publication has a reviewed local-only `prepare` operation before push.
The coordinator inspects committed paths against the original Git baseline and
write scope before issuing a publication ticket. Initially dirty bytes require
explicit `includeInitialDirtyPaths`; unrelated staged entries remain untouched.

The coordinator reads actual receipts from its private ledger after the agent
returns; it does not accept agent-returned JSON as native execution evidence.
Agent tool permissions and application checks are not an OS sandbox. Source
authors have editing tools and could exceed instructional scope; document this
limitation. Review roles use read/search-only profiles. Validate
the installed profile paths and tool sets before registering/running.

## Full release/sprint loops

Implement the explicit owner and reviewer sets from the root `loops.yml`
summarized in `RESEARCH.md`, rather than claiming a compressed approximation:

| Loop | Owner | Independent reviewers |
| --- | --- | --- |
| Architecture | Architect | Product Owner, Red Team, Critic |
| User Experience | Designer | Product Owner, Critic |
| Release Plan | Product Owner | Stakeholder, Architect, Designer, Critic |
| Sprint Design | Designer | Product Owner, Critic |
| Sprint Architecture | Architect | Product Owner, Critic, Red Team |
| Sprint Plan | Scrum Master | Product Owner, Architect, Critic |
| UI Work | Developer | Architect, Designer, Critic |
| Developer Work | Developer | Architect, Critic |
| End-to-End Test | Developer | Architect, Critic, Product Owner |
| DevOps Work | DevOps Engineer | Architect, Critic, Developer |
| Sprint Review | Product Owner | Scrum Master, Critic, Architect, Red Team |
| Sprint Retrospective | Product Owner | Scrum Master, Critic, Architect, Red Team, Designer, Developer |
| Release Closeout | Product Owner | Stakeholder, Architect, Critic |

Each loop persists an owner artifact and every role's independent vote. All
required reviewers must agree before readiness; an agent playing Stakeholder
does not manufacture an actual human approval. Non-UI UX/design loops still
produce reviewed not-applicable rationale. Every agent label includes run,
loop/stage, role, sprint index, attempt, artifact digest, and observation identity,
not just read-only research labels. Current and cumulative architecture,
UX, requirements, risks, and earlier sprint feedback flow into later loops.

The release plan has a finite, human-selected maximum sprint count. Every exact
acceptance criterion must have a stable ID and planned verification. Sprint plans
assign every task to a role/repository with a disjoint write scope and validated
dependency DAG. Ready independent assignments run in parallel, then integrate.
E2E uses actual reviewed commands; failures return evidence to bounded repair.
DevOps includes real cloud checks, not just build output. Sprint review records
new/blocked backlog items. In-scope corrections can enter remaining authorized
sprints; new goals/authority become deferred backlog rather than silent scope
expansion. Retro produces reviewed process/design improvements for the next
sprint. Closeout produces requirement coverage, release notes, and README changes
under authorized documentation paths, then revalidates any changed source.
Blocking in-scope backlog triggers a reviewed release-plan revision preserving
completed sprint definitions and assigning `backlogIds` to remaining sprints.
Exhausted sprint allowance blocks; new goals stay deferred. Closeout README and
release notes are local artifacts after the delivery freeze, with a separately
reported source fingerprint; they are not misrepresented as already published.

## Research, bootstrap, and reconciliation

Preserve context-dependent `PASS`/`BLOCKED` semantics as requested. Persist
`context: readiness|triage`; triage PASS confirms a stop and NEVER advances.
Independently triage FAIL, BLOCKED, and semantically invalid PASS. Concrete
REVISE findings return the original report, validation error, and review to the
responsible owner within the configured attempt budget. Fresh observation
labels prevent cached old research from masquerading as new observation.

Azure prerequisites proceed in causal order: target/authentication identity,
explicitly permitted provider registration, relevant numeric capacity checks,
then complete topology design and actual baseline. No billable probes during
read-only discovery. Missing future networks/origins are outputs, not discovery
failures. Provider sets, regions, resource/model identity, sizing, units, state
owners, and isolated CLI profile are inputs, not think-fast defaults. Empty
capacity is unknown; do not substitute models or resize an approved workload.
Repeat actual account/tenant/subscription/region observation before each cloud
mutation and its reconciliation, not merely once during bootstrap.

Any responsible agent can reason about an uncertain effect, receive reviewer
feedback, and escalate to upstream planning/architecture agents. Investigation
is bounded and read-only by default. Mutating remediation needs its own script,
authority, independent review, and intent. Reasoning alone cannot prove an effect
absent or safe. Only actual positive reconciliation of the original operation
permits progression or retry; preserve unknown effects when investigation fails.
Distinguish completed, positively absent/safe-to-retry, and unknown outcomes.
Recovery retains the original `DELIVERY_OPERATION_ID`. Agents can refine
data-only arguments to a frozen read-only observer after independent review;
they cannot swap the executable, script, dependencies or working directory.
Unknown observations and reviewer feedback drive bounded further investigation.
Recovery, mutation, readiness-check and repair expenditure survives resume.

Persist pending operation identity outside per-run completion records in a
workspace-wide target ledger. A new run cannot erase pending effects. Protect
concurrent RUNS with an exclusive workspace lease; never automatically
steal a stale lease. This lease is held by the coordinator, not by source tasks:
disjoint file/path assignments within one root may run concurrently in one run.
Mutation tickets are serialized by that coordinator; publication/provisioning
are not assumed independent. The coordinator is the sole ledger writer, so
parallel agents never race ledger appends. Filesystem leases are local, not distributed Azure locks.
An operator must not run a second workspace against the same target/state.

## Freeze, provisioning, and outputs

Full source monitoring is the default. Shared writable roots may explicitly
declare dependency-scoped monitoring; all write scopes, specification,
instructions, executed scripts and their declared dependencies remain covered.
Review transitive dependency closure; hashes do not discover arbitrary dynamic
imports or prove writer attribution. Actual consumed unmonitored code blocks.

Revalidate canonical roots and their physical identities on every resume and
before native execution; replaced/linked roots block even if content matches.

Each sprint has its OWN implementation, validation, source/build freeze,
optional publication, ordered provisioning, deployment, and live checks.
Later sprints consume prior admitted artifacts and positively reconciled target
state, not a mutable replacement for an earlier sprint's snapshot. Before any
new authoring, reconcile all pending effects using their original frozen inputs.
Retain hash-keyed private copies of accepted build artifacts and saved native
plans across sprints; recheck these snapshots around native execution. Model
review payloads use sanitized resource/action summaries and guard evidence,
never raw Terraform JSON/state or retained binary contents.
After implementation and all operational/documentation script authoring,
independent review and local checks, freeze source, accepted build receipt,
optional published revision, and ordered provision-stage definition.
Each stage plans only after prior stages positively apply/reconcile:

`plan -> inspect saved native bytes -> independent exact-plan review ->
persist admission -> persist intent -> operation agent executes exact saved plan
-> positive reconciliation -> next plan`.

Never regenerate a saved plan inside apply. Bind saved binary and native JSON
hashes and require canonical owner wrappers to prove their correspondence and
actual state/subscription/tenant scope. Reject destructive/replacement/unknown
actions. Changes to existing shared infrastructure require loaded owner-approved
contracts with exact source/resource/action/state limits; no regional shortcuts.
Canonical guard evidence additionally carries the full exact stage binding,
including numeric index zero; matching source alone cannot admit a stale build.
Terraform policy explicitly separates `requirement: any|avm` from
`preference: none|avm`. Defaults permit any valid Terraform and prefer AVM;
they do not require AVM. Architecture and release requirements must preserve
the exact policy, and canonical guards evaluate that same accepted policy.

The operator selected **reviewed canonical-adapter semantic guards**, not a
generic engine-maintained ARM resource catalog. Guards inspect actual ARM types,
canonical parent/remote IDs, permitted properties, owner resource limits and
project-specific approvals for equivalent AzureRM/AzAPI resources. Provider
identity neither grants authority nor rejects a legitimate resource. Generic
Terraform action, state-owner and contract-address ceilings still apply;
cross-region read/no-op inputs are not mutations. This remains a Terraform
native-plan contract, not a claim of support for arbitrary IaC plan formats.

Provisioning requires an adopter-owned, monitored, nonsecret JSON
`infrastructureProfile` with separate `{policy,metadata}` objects. The original
owner-approved `policy` ceiling participates in intake/resume identity and cannot
change; source edits or agent votes never enlarge approvals. Only `metadata`
can finalize within that ceiling. Snapshot finalized contents after implementation
and build, then independently review that exact policy together with the pinned
adapter scripts/build. Legitimate reserved-to-finalized transitions during
implementation are not rejected against intake reservations. Once accepted,
metadata and policy identity are immutable; resume validators receive the saved
policy explicitly, not an initial reservation or a missing registry argument.
The canonical helper determines project-specific finalization semantics.

Version-2 guards bind binary/JSON hashes, exact stage identity and accepted
policy identity. Each semantic check retains `{pass,evidence}` separately:
resource semantics, parent IDs, remote IDs, permitted properties, dependency
closure, cumulative scope, Terraform policy and accepted metadata. A bare
boolean or generic PASS does not suffice. The engine independently compares the
cumulative unique state-owner/Terraform-address union and count against actual
create/update changes across earlier stages/sprints and the current saved plan.
Resource-specific ceilings remain the canonical helper's responsibility.
`DELIVERY_PLAN_CONTEXT` points to a hash-pinned private policy/prior-admission
manifest. It is separate from `DELIVERY_PLAN_EVIDENCE`, which retains its exact
saved-binary meaning for apply. Cumulative history binds `planAggregate`.
Retained snapshots/context hashes are rechecked around execution; this incurs
history-proportional verification cost within the authorized finite release.
Actual own allocation counts only with independent observation bound to this
run's started stage and admitted plan.
Fresh account/capacity observations on resume may count allocated capacity only
with exact same-run started provisioning, matching revision/plan identity and
actual allocation evidence. The isolated CLI profile's physical identity is
pinned, and its credential contents are excluded from source censuses.
Credential profile paths cannot be assigned as source tasks, bootstrap work,
command entries or dependencies, including within broadly authorized new roots.

Late-bound actual outputs live in ignored evidence, never frozen source.
Origin receipts bind run/source/build/revision/target/tenant, actual HTTPS origin,
and supporting evidence. Admit only after positive deployment/reconciliation;
pin bytes and recheck before verify, smoke, browser, and resume. No loopback,
credentials, stale receipts, guessed resource domains, or origin/source rewrite.

## Evidence and completion

Local review, native plan, applied state, live revision, scripted acceptance,
browser acceptance, and paid-model acceptance are separate evidence levels.
Local-only completion is `built`, cloud completion is `deployed`, and incomplete
authority/authentication/unknown effects are `blocked`, never success-shaped.
Read actual native receipts and exact criterion coverage. Browser/model checks
are mandatory only when specified; health-only responses cannot satisfy product
criteria. Smoke/model actions may mutate application state and need retained
operation identity and reconciliation, not resubmitted prompts.
Physical completion and product acceptance are distinct facts. Reconciled
application actions require `acceptancePassed` plus exact per-lane criterion
coverage. An explicit native FAIL cannot become acceptance merely because the
request completed. Sprint Review must cite actual successful reconciliation
receipt IDs for live/browser/model criteria. Known product failures feed reviewed
corrective backlog; unknown effects never authorize re-submission.

Native environment forwarding remains an explicit nonsecret allowlist, including
the original four, isolated Azure profile/region/subscription/revision, actual
origin, stage ID/index, and plan evidence/identity/aggregate. Validate string
values including index `"0"`; retain sensitive-variable filtering. Propagate
abort/timeout/spawn/signal/exit distinctions; killing an outer process does not
prove cloud or descendant completion.

## Downstream integration and offline check

### Deployment-created runtime identities

An adopter may explicitly select
`deploymentOrder: "identity-before-post-provision"`; the default remains
`provision-first`. Provisioning stages have `phase: before-deploy|after-deploy`
(default before). All before-deploy stages must precede after-deploy declarations;
this preserves global stage indexes and the cumulative admission chain.
The opted-in sequence is foundation plan/apply/reconcile, deployment with
physical-completion reconciliation, pinned runtime identity, identity-dependent
plan/apply/reconcile, then final live verification and product acceptance.
Deployment reconciliation cannot require model access that a later stage creates.

The runtime principal comes from an actual successful native reconciliation
receipt tied to the original deployment operation, run, source, build and revision.
Pin receipt bytes and normalized principal/target/tenant/subscription. Reobserve
the original deployment read-only before dependent plans, mutations and their
reconciliation, including resume when deployment is already completed.
Identity drift blocks; it never triggers automatic redeployment or retargeting.
Post-deployment plan contexts and identities bind that original receipt. Keep
deployment's pre-stage aggregate/binding separate from the final full aggregate.
Native receipt bindings are compared by their required field values, not JSON
property order; the original receipt bytes remain hash-pinned. Read-only refresh
failure expenditure persists separately from total dispatch counts. Reserve the
failure debit before dispatch, refund only a proven pre-native interruption or
validated native success, and never reset earlier actual failures on resume.

`authorization.runtimeIdentityModelAccess: true` is a separately selected narrow
exception to the default prohibition on access grants. It requires provisioning,
deployment, opt-in ordering and immutable
`policy.runtimeIdentityModelAccess` with an exact `deploymentResourceId` and
`assignments:[{scope,roleDefinitionId}]`. Resource scopes must be exact model
resources in the selected subscription, not subscription/resource-group grants.
Canonical guards must verify model-access semantics and retain dedicated evidence.

For this IAM exception only, the engine additionally recognizes AzureRM/AzAPI
role-assignment plans and checks actual native fields against the observed
principal and exact approved scope/role tuples. Creates only, ServicePrincipal
only; updates, replacements, conditions, delegation and other principals are
not admitted. This explicit defense-in-depth carve-out is not a generic
provider-name admission policy or a general IAM catalog. Other permissions
remain prohibited. The feature permits generating/reviewing appropriate scripts;
implementing/testing it does not execute real access changes.

### Standalone integration boundary

Script dependencies may declare exact files or constrained immediate-directory
collections such as `{repository,collection:"infra/*.tf"}`. Membership and every
member's bytes are pinned; adding a matching file invalidates reviewed identity.
Dependency-scoped `sourceScope` supports the same immediate selector, including
future additions, without granting write access or recursively monitoring the
checkout. Public SSH key dependencies are permitted; private keys, Terraform
state and authentication caches remain excluded. Canonical helpers remain
responsible for actual consumed dependency completeness; hashes cannot discover
arbitrary dynamic imports.

Every native ticket receives `DELIVERY_EVIDENCE_DIRECTORY` under the ignored,
nonlinked per-run evidence tree. `withScratch` validates supplied ownership,
creates a unique marked helper child and cleans only that child in `finally`.
Invalid supplied scratch fails rather than falling back. The executor cleans
marked owned children after failure/abort; unrelated files/directories survive.
The framework requires `/.delivery-runs/` to be actually Git-ignored.

The operator selected a **standalone, optional** `lab-preflight.mjs` command,
not an automatic workflow gate. Before expensive investigation, an adopter can
run one offline integration check over explicit reviewed `commands.preflight`.
It inventories actual declared files/collections, invokes canonical local
prerequisite helpers, tests all 20 environment overrides in a real native child
(including stage index `"0"` and credential filtering), exercises scratch
preservation/failure cleanup, and optionally validates retained resume inputs
through the same plan/guard validators used by delivery. Helpers report actual
consumed files for exact inventory comparison. The framework makes no cloud or
model calls; selected helpers must themselves be offline-only.

Offline resume checks never replan, reapply or claim remote reconciliation.
They certify retained-input integrity only; delivery must still positively
observe original effects. Because invocation is optional, running this check
before investigation is the adopter's responsibility.

## Delivery and validation

1. Review and update this design with a critic before implementation.
2. Implement policy/root/loop contracts, native executor, durable state, and roles.
3. Wire bootstrap, full loops, reviewed delegated operations and recovery.
4. Install companion modules/contracts/roles/examples without overwrites or
   symlink destinations; document deliberate upgrades and fresh journal identity.
5. Run existing compatibility tests, companion regression tests, actual native
   environment and staged receipt tests, and real installed SDK registration.
   Never count only mocked environments as native propagation.

Foundry model use for validation is authorized. No cloud resource provisioning,
provider registration, access changes, Git publication, or deployment is
authorized as a side effect of implementing/testing this package. If no usable
Foundry endpoint is already available, report that validation layer as unverified;
do not provision a substitute or silently simulate a successful live run.

Cloud mutation behavior is exercised with native local fixture scripts during
package development, not by provisioning test resources. Actual SDK definition
validation and an isolated CLI registration probe are separate from workflow
execution. No unit-test result certifies a real Azure deployment or model run.

Identity-ordering amendment validation: all **55 targeted regressions passed**
with no failures or skips, including actual native subprocesses, retained-plan
resume without redeploy/replan/reapply, principal-drift blocking, persisted
native-failure allowances, owned scratch, canonical offline checks, and actual
installed SDK/isolated CLI registration. These use local fake-cloud evidence;
they do not establish successful live Azure deployment or model acceptance.

Baseline validation before the identity-ordering amendment: the complete package
suite passed **152 tests,
zero failures and zero skips**, with opt-in actual installed SDK definition and
isolated CLI registration probes enabled. Coverage includes original workflow
compatibility, all 13 lab loops, native environment propagation, staged local
fake-cloud delivery, finalized-metadata resume without replan/reapply, local-bare
Git publication controls, dependency collections, and the standalone offline
integration command. No real Azure resources, GitHub publication, or Foundry
model acceptance were exercised or certified.
