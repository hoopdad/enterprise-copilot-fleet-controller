# YAML do-er/reviewer delivery loops

`autonomous-delivery` and `lab-delivery` execute the same nested release/sprint
workflow from [loops.yml](loops.yml). The source is the root `loops.yml` in
`hoopdad/thought-connections`, revision
`503f3f8b487827014f30c3d23b8f14c86141ffa0`. YAML describes roles, work, artifacts,
reviewers and completion conditions; the SDK supplies agents and durable steps.
This is a Copilot Dynamic Workflow extension, not GitHub Actions.

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

Add authorized sibling context roots using repeated `--add-dir <path>`. This
uses the ordinary CLI `--allow-all-tools` permission, not blanket path/URL
bypasses. `--check-only` only reads configuration; it does not start a workflow
or impose a prerequisite review. Each launch saves unique, ignored logs, the
application result, and a concise `outcome.json` under
`gh-dynamic-workflows\.delivery-runs`. The terminal reports the actual stopped
loop, reason, unresolved reviewer feedback and next action. SDK `completed`
does not mean application success: application stops exit 2, runtime/CLI errors
exit 1, pause exits 3 and cancellation exits 130. Only application completion
exits 0. Full logs and Workflow Studio remain available during and after a run.

There is no engine-required initial toolchain, Azure bootstrap or deployment
adapter. The relevant do-er researches, writes and executes what the work needs,
within the user's actual permissions. Ordinary CLI tool/path/URL permissions and
real human-authority requirements still apply; these profiles are not a sandbox.

## Actual process

Architecture -> UX -> Release Plan -> repeat Sprint Design, Sprint Architecture,
Sprint Plan, assigned work, E2E, DevOps, Sprint Review and Retrospective ->
Release Closeout. Each loop uses exactly its YAML owner and reviewer set.
Review disagreement sends feedback back to that same do-er.

Independent assigned tasks run concurrently; a dependency waits for its own
do-er/reviewer agreement, not for unrelated slow tasks. Designer assignments reuse
the source Designer loop. DevOps assignments are carried into the original DevOps
loop after E2E rather than creating a new infrastructure or execution stage.
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
frozen-contract requirement is introduced, and the major YAML stages are unchanged.

Optional task `estimatedMinutes:{implementation,review,integration}` supplies
nonnegative estimates. Ready work is prioritized by its own total plus the
longest downstream path; missing estimates contribute zero and ties retain plan
order. Optional `exclusiveResources:["shared-module","test-db"]` prevents
matching assignments from overlapping, including review/rework. Dependencies
and resource waits consume no agent slots. Independent branches keep moving
when another blocks; errors are surfaced after dispatched independent work is
joined. File overlap alone creates neither a dependency nor an automatic lock.
There is no automatic worktree/service isolation.

Configure simultaneous agent calls explicitly, for example:

```json
{
  "projectRoot": ".",
  "concurrency": {"doers": 4, "reviewers": 2},
  "git": {"featureBranch": "feature/customer-work"}
}
```

Do-er slots are released before review; reviewers have their own capacity.
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

E2E can report an accurate actionable **FAIL** and receive agreement. DevOps
still requires agreement **and cloud-deployed tests passing**, because that is
in the original YAML. Reviewers judge whether those conditions were really met.
Agreement does not require an empty findings list or a prescribed evidence array.

The engine no longer has source fingerprints/freezes, script/dependency hashes,
workspace leases, execution tickets, native receipts, exact tool-profile checks,
bootstrap/discovery/publication/infrastructure/exact-plan/recovery review gates,
or a separate operator. A do-er can both edit and execute. Publication, research,
repair and deployment belong within the original work loops, when authorized.
There is no forced result-harvest sprint or clean/pushed-source admission gate.

## Transport and limits

Do-ers return `{status:"complete"|"rework"|"needs-input", summary, artifact}`.
Reviewers return `{agree:boolean, feedback:string}`. Artifacts use YAML output
names. `ReleasePlan.sprints` is an array with unique string `id`s;
`SprintPlan.tasks` contains `{id,title,kind,owner,dependsOn}`. Kinds are `ui`,
`developer`, `designer`, `devops`; their owners are Developer, Developer, Designer,
DevOps Engineer. Further backlog work gets a new sprint id. Scheduling-format
errors return to the same planning loop, not another approval gate.
Planning artifacts may instead provide a JSON document `path` relative to
`projectRoot`; the runner reads its `ReleasePlan`/`SprintPlan` object (or bare
plan) before validating and dispatching. Existing saved plans need not be
rewritten into a second inline-only format.

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
independent inspection. New IDs endorsed by all reviewers reset the counter
even when the loop still needs rework. Reusing an already credited ID or the
same evidence text (ignoring case/whitespace) never resets it. Changed summaries,
file churn, repeated tests, relabeled old work,
and unsupported progress claims do not qualify; reviewers compare against the
credited evidence and prior feedback. There is no new review stage or change
to YAML completion conditions.

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

SDK step/agent journals support replay of this engine's runs. They provide
best-effort at-least-once execution, not exactly-once side effects. Agents must
inspect uncertain real-world outcomes before repeating operations. Old native
`.delivery-runs` journals belong to the retired engine: preserve them as history,
do not resume/migrate them through this implementation. The terminal launcher
has no invented SDK-resume flag or `lab-delivery-resume` transport.

## Visualization and maintenance

[Workflow Studio](studio/README.md) provides source/design drafts, live agents
and phases, and historical results in one Copilot Canvas. Draft preview/export
does not alter source or control execution.

```powershell
npm --prefix .\gh-dynamic-workflows test
npm --prefix .\gh-dynamic-workflows\studio test
```

The original generated multi-repository fleet/MCP scaffolding is separate and
unchanged. See [LAB-DESIGN.md](LAB-DESIGN.md), [LAB-CONTRACT.md](LAB-CONTRACT.md)
and [RESEARCH.md](RESEARCH.md) for mapping, authority and platform distinctions.
