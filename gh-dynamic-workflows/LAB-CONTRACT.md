# lab-delivery contract

This companion is **opt-in**, Azure **nonproduction only**, and independent of
`autonomous-delivery`. [LAB-DESIGN.md](LAB-DESIGN.md) records its design;
`lab-policy.mjs`, `lab-executor.mjs`, and `lab-workflow.mjs` enforce its contracts.
Examples below describe artifacts, not working applications or proof of delivery.

## Adoption, grants, and roots

The source owner must explicitly adopt direct SDK lab dispatch if existing
instructions require MCP fleet queues. Installing/loading an extension is not that
authorization. Never overwrite existing instructions or silently reinterpret them.
Generated fleet dispatch and the original workflow remain unchanged.

Input is an object with:

| Field | Required meaning |
| --- | --- |
| `schemaVersion`, `profile` | `1`, `"azure-lab"` |
| `projectRoot` | Existing declared Git root, resolved from the invocation directory |
| `repositories` | Nonempty `{id,path,access,scope?}` declarations; `access` is `read`, `write`, or `create`; writable roots need explicit scopes |
| `specification` | `{repository,path}` identifying the real specification |
| `acceptance` | Nonempty `{id,criterion,level}` entries; stable unique IDs; `level` is `local`, `live`, `browser`, or `model` |
| `authorization` | Explicit booleans and acknowledgement described below |
| `target` | `{id,environment,deploy,requirePublication}`; environment is `dev`, `test`, `staging`, or `nonproduction` |
| `deploymentOrder` | Optional `"provision-first"` (default) or explicitly opted-in `"identity-before-post-provision"` |
| `azure` | Exact `{subscriptionId,tenantId,region,profile:{repository,path},providers:[],models:[]}`; profile identifies an isolated CLI directory |
| `commands` | Nonempty `baseline`, `test`, and `build` arrays; optional nonempty `preflight` array for explicitly invoked offline helpers |
| `terraformPolicy` | Optional `{requirement:"any"\|"avm",preference:"avm"\|"none"}`; defaults to `any` requirement plus `avm` preference |
| `infrastructureProfile` | `{repository,path}` for monitored nonsecret `{policy:{...},metadata:{...}}` JSON; immutable adopter-approved policy plus separately finalizable registry metadata; required for provisioning |
| `attempts` | Explicit integers `planning`, `implementation`, `recovery` >= 1 and `repair` >= 0 |
| `maxSprints` | Human-selected finite positive integer |
| `bootstrapPaths`, `documentationPaths` | Nonempty arrays of `{repository,paths:[...]}` writable assignments within repository scope; documentation assignments name exact `.md` files |
| `publication` | Optional exact `{repository,github:"owner/name",visibility:"public"\|"private",branch,tagRequired,create,includeInitialDirtyPaths?:[]}` |
| `ownerContracts` | Optional owner-approved references/limits for modifying existing shared infrastructure |

`authorization.acknowledgement` must be exactly
`"I authorize the explicitly selected nonproduction lab capabilities"`.
`localExecution` and `directSdkDispatch` must be `true`.
`provision`, `providerRegistration`, `publish`, `repositoryCreation`, and
`modelTests` must each be an explicit boolean. These grants are **independent**:
publishing does not authorize creating a repository; provisioning does not
authorize provider registration, paid model tests, quota requests, access changes,
credential changes, destructive replacement, or production. `target.deploy`
explicitly selects deployment; `requirePublication` cannot be satisfied without
publication authority. Paid model acceptance requires `modelTests: true`.
Provider registration is confined to the exact `azure.providers` ceiling.
Optional `authorization.runtimeIdentityModelAccess` is a boolean, denied unless
explicitly `true` with the immutable exact policy and prerequisites below. It is
independent of provisioning and paid model-test permission, and grants no general
IAM/access-management authority.

Publication requires the exact GitHub owner/name, visibility, branch, and explicit
tag/create policy. Both public and private publication need that authorization;
private is not an implicit safe default. `publish: true` requires `publication`,
and `create: true` additionally requires `repositoryCreation`.
`publication.includeInitialDirtyPaths` is an exact repository-relative file array,
defaulting to `[]`. Only explicitly listed initially dirty paths may enter this
run's publication; writable scope alone is not that permission. Preserve unrelated
staged index entries using explicit path-only commits or an isolated index.
Local-only delivery (`deploy: false`, `requirePublication: false`, no publication
grant) is valid and finishes `built`, never `deployed`. Live/browser/model criteria
require deployment. Building locally still uses real Azure identity/topology
bootstrap observations; it is not a simulated offline cloud run.

The isolated Azure profile directory must already exist, be nonlinked, and retain
its physical identity; it is rechecked before native execution.

Repository IDs and stage/criterion IDs are lowercase slug identifiers.
Declared repository roots may resolve siblings, but roots must be disjoint,
nonlinked Git roots (or explicitly creatable roots). Repository-relative paths
use `/`, must not traverse, and must not resolve through symlinks. Existing dirty
work is preserved; it cannot be claimed, reset, or silently included in this run's
publication. Inclusion requires the exact additional path authority above.
Canonical paths and physical root identities are checked again before
native execution and on resume.

Full tracked/nonignored source monitoring is the default. An explicitly shared
`write` root may opt into `sourceScope:[...]` with `instructionPaths:[...]`.
All write scopes, specification, owner instructions, scripts, and declared script
dependencies must remain monitored. Review the actual transitive dependency
closure: hashes do not discover dynamic imports or establish writer attribution.
Actual consumption of unmonitored code blocks delivery.
`sourceScope` may include a constrained immediate selector such as `infra/*.tf`
to monitor only `.tf` files directly in that directory. This is read monitoring,
never a wildcard write scope. Recursive patterns, arbitrary globs, and wildcard
write scopes are not supported. Public SSH keys (for example `id_ed25519.pub`) may
be monitored; private keys, state, authentication material, and secrets are excluded.

Owner contracts include `{repository,path,sourcePaths,addressPrefixes,resourceTypes,
stateOwner,subscriptionId,tenantId,actions}` with exact additive/update authority
(`create` and/or `update` only). `resourceTypes` is a nonempty exact type allowlist,
not implied by an address prefix. Their actual files are loaded and their bytes
must remain monitored. Native plan inspection checks resource types and actual
before/after locations against the admitted owner identity/region. A matching
region is not authority to mutate another owner's infrastructure.

### Terraform policy and finalized infrastructure metadata

`terraformPolicy.requirement` controls admission: `"any"` permits valid Terraform
without requiring Azure Verified Modules (AVM); `"avm"` explicitly requires AVM.
`preference:"avm"` is advisory, **not** a hidden requirement. Architecture owner
artifacts and every Release Plan/revision artifact must carry the exact configured
`terraformPolicy`. Never promote a preference into an enforced requirement.

Provisioning requires an `infrastructureProfile` referencing an actual monitored
nonsecret JSON object with this **two-part wrapper**:

```text
{
  policy: {...immutable adopter-approved rules, limits, resource types, IDs...},
  metadata: {...separately finalizable registry state...}
}
```

Intake identity includes `infrastructureCeiling = profile.policy`, **not**
reservation metadata. These policy rules cannot change during source authoring
or resume: editing source is not permission to enlarge resource approvals, IDs,
types, or limits. Metadata may finalize **within those unchanged rules** before
the exact post-build policy/adapter/build review. Reserved-to-finalized metadata
transitions are valid; do not freeze an intake reservation or mistake it for an
immutable authorization ceiling.

After implementation/build, `freezeInfrastructurePolicy` returns the accepted
snapshot `{terraform,profile:{repository,path,sha256},rules:profile.policy,
metadata:profile.metadata,ownerContracts}`. The policy owner returns
`{policyIdentity:digest(policy)}` and Architect, Critic, and Developer independently
review that exact finalized snapshot. Resume retains the immutable intake ceiling
and frozen accepted metadata rather than silently loading replacement permissions
or reinterpreting earlier reservations.

### Optional identity-dependent post-provisioning and narrow model access

Default `deploymentOrder:"provision-first"` preserves provisioning before deploy.
Only explicit `"identity-before-post-provision"` permits post-deployment
provisioning and requires `target.deploy:true`. Each provision stage may specify
`phase:"before-deploy"|"after-deploy"`; omission means `"before-deploy"`.
The stage list is monotonic: every before-deploy stage precedes all after-deploy
stages, with no return to pre-deploy work. A stage phase does not independently
grant mutation authority.

The opted-in causal sequence is:

`before-deploy plans/apply/reconcile -> deploy/reconcile physical identity ->
pin native runtime-identity receipt -> after-deploy plans/apply/reconcile ->
verify -> smoke/browser/model`.

Deployment reconciliation must first prove the physical target exists; it must
not require model permissions that the post stages have yet to assign. Its native
`data.runtimeIdentity` is
`{principalId,resourceId,tenantId,subscriptionId,evidence}` with an actual GUID
`principalId`, exact expected target resource, authorized tenant/subscription, and
nonempty actual observation references. The coordinator pins the native receipt
bytes and retains
`runtimeIdentity:{identity,operationId,receipt,path,evidenceHash,binding}`.
The `identity` member is that observed object, not an author-provided principal.

Post-stage `DELIVERY_PLAN_CONTEXT` adds `phase:"after-deploy"` and the pinned
`runtimeIdentity` object to the existing accepted policy/identity/priorAdmissions.
The canonical guard must echo
`runtimeIdentityHash:runtimeIdentity.evidenceHash`; normal source/build/revision/
stage/policy/saved-plan bindings still apply. Before dependent planning, effects,
or retained-operation reconciliation, a fresh read-only observer queries the
**original deployment** using its retained operation identity. Principal or target
drift blocks: never redeploy, replay a mutation, or retarget an assignment to
invent a matching identity. Resume preserves the same pinned original receipt
and frozen source/build rather than authoring new authority.

IAM remains denied except for **separately authorized runtime model access**.
`authorization.runtimeIdentityModelAccess:true` requires all of:
`authorization.provision:true`, `target.deploy:true`, opt-in identity ordering,
and immutable adopter-approved
`infrastructureProfile.policy.runtimeIdentityModelAccess`.
The following is a wrapper/field-shape illustration, **not approval or a complete
project infrastructure policy**:

```json
{
  "policy": {
    "runtimeIdentityModelAccess": {
      "deploymentResourceId": "<exact expected deployed target ARM resource ID>",
      "assignments": [
        {
          "scope": "<exact model ARM resource ID in the authorized subscription>",
          "roleDefinitionId": "<full exact role-definition UUID ARM ID>"
        }
      ]
    }
  },
  "metadata": {}
}
```

No wildcard/subscription-wide convenience scope, role display name, guessed
principal, or metadata change may enlarge those exact permissions. Admission
recognizes known AzureRM/AzAPI role-assignment **create-only** shapes in authorized
after-deploy stages, with exact
observed principal, approved model scope and role ID, and
`principalType:"ServicePrincipal"`. Updates, conditional/delegated properties, and
all other IAM authority are prohibited. The canonical guard additionally requires
`checks.runtimeIdentityModelAccess:{pass:true,evidence:[actual refs]}` whenever this
IAM exception is authorized. Ordering opt-in alone does not authorize role
assignments or paid model calls; the latter still needs the independent model-test
grant and actual product acceptance evidence.

## Role profiles and complete loops

Stage roles are prompts using these three installed profiles, not additional
privileged tool configurations:

| Profile | Exact tools | Responsibility |
| --- | --- | --- |
| `lab-reader` | `["read","search"]` | Planning, observations, independent reviews |
| `lab-author` | `["read","search","edit"]` | Assigned source/documentation; DevOps and Git Publisher script authoring |
| `lab-operator` | `["read","search","lab_execute_ticket"]` | Invoke one admitted operation ticket; no raw terminal or edit |

Authors cannot run scripts through their profile. Independent reviewers are
read-only. The DevOps Engineer writes operational scripts, and the Git Publisher
writes publication scripts. After review/admission, the responsible operation
agent uses the separate operator profile; the coordinator does not substitute
itself as the operation agent. Profiles and application validation are **not an
OS sandbox**: trusted native scripts run with the extension process's permissions,
and editing permissions are not filesystem confinement. Keep OS credentials,
Copilot permissions, and directory grants narrow.

Every required loop persists its owner report and all independent reviewer votes:

| Loop | Owner | Reviewers |
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

Non-UI design loops need reviewed not-applicable rationale; they are not silently
skipped. Publication adds a Git Publisher owner with Publication Critic and
Architect reviewers. An agent labeled Stakeholder is not human approval.

Owner reports are `{status:"PASS"|"BLOCKED"|"FAIL",summary,evidence:[],artifact:{}}`;
reviews are `{verdict:"PASS"|"REVISE"|"BLOCKED",findings:[],evidence:[]}`.
Readiness PASS needs actual evidence and every reviewer PASS. Triage PASS confirms
the stop, **not** readiness. Concrete REVISE feedback, the original report, and
validation errors go back to the owner within the configured budget.

Release plans return `{terraformPolicy,sprints:[{id,goal,requirementIds,backlogIds?:[]}]}`, covering
every authorized criterion within `maxSprints`. Sprint plans return
`tasks:[{id,kind,repository,paths,dependsOn,requirementIds}]`, with disjoint writable
assignments and a valid dependency DAG. `kind` is `ui`, `developer`, `designer`,
or `devops`. Ready independent tasks can run in parallel within one coordinator
lease. Each sprint has its own implementation, test/build freeze, optional
publication, sequential provision stages, deployment, and live checks. Later
sprints consume admitted prior artifacts, feedback, and reconciled target state.

### Sprint review, corrections, and retrospective

The Sprint Review owner returns:

```text
{
  coverage: [{id, status: "verified" | "blocked", evidence: [actual references]}],
  backlog: [{id, requirementIds, description, blocking: true | false}],
  resolvedBacklogIds?: []
}
```

Coverage contains exactly this sprint's criterion IDs, with nonempty actual
evidence references even for a blocked result. A `blocked` criterion is allowed
at Sprint Review only with a matching **blocking, in-scope** backlog correction
whose `requirementIds` includes that criterion. It is not release acceptance.
Backlog IDs are stable slug identifiers; descriptions are nonempty and `blocking`
is an explicit boolean. `resolvedBacklogIds` may name only retained prior items,
and resolution requires actual evidence and independent review.
For a nonlocal criterion (`live`, `browser`, or `model`), verified Sprint Review
evidence must include the **exact native reconciliation receipt `ticketId`**
provided for that criterion in `nativeCoverage`. An agent summary, primary receipt
alone, or a different receipt cannot substitute for that successful native product
acceptance observation.

The coordinator retains backlog items with `status:"open"|"resolved"` and a
`deferred` flag. Empty/unknown requirement IDs or new goals are deferred, not
authority to expand the release. Open in-scope blocking corrections trigger a
new independently reviewed **Release Plan revision**. The revision must preserve
the completed sprint prefix (definitions and order) exactly, remain within the
original requirements/grants and user `maxSprints`, and assign **every** correction
ID through `backlogIds` on remaining sprints. Exhausting `maxSprints` while such
corrections remain blocks; it does not waive coverage or silently add sprints.

Retrospective returns `{document,improvements:[]}` with reviewed process/design
improvements. The executable next-sprint design, architecture, and plan stages
receive the retained `state.backlog` and `state.improvements`; they do not merely
mention them in a final report. Later planning applies corrections within existing
authority without changing prior frozen delivery snapshots. E2E and release
closeout still require verified coverage; Sprint Review's temporary blocked
coverage cannot become a success-shaped release.

## Reviewed native commands

Every command has this shape (paths/names are placeholders):

```json
{
  "repository": "app",
  "executable": "node",
  "script": "scripts/lab/verify.mjs",
  "args": [],
  "cwd": ".",
  "timeoutMs": 120000,
  "dependencies": [
    {"repository": "app", "path": "scripts/lab/shared.mjs"}
  ]
}
```

Use native `node`, `pwsh`, or `python` scripts, not shell strings, inline `-e`
programs, `.cmd`, `.bat`, or arbitrary executables. Interpreter platform aliases
accepted by policy do not grant arbitrary shell execution. PowerShell is started
with `-NoProfile -NonInteractive -File`; Python with `-I`. `args` are literal
strings, `timeoutMs` a positive integer, and `dependencies` an explicit array
(empty only when there are no file dependencies). Each entry is either a file
`{repository,path}` **or** a constrained immediate collection
`{repository,collection:"infra/*.tf"}`, never both. Collection membership is sorted,
nonempty, and pinned along with member bytes; additions/removals invalidate the
command identity. No recursive or arbitrary glob is accepted. Script and every dependency
must exist as nonlinked, tracked/nonignored, monitored files. Admission binds the
exact native script/dependency bytes, arguments, working directory, timeout,
source/build, stage, target, plan, and grants. Changing any pinned bytes invalidates
admission. A wrapper around a real tool must validate exact arguments/targets and
produce actual evidence, not conceal an unrestricted shell.

The operator receives only an active, unguessable, single-use ticket and invokes
`lab_execute_ticket` with `{"ticket":"<coordinator-supplied-ticket>"}`.
Agents cannot submit replacement commands to this tool. Before spawning a
mutation, the executor durably records intent; afterward it persists native
exit/signal/spawn/timeout/abort outcomes and reads the actual evidence file.
The coordinator reads its private receipt ledger, never an agent's claimed receipt.

## Owned scratch and optional offline preflight

`/.delivery-runs/` must actually be Git-ignored in the adopting project; merely
intending to keep receipts private is insufficient. The framework verifies this.
Commands receive their marked run-owned scratch root through
`DELIVERY_EVIDENCE_DIRECTORY`. Import `withScratch` from `lab-scratch.mjs` to create
a unique, ownership-marked helper child and clean up that child in `finally`.
An invalid supplied scratch path fails validation; there is **no fallback** to
source-adjacent folders or an arbitrary temporary location. Cleanup preserves
unrelated files and only removes recognized owned helper children. Retain final
receipts/saved plans at their designated evidence paths, not disposable scratch.

Offline preflight is a **standalone, explicit opt-in command**, never an automatic
workflow gate:

```powershell
node .\gh-dynamic-workflows\lab-preflight.mjs .\lab.json
node .\gh-dynamic-workflows\lab-preflight.mjs .\lab.json --resume RUN-ID
```

It validates local input/roots/dependency inventory/scratch ownership and shared
retained-plan resume integrity. `commands.preflight` is optional for workflow
inputs, but this standalone invocation requires explicit reviewed helpers; it
does not silently substitute a generic success probe. Those entries execute only
as part of this invocation, using native environment forwarding, owned scratch,
and exact command/dependency inventories. These are reviewed **offline-only**
helpers: the framework dispatches no agents, models, or cloud operations.
Native scripts still run with local permissions; offline behavior is a reviewed
helper contract, not an OS sandbox or a license to hide cloud calls in a wrapper.

Each helper writes actual evidence to `DELIVERY_EVIDENCE_PATH`:

```text
{
  status: "PASS",
  binding: {runId, sourceFingerprint},
  evidence: [actual references],
  data: {
    offline: true,
    checks: {
      prerequisites: true,
      dependencyInventory: true,
      scratchOwnership: true
    },
    consumedSources: [{repository, path}]
  }
}
```

`consumedSources` must exactly match **that helper's own** pinned command inventory,
including its script entry and every explicit/expanded collection dependency.
For offline helpers, `DELIVERY_PLAN_CONTEXT` points to that helper's private
command/dependency inventory JSON; it is not an admitted cloud-plan context.
Do not report the whole workspace or omit the entry. Checks and PASS must describe
actual local observations, not fabricated receipts. This is not cloud readiness,
account/capacity certification, plan admission, or real delivery validation.
Running preflight does not invoke `lab-delivery`; running `lab-delivery` does not
implicitly run preflight.

## Native evidence and bindings

Every successful script writes JSON to the provided `DELIVERY_EVIDENCE_PATH`:

```json
{
  "status": "PASS",
  "binding": {
    "runId": "<actual run>",
    "sourceFingerprint": "<actual accepted source fingerprint>"
  },
  "evidence": ["<reference to actual sanitized native observation>"],
  "data": {}
}
```

This is a shape example, **not valid evidence**. Exit zero alone is insufficient.
Do not fabricate PASS files. All binding identities passed for the stage must be
present, nonempty when applicable, and exactly equal, preserving types:
`runId`, `sourceFingerprint`, then `buildFingerprint`, `sprintId`, `revision`,
`stageId`, `stageIndex`, `planAggregate`, `planContext`, `planIdentity`, `planEvidence`, and
`webOrigin` as supplied. `stageIndex` is a number; index `0` is valid, not missing.
Do not add empty future identities in early bootstrap/build receipts.

The explicit native environment forwards these **20** allowlisted names, retaining
string-value validation and sensitive-variable filtering: `DELIVERY_RUN_ID`,
`DELIVERY_SOURCE_FINGERPRINT`, `DELIVERY_BUILD_FINGERPRINT`, `DELIVERY_REVISION`,
`DELIVERY_SPRINT_ID`,
`DELIVERY_TARGET`, `DELIVERY_SUBSCRIPTION_ID`, `DELIVERY_TENANT_ID`,
`DELIVERY_REGION`, `AZURE_CONFIG_DIR`, `DELIVERY_WEB_ORIGIN`,
`DELIVERY_PROVISION_STAGE`, `DELIVERY_PROVISION_STAGE_INDEX`,
`DELIVERY_PLAN_AGGREGATE`, `DELIVERY_PLAN_IDENTITY`, `DELIVERY_PLAN_EVIDENCE`,
`DELIVERY_OPERATION_ID`, `DELIVERY_EVIDENCE_PATH`, `DELIVERY_EVIDENCE_DIRECTORY`,
and `DELIVERY_PLAN_CONTEXT`. Read sprint identity from
`DELIVERY_SPRINT_ID`; never infer it from unrelated source or cached state.
Retain only sanitized evidence references, never credentials or raw secret output.

During provisioning, `DELIVERY_PLAN_CONTEXT` is a private JSON file path containing
`{policy,policyIdentity,priorAdmissions}`; its exact path is the `planContext`
binding. `planAggregate` covers cumulative admissions from **previous sprints and
stages**, not just the current sprint. `DELIVERY_PLAN_EVIDENCE` is different: it
remains the exact saved native binary plan path at apply. Never repurpose it as
the policy/context path.
After-deploy context additionally carries `phase` and the pinned `runtimeIdentity`
record described above; the saved-binary environment variable does not change.

Reconciliation scripts observe the **original** operation read-only and return:

```json
{
  "effect": "completed",
  "observations": ["<actual observed resource/revision/operation reference>"]
}
```

This is the receipt's `data`, not a top-level replacement receipt. `effect` is
`completed`, `absent`, or `unknown`. `safeToRetry:true` is valid **only** with
positively observed `absent`; never infer absence from timeout, missing receipts,
local journaling, an agent opinion, or a zero exit. `unknown` blocks. Cloud effects
need actual native cloud observations; a local receipt describing its own creation
cannot prove remote completion. Smoke/browser/model calls can mutate application
state and require the same retained intent and reconciliation discipline.

For smoke, browser, and model reconciliation, `data` additionally **must** contain
`acceptancePassed:boolean` and `coverage:[{id,status,evidence}]`. Coverage contains
exactly the current sprint's criterion IDs for the command's lane (`live` for
smoke, `browser` for browser, `model` for model), with no omissions, extras, or
duplicates; use `[]` when that lane has no criteria. Entries have `status:"verified"`
or `"blocked"` and nonempty actual evidence references. A false
`acceptancePassed` cannot claim verified coverage. `effect:"completed"` proves only
the physical action finished, not that the product passed.

Reconciliation preserves the original `DELIVERY_OPERATION_ID`, so the read-only
observer queries the original retained application run rather than creating or
submitting a new prompt. An explicit primary native `status:"FAIL"` cannot be
contradicted by a reconciler claiming `acceptancePassed:true`. An unknown primary
outcome may positively reconcile the actual original result, but missing primary
evidence is never itself a pass. These product results and exact reconciliation
receipt identities feed `nativeCoverage` for independent Sprint Review.

## Bootstrap author artifact

```text
{
  identity: {command},
  providers?: {command, reconcile},
  capacity?: {command},
  topology: {command}
}
```

The DevOps author writes only `bootstrapPaths`. Execution order is identity,
explicitly permitted providers, relevant capacity, topology, then actual baseline.
Do not make billable probes during discovery. Missing future networks/origins are
outputs to design, not fabricated existing resources.

* Identity data: `{subscriptionId,tenantId,region,enabled:true}` exactly matching
  input and actual authenticated subscription status in the isolated profile.
* Providers: optional only for a nonempty authorized provider ceiling;
  registration needs positive read-only reconciliation. Its actual data contains
  `providers:[{namespace,state:"Registered"}]`, matching the exact authorized
  namespaces; a generic completed effect does not establish registration.
* Capacity data: `{models:[...]}` exactly matching every requested
  `{name,version,sku,unit,requiredCapacity}`; add numeric `availableCapacity`
  (nonnegative) and `supported:true`. Initially, available capacity must satisfy
  the requested capacity. Empty/unknown capacity is not sufficient. Do not
  substitute models, change sizing, or request quota.
* Topology data: nonempty `designEvidence:[actual refs]` and `designQuestions:[]`.
  Unresolved design questions block; capacity alone cannot establish topology.

Bootstrap observation-review artifacts must return the actual native `data`
**unchanged**. Independent review can block or request correction, but cannot
rewrite account, provider, capacity, or topology facts to make them pass.

On resume, fresh account and relevant capacity observations execute **after the
source-drift fence**, rather than trusting cached readiness. Review again returns
actual data unchanged. A capacity observation may count `allocatedCapacity` only
as a nonnegative finite number, with actual `allocationEvidence` references and
exact `allocationRevision` and `planIdentity` matching a same-run completed
provisioning operation that was durably **started**. Another run's allocation or
an admitted-but-never-started plan is not own capacity. With that proof,
`availableCapacity + allocatedCapacity >= requiredCapacity` may satisfy sizing;
unproven allocation cannot fill a capacity gap.

## Sprint adapter and saved plans

```text
{
  provisionStages: [{id, phase?, plan: command, command, reconcile}],
  publication?: {prepare: {command, reconcile}, command, reconcile},
  deploy?: {command, reconcile},
  verify: command,
  smoke: [{command, reconcile}],
  browser?: {command, reconcile},
  model?: {command, reconcile}
}
```

`verify` is **one command**, not an array. `provisionStages` is always an explicit
array; empty means no provisioning. For local-only delivery omit `deploy`,
`verify`, `browser`, and `model`, and set `smoke:[]`. Publication is present only
with its independent grant. Deployment requires `deploy`, `verify`, and nonempty
`smoke`; browser/model pairs are required exactly when acceptance specifies them.
Provisioning is incompatible with build-only mode.
`phase` defaults to `before-deploy`; `after-deploy` requires the explicit
identity-ordering opt-in and monotonic phase ordering described above.

When publication is granted, the separately reviewed Git Publisher artifact
**must** contain `{prepare:{command,reconcile},command,reconcile}`.
`prepare.command` makes a task-only **local commit**, never a push or remote
repository creation, and its observer positively reconciles that local effect.
Before admitting `publication.command`, the coordinator deterministically inspects
the committed paths against authorized write scope and the original dirty-path
baseline. Any initially dirty path requires exact
`publication.includeInitialDirtyPaths` authority; omitted means empty.
Use explicit path-only commits or an isolated index to preserve unrelated staged
entries. Do not run `git add .`, clear the index, or treat a dirty index as
permission to publish it. Only the subsequent independently admitted command may
publish/create a remote within the exact granted owner/name/visibility/branch and
repository-creation policy, and it requires its own reconciliation.

Each provision stage executes only after the prior stage is positively reconciled:
plan -> inspect saved bytes -> independent exact-plan review -> admission ->
persist intent -> operator applies the **same saved plan** -> reconcile.
Apply must never regenerate a plan.

Plan command data contains `plans:[{repository,binary,json,guard,ownership}]`.
`ownership` is `{stateOwner,shared,subscriptionId,tenantId,region}`.
The named files are distinct saved native binary, native JSON, and canonical-owner
guard evidence. Canonical guard JSON is **version 2** and includes
`version:2`, `status:"PASS"`, `policyIdentity:digest(acceptedPolicy)`, `binaryHash`, `jsonHash`,
`stateOwner`, `subscriptionId`, `tenantId`, `sourceFingerprint`, and nonempty
`evidence`. It must additionally contain `binding:{...}` with **every exact
plan-stage binding key**: `sprintId`, `runId`, `sourceFingerprint`,
`buildFingerprint`, `revision`, `stageId`, numeric `stageIndex` (including `0`),
`planAggregate`, and `planContext`, plus any other binding keys supplied for that stage.
`inspectPlans` checks every key and value, not just the top-level source
fingerprint: a guard from the same source but a different build, sprint, run,
revision, or stage is stale and rejected. The guard also requires all eight
`checks` entries, each `{pass:true,evidence:[actual refs]}`:

* `resourceSemantics`
* `parentIds`
* `remoteIds`
* `permittedProperties`
* `dependencyClosure`
* `cumulativeScope`
* `terraformPolicy`
* `acceptedMetadata`

Post-deploy guards additionally echo the pinned receipt's
`runtimeIdentityHash`, and separately authorized model IAM adds the
`runtimeIdentityModelAccess` check. These additions do not replace any existing
guard bindings or checks.

Reviewed canonical helpers validate **actual ARM semantics** for AzureRM and
AzAPI, including allowed parent/remote IDs, permitted properties, resource types,
regions, and project limits from the frozen accepted rules/owner contracts, with
finalized metadata checked for consistency inside that immutable ceiling.
The generic engine retains destructive/action/address/owner bounds; it does
**not** impose a Terraform provider identity or substitute a provider-name allowlist
for ARM semantic validation. Read/no-op cross-region inputs are permitted;
mutation limits do not turn observations into unauthorized writes.

`guard.scope` is `{addresses:[...],count:N}`. Addresses are the sorted, unique
`stateOwner:Terraform-address` union of cumulative create/update resources from
prior stages/sprints and the current plans. The engine independently derives and
checks that union and count; a per-stage-only or reset-per-sprint list is invalid.
The wrapper proves native binary/JSON correspondence and actual state scope.
Hashes and shape-valid PASS entries alone cannot prove canonical ownership or ARM
semantics. Native actions permit only
create/read/no-op/authorized update; replacement, destruction, import, movement,
deferred/unknown actions, and unapproved shared-owner changes block. Each resource
type and location mutation semantics must be within the applicable owner's
accepted policy; canonical ARM checks enforce `resourceTypes` without confusing
Terraform provider/resource aliases with the actual remote resource type.
Canonical native helpers inspect raw plans locally; agent reviewers receive
sanitized resource summaries, script bytes, hashes, and guard evidence. Never
transmit raw Terraform JSON/state or retained binaries to a model.

Build data is `{artifacts:[{repository,path,sha256}]}` with actual file-byte hashes;
the coordinator verifies files and derives `buildFingerprint`. Put build artifacts
and late-bound evidence in explicitly ignored locations rather than changing frozen
source. Verification data is `{webOrigin,revision,buildFingerprint}` from the actual
deployed target, matching the frozen build/revision. `webOrigin` must be a real
HTTPS authority-only origin without credentials, path, or loopback. Subsequent
smoke/browser/model evidence binds that exact observed origin; never guess Azure
domains or rewrite source to install a late-bound endpoint.

Local review, saved plan, applied state, live revision, product smoke, browser
acceptance, and paid model acceptance are distinct evidence levels. A health-only
response cannot satisfy product criteria. E2E/closeout return exact
`coverage:[{id,status:"verified",evidence:[actual refs]}]`, not invented coverage.
Sprint Review alone allows the bounded blocked/corrective-backlog contract above.
Closeout authors real `releaseNotes:{repository,path}` and
`readme:{repository,path}` only within `documentationPaths`, plus `document` and
coverage. These README/release-note changes are **local, after the deployed freeze**;
they are not silently committed, published, or deployed as part of the frozen
revision. Final closeout test commands revalidate the changed source. The result
explicitly reports `documentationPublication` and a separate
`closeoutSourceFingerprint`, while `delivery` identifies the actual earlier
published/deployed revision and frozen source/build.

## Journals, resume, and completion

Keep `/.delivery-runs/` actually Git-ignored and local. The workspace-wide
`lab-target-ledger.json` retains pending mutation identities outside run completion
records. `lab-active.json` is an exclusive local coordinator lease; never steal a
stale lease automatically. It is not a distributed Azure lock: do not run another
workspace against the same target/state. Agents do not own competing ledger writes.

Resume the original run with unchanged input/root/specification identity.
Before any new authoring, reconcile pending effects against their original
frozen inputs. Reviewed recovery may refine data-only arguments to the original
observer, not its executable, script/dependencies, or working directory. Recovery
attempt expenditure persists across resumes. New run IDs cannot erase unresolved
operations. An intentional
input, implementation-version, or root change needs deliberate upgrade/review
and a fresh journal identity **after** outstanding effects are reconciled; do not
delete journals to bypass admission. Do not reinstall over existing profiles or
instructions. Installation preflights all destinations and refuses existing files
and symlinks; upgrading is a deliberate reviewed replacement, not a forced copy.

Completion is `built` for local-only, `deployed` only with actual cloud/live
evidence, otherwise `blocked`. Workflow-envelope completion is not delivery
success. Missing authority, authentication, exact evidence, or unknown effects
must not become a success-shaped report.
