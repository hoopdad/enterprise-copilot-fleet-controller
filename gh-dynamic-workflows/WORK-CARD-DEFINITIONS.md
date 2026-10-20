# Solution components, flows, and work cards

These definitions were agreed with the user on 2026-10-20 while preparing
enhancements to the lab-deployment workflow and Workflow Studio work cards.
They are the reference for implementation and future revision. The workflow now
requests structured work cards and a named architecture model; Studio displays
the retained card metadata. Historical records without it retain their supported
legacy presentation rather than receiving invented context.

## Solution components

A **solution component** is a meaningful technical building block of the
solution. Examples include an HTML page, API endpoint, API server, agent,
database, Azure Storage Account, managed identity, role assignment, or
Terraform resource.

Component boundaries require architectural judgment. An ordinary prompt input
drawn using HTML or TypeScript is a detail of its page, not a separate solution
component. A custom input control can be a solution component.

Purpose-named logical components can have implementation children and related
supporting components. For example, **Question/Answer Storage** can have
Terraform resource children and supporting identity/access structures, including
a user-assigned managed identity (UAMI) and role assignments. A shared identity
or role assignment exists once and can link to multiple components.

Two Storage Accounts with different purposes receive distinct names in the
design. The flows using them provide additional context.

The **Architect establishes component and flow names** from requirements and
the solution design; downstream planners, workers, and reviewers reuse them.
The user does not need to supply or approve those names.

## Flows

A **flow** starts with a trigger: nothing is happening, then an event initiates
the behavior. It describes what happens through named solution components.

Example **Question-Answer flow**:

1. A user enters a question in the chat page and clicks Submit.
2. The browser sends the question to the API.
3. The question-answer microservice stores the question in the database.
4. The microservice calls the brilliant-singer agent to answer the question.
5. The microservice stores the answer in the database.
6. The answer is returned to the user.

Choose a useful level of detail rather than enumerating every low-level
operation. A tier will often have one or two main items, with supporting
details beneath them. Include persistence, agent calls, and the return path
when they belong to the behavior being described.

Personas come from input requirements when applicable. If no persona is named,
the Architect can name one as useful; a missing persona is not an error.
For example, **Sales colleague** can group the flows that persona uses.

## Assignment scope

A work card reflects the assignment's actual focus. It can concern a component,
a flow, a particular flow step, or several components and flows together.
Do not force every assignment into a single scope type.

Examples:

- A Developer builds the HTML page within the Question-Answer flow.
- An Architect designs the Question-Answer flow.
- An end-to-end tester verifies the Question-Answer flow.
- An end-to-end tester verifies all flows used by a Sales colleague.
- A Developer fixes database-write permissions in the QuestionAnswer API.

Keep **one card per assignment**, including cross-cutting assignments affecting
multiple components or flows. A broad heading such as
**End-to-end tester: Verify Sales colleague journeys** can list the specific
covered flows and expected behavior in its details.

## Card content

Lead with **responsible role: meaningful action or goal**, not an internal task
ID, loop name, or generic status.

Preferred heading:

> Developer: Fix database-write access in QuestionAnswer API

Avoid headings such as `RP-53 DevOps remains blocked` or
`Assigned Work Developer`, which do not explain the affected solution or work.

Show the following where relevant:

| Field | Meaning |
| --- | --- |
| Scope | Affected component(s), flow(s), and relevant flow step |
| State | Actual work state, such as needs revision or awaiting input |
| Failure category | The kind of problem, allowing multiple categories |
| Must act | The role responsible for the next action |
| Goal | The assigned action or intended result |
| Done when | Task-specific acceptance goal |
| Location | One file, or a meaningful common folder for several files |
| Evidence | What was observed, what is known, and what remains uncertain |
| Verification | What has actually been verified, or not yet verified |

If work spans many folders, omit the code location from the short card rather
than displaying an unhelpful broad folder or a long list. Keep exact locations
available in details. Technical task IDs, loop names, and other provenance also
remain available in details rather than leading the card.

Starting failure categories:

- Identity/access
- Network/connectivity
- Configuration
- Deployment/build
- Application logic
- UI/presentation
- Data
- Unknown

Distinguish **who found the issue** from **who must act**. A reviewer finding
a problem does not make the reviewer responsible for implementing its fix.

Show **Action required from you** only when evidence establishes that agents
cannot proceed without a user decision or an action reserved for the user.
A blocked task alone does not imply the user must act.

## Evidence and accuracy

Separate observed failures from confirmed or suspected causes. A
`permission denied` result does not identify the missing permission by itself;
say explicitly when that permission has not yet been identified.

Show **not yet verified** until verification evidence exists. Agent completion
and reviewer agreement do not establish that an end-to-end flow works.
The assigned acceptance goal describes what must become true, not what has
already been proven.

Do not invent names, diagnoses, verification, or human-action requirements
for historical work lacking that information.

## Agreed illustrative card

This is an example, not a diagnosis of an existing task.

**Developer: Fix database-write access in QuestionAnswer API**

| Field | Value |
| --- | --- |
| Scope | QuestionAnswer API; Question-Answer flow |
| Affected step | API -> database: save question/answer |
| State | Needs revision |
| Failure category | Identity/access |
| Must act | Developer |
| Goal | Allow the API identity to save questions and answers |
| Done when | The API identity can save both questions and answers |
| Location | `infra\` (if several relevant files are there) |
| Evidence | Write attempt returned permission denied; missing permission not yet identified |
| Verification | Not yet verified |

## Workflow implementation

This requires changes to workflow-produced information, not just replacement
display labels:

1. Architecture and sprint architecture establish reusable named components,
   implementation/support relationships, flows, steps, and applicable personas.
2. Planning binds assignments to that model and records meaningful goals and
   acceptance criteria. Workers and reviewers reuse the same names.
3. Work reports carry affected scope, responsibility, categorized failures,
   evidence, uncertainty, and verification through revisions and replanning.
4. Studio projects supported semantic fields and renders concise cards, retaining
   technical provenance in details without exposing arbitrary prompts or tools.

Implementation surfaces include `work-cards.mjs`, `lab-loops.mjs`,
`loop-workflow.mjs`, `task-context.mjs`, `scope-governance.mjs`,
`studio/usage.mjs`, `studio/observed.mjs`, and `studio/app.mjs`.
`work-cards.mjs` owns the report schema, runtime validation and shared
component/flow instructions; it is shipped by the workflow installer.
The original `loops.yml` stages and roles are unchanged.

New report schemas request cards for owners, reviewers and feedback
coordinators. Supplied cards are validated; legacy replay can omit them.
SprintPlan task metadata supplies context for pending work when its exact
planning invocation is available in observed records; final reports supersede
that planned context. New SprintPlan reports include a compact `taskCards`
projection even for file-backed plans; the runner checks it against the resolved
assignments before dispatch. File-only historical plans without retained task
metadata do not gain invented pending-card context.

Preserve existing workflow stages, reviewer sets, acceptance semantics,
authority, and exact evidence attribution. Framework source changes do not
automatically update an installed or active target workflow.
