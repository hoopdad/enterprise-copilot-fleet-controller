# YAML-loop input and authority contract

Required input: `{projectRoot:string}`. Supply a `specification` path, or
`{repository,path}` with `repositories:[{id,path,access,...}]`, or an `input`
goal/path. Other fields describe the actual user request, acceptance, allowed
commands, deployment/publication destinations and restrictions. They are context
for do-ers/reviewers, not a second engine-admission language.

Optional `workflowPath` selects an edited YAML file relative to projectRoot;
otherwise the installed `loops.yml` is used. Optional `agents.doer` and
`agents.reviewer` select ordinary agent profiles; the engine does not inspect
their exact tools or source. Defaults are `workflow-doer` and `workflow-reviewer`.
CLI permissions and project instructions remain authoritative.

Optional `maxSprints` and `attempts.planning` / `attempts.implementation` are
positive integers; per-loop-id attempt properties override category limits.
No defaults are inserted. Implementation covers UI/backend and DevOps work;
other original loops use planning. Each round includes its original reviewers.
There are no separate repair/recovery stages or their former budgets.
These attempt limits count every round, not just failures. Omit both `attempts`
and `maxSprints` to allow unlimited rounds and sprints.

Optional `maxNoProgressRounds` is a positive integer with no default. It stops
each original loop invocation/assignment after that many consecutive rounds
without new progress independently verified by all of its original reviewers.
Verified progress resets the counter even when completion is not yet agreed.
The existing completion/human-input conditions take precedence. Legacy total
round/sprint caps, if also supplied, remain independent limits.

Do-er report: `{status:"complete"|"rework"|"needs-input",summary:string,artifact:object}`.
An optional `nextAction` can identify the exact decision needed for human input.
Reviewer report: `{agree:boolean,feedback:string}`. No mandated empty findings,
file evidence lists, cryptographic bindings or native PASS receipt.

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
      {"id":"api","title":"Implement API","kind":"developer","owner":"Developer","dependsOn":[]},
      {"id":"ui","title":"Implement UI","kind":"ui","owner":"Developer","dependsOn":["api"]},
      {"id":"deploy","title":"Deploy and verify","kind":"devops","owner":"DevOps Engineer","dependsOn":["ui"]}
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

`completed` means the source loops reached agreement, including their original
conditions, not that every reported test was PASS. Other application results
include `needs-input`, `limit-reached` and dependency `not-run`; errors remain
errors. Check the result as well as the SDK envelope.

This engine's SDK journals are distinct from retired `.delivery-runs` native
journals. Preserve historical runs; do not migrate or silently replay them.
Use supported SDK owner-session resume for new-engine runs, not a fabricated
terminal flag or a second workflow wrapping native continuation.
