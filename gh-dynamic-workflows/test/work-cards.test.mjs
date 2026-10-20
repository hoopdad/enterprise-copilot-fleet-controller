import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { workCardSchema, validateWorkCard, validateTaskCards } from "../work-cards.mjs";
import { runLoop, ownerSchema, reviewerSchema } from "../lab-loops.mjs";
import { createLoopRunner, sprintTasks } from "../loop-workflow.mjs";
import { outcomeContext } from "../task-context.mjs";
import { definition, flattenLoops } from "../loop-source.mjs";

const card = (changes = {}) => ({
    role: "Developer", action: "Fix database-write access in QuestionAnswer API",
    goal: "Allow the API identity to save questions and answers.",
    components: ["QuestionAnswer API"], flows: ["Question-Answer"],
    flowSteps: ["API -> database: save question/answer"], doneWhen: "Both writes succeed.",
    failureCategories: ["Identity/access"], mustAct: "Developer", locations: ["infra\\access.tf"],
    evidence: "Write attempt returned permission denied.", cause: "Missing permission not yet identified.",
    verification: { status: "not-yet-verified", evidence: "" }, humanAction: "", humanActionEvidence: "",
    ...changes,
});

test("new response schemas require meaningful cards; legacy replay may omit them, malformed supplied cards fail", () => {
    for (const schema of [ownerSchema, reviewerSchema]) {
        assert.ok(schema.required.includes("workCard"));
        assert.equal(schema.properties.workCard, workCardSchema);
    }
    validateWorkCard(undefined, "legacy");
    validateWorkCard(card(), "owner");
    for (const change of [
        { action: " " }, { components: [7] }, { failureCategories: ["made-up"] },
        { verification: { status: "passed", evidence: "" } }, { humanAction: "Grant access." },
        { humanActionEvidence: "User-only action." }, { secret: "not part of a card" },
    ]) assert.throws(() => validateWorkCard(card(change), "test"), /Invalid workCard in test/);
    validateWorkCard(card({ verification: { status: "failed", evidence: "Write check returned 403." } }), "evidenced");
});

test("SprintPlan preserves component/flow metadata and rejects contradictory assignment cards", () => {
    const workCard = card();
    const task = { id: "api", title: workCard.action, kind: "developer", owner: "Developer",
        dependsOn: [], doneWhen: workCard.doneWhen, workCard };
    assert.deepEqual(sprintTasks({ SprintPlan: { tasks: [task] } })[0].workCard, workCard);
    for (const change of [{ title: "Different title" }, { owner: "Designer", kind: "designer" }, { doneWhen: "Different criterion" }]) {
        assert.throws(() => sprintTasks({ SprintPlan: { tasks: [{ ...task, ...change }] } }), /workCard must match/);
    }
    assert.equal(outcomeContext({ workCard, reviews: [{ role: "Critic", workCard }] }).workCard, workCard);
    assert.equal(outcomeContext({ reviews: [{ role: "Critic", workCard }] }).reviews[0].workCard, workCard);
    validateTaskCards([{ id: "api", workCard }], [task], "saved plan");
    validateTaskCards([{ id: "api", workCard: { ...workCard, verification: { evidence: "", status: "not-yet-verified" } } }],
        [task], "reordered JSON");
    validateTaskCards(undefined, [task], "legacy plan");
    assert.throws(() => validateTaskCards([], [task], "saved plan"), /report each planned assignment/);
    assert.throws(() => validateTaskCards([{ id: "api", workCard: card({ goal: "Wrong goal." }) }], [task], "saved plan"),
        /must match its resolved SprintPlan/);
});

test("architecture, planning, owners and original reviewers share names and evidence-aware card instructions", async () => {
    const loops = flattenLoops(definition.workflows.ReleaseLoop.steps);
    for (const id of ["ArchitectureLoop", "SprintArchitectureLoop", "SprintPlanLoop", "AssignedWorkDeveloperLoop"]) {
        const calls = [];
        const workCard = card();
        const ctx = {
            log() {}, step: async (_, fn) => fn(), parallel: (items) => Promise.all(items.map((fn) => fn())),
            agent: async (prompt, options) => {
                const input = JSON.parse(prompt);
                calls.push({ ...input, schema: options.schema });
                return input.kind === "doer" ? { status: "complete", summary: "Bounded work done.", artifact: {}, workCard }
                    : { agree: true, feedback: "Inspected work.", workCard: card({ role: input.role }) };
            },
        };
        const result = await runLoop({ ctx, loop: loops.find((loop) => loop.id === id), key: id, context: {} });
        assert.deepEqual(result.workCard, workCard);
        assert.equal(calls.filter((call) => call.kind === "reviewer").length,
            loops.find((loop) => loop.id === id).reviewers.length);
        for (const call of calls) {
            assert.match(call.instructions.join("\n"), /Permission denied/i);
            assert.match(call.instructions.join("\n"), /blocked alone never means the user must act/);
            assert.match(call.instructions.join("\n"), /not proof that a flow works/);
        }
        if (id.includes("Architecture")) assert.match(calls[0].instructions.join("\n"), /solutionModel.*implementationOf.*supports/);
        if (id === "SprintPlanLoop") assert.match(calls[0].instructions.join("\n"), /every SprintPlan task a workCard/);
    }
});

test("file-backed plans retain identical cards through actual dispatch, reviews and dependency handoffs", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "work-card-plan-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const planned = card({ evidence: "", cause: "", failureCategories: [] });
    const task = { id: "api", title: planned.action, kind: "developer", owner: planned.role,
        doneWhen: planned.doneWhen, dependsOn: [], workCard: planned };
    await writeFile(path.join(root, "plan.json"), JSON.stringify({ tasks: [task] }));
    const calls = [];
    const solutionModel = { components: [{ id: "api", name: "QuestionAnswer API", supports: [] }],
        flows: [{ id: "qa", name: "Question-Answer", trigger: "User submits a question.", steps: [] }] };
    const result = await createLoopRunner()({
        args: { projectRoot: root }, log() {}, phase() {},
        step: async (_, fn) => fn(), parallel: (items) => Promise.all(items.map((fn) => fn())),
        agent: async (prompt) => {
            const input = JSON.parse(prompt);
            calls.push(input);
            if (input.kind === "reviewer") return {
                agree: true, taskComplete: true, unmetCriteria: [], feedback: "Checks inspected.",
                workCard: card({ role: input.role }),
            };
            const artifact = input.loop.id === "ArchitectureLoop" ? { Architecture: { solutionModel } }
                : input.loop.id === "ReleasePlanLoop" ? { ReleasePlan: { sprints: [{ id: "s1" }] } }
                : input.loop.id === "SprintPlanLoop" ? { SprintPlan: { path: "plan.json" } } : {};
            return { status: "complete", summary: "Bounded deliverable complete.", artifact,
                workCard: card({ role: input.role }),
                ...(input.loop.id === "SprintPlanLoop" ? { taskCards: [{ id: task.id, workCard: planned }] } : {}) };
        },
    });
    assert.equal(result.status, "completed");
    const worker = calls.find((call) => call.kind === "doer" && call.context.assignment);
    assert.deepEqual(worker.context.assignment.workCard, planned);
    assert.deepEqual(worker.context.documents.Architecture.solutionModel, solutionModel);
    const plannerReview = calls.find((call) => call.kind === "reviewer" && call.loop.id === "SprintPlanLoop");
    assert.equal(plannerReview.dispatch.status, "dispatched");
    assert.deepEqual(plannerReview.owner.taskCards[0].workCard, planned);
    assert.deepEqual(result.outcomes.find((outcome) => outcome.loopId === "AssignedWorkDeveloperLoop").workCard,
        card({ role: "Developer" }));
});

test("feedback coordination records its own scoped card without adding an acceptance reviewer", async () => {
    const loop = flattenLoops(definition.workflows.ReleaseLoop.steps).find((item) => item.id === "ArchitectureLoop");
    let round = 0;
    const governanceCalls = [];
    const ctx = {
        log() {}, step: async (_, fn) => fn(), parallel: (items) => Promise.all(items.map((fn) => fn())),
        agent: async (prompt, options) => {
            const input = JSON.parse(prompt);
            if (input.kind === "governance") {
                governanceCalls.push(input);
                assert.ok(options.schema.required.includes("workCard"));
                return { summary: "Original correction remains.", requiredCorrections: [], scopeQuestions: [],
                    workCard: card({ role: "Scrum Master", action: "Reconcile Question-Answer access feedback" }) };
            }
            if (input.kind === "doer") return {
                status: ++round === 1 ? "rework" : "complete", summary: "Architecture finding.", artifact: {},
                workCard: card({ role: input.role }),
            };
            return { agree: true, feedback: "Accurate finding.", workCard: card({ role: input.role }) };
        },
    };
    const result = await runLoop({ ctx, loop, key: "feedback", context: {} });
    assert.equal(result.status, "agreed");
    assert.equal(governanceCalls.length, 1);
    assert.equal(result.governanceHistory[0].governance.triage.workCard.role, "Scrum Master");
    assert.deepEqual(result.reviews.map((review) => review.role), loop.reviewers);
});
