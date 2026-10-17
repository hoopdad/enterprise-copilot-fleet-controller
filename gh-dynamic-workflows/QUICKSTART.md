# Quickstart: deliver a specification to an existing test target

Use **PowerShell 7**, **Node.js 22+**, and a current **Copilot CLI** with
experimental workflows available and an authenticated, eligible account.
There is no `npm install` step: Copilot supplies the extension SDK.

## Copy/paste installation prompt for GitHub Copilot

**Want Copilot to install this for your repository?** Open Copilot CLI from the
**target project**, replace all placeholders below, and paste this prompt.
`<FRAMEWORK_CHECKOUT>` is a separate reviewed local checkout containing this
package; `<TARGET_REPO>` is the existing project that receives it. Choose an
explicit reviewed revision **and** approve any intended working-copy changes.
Do not assume a remote branch/release contains the new companion: at the time of
these instructions, companion changes may still be uncommitted locally.
The verified instructions in your selected package revision and the target's
owner policies take precedence over generic setup advice.

### Installation prompt

```text
Install ONLY the standalone gh-dynamic-workflows package into my current target
repository. This is installation and safe registration verification, not a
delivery run.

Target repository: <TARGET_REPO>
Reviewed framework checkout: <FRAMEWORK_CHECKOUT>
Approved revision / explicitly reviewed working-copy snapshot:
<REVIEWED_REVISION_AND_ANY_APPROVED_LOCAL_CHANGES>

First read the target repository's applicable owner instructions and the package
README.md and QUICKSTART.md under <FRAMEWORK_CHECKOUT>\gh-dynamic-workflows.
Verify the checkout revision and working-copy state match my reviewed source;
stop on unexpected differences or missing companion files. Do not silently
substitute a remote branch, clone, update, reset, or change the framework checkout.
Use only the narrow source/target access permissions needed; never enable
allow-all, bypass trust, disable safeguards, or override source-owner policy.

Preserve existing target instructions, unrelated files, dirty work, staged index,
and any required fleet MCP dispatch policy. Do not run fleet scaffolding,
init.sh, /init, migrations, or generated-fleet upgrades.

Run the reviewed installer from that explicit checkout:
node "<FRAMEWORK_CHECKOUT>\gh-dynamic-workflows\install.mjs" "<TARGET_REPO>"

Install only the package modules/docs, extension loader, and registered agent
profiles that this installer declares. Stop if any destination already exists,
is linked, or would be overwritten; do not delete, force-copy, or upgrade over
existing files. Report deliberate upgrade options separately.

Verify installed files and exact profile tool sets, then safely verify extension
registration without executing a workflow. Use the supported extension reload
tool if available, or a supported CLI restart/relaunch; check current help rather
than inventing a reload slash command. Confirm autonomous-delivery, lab-delivery,
and lab_execute_ticket register, and report startup/registration errors honestly.

Do not provision Azure resources, modify IAM/credentials, publish Git changes,
create remotes, make paid model calls, run preflight helpers, or execute any
workflow as an installation side effect. Do not grant lab authority merely by
copying an example. Explain the separate opt-in lab profile, owner approval for
direct SDK dispatch, and independent execution/capability grants before any
future run. Finish with installed paths, source revision/snapshot, registration
results, and any blockers; do not claim application delivery.
```

### Manual Windows equivalent — installation only

Use reviewed local source, not an assumed remote distribution. Replace both
placeholders with actual absolute Windows paths; the directories must differ:

```powershell
Set-Location -LiteralPath '<TARGET_REPO>'
node '<FRAMEWORK_CHECKOUT>\gh-dynamic-workflows\install.mjs' '<TARGET_REPO>'
if ($LASTEXITCODE) { throw 'Installation refused or failed; do not overwrite existing files.' }
copilot --experimental
```

In the target session, ask for **safe registration verification only**.
The installed CLI's help lists `/experimental`, `/env`, and `/restart`; supported
extension tooling can reload when available, otherwise restart/relaunch the CLI.
There is no need to invent `/reload`. Enabling/loading a workflow does not run it
or authorize its lab profile. The remaining numbered steps below describe the
original workflow's setup and execution, **not installation-only side effects**.

Bring a **different, existing Node project**, a real specification in that repo,
working toolchain/dependencies and baseline/test/build commands, and a named,
existing **nonproduction** target with scoped credentials already configured.
Make its deployment mechanism and endpoint discoverable in repository instructions;
never put credentials in the spec or input. This is not a universal one-command
app generator or infrastructure provisioner. Use a disposable branch or worktree.

## 1. Clone the framework

Run from the parent folder where you keep source repositories:

```powershell
git clone --branch feature/gh-dynamic-workflows --single-branch https://github.com/hoopdad/enterprise-copilot-fleet-controller.git
Set-Location .\enterprise-copilot-fleet-controller
node --version
copilot --version
copilot login
```

If already authenticated, skip `copilot login`. Keep this PowerShell session open.
This selects the feature branch containing the workflow before it is merged.
All distributable files are under `gh-dynamic-workflows`; cloning alone does not
register the extension in the framework repository.

## 2. Install once and create your input

Paste the block below and answer the prompts with real values. The spec path is
relative to the **target project**, not this clone (for example, `specs/product.md`).
The installer refuses existing files: **do not install into this framework clone
or repeat installation over an installed copy**.

```powershell
$framework = (Get-Location).Path
$target = (Resolve-Path -LiteralPath (Read-Host 'Existing product repository folder')).Path
if ($target -eq $framework) { throw 'Select a different existing project.' }
$spec = (Read-Host 'Existing repo-relative product specification file').Replace('\', '/')
if ([IO.Path]::IsPathRooted($spec) -or '..' -in $spec.Split('/')) {
    throw 'Use a repository-relative specification path without .. segments.'
}
if (-not (Test-Path -LiteralPath (Join-Path $target $spec) -PathType Leaf)) {
    throw 'The specification file must already exist in the target project.'
}
$testTarget = Read-Host 'Named existing NONPRODUCTION deployment target'
if ([string]::IsNullOrWhiteSpace($testTarget)) { throw 'A test target is required.' }
$inputFile = Join-Path $target 'delivery-input.json'
if (Test-Path -LiteralPath $inputFile) { throw 'Review the existing delivery-input.json first.' }
node .\gh-dynamic-workflows\install.mjs $target
if ($LASTEXITCODE) { throw 'Installation failed; stop here.' }
$delivery = Get-Content -Raw .\gh-dynamic-workflows\examples\product.json | ConvertFrom-Json
$delivery.projectRoot = '.'
$delivery.input.path = $spec
$delivery.deployment.target = $testTarget
$delivery | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $inputFile
Set-Location -LiteralPath $target
```

Installation places runtime files in the target's `gh-dynamic-workflows`, its
loader in `.github\extensions\autonomous-delivery`, and its read/search-only
agent in `.github\agents`. Review those files before trusting the project.

## 3. Review the input and establish narrow permissions

```powershell
notepad .\delivery-input.json
```

Adapt the goal and acceptance criteria to your spec. The example requires
**`node --test`** for baseline/test and **`node scripts/build.mjs`** for build;
these must be real, passing project commands, not placeholders. Review/adapt
`commands` (native executables and argument arrays; no shell, `npm.cmd`, or
`.bat`), `scope` (`src`, `test`, `scripts/delivery`), and `generatedPaths` (`dist`)
to your project. Run your reviewed baseline/test/build commands successfully
before continuing. Keep `scripts/delivery` writable for generated deployment
adapters, or explicitly configure another scoped `deployment.adapterPaths`.

Review `deployment.acceptance`, `allowedExecutables` (default `node`), and the
named target. You **do not need to author deployment scripts**: the workflow
prepares and reviews deploy/revision-verification/smoke/reconciliation adapters.
It needs an existing, discoverable deployment mechanism and working credentials.
Review both execution/deployment authorization and diagnostics sharing in the
input; saving `authorized: true` is your authorization for this run's commands
and target, not a request for approval before every action. Do not authorize
diagnostics from commands that can print sensitive data.

Add `.delivery-runs/` to your target's `.gitignore`; records stay local. Then:

```powershell
copilot --experimental
```

Complete initial project trust setup. Ask Copilot to reload extensions and list
registered workflows; confirm `autonomous-delivery` loads. An interactive pilot
may be needed to establish narrowly scoped agent read/search permissions for the
spec and project. Exit the session when ready. The terminal runner below **cannot
prompt for unapproved reads**; do not grant blanket permissions to bypass this.

## 4. Run from the target project

```powershell
copilot --experimental workflow run autonomous-delivery --args '@delivery-input.json'
```

Normal delivery is **implement → test/build → deploy → verify → smoke**, without
a routine pause. Check the returned delivery status and `.delivery-runs` records:
`blocked`/`failed` is not success, even if the workflow envelope says `completed`.
Missing tools, permissions, credentials, or verification evidence must block.
For local-only work, explicitly set `deployment` to `{"mode":"build-only"}`.
See [README.md](README.md#delivery-and-resume) for retries, resume, and limitations.

## Optional lab-delivery companion

This is an **alternative opt-in run**, not an extra step in the original four-step
`autonomous-delivery` quickstart. The original workflow and fleet MCP queues are
unchanged. Read [LAB-DESIGN.md](LAB-DESIGN.md) and
[LAB-CONTRACT.md](LAB-CONTRACT.md) before granting lab authority.

### 1. Choose an authorized separate workspace

Use a different existing Git project/worktree, not this framework source checkout.
Read its source-owner instructions first. If they require fleet MCP dispatch,
the owner must deliberately authorize this separate SDK execution model; loading
the extension does not override that policy. Never replace existing instructions.
Keep directory grants/tool permissions narrow: these profiles are **not an OS
sandbox**, and native scripts run with your local permissions.

The input [examples/lab.json](examples/lab.json) is a **template, not a runnable
application**. Replace every `REPLACE` value and supply real project source,
specification, acceptance, baseline/test/build scripts and dependencies. It selects
local-only delivery, not provisioning, deployment, or publication. Azure identity,
an existing isolated CLI profile directory, region, and real topology observations
are still required; do not put credentials in JSON.

### 2. Install once, then copy/review the lab input

Run from this framework root with a *fresh, not previously installed* target:

```powershell
$framework = (Get-Location).Path
$labTarget = (Resolve-Path -LiteralPath (Read-Host 'Separate authorized lab Git project')).Path
if ($labTarget -eq $framework) { throw 'Select a different project.' }
$labInput = Join-Path $labTarget 'lab-input.json'
if (Test-Path -LiteralPath $labInput) { throw 'Review existing lab-input.json; do not overwrite it.' }
node .\gh-dynamic-workflows\install.mjs $labTarget
if ($LASTEXITCODE) { throw 'Installation failed; stop here.' }
Copy-Item -LiteralPath .\gh-dynamic-workflows\examples\lab.json -Destination $labInput
notepad $labInput
```

The installer copies both workflows, their modules, lab contract/design, and all
four agent profiles. It preflights **all** destinations and refuses overwrites or
symlinks. Do not repeat this command over an installed copy. Upgrades require
deliberate review/replacement of installed files, retaining journals and reconciling
pending effects before a fresh identity. It never overwrites owner instructions.

### 3. Review every boundary

* Select declared read/write/create roots and exact writable scopes. Siblings are
  allowed; overlapping/linked roots are not. Do not claim unrelated dirty work.
* Set nonempty `bootstrapPaths` and `documentationPaths` assignments; documentation
  paths name exact Markdown files. Pick finite `maxSprints` and explicit
  `planning`, `implementation`, `repair`, and `recovery` attempt budgets.
* Keep the template's independent grants `false` unless you really authorize each.
  For cloud delivery set `target.deploy:true` for an exact nonproduction target.
  Provisioning, provider registration, publication, repository creation, and paid
  model tests need their own grants; none authorizes another.
  Optional runtime identity-to-model IAM has its own narrow grant and immutable
  exact policy; deployment/provisioning alone never grants it.
* Public **or** private GitHub publication needs exact
  `publication` owner/name/visibility/branch/create/tag policy. Initially dirty
  paths need exact `publication.includeInitialDirtyPaths` authority (default `[]`);
  preserve unrelated staged index entries. Local-only is valid
  with `deploy:false`, `requirePublication:false`, and publication disabled.
* Provide exact subscription/tenant/region and allowed provider/model identities.
  Numeric model capacity must match requested sizing; unknown capacity blocks.
  Bootstrap observes actual identity before providers, capacity, topology, baseline.
* Baseline/test/build entries are reviewed native script commands with explicit
  dependency file lists, not shell strings or stub PASS writers. Build commands
  produce actual hashed artifacts. Follow the receipt contract.
* Keep full-source monitoring by default. Dependency-scoped monitoring on a shared
  writable root is optional and must still cover source instructions, specification,
  all write paths, operational scripts, and every consumed dependency. An immediate
  `infra/*.tf` collection can narrow read monitoring/dependencies, with exact
  membership pinned; never use a wildcard write scope.
* Review `terraformPolicy`: default `any` requirement plus `avm` preference does
  **not** require AVM. Architecture/Release Plan artifacts retain the exact policy.
  Provisioning needs an adopter-owned monitored nonsecret `infrastructureProfile`
  JSON reference with `{policy:{...},metadata:{...}}`. Intake pins `policy` as the
  immutable `infrastructureCeiling`; source edits/resume cannot enlarge approved
  rules/limits/types/IDs. Only registry `metadata` may finalize within those rules
  before exact post-build policy/adapter/build review. Resume uses frozen accepted
  rules/metadata, not replacement permissions or an intake reservation.
* Add `/.delivery-runs/` and late-bound build/evidence/profile locations to the
  target's ignore rules deliberately. Never store cloud receipts/origins in frozen
  source or commit secrets. Actual Git-ignore status is required, not assumed.
  Public SSH keys may be monitored; private keys, state, and auth material may not.

The DevOps and Git Publisher author roles write deterministic scripts using
`lab-author` (read/search/edit, **no terminal/executor**).
Independent reviewers use `lab-reader` (read/search).
The responsible operation agent uses `lab-operator`
(read/search/`lab_execute_ticket` **only**) to run one admitted ticket; it cannot
edit or invoke a raw terminal. Saved native plans are reviewed and applied without
regeneration. Mutations and smoke/model operations retain intent and require actual
positive reconciliation; a local receipt alone is not cloud proof.

Publication scripts must return
`{prepare:{command,reconcile},command,reconcile}`. Prepare makes a reviewed,
task-only local commit, with no push/remote creation and with unrelated staged
entries preserved by path-only commit or isolated index. The coordinator checks
committed paths before admitting the later exact-target publish command.
Existing shared-infrastructure owner contracts need monitored bytes and exact
`resourceTypes` alongside source/address/action/state/subscription/tenant limits;
native plan resource types and actual locations must match the owner.

Canonical v2 guards bind accepted policy and exact run/source/build/sprint/revision/
stage/aggregate/context identities. They provide actual ARM semantics evidence
for AzureRM/AzAPI parent/remote IDs, permitted properties, dependency closure,
project limits, and cumulative create/update scope across prior stages/sprints.
No generic Terraform-provider identity requirement is imposed; cross-region
read/no-op inputs remain valid. `DELIVERY_PLAN_CONTEXT` is the private accepted
policy/prior-admission JSON path, **not** `DELIVERY_PLAN_EVIDENCE`, which remains the
saved native binary at apply.

### Optional deploy-identity-before-post-provision delivery

Leave `deploymentOrder` omitted or `"provision-first"` for the existing order.
Only if separately intended, choose `"identity-before-post-provision"` and order
provision stages monotonically: `phase:"before-deploy"` (default) first, then
`phase:"after-deploy"`. Deploy/reconcile physical creation and its real runtime
identity before post-stage Terraform; run verify/smoke/model only afterward.
Deployment reconciliation returns actual
`runtimeIdentity:{principalId,resourceId,tenantId,subscriptionId,evidence}`.
The coordinator pins its native receipt and passes it in post-stage
`DELIVERY_PLAN_CONTEXT`; the canonical guard echoes its evidence hash.

If post-stage Terraform must assign model access, independently authorize
`authorization.runtimeIdentityModelAccess:true` **and** provisioning/deployment,
with immutable `profile.policy.runtimeIdentityModelAccess` specifying exact
`deploymentResourceId` and `assignments:[{scope,roleDefinitionId}]`.
Scopes are exact model ARM resources in the authorized subscription; roles use
full exact role-definition UUID ARM IDs. Known AzureRM/AzAPI role assignments are
create-only for the observed `ServicePrincipal`, exact model scope, and exact role;
no conditional/delegated properties or other IAM authority. Guard evidence must
include `runtimeIdentityModelAccess`. Paid model calls still require their separate
grant. Fresh original-deployment observation precedes dependent effects/resume;
principal drift blocks, never redeploys or retargets. See the full
[identity-ordering contract](LAB-CONTRACT.md#optional-identity-dependent-post-provisioning-and-narrow-model-access).
These are future-run decisions, **never installation permissions or side effects**.

### Optional offline preflight — explicit invocation only

From the configured target, after replacing the example's optional
`REPLACE-offline-preflight.mjs` helper with a real reviewed offline-only script:

```powershell
Set-Location -LiteralPath $labTarget
node .\gh-dynamic-workflows\lab-preflight.mjs .\lab-input.json
# To check retained original-run plan integrity instead:
node .\gh-dynamic-workflows\lab-preflight.mjs .\lab-input.json --resume RUN-ID
```

This standalone command does not run agents/models/cloud operations through the
framework, certify Azure readiness, or automatically gate `lab-delivery`.
The command requires explicit `commands.preflight` helpers. If you omit this
optional input field, skip this optional invocation rather than expecting a
generic preflight PASS.
Helpers receive validated native environment and an owned
`DELIVERY_EVIDENCE_DIRECTORY`; use exported `withScratch` for unique marked helper
children with `finally` cleanup. Invalid supplied paths fail without fallback;
unrelated files are preserved. Emit the exact offline receipt in
[LAB-CONTRACT.md](LAB-CONTRACT.md#owned-scratch-and-optional-offline-preflight),
including actual prerequisite/inventory/ownership checks and `consumedSources`
matching that helper's own entry/dependency inventory. Do not hide cloud calls in
an allegedly offline helper.
For offline helpers only, `DELIVERY_PLAN_CONTEXT` points to their private
command/dependency inventory, not a cloud-plan policy context.

### 4. Load and run only after reviewing the input

```powershell
Set-Location -LiteralPath $labTarget
copilot --experimental
```

Complete project trust/permission setup. Ask Copilot to reload extensions and list
registered workflows; confirm both `autonomous-delivery` and `lab-delivery` load
without startup errors. Exit that interactive session, then:

```powershell
copilot --experimental workflow run lab-delivery --args '@lab-input.json'
```

Expect all 13 role loops and bounded independent reviews, not a compressed demo.
Sprint Review records exact coverage and typed blocking corrections; a blocked
criterion needs matching in-scope backlog, not a success claim. Open in-scope
blocking corrections cause a reviewed Release Plan revision preserving completed
sprints and assigning correction `backlogIds` to remaining sprints within
`maxSprints`; exhaustion blocks. Unknown/new goals are deferred. Retrospective
improvements and retained backlog feed the next design/architecture/plan stages.
Check actual `.delivery-runs` receipts and criterion coverage. `built` is local
completion; `deployed` needs real revision/origin and live evidence. `blocked` is
not success. Triage PASS confirms a stop, never readiness. Unknown remote effects
must be reconciled in the original run before retries/new authoring; do not delete
the workspace target ledger or steal the lease. No second workspace may operate
against the same target/state.

Release-closeout README/release-note edits remain local after the deployed freeze.
Final closeout tests revalidate them; the result separately identifies local
documentation/source changes and the actual earlier published/deployed revision.

This setup guide does not authorize cloud actions while testing the package itself.
Use existing approved Foundry endpoints only for separately authorized model-call
validation; no provisioning, provider registration, deployment, Git publication,
or access changes. Report unavailable live validation as **unverified**.
