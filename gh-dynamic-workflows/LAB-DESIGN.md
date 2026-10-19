# Original-loop execution design

`loops.yml` is the executable process source. Provenance:
`hoopdad/thought-connections:loops.yml`,
`503f3f8b487827014f30c3d23b8f14c86141ffa0`.

`loop-source.mjs` parses YAML without evaluating code and derives SDK metadata.
`loop-workflow.mjs` iterates the release/sprint hierarchy, schedules the assigned
task dependency graph and carries accepted artifacts forward. `lab-loops.mjs`
implements the repeated do-er followed by independent original reviewers.
Both workflow registration names use that same runner.
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
work is joined to avoid old/revised assignments racing; its results feed rework.
Saved JSON plan references and inline graphs use the same scheduler.

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
