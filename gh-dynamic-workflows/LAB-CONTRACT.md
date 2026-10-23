# YAML-loop input and authority contract

Required input: `{projectRoot:string}`. Supply a `specification` path, or
`{repository,path}` with `repositories:[{id,path,access,...}]`, or an `input`
goal/path. Other fields describe the actual user request, acceptance, allowed
commands, deployment/publication destinations and restrictions. They are context
for do-ers/reviewers, not a second engine-admission language.

Optional `workflowPath` selects an edited YAML file relative to projectRoot;
otherwise the installed `loops.yml` is used. Optional `agents.owner` (or legacy `agents.doer`) and
`agents.reviewer` select ordinary agent profiles; the engine does not inspect
their exact tools or source. Defaults are `workflow-owner` and `workflow-reviewer`.
`agents.owner` wins over `agents.doer`; the latter remains supported for existing
custom profiles. Original concrete YAML roles and stable doer event/label
protocol remain unchanged. Fresh installs ship the owner profile; explicit
upgrades retain old installed doer profiles only as legacy overrides.
CLI permissions and project instructions remain authoritative.

Optional `concurrency:{doers,reviewers}` sets separate positive integer
capacities for active agent calls. Either field may be omitted (no local cap);
no capacity is guessed. Do-er capacity is released before review, and reviewers
have an independent queue. Dependency-waiting assignments do not enter either
queue. Actual host/session limits still apply; these settings do not override
them or create a total round, sprint, time or spend ceiling.

Optional `git:{featureBranch:string}` names the authorized integration branch.
Otherwise agents use the project's intended feature branch. Establish it before
parallel writing; the engine does not switch branches or merge code itself.

Optional `maxSprints` and `attempts.planning` / `attempts.implementation` are
positive integers; per-loop-id attempt properties override category limits.
No defaults are inserted. Implementation covers UI/backend and DevOps work;
other original loops use planning. Each round includes its original reviewers.
There are no separate repair/recovery stages or their former budgets.
These attempt limits count every round, not just failures. Omit both `attempts`
and `maxSprints` to allow unlimited rounds and sprints.

Optional `maxNoProgressRounds` is a positive integer with no default. It stops
each original loop invocation/assignment after that many consecutive rounds
without new progress independently verified by its original check-adequacy
reviewers (excluding Critic and Red Team, whose observations cannot veto progress).
Verified progress resets the counter even when completion is not yet agreed.
The existing completion/human-input conditions take precedence. Legacy total
round/sprint caps, if also supplied, remain independent limits.

## Repository requirements and executable checks

The Git-tracked `docs/requirements` files and regression tests are the durable
requirements-and-tests ledger. They replace Scrum triage, Architect advice,
Product Owner disposition ledgers and runtime governance. There are no runtime
dispositions or `priorDispositions`. Historical audits remain readable evidence,
not current authority, and are not imported as instructions.

An accepted scope change requires a committed edit under `docs/requirements`
and a corresponding regression test, within existing user authority. Declined
proposals never enter this ledger. No reviewer can grant additional permissions;
missing authority or credentials uses the ordinary `needs-input` path.

Every role's mandatory corrections must identify an original user requirement,
an explicitly approved amendment, or a demonstrated defect preventing that
requirement, with a citation and a falsifiable reason why the current work fails.
Everything else stays optional, including Architect, Product Owner and Scrum
Master suggestions. Committed agent interpretations and newly invented failing
tests do not create user authority. Red Team remains limited to infrastructure
configuration and application-library CVEs, identifying the affected library,
version and CVE. Reviewers remain read-only; no new role or approval stage is added.

Do-er report: `{status:"complete"|"rework"|"needs-replan"|"needs-input",summary:string,artifact:object,workCard:object,checks:array}`.
An optional `nextAction` can identify the exact decision needed for human input.
Every check has `{id,kind,command,requirement,environment,exitCode,evidence}`:
`kind` is `test`, `schema` or `deployed-probe`; `environment` is `local` or
`deployed`; integer `exitCode` records the observed command result (zero passes).
IDs identify checks; `requirement` traces their purpose to the ledger.
Each check's `evidence` is a
nonempty repository-relative path to its log/result file, not arbitrary prose.
The runtime verifies that this file is readable and confined to the repository;
reviewers verify actual execution and evidence credibility.
Owners run the commands through ordinary permission-bound tools;
the runtime does not execute arbitrary reported commands or grant unrestricted
execution. `complete` requires a nonempty passing check array. Assigned work
also requires a passing deployed check; local checks alone cannot complete it.

Reviewer reports require `{feedback,workCard,checksValid:boolean,findings}`; `agree`
is not a required field or a completion vote.
`findings` discriminate `type:"blocking"|"observation"`. Every finding requires
`summary` and `action`. Blocking findings additionally require:

- `basis:"original-requirement"|"approved-amendment"|"demonstrated-defect"`.
- `requirement:{path,line}` citing the original request or explicit approval
  directly, and `reason` explaining the specific, falsifiable failure.
- For `demonstrated-defect`, `evidence`: a readable nonempty repository-relative
  source/log showing how the defect prevents the cited requirement. Optional
  `failingCheck` must identify an emitted nonzero-exit check with that same evidence.

Citation paths may identify existing original request/approval files outside
`docs/requirements`; no duplicate authority ledger is needed. They must remain
inside projectRoot without traversal or symlink escapes, and their positive,
nonempty line must match committed `HEAD`. New/dirty citations, missing reasons
and unsupported defects normalize to observations. Fixed read-only Git commands
verify citation integrity, **not** user authorship, execution or semantic truth.
The existing owner and reviewers must inspect the actual request/approval and
judge whether the cited text entails the correction; an agent's committed
interpretation is not approval.

`checksValid` remains diagnostic for suitability and credibility. It cannot
block **any** role without a supported structured finding. Explain an omitted
required behavior or fabricated execution against the actual requirement in a
finding instead of using a bare false vote. Raw votes and feedback prose do not
create mandatory work. Red Team findings retain their required
`scope:"infrastructure-config"|"dependency-cve"`. Actual missing/failing execution
checks, deployment checks, permission boundaries and owner `rework` still
prevent completion; optional suggestions do not waive them.

The runtime assigns supported findings a `correctionId` such as `Architect:1`.
On the next existing do-er turn, `correctionAssessments` must address every
previous supported correction exactly once:

```json
{
  "correctionAssessments": [{
    "correctionId": "Architect:1",
    "verdict": "refuted",
    "reason": "The existing endpoint and probe already cover the requested response.",
    "evidence": "checks/health-response.log"
  }]
}
```

This is a response fragment, not a full owner report. Verdicts are `confirmed`,
`refuted` or `unresolved`; confirmed/refuted judgments require inspectable
repository-relative evidence. Unresolved may leave evidence empty but must
explain the uncertainty. Missing, duplicate, invented or malformed assessments
fail explicitly. The original reviewers verify the owner's reasoning in the
next existing review, withdraw refuted claims and uphold only currently
supported failures. Architect checks technical reasoning and Product Owner
checks requirement entailment where already assigned; absent roles are not
summoned. Unresolved opinion is not a mandatory correction, and an owner
refutation is not a waiver of an actual failing required check. Assessments
remain in outcomes, handoffs and Studio alongside the submitted claims.

All newly requested owner and reviewer reports require a
`workCard` using `work-cards.mjs`'s shared schema. Historical records may omit it;
supplied malformed metadata is an explicit error. The card contains
`role`, `action`, `goal`, `components`, `flows`, `flowSteps`, `doneWhen`,
`failureCategories`, `mustAct`, `locations`, `evidence`, `cause`,
`verification:{status,evidence}`, `humanAction` and `humanActionEvidence`.
Verification status is `not-yet-verified`, `passed`, `failed` or `partial`;
anything other than unverified needs concrete evidence. Human action and its
supporting evidence must both be present or both empty. A blocked task does
not establish a user-only action.

The Architect maintains `solutionModel` in Architecture/SprintArchitecture
or their referenced design files: named components with stable IDs,
implementation children and shared-support links, and named flows with triggers,
steps referencing components, and optional personas. Downstream roles reuse
these names without requiring user naming. SprintPlan task cards match their
assigned owner, title/action and doneWhen, and survive saved planning documents
and scoped replanning. See [definitions and examples](WORK-CARD-DEFINITIONS.md).
SprintPlan reports also request `taskCards:[{id,workCard}]`, matching every
resolved plan assignment. This display-only projection supports file-backed
plans without Studio reading arbitrary files. Supplied projections are checked
against the resolved plan before dispatch.

Agreed assigned-work `needs-replan` reuses the existing scoped Architect/Scrum
Master planning loops, not human input. Those loops return bounded replacement
assignments with internal dependency edges and accepted outer prerequisites in
context; the outer graph and unrelated work are preserved. Replacement tasks
use the same graph for DevOps and other work. Shared resources are released
before routing and applied to replacements; SDK replay reuses amended steps.
Unassigned planning/release `needs-replan` remains feedback to the existing
owner until its own deliverable is resolved; downstream original roles then
plan their work normally. Reviewers assess their own votes, not whether other
parallel votes have arrived. Stopped results omit absent optional properties
rather than returning SDK-invalid `undefined` values.

Planners supply `doneWhen`, `exclusions` and `handoff`; supplied fields are
validated but absent legacy fields do not create a new admission gate. Completion
is task-specific: sprint criteria may describe contribution rather than full
ownership, but assigned `doneWhen` includes deployed verification. Research
handoffs do not waive the required checks or imply unverified live readiness.
Concrete rework identifies an unmet criterion and closing action; material
expansion uses `needs-replan`.

When `maxNoProgressRounds` is supplied, do-ers additionally return
`progress:[{id:string,evidence:string}]` (or `[]`). IDs identify stable
milestones, checks or findings; evidence identifies concrete new advances this
round and how to inspect them. Reviewers additionally return
`verifiedProgress:[id,...]` (or `[]`), a subset of the proposed IDs whose new
underlying progress they actually verified. Missing/malformed fields and
unknown IDs are explicit errors, not successful progress or silent defaults.
Reviewers receive the credited evidence and prior feedback. New IDs endorsed
by every check-adequacy reviewer reset stagnation; previously credited IDs cannot reset it.
The same evidence text, ignoring case/whitespace, also cannot reset it under a
new ID. Reviewers must detect paraphrased/repackaged prior work too.
Do not recredit prior work by relabeling it. Claims, cosmetic churn and repeated
test runs alone do not count. This is normal original-loop review, not an
additional approval stage or evidence protocol when the option is absent.

The threshold returns `blocked`, `stopCause:"no-progress"`, total `rounds`,
`progress:{noProgressRounds,limit,credited:[{id,evidence,round}]}`, unresolved
`feedback` and an actionable `nextAction`. The launcher preserves this evidence
and exits 2, even if the SDK envelope says completed. Dispatched work is joined
before stopping. Stagnation detection relies on reviewer judgment, not a source
freeze/hash or proof of semantic improvement. It only runs between rounds and
does not bound a single agent's tool calls, time or spend.

Artifacts use the output names from YAML:

```json
{
  "ReleasePlan": {
    "sprints": [{"id":"sprint-1","goal":"Deliver the requested behavior"}]
  },
  "SprintPlan": {
    "tasks": [
      {"id":"skeleton","title":"Deploy walking skeleton with azd","kind":"devops","owner":"DevOps Engineer","walkingSkeleton":true,"dependsOn":[],
      "doneWhen":"azd deploys the minimal application and a deployed smoke check passes"},
      {"id":"contract","title":"Agree interfaces and fixtures","kind":"developer","owner":"Developer","dependsOn":["skeleton"],
      "doneWhen":"Contract checks and a deployed compatibility check pass",
      "estimatedMinutes":{"implementation":5,"review":3}},
      {"id":"api","title":"Implement API","kind":"developer","owner":"Developer","dependsOn":["contract"],
      "doneWhen":"API regression checks and deployed API probes pass",
      "estimatedMinutes":{"implementation":20,"review":5}},
      {"id":"ui","title":"Implement UI against fixtures","kind":"ui","owner":"Developer","dependsOn":["contract"],
      "doneWhen":"UI regression checks and deployed browser checks pass",
      "estimatedMinutes":{"implementation":15,"review":5}},
      {"id":"integrate","title":"Connect implementations and reconcile Git","kind":"developer","owner":"Developer","dependsOn":["api","ui"],
       "doneWhen":"Integrated regression checks and deployed end-to-end checks pass",
       "estimatedMinutes":{"integration":5,"review":3},"exclusiveResources":["integration-test-db"]}
    ]
  }
}
```

Task/sprint ids are unique. Task kinds are ui/developer/designer/devops; assign
Developer/Developer/Designer/DevOps Engineer respectively. Dependencies must
exist and form an acyclic graph shared by DevOps and all other task kinds.
Sprint 1 starts with a dependency-free DevOps assignment marked
`walkingSkeleton:true`, using `azd`; every other assignment depends on it
transitively. Skeleton completion records an actual `azd up`, `azd provision`
or `azd deploy` check and a separate passing deployed probe; naming `azd` in
planning prose is not execution evidence.
After every assignment, the existing DevOps loop deploys/verifies
the increment, then the E2E loop tests that latest deployment before any dependents
are released, not as late-only stages.
Reviewer feedback can request changed work without any new review type. Further sprint backlog uses
new sprint ids. Review/retro can replace accepted shared design/plan documents.

Optional task `estimatedMinutes` contains nonnegative finite `implementation`,
`review` and/or `integration` numbers. Ready assignments are ranked by their
own total plus the longest downstream path across all task kinds.
Missing estimates contribute zero; ties preserve plan order. Priorities are
nonpreemptive estimates, not deadlines, reservations of host capacity or gates.
Optional `exclusiveResources` is an array of unique nonempty names. Assignments
with matching names do not overlap, including review/rework; all their resources
are acquired together and released when the assignment settles. Resource waits
do not consume agent capacity. Other assignments continue when a branch blocks
or fails; descendants of unsuccessful work are not dispatched. Execution errors
are reported after independent dispatched work is joined.
All assigned loops acquire `workflow:deployed-environment` through assignment,
DevOps deployment and E2E verification, serializing otherwise independent work
against the shared environment. Graph independence is not a promise of concurrent
writes to one environment.

The planner and its existing reviewers distinguish accepted contract/fixture
handoffs from completed implementations. Split broad foundations at useful
handoffs, describe produced/consumed interfaces and acceptance criteria in the
task, then plan substantial parallel implementation and explicit integration
tasks using existing kinds. Accept economical refactoring rather than freezing
contracts or adding proof stages. File overlap alone adds no dependency or
automatic lock. Declare matching resources for actual shared editing/testing
contention; the engine supplies no worktree, database, port or OS isolation.

For planning artifacts, `{SprintPlan:{path:"docs/SprintPlan.json"}}` (or the
equivalent ReleasePlan reference) reads the named JSON document relative to
projectRoot. The file can contain the named object or the bare plan.
SprintPlan `complete` submits a dispatch-ready graph: the orchestrator dispatches
original independent work loops before planning reviewers verify the source
condition, and the later assigned-work steps await their results. The Scrum
Master does not need a separate dispatch tool or extra permission stage.

Do-ers write and run real project commands directly. Removed native contracts
(`DELIVERY_*`, tickets, exact source/dependency/plan hashes, scratch markers,
leases, intent/result receipts) are not required and no longer supplied.
Do not adapt scripts to recreate them. Retain genuine product provenance and
telemetry, user-selected resource permissions and relevant idempotence.

Every file-changing do-er turn commits its own intended changes before review,
including partial work on `rework`/`needs-input`, and reports branch/commit IDs.
No-change turns need no artificial commit. Preserve other staged/dirty work:
stage explicit owned paths and use path-scoped `git commit --only` in shared
checkouts. Never commit secrets/ignored outputs, switch branches under active
agents, discard work or remove another process's Git lock. Report commit
failures instead of claiming completion. Reviewers inspect actual commits.
When available, record observed model name, input/cached/output counts and elapsed
time with units/scope in commit messages. Omit unavailable values; a follow-up
metadata commit can reference the code commit without amending reviewed history.
Their execute tool is restricted by instructions to read-only Git inspection,
not writable commands or an OS-enforced sandbox.

The Scrum Master is the existing `SprintPlanLoop` do-er role, normally played
by `workflow-owner`, and an existing read-only sprint review/retro reviewer.
It assigns Git integration responsibility in planning and audits reconciliation
in review. The existing Product Owner do-er performs any reconciliation needed
in sprint review/retro and release closeout; no writable Scrum Master reviewer
or extra stage is added. Every task's code must reach the feature branch or be
explicitly abandoned: retain code commits on a named branch and commit the
task, branch/commit IDs and concrete abandonment reason in a feature-branch
commit message. An empty documentation commit is permitted for that record.
Do not delete abandoned code branches or substitute a chat-only explanation.
These are ordinary do-er/reviewer responsibilities, not a new native Git
admission protocol; real Git actions are performed by agents, not the scheduler.

`completed` requires the source loop conditions and verified suitable passing
checks, including deployed checks for assigned work and continuous DevOps-then-E2E
verification before dependency release. An accurately reported failed check is
useful evidence, not successful completion. Other application results
include `needs-input`, `limit-reached` and dependency `not-run`; errors remain
errors. Check the result as well as the SDK envelope.

The engine identity is `yaml-loops-v2` with correction contract
`requirement-grounded-v1` in the run marker. Older v2 correction contracts and
unversioned context history are rejected without modifying old journals. Prior
`yaml-loops-v1` accepted journal steps cannot bypass new checks or replay as v2
acceptance: preserve them as history and start a new run after adoption. Retired `.delivery-runs`
native journals also remain historical, not migration/replay input.
Use supported SDK owner-session resume only for compatible v2 runs, not a
fabricated terminal flag or a second workflow wrapping native continuation.
