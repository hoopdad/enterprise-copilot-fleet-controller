import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createLoopRunner, sprintTasks, releasePlan } from "../loop-workflow.mjs";

const task = (id, kind = "developer", dependsOn = []) => ({
    id, title: id, kind, owner: kind === "designer" ? "Designer" : kind === "devops" ? "DevOps Engineer" : "Developer", dependsOn,
});
function fake({ tasks = [], artifact, review, args = {} } = {}) {
    const calls = [], phases = [], journal = new Map();
    const ctx = {
        runId: "synthetic-offline", args: { projectRoot: process.cwd(), ...args },
        log() {}, phase: (title) => phases.push(title),
        parallel: (thunks) => Promise.all(thunks.map(async (fn) => {
            try { return await fn(); } catch { return null; }
        })),
        step: async (key, fn) => {
            if (!journal.has(key)) journal.set(key, await fn());
            return journal.get(key);
        },
        agent: async (prompt, options) => {
            const input = JSON.parse(prompt);
            calls.push({ ...input, options });
            if (input.kind === "reviewer") return review?.(input) ?? { agree: true, feedback: "Reviewed; observation retained" };
            let output = {};
            if (input.loop.id === "ReleasePlanLoop") output = { ReleasePlan: { sprints: [{ id: "s1" }] } };
            if (input.loop.id === "SprintPlanLoop") output = { SprintPlan: { tasks } };
            if (input.loop.id === "EndToEndTestLoop") output = { EndToEndTest: { outcome: "FAIL", feedback: "Accurate actionable failure" } };
            return { status: "complete", summary: "actual synthetic work", artifact: await artifact?.(input, output) ?? output };
        },
    };
    return { ctx, calls, phases, journal };
}
test("only source loops run; E2E FAIL can be agreed; DevOps retains its original condition", async () => {
    const f = fake({ tasks: [task("ui", "ui"), task("api")] });
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    assert.equal(result.documents.EndToEndTest.outcome, "FAIL");
    assert.deepEqual(f.calls.filter((call) => call.kind === "doer").map((call) => call.loop.id), [
        "ArchitectureLoop", "UserExperienceLoop", "ReleasePlanLoop", "SprintDesignLoop", "SprintArchitectureLoop",
        "SprintPlanLoop", "AssignedWorkUIDeveloperLoop", "AssignedWorkDeveloperLoop", "EndToEndTestLoop",
        "DevOpsWorkLoop", "SprintReviewLoop", "SprintRetroLoop", "ReleaseCloseoutLoop",
    ]);
    const devops = f.calls.find((call) => call.kind === "doer" && call.loop.id === "DevOpsWorkLoop");
    assert.match(devops.loop.completeWhen, /cloud-deployed system passes tests/);
    assert.ok(!f.phases.some((name) => /bootstrap|publication|discovery|recovery|exact.plan|reconciliation/i.test(name)));
    assert.ok(f.calls.filter((call) => call.context.assignment).every((call) => call.options.label.includes(call.loop.id)));
});
test("independent tasks overlap, dependent work starts after its own reviews, not a batch barrier", async () => {
    let releaseSlow, fastFinished = false;
    const slowWait = new Promise((resolve) => { releaseSlow = resolve; });
    const events = [];
    const f = fake({
        tasks: [task("slow"), task("fast"), task("after-fast", "ui", ["fast"]), task("design", "designer")],
        artifact: async (input, output) => {
            const id = input.context.assignment?.id;
            if (id) events.push(`start:${id}`);
            if (id === "slow") await slowWait;
            if (id === "after-fast") {
                assert.ok(fastFinished);
                assert.ok(!events.includes("end:slow"));
                releaseSlow();
            }
            if (id) events.push(`end:${id}`);
            return output;
        },
        review: (input) => {
            if (input.context.assignment?.id === "fast" && input.role === "Critic") fastFinished = true;
            return { agree: true, feedback: "" };
        },
    });

    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.ok(events.indexOf("start:fast") < events.indexOf("end:slow"));
    assert.ok(f.calls.some((call) => call.kind === "doer" && call.context.assignment?.id === "design" && call.loop.owner === "Designer"));
});

test("SprintPlan dispatches the saved eleven-task graph before planning agreement, without waiting for implementation", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yaml-sprint-dispatch-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const tasks = [
        task("package"), task("platform"), task("design", "designer"),
        task("contracts", "developer", ["package"]),
        task("corpus", "developer", ["contracts", "package"]),
        task("runtime", "developer", ["contracts", "package", "platform"]),
        task("paired", "developer", ["corpus", "runtime"]),
        task("collection", "developer", ["contracts", "package"]),
        task("terminal", "ui", ["contracts", "package", "design"]),
        task("integration", "ui", ["paired", "collection", "terminal"]),
        task("deployment", "devops", ["integration", "platform"]),
    ];
    await writeFile(path.join(root, "SprintPlan.json"), JSON.stringify({ SprintPlan: { tasks } }));
    const started = new Set();
    let releasePackage, planReviewed = false, packageFinished = false;
    const packageWait = new Promise((resolve) => { releasePackage = resolve; });
    const f = fake({
        args: { projectRoot: root, attempts: { planning: 3, implementation: 5 } },
        artifact: async (input, output) => {
            if (input.loop.id === "SprintPlanLoop") return { SprintPlan: { path: "SprintPlan.json", tasksPreserved: 11 } };
            const id = input.context.assignment?.id;
            if (id) started.add(id);
            if (id === "package") { await packageWait; packageFinished = true; }
            if (id === "contracts") assert.ok(packageFinished);
            if (input.loop.id === "DevOpsWorkLoop") {
                assert.ok(planReviewed);
                assert.ok(started.has("integration"));
            }
            return output;
        },
        review: (input) => {
            if (input.loop.id === "SprintPlanLoop") {
                assert.equal(input.dispatch.status, "dispatched");
                assert.equal(input.dispatch.taskIds.length, 10);
                assert.deepEqual(input.dispatch.deferredDevOps, ["deployment"]);
                assert.ok(["package", "platform", "design"].every((id) => started.has(id)));
                assert.equal(packageFinished, false);
                assert.equal(started.has("contracts"), false);
                assert.equal(input.owner.artifact.SprintPlan.tasks.length, 11);
                planReviewed = true;
                if (input.role === "Critic") releasePackage();
            }
            return { agree: true, feedback: "" };
        },
    });
    const agent = f.ctx.agent;
    f.ctx.agent = (prompt, options) => {
        const input = JSON.parse(prompt);
        if (input.kind === "doer" && input.loop.id === "SprintPlanLoop") {
            if (!input.instructions.some((instruction) => /orchestrator then dispatches/.test(instruction))) {
                return { status: "needs-input", summary: "Cannot dispatch before planning agreement.", artifact: {} };
            }
        }
        return agent(prompt, options);
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    assert.equal(started.size, 10);
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment).length, 10);
    assert.equal(result.outcomes.find((outcome) => outcome.loopId === "SprintPlanLoop").dispatch.status, "dispatched");
});

test("plan rework joins already-dispatched work before revising assignments and does not reuse a stale task step", async () => {
    let plans = 0, workReviews = 0, workOwners = 0;
    const f = fake({
        tasks: [task("revised")],
        artifact: (input, output) => {
            if (input.loop.id === "SprintPlanLoop") {
                plans++;
                if (plans === 2) {
                    assert.equal(workReviews, 1);
                    assert.equal(input.feedback.dispatchedWork[0].status, "agreed");
                }
            }
            if (input.context.assignment) workOwners++;
            return output;
        },
        review: (input) => {
            if (input.context.assignment && input.role === "Critic") workReviews++;
            return { agree: !(input.loop.id === "SprintPlanLoop" && plans === 1 && input.role === "Critic"), feedback: "Revise the plan" };
        },
    });
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.equal(plans, 2);
    assert.equal(workOwners, 2);
    assert.equal(workReviews, 2);
});
test("review backlog and retrospective document changes feed the next sprint without freezes", async () => {
    const f = fake({
        artifact: (input, output) => {
            if (input.loop.id === "SprintReviewLoop" && input.context.sprint.id === "s1") {
                return { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2", goal: "Review finding" }] } };
            }
            if (input.loop.id === "SprintRetroLoop") return { Architecture: { revisedByRetro: input.context.sprint.id } };
            if (input.loop.id === "SprintArchitectureLoop" && input.context.sprint.id === "s2") {
                assert.equal(input.context.documents.Architecture.revisedByRetro, "s1");
            }
            return output;
        },
    });
    const result = await createLoopRunner()(f.ctx);
    assert.deepEqual(result.completedSprints, ["s1", "s2"]);
    assert.equal(result.documents.Architecture.revisedByRetro, "s2");
});
test("bad scheduling output returns to the original planning loop, not another reviewer gate", async () => {
    let plans = 0;
    const f = fake({ artifact: (input, output) => {
        if (input.loop.id === "SprintPlanLoop" && ++plans === 1) return { SprintPlan: { tasks: [task("bad", "developer", ["missing"])] } };
        return output;
    } });
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.equal(plans, 2);
    assert.equal(f.calls.filter((call) => call.kind === "reviewer" && call.loop.id === "SprintPlanLoop").length, 6);
});
test("SDK journal replay reuses completed loop results, with no native ledger or source freeze", async () => {
    const f = fake();
    const runner = createLoopRunner();
    await runner(f.ctx);
    const count = f.calls.length;
    await runner(f.ctx);
    assert.equal(f.calls.length, count);
});
test("only explicit sprint caps stop additional planned work", async () => {
    const f = fake({
        args: { maxSprints: 1 },
        artifact: (input, output) => input.loop.id === "ReleasePlanLoop"
            ? { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } } : output,
    });
    assert.equal((await createLoopRunner()(f.ctx)).status, "limit-reached");
    assert.throws(() => sprintTasks({ SprintPlan: { tasks: [task("a", "ui", ["b"]), task("b", "developer", ["a"])] } }), /Circular/);
    assert.throws(() => releasePlan({ ReleasePlan: { sprints: [] } }), /sprints/);
    assert.throws(() => sprintTasks({ SprintPlan: { tasks: [{ id: "x", title: "x", kind: "constructor", dependsOn: [] }] } }), /Every task/);
    const invalid = fake({ args: { maxSprints: 0 } });
    await assert.rejects(createLoopRunner()(invalid.ctx), /positive integer/);
    assert.equal(invalid.calls.length, 0);
});

test("omitting a sprint cap allows more than six sprints", async () => {
    const f = fake({ artifact: (input, output) => input.loop.id === "ReleasePlanLoop"
        ? { ReleasePlan: { sprints: Array.from({ length: 7 }, (_, index) => ({ id: `s${index + 1}` })) } } : output });
    assert.equal((await createLoopRunner()(f.ctx)).completedSprints.length, 7);
});

test("retired native history is neither reinterpreted nor modified by SDK replay", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legacy-yaml-history-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = path.join(root, ".delivery-runs", "synthetic-offline");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "lab-state.json"), original = '{"retained":"history"}';
    await writeFile(file, original);
    const f = fake({ args: { projectRoot: root } });
    await assert.rejects(createLoopRunner()(f.ctx), /retired native engine/);
    assert.equal(f.calls.length, 0);
    assert.equal(await readFile(file, "utf8"), original);
});

test("dependency human-input failure reports its original cause, not an undefined or successful result", async () => {
    const f = fake({ tasks: [task("dependent", "ui", ["prerequisite"]), task("prerequisite")] });
    const original = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        if (input.kind === "doer" && input.context.assignment?.id === "prerequisite") {
            return { status: "needs-input", summary: "Actual user authority required", artifact: {} };
        }
        return original(prompt, options);
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.equal(result.summary, "Actual user authority required");
    assert.equal(result.stoppedAt, "AssignedWorkDeveloperLoop");
    assert.match(result.stoppedKey, /task\/prerequisite/);
    assert.equal(result.rounds, 1);
    assert.ok(!f.calls.some((call) => call.kind === "doer" && call.context.assignment?.id === "dependent"));
    assert.ok(!f.calls.some((call) => call.loop.id === "DevOpsWorkLoop"));
    assert.doesNotThrow(() => JSON.stringify(result));
});

test("a failed parallel assignment names its task instead of hiding which work failed", async () => {
    const f = fake({ tasks: [task("actual-failed-task")] });
    const original = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        if (input.kind === "doer" && input.context.assignment) throw new Error("Synthetic agent failure");
        return original(prompt, options);
    };
    await assert.rejects(createLoopRunner()(f.ctx), /Assigned work execution failed for actual-failed-task/);
});
