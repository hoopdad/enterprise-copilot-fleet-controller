# YAML do-er/reviewer delivery loops

`autonomous-delivery` and `lab-delivery` execute the same nested release/sprint
workflow from [loops.yml](loops.yml). The source is the root `loops.yml` in
`hoopdad/thought-connections`, revision
`503f3f8b487827014f30c3d23b8f14c86141ffa0`. YAML describes roles, work, artifacts,
reviewers and completion conditions; the SDK supplies agents and durable steps.
This is a Copilot Dynamic Workflow extension, not GitHub Actions.

The agreed [solution component, flow, and work-card definitions](WORK-CARD-DEFINITIONS.md)
guide planning and reporting. Architects name the components and trigger-driven
flows; assignments, owners and reviewers reuse those names.
Structured cards lead with **role: meaningful action**, preserving scope,
failure category, responsibility, bounded acceptance, code location, evidence
and verification rather than opaque task IDs or generic blocked messages.
The corresponding Studio update displays this metadata; old runs without it
remain readable without invented diagnoses.

## Install and launch

From this framework checkout, into a different existing project:

```powershell
node .\gh-dynamic-workflows\install.mjs 'C:\path\to\project'
npm --prefix 'C:\path\to\project\gh-dynamic-workflows' ci
Set-Location -LiteralPath 'C:\path\to\project'
copilot --experimental
```

Review/trust the extension, establish the required ordinary CLI permissions,
then reload extensions. Installation refuses to overwrite existing files.
After confirming there is no active run, upgrading an existing installation uses
`node .\gh-dynamic-workflows\install.mjs 'C:\path\to\project' --replace-retired-engine`.
This deliberately replaces the distributed runtime/profiles/tests and removes
known retired engine files, not run history. Review/update project-specific
launcher, input and instructions too; they are not overwritten by the installer.

Supply `delivery-input.json` with `projectRoot`, a specification or goal, actual
project authority and acceptance criteria. See [examples](examples) and
[QUICKSTART.md](QUICKSTART.md).

```powershell
copilot --experimental workflow run lab-delivery --args '@delivery-input.json'
```

For concise terminal output with full local evidence retained:

```powershell
node .\gh-dynamic-workflows\run.mjs --workflow lab-delivery --input delivery-input.json
```

Add authorized sibling context roots using repeated `--add-dir <path>`.
The launcher grants no blanket tool, path or URL permission; establish only the
ordinary permissions actually authorized for the work.
`--check-only` only reads configuration; it does not start a workflow
or impose a prerequisite review. Each launch saves unique, ignored logs, the
application result, and a concise `outcome.json` under
`gh-dynamic-workflows\.delivery-runs`. The terminal reports the actual stopped
loop, reason, unresolved reviewer feedback and next action. SDK `completed`
does not mean application success: application stops exit 2, runtime/CLI errors
exit 1, pause exits 3 and cancellation exits 130. Only application completion
exits 0. Full logs and Workflow Studio remain available during and after a run.

The relevant do-er researches, writes and executes what the work needs within
the user's actual permissions. Sprint 1 establishes the `azd` walking skeleton
described below; missing tools can be prepared only within that authority.
Ordinary CLI tool/path/URL permissions and real human-authority requirements
still apply; these profiles are not a sandbox. Missing deployment credentials or
user-only approval requires `needs-input`, not an invented deployment success.

## Actual process

Architecture -> UX -> Release Plan -> repeat Sprint Design, Sprint Architecture,
Sprint Plan, assigned work with continuous DevOps-then-E2E verification, Sprint
Review and Retrospective -> Release Closeout. Existing YAML roles perform the
work and review; E2E and DevOps are not deferred to late-only stages.

### Requirements-and-tests ledger

Git-tracked `docs/requirements` files and regression tests are the durable ledger.
They replace all Scrum feedback triage, Architect advice and Product Owner
disposition ledgers. There is no runtime governance or `priorDispositions`.
An accepted scope change is a committed requirements edit plus a regression test
under existing user authority. Declined proposals never enter the ledger.
Historical audits are preserved for inspection, not treated as current authority.

Every role's mandatory correction needs an original user requirement or explicitly
approved amendment citation and a falsifiable reason why the work fails it.
Demonstrated defects also need inspectable evidence that they prevent that
requirement. Everything else stays optional, including Architect, Product Owner
and Scrum Master suggestions. Neither a committed agent interpretation nor an
invented failing test establishes user authority. Red Team remains limited to
infrastructure configuration and application-library CVEs, identifying the CVE,
library and version. Reviewers remain read-only.

Findings use `type:"blocking"|"observation"`, `summary` and `action`. Blocking
entries require `basis:"original-requirement"|"approved-amendment"|"demonstrated-defect"`,
`requirement:{path,line}` and `reason`; demonstrated defects also require
`evidence`. Optional `failingCheck` on a defect names an emitted failed check with
matching evidence, never authority by itself. Cite the original request/approval
directly in an existing repository-local file; its positive, nonempty line must
match committed `HEAD`. No new ledger is required. Traversal, symlink escapes,
new/dirty citations and unsupported claims cannot establish blockers. Git verifies
citation integrity, not user authorship or semantic truth; existing participants
verify those against the actual user request. Red Team findings also require
`scope:"infrastructure-config"|"dependency-cve"`.

The assigned owner judges each supported correction on retry with
`correctionAssessments:[{correctionId,verdict,reason,evidence}]`: confirmed,
refuted or unresolved. The existing reviewers independently verify that judgment,
without a new approval agent or stage. See [LAB-CONTRACT.md](LAB-CONTRACT.md) for
the full contract and examples.

Owners emit executable check results and reviewers assess their suitability and
verification with diagnostic `checksValid`, rather than subjective completion
votes. `checksValid:false` alone cannot block any role; mandatory corrections
need the structured grounding above. Actual failed/missing checks remain failures. Checks
do not grant execution authority: owners run commands through their ordinary
permission-bound tools, not an unrestricted runtime command executor.

### Bounded task context and readable history

`task-context.mjs` separates current instructions from historical audit payloads.
Global outcomes are status/reference entries; only direct dependency handoffs
carry artifacts, original completion votes and limitations. File-backed planning
documents retain paths and revision metadata rather than expanded content.
The current assignment, user authority and scientific controls remain unchanged.
Owners and original reviewers must read the relevant referenced files/commits;
reference presence is not acceptance, readiness or an independent quality pass.

Scoped replanning retains current grounded feedback, ledger references and parent
criteria, not nested raw histories. Retry prompts retain the latest owner/
reviewer evidence. Historical audits and raw dispatched-work results are not
recursively copied into another task's prompt or promoted to instructions.

Exact original outcomes, scoped requests and retry feedback are written as
additive JSON artifacts under
`gh-dynamic-workflows/.delivery-runs/<run-id>/context/`; packets include readable
relative paths. Content-derived filenames deduplicate identical snapshots and
never replace different historical bytes. These are ordinary audit files, not
receipts, source freezes or execution-approval gates. SDK journals and complete
final results are retained unchanged. No model summarizer, arbitrary truncation,
new acceptance stage or guessed model-token limit is introduced.

Independent assigned tasks run concurrently in one dependency graph, including
DevOps tasks. Sprint 1's first assignment is a dependency-free DevOps task marked
`walkingSkeleton:true` that uses `azd` to deploy a minimal working application.
All other assignments depend on it transitively. After **each** assignment, the
existing DevOps loop deploys/verifies the increment, then E2E tests the latest
deployment before dependents are released. A dependency waits for these checks and review, not unrelated slow
tasks. Designer assignments reuse the source Designer loop.
Review/retro changes to Architecture, UX and ReleasePlan affect later sprints.
Sprint planning dispatches ready original work loops **before** its reviewers
verify the source's assignment-and-dispatch completion condition. Those reviews
do not wait for implementation to finish; the assigned-work steps join it.
If planning needs revision, already-dispatched work is joined before revising
assignments, so old and revised work cannot race.

Planning and its original reviewers distinguish needing an **agreed interface
or fixture** from needing a finished implementation. Broad foundations become
useful handoffs, substantial parallel work and explicit integration/refactoring
tasks. Rough critical-path estimates guide dispatch; small integration changes
are preferable to unnecessary dependency chains. No extra proof stage or
frozen-contract requirement is introduced. Every assigned handoff still includes
deployed verification; interface work does not waive it.

Optional task `estimatedMinutes:{implementation,review,integration}` supplies
nonnegative estimates. Ready work is prioritized by its own total plus the
longest downstream path; missing estimates contribute zero and ties retain plan
order. Optional `exclusiveResources:["shared-module","test-db"]` prevents
matching assignments from overlapping, including review/rework. Dependencies
and resource waits consume no agent slots. Independent branches keep moving
when another blocks; errors are surfaced after dispatched independent work is
joined. File overlap alone creates neither a dependency nor an automatic lock.
There is no automatic worktree/service isolation.
All assigned loops acquire the shared `workflow:deployed-environment` resource
through assignment, DevOps deployment and E2E verification. This serializes
otherwise independent assignments against the shared environment; independent
graph branches do not imply concurrent deployment-environment mutation.

Configure simultaneous agent calls explicitly, for example:

```json
{
  "projectRoot": ".",
  "concurrency": {"doers": 4, "reviewers": 2},
  "git": {"featureBranch": "feature/customer-work"}
}
```

Do-er slots are released before review; reviewers use the independent reviewer
capacity. No agent slot is held while joining dispatched work or waiting for
dependencies/resources.
These are example values, not defaults or new lifetime caps. Omitted capacities
remain uncapped locally; actual host/session limits still apply.

### Git responsibility

Any do-er changing files commits its own intended changes **at the end of each
turn, before review**, including useful partial work on rework/input stops.
It reports actual branch/commit IDs and commit failures, preserves other dirty
or staged work, and uses explicit owned paths (`git commit --only` in shared
checkouts). Never commit secrets/ignored outputs, discard work, remove another
process's Git lock or switch a shared branch under active agents.

The **Scrum Master** is the normal do-er playing that role in `SprintPlanLoop`
and an existing reviewer in sprint review/retro. It assigns Git integration
responsibility and audits that all work is reconciled. The existing Product
Owner do-er handles needed reconciliation in review/retro/closeout; no writable
reviewer or new stage is added. All task commits must reach the authorized
feature branch, or their code must stay on a retained branch with the task,
branch/commit IDs and abandonment reason recorded in a **feature-branch commit
message**. An empty documentation commit can record abandonment. Chat notes
alone are insufficient; do not delete the retained code branch.

Reviewers can execute **read-only Git inspection** and otherwise remain
non-editing. Their command restrictions are instructions, not an OS sandbox.
Committing and reconciliation are agent responsibilities checked in existing
reviews, not a new engine admission or evidence framework.

### Task completion and scoped amendments

New plans supply each task's `doneWhen` string, `exclusions` array and `handoff`
string. Legacy plans remain readable; owners/reviewers must clarify their actual
bounded scope rather than silently substitute full sprint acceptance. Assigned
`doneWhen` describes passing deployed checks, including for research or contract
handoffs; an unverified live capability cannot be called complete. Rework names
the unmet task criterion and a closing action; additional interesting research
alone is not a reason to loop.

Every owner report includes a required `checks` array of
`{id,kind,command,requirement,environment,exitCode,evidence}` objects.
`kind` is `test`, `schema` or `deployed-probe`; `environment` is `local` or
`deployed`; integer `exitCode:0` means passing. Commands and observed exit
codes must be inspectable and traceable to requirements. Each check's `evidence`
is a nonempty repository-relative path to its log/result file, not arbitrary
prose. The runtime checks readability and confinement to the repository;
reviewers verify actual execution and credibility. `complete` requires nonempty passing checks; assigned
work must also have a passing deployed check. Reviewers return `checksValid:boolean`
to assess suitability and actual verification, not `taskComplete`. Unsupported
disagreement or bare `checksValid:false` from any role does not block. Reviews cannot promote owner
`rework` into completion.
Owner `complete` expresses the owner's acceptance of a ready deliverable, not
a claim that reviewers have already voted. Pending votes alone are not owner
rework; the runner collects every original vote before recording agreement.
Substantive conditions, including actual deployed tests, remain binding.

An agreed assigned-work owner `needs-replan` invokes the existing Sprint Architect
and Scrum Master loops for a scoped amendment under Sprint Loop. They resolve only the
affected architecture and return a self-contained replacement `SprintPlan` for
that assignment. Existing accepted prerequisites are supplied as context; new
dependencies stay within the replacement graph. Its accepted handoffs fulfill
the original outer dependency. Unrelated accepted/running tasks are not restarted
or cancelled. Replacement work dispatches before its planning reviews, joins
before plan revision, and shares resource/agent queues with ordinary work.
Source task resources are released before routing. DevOps replacements use the
same graph and continuous checks. This is conditional reuse of existing roles,
not a new standing approval stage or full architecture restart. Human
`needs-input` stays distinct.
The scoped request carries grounded feedback and requirements/test references.
Unsupported expansion does not force a replacement DAG; accepted changes first
update and commit the requirements-and-tests ledger.
In unassigned planning/release loops, `needs-replan` instead feeds the report
and original reviews back to that same owner to resolve its own deliverable.
An Architect corrects architecture/ownership before later original planning
stages assign implementation; no extra stage or automatic acceptance is added.
Only the six original architecture/design/release/sprint planning loops use
that in-owner behavior. Unassigned execution/test/deployment loops return an
agreed `needs-replan` as an incomplete application stop. Their existing
prerequisites can then be corrected through original planning against current
work; they do not repeat unchanged blocker reports until stagnation, skip later
reviews or turn an accurate deployment failure into success.
Parallel reviewers judge their own votes; orchestration aggregates peer votes.
Stopped results omit unavailable optional fields so SDK JSON validation retains
the real outcome rather than failing on nested `undefined`.

When observed values are available, commit messages include model name, input,
cached/cache-read and output tokens, and elapsed time with units/scope. Omit
unknown values; do not estimate or invent zeroes. Later usage can be recorded in
a follow-up metadata commit referencing the original, without amending reviewed
history.

An accurate actionable **FAIL** is useful feedback, not completed verification.
The continuous DevOps-then-E2E loops require passing checks before dependents are
released. Reviewers verify check suitability and evidence; nonblocking observations
need not disappear for completion.

The engine no longer has source fingerprints/freezes, script/dependency hashes,
workspace leases, execution tickets, native receipts, exact tool-profile checks,
bootstrap/discovery/publication/infrastructure/exact-plan/recovery review gates,
or a separate operator. A do-er can both edit and execute. Publication, research,
repair and deployment belong within the original work loops, when authorized.
There is no forced result-harvest sprint or clean/pushed-source admission gate.

## Transport and limits

Owners return `{status:"complete"|"rework"|"needs-replan"|"needs-input", summary, artifact, workCard, checks}`.
Reviewers return `{feedback:string, workCard, checksValid:boolean, findings}`;
`agree` is not required or used as a completion vote. Artifacts use YAML output
names. `ReleasePlan.sprints` is an array with unique string `id`s;
`SprintPlan.tasks` contains `{id,title,kind,owner,dependsOn}`. Kinds are `ui`,
`developer`, `designer`, `devops`; their owners are Developer, Developer, Designer,
DevOps Engineer. Further backlog work gets a new sprint id. Scheduling-format
errors return to the same planning loop, not another approval gate.
Planning artifacts may instead provide a JSON document `path` relative to
`projectRoot`; the runner reads its `ReleasePlan`/`SprintPlan` object (or bare
plan) before validating and dispatching. Existing saved plans need not be
rewritten into a second inline-only format.

The shared default writing profile is **`workflow-owner`**, with the concrete
Developer/Architect/Designer/etc. role supplied by YAML. `agents.owner` selects
an override; historical `agents.doer` remains compatible (owner wins if both
are supplied). `agents.reviewer` selects original read-only reviews.
The default remains `workflow-reviewer` for those calls.
Stable `kind:"doer"` and `:doer:<round>` labels remain unchanged for callers,
journals and historical Studio attribution; this is a profile rename, not a
protocol rewrite.

No attempt, sprint, concurrency, time or credit ceiling is invented. Optional
`maxSprints` and `attempts.planning`/`attempts.implementation` apply only when
supplied; a loop-id property can override its round limit. Those legacy attempt
limits count **all rounds**, including productive rework, not just failures.

For unlimited productive rounds and sprints with a stagnation stop, omit
`attempts` and `maxSprints` and explicitly supply:

```json
{"projectRoot":".","maxNoProgressRounds":10}
```

This counts **consecutive rounds without new progress verified by every
original reviewer**, independently per loop invocation/assignment. The do-er
reports `progress:[{id,evidence}]` using stable milestone/check/finding IDs and
inspectable evidence; each reviewer returns `verifiedProgress:[id,...]` after
independent inspection. New IDs endorsed by all check-adequacy reviewers
(excluding Critic and Red Team) reset the counter
even when the loop still needs rework. Reusing an already credited ID or the
same evidence text (ignoring case/whitespace) never resets it. Changed summaries,
file churn, repeated tests, relabeled old work,
and unsupported progress claims do not qualify; reviewers compare against the
credited evidence and prior feedback. There is no new review stage or change
to check-based completion conditions from the stagnation guard.

At the threshold the result is `blocked` with `stopCause:"no-progress"`, the
consecutive counter, credited evidence and unresolved feedback. Completion or
reviewer-confirmed `needs-input` exits earlier, including on the threshold round.
Already-dispatched work is joined before stopping or revising a plan. If legacy
`attempts`/`maxSprints` are also supplied, they remain independent hard ceilings.
No stagnation threshold is inserted by default. This is a reviewer-judged
round-boundary safeguard, not a deterministic proof of progress, per-agent
timeout, or spend ceiling; a single hung/expensive agent call is not preempted
by it. Explicit SDK resource limits, when supplied, still apply.

Rework stays inside original loops, not a separate repair/recovery pipeline.
An agreed `needs-input`, stagnation `blocked`, or explicitly reached limit is
not success. Inspect both the SDK envelope and the application-level result.

The engine identity is `yaml-loops-v2`, with correction contract
`requirement-grounded-v1` recorded in the run marker. Older v2 correction contracts
and unversioned context history are rejected without modifying old journals. Accepted
`yaml-loops-v1` journal steps cannot bypass new checks or replay as v2 acceptance.
Preserve prior runs as history and start a new run after adoption.
SDK step/agent journals support replay of compatible v2 runs. They provide
best-effort at-least-once execution, not exactly-once side effects. Agents must
inspect uncertain real-world outcomes before repeating operations. Old native
`.delivery-runs` journals belong to the retired engine: preserve them as history,
do not resume/migrate them through this implementation. The terminal launcher
has no invented SDK-resume flag or `lab-delivery-resume` transport.

## Visualization and maintenance

[Workflow Studio](studio/README.md) provides source/design drafts, live agents
and phases, and historical results in one Copilot Canvas. Draft preview/export
does not alter source or control execution.

### Adopting this runtime in an existing installation

Stop/join the old run first; preserve its work, history and project-specific
instructions/input/authority. Do not hot-swap its modules or silently resume
partially journaled old rounds under the new check/ledger semantics. The
operator starts a **new run manually** after adoption.

The explicit `--replace-retired-engine` installer is the authoritative complete
copy manifest: it replaces known package/runtime/registration/template/docs/test
paths, including the owner and reviewer profiles.
It does not change target launchers, input, authority, histories or Studio.
Already installed `workflow-doer` profiles/templates are left alone for explicit
legacy `agents.doer` overrides; fresh installations install only the owner and
reviewer profiles. No dependency manifest changes are needed for this upgrade.

For a narrowly reviewed manual adoption, the behavioral files are
`lab-loops.mjs`, `loop-workflow.mjs`, `loop-source.mjs`, `task-context.mjs`,
`install.mjs`, `templates/workflow-owner.agent.md`,
`templates/workflow-reviewer.agent.md`, and the latter two copied to matching
`.github/agents` paths. Keep the README/contract/design/quickstart and distributed
tests in sync (the installer manifest lists their exact paths). Existing
`workflow.mjs`, `lab-workflow.mjs` and `extension.mjs` already load the common
runner and require no registration change. If Studio is installed, separately
copy `studio/usage.mjs` and `studio/observed.mjs` (and their regressions) for
structured check-review rendering and readable historical attribution;
historical `workflow-doer` labels still render.

```powershell
npm --prefix .\gh-dynamic-workflows test
npm --prefix .\gh-dynamic-workflows\studio test
```

The original generated multi-repository fleet/MCP scaffolding is separate and
unchanged. See [LAB-DESIGN.md](LAB-DESIGN.md), [LAB-CONTRACT.md](LAB-CONTRACT.md)
and [RESEARCH.md](RESEARCH.md) for mapping, authority and platform distinctions.
