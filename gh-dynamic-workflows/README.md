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
