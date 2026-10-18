# Original-loop execution design

`loops.yml` is the executable process source. Provenance:
`hoopdad/thought-connections:loops.yml`,
`503f3f8b487827014f30c3d23b8f14c86141ffa0`.

`loop-source.mjs` parses YAML without evaluating code and derives SDK metadata.
`loop-workflow.mjs` iterates the release/sprint hierarchy, schedules the assigned
task dependency graph and carries accepted artifacts forward. `lab-loops.mjs`
implements the repeated do-er followed by independent original reviewers.
Both workflow registration names use that same runner.

The 13 leaf loops are Architecture, User Experience, Release Plan, Sprint
Design, Sprint Architecture, Sprint Plan, UI Developer Work, Developer Work,
End-to-End Test, DevOps Work, Sprint Review, Sprint Retrospective and Release
Closeout. Sprint Loop is their source container, not another approval stage.
Exact owners, reviewers, descriptions and conditions remain in YAML.

Do-ers can edit and execute ordinary tools; reviewers independently inspect
work read-only. Named roles are passed with their source descriptions. There
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
Planning submits a dispatch-ready graph; the scheduler dispatches its original
work loops before planning reviewers verify actual assignment and dispatch.
Implementation need not finish for that planning agreement. The following
assigned-work steps join it. Before revising a rejected plan, already-dispatched
work is joined to avoid old/revised assignments racing; its results feed rework.
Saved JSON plan references and inline graphs use the same scheduler.

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
An agreed human-input blocker or reached user limit ends with an explicit
non-success result. Real project permissions, credentials, actual user approvals,
scientific data provenance and product acceptance requirements are not removed.
The shared `run.mjs` launcher keeps full CLI logs/results in unique ignored
directories and prints a short application outcome, stopped loop, reason and
next action. It reads the CLI's `workflow.result.data.run` envelope separately
from `--result-file` application data; SDK completion cannot hide a work stop.
