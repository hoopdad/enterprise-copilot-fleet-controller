# Original-loop execution design

`loops.yml` is the executable process source. Provenance:
`hoopdad/thought-connections:loops.yml`,
`503f3f8b487827014f30c3d23b8f14c86141ffa0`.

`loop-source.mjs` parses YAML without evaluating code and derives SDK metadata.
`loop-workflow.mjs` iterates the release/sprint hierarchy, schedules the assigned
task dependency graph and carries accepted artifacts forward. `lab-loops.mjs`
implements the repeated do-er followed by independent original reviewers.
Git-tracked `docs/requirements` files and regression tests form the durable
requirements-and-tests ledger. It replaces Scrum feedback triage, Architect advice
and Product Owner disposition ledgers; no runtime governance, dispositions or
`priorDispositions` are supplied. Accepted scope changes require a committed
requirements edit and regression test within existing user authority. Declined
proposals never enter the ledger. Historical audits remain available but are
not current authority or recursively recopied into later prompts.

Critic and Red Team findings block only with a specific `docs/requirements`
file:line or failing owner-emitted check. Unsupported findings are nonblocking
in schema and runtime even when raw `agree:false` accompanies them. Red Team
scope is infrastructure configuration and application-library CVEs; CVE findings
identify the CVE, library and affected version. Reviewers inspect evidence
read-only and use `checksValid` for check suitability and verification.
Findings discriminate `type:"blocking"|"observation"`; blocking findings carry
exactly one of `requirement:{path,line}` or `failingCheck`. Every finding requires
`summary` and `action`; requirement lines are positive integers and `failingCheck`
names an emitted check ID. Required Red Team scope is
`infrastructure-config` or `dependency-cve`.
Requirement citations resolve beneath `projectRoot/docs/requirements`, with
nonempty working-tree lines matching committed `HEAD` at the same path/line.
Symlink escapes and new/altered requirement anchors cannot establish blockers.
Fixed read-only Git arguments verify citations without evaluating emitted commands.
Both workflow registration names use that same runner. Its default shared writing
profile is `workflow-owner` (`agents.owner`, then legacy `agents.doer` overrides);
concrete YAML roles, stable doer kinds/labels and historical Studio remain intact.
Read-only reviews use the ordinary reviewer profile/tools.
`scheduling.mjs` owns the dependency-ready queue, longest-downstream estimates,
named assignment resources and separate do-er/reviewer agent capacity.

The 13 leaf loops are Architecture, User Experience, Release Plan, Sprint
Design, Sprint Architecture, Sprint Plan, UI Developer Work, Developer Work,
End-to-End Test, DevOps Work, Sprint Review, Sprint Retrospective and Release
Closeout. Sprint Loop is their source container, not another approval stage.
Exact owners, reviewers, descriptions and conditions remain in YAML.

Do-ers can edit and execute ordinary permission-bound tools; reviewers independently inspect
work without editing, including read-only Git commands through their execute
tool. That restriction is an instruction, not an OS sandbox. Named roles are
passed with their source descriptions. There
is no source/profile admission, native executor, ticket broker, workspace lease,
separate operator, frozen artifact/plan, or engine-managed receipt protocol.
Owners report required `checks` arrays of
`{id,kind,command,requirement,environment,exitCode,evidence}`. Kind is `test`,
`schema` or `deployed-probe`; environment is `local` or `deployed`. Each check's
`evidence` is a nonempty repository-relative log/result file path, not arbitrary
prose. The runtime verifies readability and repository confinement; reviewers
verify actual execution and credibility. Commands run by owners, not by an
unrestricted runtime executor. Complete reports require
nonempty passing checks; assigned work also requires a passing deployed check.
Reviewers validate suitability and actual results with `checksValid`, not
subjective `taskComplete` votes. Research and technical repair remain in the loops.
Reviewer reports require `checksValid`, `findings`, `feedback` and `workCard`,
not `agree`.

SprintPlan assignments have a machine-readable dependency graph so independent
UI/backend/design/DevOps work fans out through one scheduler. Sprint 1 starts
with a dependency-free DevOps assignment marked `walkingSkeleton:true`, using
`azd` to deploy a minimal application; all other assignments depend on it
transitively. After every assignment, the existing DevOps loop deploys/verifies
the increment, then E2E tests the latest deployment. Both must pass before
dependents start, rather than running as late-only stages.
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
work is joined before plan rework to avoid old/revised assignments racing.
No agent slot spans a join or dependency/resource wait.
Saved JSON plan references and inline graphs use the same scheduler.

Task doneWhen/exclusions/handoff distinguish bounded research completion from
live capability, without waiving assigned deployed checks. Assigned reviewers
assess check suitability and verification. Agreed needs-replan releases task resources, reuses the
existing Sprint Architect and Scrum Master loops for a scoped replacement
graph, and joins its accepted handoffs into the original dependency. Already
accepted prerequisites are context; replacement dependencies stay internal.
Shared agent/resource queues cover replacements. Every assigned loop acquires
`workflow:deployed-environment` through assignment, DevOps and E2E verification,
serializing otherwise independent work against the shared environment.
Agent capacity remains separate from resource waits.
DevOps replacements share the graph and continuous checks. SDK replay
reuses scoped keys rather than redispatching accepted work.
Unassigned planning/release scope corrections feed back to the existing owner,
not terminal needs-replan or an added stage. Original later roles retain their
responsibilities. Stopped results omit absent optional fields for SDK JSON
compatibility; parallel reviewers never wait on one another's votes.
Unsupported scope demands do not force a replacement graph. Accepted changes
first update the committed requirements-and-tests ledger.

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
Accurate E2E failure reports are actionable feedback, not completion. The
continuous DevOps-then-E2E loops require passing deployed verification before
releasing dependents.

The engine identity is `yaml-loops-v2`. A run-version marker distinguishes
compatible runs; existing unversioned context history is rejected. Accepted
`yaml-loops-v1` journal steps cannot bypass new checks or replay as v2 acceptance;
preserve them as history and
start a new run after adoption. Results and rounds are journaled by SDK durable
steps. Compatible v2 replay preserves completed work, not exactly-once effects. An interruption
can leave an external operation uncertain; do-ers must inspect actual state and
report it honestly rather than repeat blindly. This is not an extra review gate.
Old engine native journals remain historical and are not replay-compatible.

Explicit user round/sprint limits are honored; unspecified limits remain absent.
An optional `maxNoProgressRounds` counts consecutive stalled rounds per loop/
assignment. Do-ers propose stable progress IDs with inspectable evidence; the
original check-adequacy reviewers independently verify them within their existing
review. Critic and Red Team cannot veto progress through observation-only
responses. Only new IDs verified by every check-adequacy reviewer reset the counter. The credited
evidence and prior feedback accompany later rounds to prevent repeated work
being relabeled as progress. At the threshold, dispatched work has been joined
and a `blocked`/`no-progress` result retains the counter and unresolved feedback.
Omit total round and sprint limits to allow unlimited productive work. This
opt-in safeguard does not change YAML agreement, introduce a review stage or
preempt an individual agent call; semantic progress remains reviewer-judged.
An agreed human-input blocker, stagnation stop or reached user limit ends with an explicit
non-success result. Missing credentials or user-only approval requires `needs-input`.
Real project permissions, credentials, actual user approvals,
scientific data provenance and product acceptance requirements are not removed.
The shared `run.mjs` launcher keeps full CLI logs/results in unique ignored
directories and prints a short application outcome, stopped loop, reason and
next action. It reads the CLI's `workflow.result.data.run` envelope separately
from `--result-file` application data; SDK completion cannot hide a work stop.
