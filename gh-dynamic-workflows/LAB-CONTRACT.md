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
`maxSprints` counts entered sprints, including incomplete/partial ones; it cannot
be evaded by pulling a not-entered sprint's work into a continuation amendment.

Optional `maxNoProgressRounds` is a positive integer with no default. It stops
each original loop invocation/assignment after that many consecutive rounds
without new progress independently verified by all of its original reviewers.
Verified progress resets the counter even when completion is not yet agreed.
The existing completion/human-input conditions take precedence. Legacy total
round/sprint caps, if also supplied, remain independent limits.

## Work conservation and continuation amendments

[DELIVERY-PRINCIPLES.md](DELIVERY-PRINCIPLES.md) records the accepted decision.
A task/stage `needs-input`, `needs-replan` or no-progress outcome remains
incomplete while independent authorized release work continues. It is not an
automatic terminal release result. Accepted tasks/stages and their original
reviews are retained; partial sprints are never counted as completed.

`ReleasePlan.sprints[].dependsOn`, when supplied, contains unique existing
sprint IDs and must be acyclic. It means full prerequisite sprint acceptance.
Prefer smaller reviewed handoffs when the whole sprint is not needed. Absence
of a whole-sprint edge does not waive actual source/contract/authority needs;
later original planning/reviews receive `delivery` with unresolved blockers.

After planned ready work settles, the existing SprintArchitectureLoop and
SprintPlanLoop receive `context.continuation` with exact blocked outcome keys,
audit references, scheduled task IDs and permitted source sprint IDs. Architect
assesses component/flow/source blast radius and feasible construction; Scrum
audits ready work, splits, independent approved backlog and bounded unlocking
investigation. No new standing role or YAML acceptance stage is inserted.

Continuation SprintPlan `complete` reports also supply:

```json
{
  "artifact": {
    "SprintPlan": {
      "tasks": [{
        "id": "adapter-source",
        "title": "Build the approved adapter against its accepted contract",
        "kind": "developer",
        "owner": "Developer",
        "dependsOn": [],
        "sourceSprintId": "s1",
        "sourceCriterion": "Original approved adapter construction criterion"
      }]
    },
    "Continuation": {
      "disposition": "continue",
      "summary": "Live registration does not block adapter source construction",
      "evidence": ["Inspected the approved contract and missing source module"],
      "resumes": []
    }
  }
}
```

Normal work-card, taskCards and task-boundary requirements still apply (omitted
in this abbreviated example). Each new task ID must be unused in that partial
sprint; sourceSprintId names an allowed approved release sprint and
sourceCriterion cites its actual criterion. Amendment dependencies stay inside
the amendment. Prior handoffs retain exact audit references and limitations.
Save amendments separately; do not overwrite the original SprintPlan or
ReleasePlan. Actual `devops` tasks are not permitted in this source-work graph.
Authorized script/adapter construction may be developer work, not live PASS.

Optional `resumes:[{key,after:[newTaskId],evidence}]` requests reassessment of an
exact supplied blocker when its conditions materially change. Only its named
new handoffs must be accepted; unrelated incomplete amendment tasks do not
prevent reassessment. Empty `after` requires concrete newly obtained authoritative
evidence, verified by the original planning reviewers and then the original
task/stage owner/reviewers. Unknown keys/handoffs, duplicate references and
reassessment of capped/error invocations fail validation. No implicit permission,
blind replay, acceptance waiver or new-key limit reset is allowed.

For blocked DevOps, optional `resumes[].e2eSubject` selects an exact accepted
same-sprint Developer source outcome from `continuation.sourceSubjects`.
The subject must retain a full commit ID, `DeveloperWork.taskComplete:true`,
and the original Architect/Critic acceptance. It must differ from the agreed
original E2E's tested revision. A single changed accepted source in `after`
also qualifies older plans; ambiguous candidates require explicit selection.
The original E2E runs before DevOps with the retained source document/dependency,
not a newer workflow-repair commit. Its single `PASS` or `FAIL with feedback`
artifact must report `taskComplete:true` and the exact `testedRevision`; all
three original reviewers independently supply `taskComplete`/`unmetCriteria`.
Failed/capped/error/no-progress qualification is never reset this way.

Qualified outcomes retain the canonical original E2E key. Durable execution
uses `requalification/<continuationRound>` and, when an accepted exact-stage
resume exists, `/resume/<revision>` before `/EndToEndTestLoop`. A document-only
`after:[]` reassessment with no `e2eSubject` retains the qualification/source
but gets fresh owner/reviewer steps for its genuine resume revision. It does
not renew a limit or authorize effects. Audit references bind each historical
outcome object, not merely its shared semantic key; old bytes remain immutable.
Unchanged replay reuses execution identities without new agent calls.

`disposition:"exhausted"` requires empty tasks/resumes and inspectable findings
showing no ready/executing work, feasible split, independent approved backlog
or bounded unlocking investigation remains. `continue` requires tasks or
reassessment; report agreement alone is not progress. New accepted construction/
execution or successful reassessment can trigger another audit; unchanged
blockers/exhaustion do not poll. Explicit continuation-planning caps are retained.
Scoped replacement graphs retain their own accepted tasks and blocked planning
stages. Reassessment targets the exact child/stage; it does not rerun the
superseded parent or reacquire its edit resources while awaiting children.

Final non-success application results include `delivery:{state:"waiting",
waitReason,completedSprints,partialSprints,pendingSprints,acceptedWork,remainingWork,blockedWork,
continuationAudits}`. `waitReason` distinguishes `work-exhausted`, `explicit-limit`,
`prerequisite-planning`, blocked `continuation-review` and final `release-closeout`.
Top-level prerequisite/closeout blockers also remain explicit in `blockedWork`.
An incomplete or capped
continuation assessment is not an accepted exhaustion audit. Original summary/status and all raw outcomes
remain available. Branch-local execution errors are raised explicitly after
independent release work settles; cancellation is not downgraded to a blocker.
Failure checkpoints are also archived additively and their path is logged and
included in the aggregate error. Prompt packets contain accepted-work scope/
audit indices and only the latest continuation assessment per sprint, not
historical accepted reports or repeated raw continuation evidence.
SDK journals/context files persist the checkpoint, not a live SDK pause or an
interactive input channel. Studio's cross-session observation remains read-only.

## Mandatory feedback coordination

Every unresolved round is joined to any dispatched work, then receives a
read-only Scrum Master triage before owner retry or assigned scope routing.
Acceptance and confirmed human needs-input exit without triage. This applies
even without progress guards or expansion flags. Governance roles use
`agents.reviewer`/`workflow-reviewer` and individual reviewer-capacity slots;
no slot is held across joins or between role calls.
The final explicit hard-cap round skips governance when no retry remains
(assigned needs-replan routing is the exception). It still joins dispatch and
retains the raw feedback; stagnation accounting runs once and retains its normal
precedence. Governance never consumes an extra round or credits progress.

Structured role contracts (validated at runtime; failed/malformed calls are
errors, never implicit acceptance):

- Scrum Master: `{summary,requiredCorrections:[{id,requirement,evidence,action}],
  scopeQuestions:[{id,request,evidence}]}`. Inspect all existing criteria,
  evidence and conflicts independently; choose the smallest sufficient
  correction. IDs are unique across both lists. Either record can additionally
  supply `priorReference:string` to identify an existing disposition precisely.
  A correction referencing prior scope is moved to scopeQuestions for conditional
  Architect/PO reconsideration, not silently promoted to required work.
- When scopeQuestions is nonempty, Architect:
  `{assessments:[{id,necessity:"required"|"enhancement",rationale,simplestOption}]}`.
  Assess correctness, safety and integration necessity, not product authority.
- Then Product Owner: `{decisions:[{id,disposition:"required"|"approve"|"defer"|"decline",
  rationale,action,acceptance,taskBoundary}]}`. Each question must have exactly
  one advice and decision entry. Required/approved entries need nonempty action,
  acceptance and task boundary. Required work cites existing scope; enhancements
  must stay within existing user authority. Architect-confirmed required failures
  cannot be deferred/declined. Defer/decline is for optional work only.

The runtime supplies ONE reconciled `feedback.governance.instructions` set to
the next owner and all original reviewers, regardless of the guard option.
`governance.nonBlocking` retains deferred/declined enhancements; raw feedback
and structured role reports stay in `governanceHistory` for audit, including
on eventual acceptance. PO decisions persist across later rounds; revisiting
a decided ID must use an explicit new PO decision, never a Scrum correction.
Owners reflect decisions rather than replaying raw suggestions; reviewers may
not reintroduce discarded enhancements as blockers. Real failures still block
acceptance, and original reviewer agreement/task completion remains required.
No role may rewrite requirements to waive failures. New human authority is
resolved only through the original needs-input path.

Every owner/reviewer/governance prompt also receives authoritative bounded
`priorDispositions`, including on the first turn of a new invocation. The
projection uses existing `context.outcomes` governance, scoped/inherited request
feedback and current plan dispositions passed at dispatch. Entries carry
`reference` (origin key plus local ID), origin loop/task/sprint and task acceptance/
boundaries; source outcome status is included when available. Required/approved
and nonblocking dispositions cross replacements and later sprints without copying
raw audit histories. There is no separate persistence database/registry.

Apply prior instructions only within their actual boundaries; accepted upstream
work is not reopened, and unrelated criteria with matching short IDs remain
required. Reconsideration requires the exact provenance-qualified priorReference.
Unknown/duplicate references or reusing a local decided ID for unrelated scope
is an explicit error; use a new ID for unrelated criteria. Runtime-generated
`supersedes` references record explicit PO changes transitively, so subsequent
contexts expose the latest disposition rather than resurrecting old ones.
Applicability and completion remain reviewer-judged: no criterion-proof protocol
or automatic semantic matching is added.

This requested runtime coordination is an explicit exception to prior
no-added-gate prose, not a new YAML stage, owner or reviewer set. Progress is
still judged independently by each original reviewer. Existing assigned
needs-replan routing receives the reconciled feedback; when only discarded
enhancements remain, retry the original owner instead of replacing its DAG.
Unassigned needs-replan still retries the same owner.

Do-er report: `{status:"complete"|"rework"|"needs-replan"|"needs-input",summary:string,artifact:object,workCard:object}`.
An optional `nextAction` can identify the exact decision needed for human input.
Reviewer report: `{agree:boolean,feedback:string,workCard:object}`. No mandated empty findings,
file evidence lists, cryptographic bindings or native PASS receipt.
Assigned-work reviews additionally require `taskComplete:boolean` and
`unmetCriteria:string[]`, separating accurate reports from completion judgments.
Owner `complete`, reviewer agreement and completion endorsement are all needed
for assignment acceptance. No reviewer promotes owner rework into completion.

All newly requested owner, reviewer and feedback-governance reports require a
`workCard` using `work-cards.mjs`'s shared schema. Legacy replay may omit it;
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

Agreed assigned-work `needs-replan` is internal scoped Architect/Scrum Master coordination,
not human input. The existing architecture/plan loops return bounded replacement
assignments with internal dependency edges and accepted outer prerequisites in
context; the outer graph and unrelated work are preserved. Replacement tasks
cannot pull later DevOps work into implementation. Shared resources are released
before routing and applied to replacements; SDK replay reuses amended steps.
Unassigned planning/release `needs-replan` remains feedback to the existing
owner until its own deliverable is resolved; downstream original roles then
plan their work normally. Reviewers assess their own votes, not whether other
parallel votes have arrived. Stopped results omit absent optional properties
rather than returning SDK-invalid `undefined` values.

Planners supply `doneWhen`, `exclusions` and `handoff`; supplied fields are
validated but absent legacy fields do not create a new admission gate. Completion
is task-specific: sprint criteria may describe contribution rather than full
ownership. Actionable unresolved research is a valid completed handoff when
scoped that way, without implying live readiness. Concrete rework identifies an
unmet criterion and closing action; material expansion uses `needs-replan`.

When `maxNoProgressRounds` is supplied, do-ers additionally return
`progress:[{id:string,evidence:string}]` (or `[]`). IDs identify stable
milestones, checks or findings; evidence identifies concrete new advances this
round and how to inspect them. Reviewers additionally return
`verifiedProgress:[id,...]` (or `[]`), a subset of the proposed IDs whose new
underlying progress they actually verified. Missing/malformed fields and
unknown IDs are explicit errors, not successful progress or silent defaults.
Reviewers receive the credited evidence and prior feedback. New IDs endorsed
by every reviewer reset stagnation; previously credited IDs cannot reset it.
The same evidence text, ignoring case/whitespace, also cannot reset it under a
new ID. Reviewers must detect paraphrased/repackaged prior work too.
Do not recredit prior work by relabeling it. Claims, cosmetic churn and repeated
test runs alone do not count. This is normal original-loop review, not an
additional approval stage or evidence protocol when the option is absent.

The threshold returns `blocked`, `stopCause:"no-progress"`, total `rounds`,
`progress:{noProgressRounds,limit,credited:[{id,evidence,round}]}`, unresolved
`feedback` and an actionable `nextAction`. The launcher preserves this evidence
and exits 2, even if the SDK envelope says completed. Dispatched work is joined
before the affected branch settles. Other authorized release work continues.
Stagnation detection relies on reviewer judgment, not a source
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
      {"id":"contract","title":"Agree interfaces and fixtures","kind":"developer","owner":"Developer","dependsOn":[],
       "estimatedMinutes":{"implementation":5,"review":3}},
      {"id":"api","title":"Implement API","kind":"developer","owner":"Developer","dependsOn":["contract"],
       "estimatedMinutes":{"implementation":20,"review":5}},
      {"id":"ui","title":"Implement UI against fixtures","kind":"ui","owner":"Developer","dependsOn":["contract"],
       "estimatedMinutes":{"implementation":15,"review":5}},
      {"id":"integrate","title":"Connect implementations and reconcile Git","kind":"developer","owner":"Developer","dependsOn":["api","ui"],
       "estimatedMinutes":{"integration":5,"review":3},"exclusiveResources":["integration-test-db"]},
      {"id":"deploy","title":"Deploy and verify","kind":"devops","owner":"DevOps Engineer","dependsOn":["integrate"]}
    ]
  }
}
```

Task/sprint ids are unique. Task kinds are ui/developer/designer/devops; assign
Developer/Developer/Designer/DevOps Engineer respectively. Dependencies must
exist and form an acyclic graph. Earlier implementation cannot depend on later
DevOps work; correct such a plan within SprintPlanLoop. Reviewer feedback can
request changed work without any new review type. Further sprint backlog uses
new sprint ids. Review/retro can replace accepted shared design/plan documents.

Optional task `estimatedMinutes` contains nonnegative finite `implementation`,
`review` and/or `integration` numbers. Ready assignments are ranked by their
own total plus the longest downstream path, including later DevOps estimates.
Missing estimates contribute zero; ties preserve plan order. Priorities are
nonpreemptive estimates, not deadlines, reservations of host capacity or gates.
Optional `exclusiveResources` is an array of unique nonempty names. Assignments
with matching names do not overlap, including review/rework; all their resources
are acquired together and released when the assignment settles. Resource waits
do not consume agent capacity. Other assignments continue when a branch blocks
or fails; descendants of unsuccessful work are not dispatched. Execution errors
are reported after independent dispatched work is joined.

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
Their execute tool is restricted by instructions to read-only Git inspection
and task-authorized byte hashing/structured-data parsing of explicitly supplied
evidence with built-in or standard-library tools. It does not authorize
repository script/test execution, code imports, credential access or writable
commands, and is not an OS-enforced sandbox.

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

`completed` means the source loops reached agreement, including their original
conditions, not that every reported test was PASS. Other application results
include `needs-input`, `limit-reached` and dependency `not-run`; errors remain
errors. Check the result as well as the SDK envelope.

This engine's SDK journals are distinct from retired `.delivery-runs` native
journals. Preserve historical runs; do not migrate or silently replay them.
Use supported SDK owner-session resume for new-engine runs, not a fabricated
terminal flag or a second workflow wrapping native continuation.
