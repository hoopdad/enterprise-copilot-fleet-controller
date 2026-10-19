# Original-loop execution design

`loops.yml` is the executable process source. Provenance:
`hoopdad/thought-connections:loops.yml`,
`503f3f8b487827014f30c3d23b8f14c86141ffa0`.

`loop-source.mjs` parses YAML without evaluating code and derives SDK metadata.
`loop-workflow.mjs` iterates the release/sprint hierarchy, schedules the assigned
task dependency graph and carries accepted artifacts forward. `lab-loops.mjs`
implements the repeated do-er followed by independent original reviewers.
`scope-governance.mjs` coordinates unresolved feedback: Scrum Master triage
on every retry, plus Architect advice then Product Owner decisions only when
scope is ambiguous. It validates structured responses and builds one actionable
instruction set plus nonblocking deferred/declined decisions. Decisions persist
across retries; raw owner/review/role evidence remains audit history, not competing
instructions. Both owner and original reviewers receive the same reconciliation,
even without a stagnation guard. Actual failures cannot be waived or requirements
rewritten. Acceptance and confirmed human input skip triage. This is requested
runtime coordination, the explicit exception to earlier no-added-gate prose;
no YAML stages or original owner/reviewer sets change.
Full audit history is retained in final outcomes, not recursively recopied into
every later loop's context. Later loops receive each outcome's latest reconciled
governance; the current loop still receives its own full round audit. This keeps
unlimited productive runs from amplifying prior audit evidence in every prompt.
`priorDispositions` projects bounded instructions from these existing outcomes
and scoped/inherited request feedback onto every invocation's first owner,
reviewer and governance turns. Plan dispatch also passes the current plan's
projection before its result is recorded. Provenance-qualified references,
origin task/sprint, source status and explicit acceptance/task boundaries prevent
short-ID collisions from waiving unrelated work; applicability remains role
judgment. Reconsidering an exact priorReference routes through Architect/PO,
including a Scrum-proposed required reclassification. Explicit supersession
references carry forward transitively. No separate registry/database or raw
audit fanout is introduced. Final hard-cap rounds skip unnecessary triage while
retaining raw feedback and normal once-per-round stagnation accounting; assigned
needs-replan still receives governance before routing.
Both workflow registration names use that same runner. Its default shared writing
profile is `workflow-owner` (`agents.owner`, then legacy `agents.doer` overrides);
concrete YAML roles, stable doer kinds/labels and historical Studio remain intact.
Read-only coordination uses the ordinary reviewer profile/tools.
`scheduling.mjs` owns the dependency-ready queue, longest-downstream estimates,
named assignment resources and separate do-er/reviewer agent capacity.

The 13 leaf loops are Architecture, User Experience, Release Plan, Sprint
Design, Sprint Architecture, Sprint Plan, UI Developer Work, Developer Work,
End-to-End Test, DevOps Work, Sprint Review, Sprint Retrospective and Release
Closeout. Sprint Loop is their source container, not another approval stage.
Exact owners, reviewers, descriptions and conditions remain in YAML.

Do-ers can edit and execute ordinary tools; reviewers independently inspect
work without editing, including read-only Git commands through their execute
tool. That restriction is an instruction, not an OS sandbox. Named roles are
passed with their source descriptions. There
is no source/profile admission, native executor, ticket broker, workspace lease,
separate operator, frozen artifact/plan, or engine-managed receipt protocol.
The only progression agreement is the agreement in the original loop.
Research and technical repair occur within those loops.

SprintPlan assignments have a machine-readable dependency graph so independent
UI/backend/design work fans out and dependants start when their own prerequisites
are reviewed. DevOps assignments are handled in the original later DevOps loop.
This validates scheduling data, not a new risk-policy review. No globally
disjoint-file rule is imposed; planning/reviewers decide whether work is genuinely
independent. Simultaneous tasks are labeled; SDK phase is set outside parallel
work because it is run-global.
The ready queue never starts dependency-waiting assignments. It ranks ready
work by rough implementation/review/integration minutes plus the longest
downstream path, with plan-order ties and no invented estimates. Optional
`concurrency.doers` and `concurrency.reviewers` independently limit agent calls,
not whole task loops, so review does not occupy do-er capacity. Named exclusive
resources are acquired atomically for an assignment, including review/rework;
resource waits consume no agent slots. Unrelated branches continue after an
unsuccessful assignment; errors are surfaced after dispatched work settles.
No capacity setting overrides host limits or inserts round/sprint ceilings.

Planning and original reviewers favor development by contract: accepted
interface/fixture handoffs unlock substantial parallel implementations, followed
by explicit integration tasks. Small refactorings are expected; file overlap is
not automatically a dependency, and no new proof or frozen-contract protocol is
introduced. Shared mutable editing/testing resources need matching declarations;
these are in-process scheduling controls, not worktrees or cross-run isolation.
Planning submits a dispatch-ready graph; the scheduler dispatches its original
work loops before planning reviewers verify actual assignment and dispatch.
Implementation need not finish for that planning agreement. The following
assigned-work steps join it. Before revising a rejected plan, already-dispatched
work is joined before governance or plan rework to avoid old/revised assignments
racing; its results feed the reconciliation. Each governance call individually
uses reviewer capacity; no agent slot spans a join or the coordination sequence.
Saved JSON plan references and inline graphs use the same scheduler.

Task doneWhen/exclusions/handoff distinguish bounded research completion from
live capability. Assigned reviewers separately assess report agreement and
task completion. After triage, agreed needs-replan releases task resources, reuses the
existing Sprint Architect and Scrum Master loops for a scoped replacement
graph, and joins its accepted handoffs into the original dependency. Already
accepted prerequisites are context; replacement dependencies stay internal.
Unrelated work continues. Shared agent/resource queues cover replacements and
only scoped planning do-er edits are serialized; no slot is held during review.
Major YAML stage order and later DevOps placement are unchanged. SDK replay
reuses scoped keys rather than redispatching accepted work.
Unassigned planning/release scope corrections feed back to the existing owner,
not terminal needs-replan or an added stage. Original later roles retain their
responsibilities. Stopped results omit absent optional fields for SDK JSON
compatibility; parallel reviewers never wait on one another's votes.
When the only scope demands are deferred/declined enhancements, retry the same
owner against original acceptance rather than forcing a replacement graph.

Every file-changing do-er turn commits owned changes before review; reviewers
inspect those commits with read-only Git commands. The Scrum Master remains the
existing planning do-er and sprint review/retro reviewer, assigning and auditing
Git reconciliation. Existing Product Owner turns perform needed merges/repairs.
Task commits reach the feature branch or stay on retained branches with the task,
commit IDs and abandonment reason in a feature-branch commit message. No code
is silently discarded and no new role, stage or native Git gate is added. The
scheduler does not run Git on the user's behalf or require a clean starting tree.

Sprint Review may append work to ReleasePlan. Retro may update Architecture,
UserExperience and ReleasePlan. Subsequent sprints use these accepted updates;
there is no initial-plan freeze or required separate asset-harvest sprint.
E2E agreement certifies accurate actionable outcomes, including FAIL. The
original DevOps condition still includes cloud-deployed tests passing.

Results and agreement rounds are journaled only by SDK durable steps. This
preserves completed work on SDK replay, not exactly-once effects. An interruption
can leave an external operation uncertain; do-ers must inspect actual state and
report it honestly rather than repeat blindly. This is not an extra review gate.
Old engine native journals remain historical and are not replay-compatible.

Explicit user round/sprint limits are honored; unspecified limits remain absent.
An optional `maxNoProgressRounds` counts consecutive stalled rounds per loop/
assignment. Do-ers propose stable progress IDs with inspectable evidence; the
original reviewers independently verify them within their existing review.
Only new IDs verified by every reviewer reset the counter. The credited
evidence and prior feedback accompany later rounds to prevent repeated work
being relabeled as progress. At the threshold, dispatched work has been joined
and a `blocked`/`no-progress` result retains the counter and unresolved feedback.
Omit total round and sprint limits to allow unlimited productive work. This
opt-in safeguard does not change YAML agreement, introduce a review stage or
preempt an individual agent call; semantic progress remains reviewer-judged.
An agreed human-input blocker, stagnation stop or reached user limit ends with an explicit
non-success result. Real project permissions, credentials, actual user approvals,
scientific data provenance and product acceptance requirements are not removed.
The shared `run.mjs` launcher keeps full CLI logs/results in unique ignored
directories and prints a short application outcome, stopped loop, reason and
next action. It reads the CLI's `workflow.result.data.run` envelope separately
from `--result-file` application data; SDK completion cannot hide a work stop.
