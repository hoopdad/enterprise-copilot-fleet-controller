# Work-conserving autonomous delivery

## Decision: continue construction when release completion is blocked

Accepted 2026-10-20 for both `lab-delivery` and `autonomous-delivery`.
This amends the original fail-fast release/sprint traversal, not the original
owners, reviewers, acceptance criteria, user authority or cloud-test condition.

**A blocked task reduces the executable work graph; it does not terminate the
autonomous session. Continue building and reviewing authorized, useful work
until that graph is exhausted.** A release-blocking condition is not necessarily
a construction blocker. Overnight capacity must not be lost merely because one
stream needs a user decision, permission, service capability or missing evidence.

The previous scheduler drained independent tasks in one SprintPlan, then the
runner returned on the first incomplete assignment/stage. That was within-plan
parallelism, not release-wide work conservation. Merely changing prompts or
adding another reviewer cannot repair that control-flow boundary.

## Guiding principles

1. **Use a walking skeleton, not a global skeleton gate.** Build a small useful
   end-to-end flow early. A blocked live step must not prevent independent
   components, other flows or contract-backed implementation from progressing.
2. **Plan a release-wide readiness graph.** Connect approved objectives and
   criteria to named components, flow steps, source files/modules, contracts,
   tasks and verification evidence. Source locations make missing construction
   concrete; file overlap alone creates neither a behavioral dependency nor a
   requirement to serialize all work.
3. **Dependencies name the smallest necessary handoff.** Distinguish construction
   from deployment and live verification. An accepted interface or fixture may
   suffice to build a consumer, but never establishes the real service works.
   Whole-sprint dependencies are appropriate only when the whole sprint truly
   must be accepted; otherwise use reviewed task-level handoffs.
4. **Localize blockers.** Retain the exact missing fact/authority, affected
   operations, components, flow steps, criteria, downstream tasks and unblock
   condition. Do not propagate one uncertain operation into a blanket stop.
5. **Replenish ready work.** Preserve accepted work; continue other approved
   sprints after their original planning reviews. Existing Architect and Scrum
   Master roles audit blocked work, split feasible construction from blocked
   verification, and pull forward independent approved release work. Product
   Owner review remains responsible for product scope. No speculative features
   or busywork are authorized by idle capacity.
6. **Recompute critical paths.** Favor work that unlocks downstream work, reduces
   integration uncertainty or shortens the remaining delivery path. Use
   available capacity on substantial independent branches while the earliest
   possible release date is constrained by an external dependency.
7. **Recover evidence before asking again.** Inspect authorized current input,
   applicable decisions, exact artifact/commit references and direct handoffs.
   A historical claim that evidence existed is not the evidence. Technical
   investigation and internal design decisions are not automatically user-only
   needs-input. Never bypass an actual tool denial.
8. **Resume only on changed conditions.** New accepted handoffs or concrete
   authoritative evidence can justify reassessing an exact blocked task/stage
   through its original owner and reviewers. Do not repeat unchanged denials,
   uncertain external effects, exhausted research or previously accepted work.
9. **Acceptance remains separate from utilization.** Preserve partial sprints
   and all unmet criteria. Do not mark a sprint/release complete merely because
   its report is accurate or its available work was exhausted. Distinguish
   implemented, locally verified, deployed and independently live-verified
   evidence; fixture checks are not live checks.
10. **Wait only after a work-exhaustion audit.** Establish that no task is ready
    or executing, no useful work can be split from blockers, no independent
    approved backlog work can be pulled forward, and no bounded investigation
    or integration correction can unlock progress. Persist an explicit
    incomplete/waiting checkpoint with exact unblock conditions. Do not poll
    unchanged conditions merely to keep a session alive.

Cancellation, genuine global safety/authority restrictions and explicit user
limits remain binding. Count entered sprints, including partial ones, against
an explicit sprint cap; pulling their work under a different label cannot evade
the cap. A capped invocation must not be retried under a fresh key to reset it.
Stagnation remains local to the affected invocation, not a reason to abandon
other feasible work.

## Runtime decision

The existing YAML loops remain the role/acceptance source. The runner retains
per-sprint stage and task outcomes, drains independent planned sprints, and
reuses SprintArchitectureLoop/SprintPlanLoop for reviewed continuation
amendments. Amendments are separate from the original SprintPlan, identify the
approved source sprint/criterion for new tasks, and keep actual DevOps execution
in its original later stage. Original work is rechecked only when a reviewed
continuation cites changed evidence and its necessary new handoffs are accepted.
Retain nested scoped replacement graphs too: reassess the actual blocked child
or scoped planning stage, not its superseded parent or accepted siblings.

A reviewed DevOps resume can cite the exact accepted original E2E prerequisite
from the runtime's `continuation.recheckable` list using `recheck:[key]` when
changed source makes its old evidence stale. This reopens only that same-sprint
E2E stage, after the required accepted handoffs, before the original blocked
DevOps stage. Both keep their original owners, reviewers and historical audits.
Incomplete E2E prevents DevOps execution; agreement on an accurate test failure
still grants no package/live acceptance. Other accepted work and effects stay
retained. Explicit-round, error and no-progress stops are not resumable through
a new key or a fresh continuation audit.

SDK durable steps and additive context audits retain work and deterministic
continuation keys for replay. They do not provide exactly-once external effects.
After exhaustion, the application result remains non-success, with accepted
work, partial/pending sprints, blockers and continuation-audit references. This
waiting checkpoint is not a claim that the SDK has paused a live connection.

## Studio and follow-on boundary

Studio should show what continues despite blockers, the affected components/
flows, accepted construction and remaining verification separately. A user
question should not gate unrelated work. Bidirectional questions/answers require
an explicitly enabled authenticated connection to the owning runtime; the
existing cross-session SQLite observer must remain read-only. This decision
does not authorize writing session databases or silently replaying stopped runs.

Measure time to first working flow, blocked time by cause, repeated blockers,
remaining critical-path work and user interruptions per delivered flow, rather
than cards or repeated reports completed.
