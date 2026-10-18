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

Do-er report: `{status:"complete"|"rework"|"needs-input",summary:string,artifact:object}`.
An optional `nextAction` can identify the exact decision needed for human input.
Reviewer report: `{agree:boolean,feedback:string}`. No mandated empty findings,
file evidence lists, cryptographic bindings or native PASS receipt.

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
