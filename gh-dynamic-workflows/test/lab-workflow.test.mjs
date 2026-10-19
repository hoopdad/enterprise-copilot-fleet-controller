import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createLoopRunner, sprintTasks, releasePlan } from "../loop-workflow.mjs";
import { governanceResponse } from "./scope-governance.fixture.mjs";

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
            if (input.kind === "governance") return governanceResponse(input);
            if (input.kind === "reviewer") return {
                taskComplete: input.owner.status === "complete",
                unmetCriteria: input.owner.status === "complete" ? [] : ["The assigned handoff remains incomplete."],
                ...(await review?.(input) ?? { agree: true, feedback: "Reviewed; observation retained" }),
            };
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
test("agreed Architecture needs-replan is resolved internally before downstream planning", async () => {
    const f = fake({ tasks: [task("adapter")] });
    const agent = f.ctx.agent;
    let rounds = 0;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        if (input.kind === "doer" && input.loop.id === "ArchitectureLoop") {
            rounds++;
            if (rounds === 1) return { status: "needs-replan", summary: "Assign Hosted adapter implementation explicitly.",
                artifact: { Architecture: { missingOwner: "Hosted adapter" } } };
            assert.equal(input.feedback.owner.artifact.Architecture.missingOwner, "Hosted adapter");
            assert.equal(input.feedback.reviews.length, 3);
            assert.match(input.instructions.join("\n"), /resolve internal replanning in this existing owner loop/);
            return { ...result, artifact: { Architecture: { owner: "Developer", deliveryStage: "SprintPlanLoop" } } };
        }
        return result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    assert.equal(rounds, 2);
    assert.equal(result.documents.Architecture.owner, "Developer");
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment?.id === "adapter").length, 1);
    const count = f.calls.length;
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.equal(f.calls.length, count);
});

test("every stopped result is SDK JSON-safe without invented optional fields", async () => {
    const check = (value, location = "$") => {
        assert.notEqual(value, undefined, `nested undefined at ${location}`);
        if (value !== null && typeof value === "object") {
            for (const [key, item] of Object.entries(value)) check(item, `${location}.${key}`);
        }
    };
    for (const status of ["needs-input", "rework", "needs-replan"]) {
        const f = fake({ args: { attempts: { planning: 1 } } });
        const agent = f.ctx.agent;
        f.ctx.agent = async (prompt, options) => {
            const input = JSON.parse(prompt);
            const result = await agent(prompt, options);
            return input.kind === "doer" ? { ...result, status, summary: "Concrete unresolved criterion" } : result;
        };
        const result = await createLoopRunner()(f.ctx);
        assert.equal(result.status, status === "needs-input" ? status : "limit-reached");
        check(result);
        assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
        assert.ok(!Object.hasOwn(result, "reason") || typeof result.reason === "string");
        assert.ok(!Object.hasOwn(result, "limit") || result.limit === 1);
    }
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

test("ready work uses critical-path priority with bounded do-ers, and planning reviewers still run", async () => {
    const tasks = [
        { ...task("short"), estimatedMinutes: { implementation: 1 } },
        { ...task("critical"), estimatedMinutes: { implementation: 2, review: 1 } },
        { ...task("integration", "developer", ["critical"]), estimatedMinutes: { integration: 20 } },
    ];
    const f = fake({ tasks, args: { concurrency: { doers: 1, reviewers: 1 } } });
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    const work = f.calls.filter((call) => call.kind === "doer" && call.context.assignment);
    assert.equal(work[0].context.assignment.id, "critical");
    assert.equal(work[0].context.scheduling.criticalPathMinutes, 23);
    assert.equal(work.length, 3);
    assert.ok(f.calls.some((call) => call.kind === "reviewer" && call.loop.id === "SprintPlanLoop"));
});

test("scoped Architect/plan amendments replace only the affected assignment and release its resources", { timeout: 5000 }, async () => {
    const amended = Promise.withResolvers();
    const f = fake({
        args: { concurrency: { doers: 2, reviewers: 2 } },
        tasks: [{ ...task("research"), exclusiveResources: ["contract"] }, task("independent"), task("consumer", "developer", ["research"])],
        artifact: async (input, output) => {
            if (input.context.scopeRevision && input.loop.id === "SprintArchitectureLoop") {
                assert.ok(input.context.scopeRevision.request.feedback.governance.instructions.length);
                assert.ok(input.context.scopeRevision.request.governanceHistory.length);
                amended.resolve();
                return { SprintArchitecture: { disposition: "Bounded research may finish with unresolved live capability." } };
            }
            if (input.context.scopeRevision && input.loop.id === "SprintPlanLoop") {
                return { SprintPlan: { tasks: [{ ...task("research"), exclusiveResources: ["contract"],
                    doneWhen: "Deliver actionable unresolved findings.", exclusions: ["A working live adapter."],
                    handoff: "Capability findings and offline contract." }] } };
            }
            if (input.context.assignment?.id === "independent") await amended.promise;
            if (input.context.assignment?.id === "research" && input.context.inherited?.assignment) {
                return { research: { complete: true, liveReady: false } };
            }
            if (input.context.assignment?.id === "consumer") {
                assert.equal(input.context.dependencies[0].artifact.research.complete, true);
                assert.equal(input.context.dependencies[0].artifact.research.liveReady, false);
            }
            return output;
        },
    });
    const original = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await original(prompt, options);
        return input.kind === "doer" && input.context.assignment?.id === "research" && !input.context.inherited?.assignment
            ? { ...result, status: "needs-replan", summary: "Separate bounded research from live implementation." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment?.id === "independent").length, 1);
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment?.id === "research").length, 2);
    assert.ok(f.calls.some((call) => call.role === "Architect" && call.context.scopeRevision));
    assert.ok(f.calls.some((call) => call.role === "Scrum Master" && call.context.scopeRevision));
    assert.equal(new Set(f.calls.map((call) => call.options.label)).size, f.calls.length);
    const callsBeforeReplay = f.calls.length;
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.equal(f.calls.length, callsBeforeReplay);
});

test("review does not hold a do-er slot, reviewer capacity is independent, and resource locks include review", { timeout: 3000 }, async () => {
    const reviewing = Promise.withResolvers(), implemented = Promise.withResolvers();
    const started = new Set();
    const f = fake({
        args: { concurrency: { doers: 1, reviewers: 1 } },
        tasks: [
            { ...task("first"), exclusiveResources: ["shared-module"] },
            { ...task("conflicting"), exclusiveResources: ["shared-module"] },
            task("independent"),
        ],
        artifact: async (input, output) => {
            const id = input.context.assignment?.id;
            if (id) started.add(id);
            if (id === "independent") {
                await reviewing.promise;
                implemented.resolve();
            }
            return output;
        },
        review: async (input) => {
            if (input.context.assignment?.id === "first" && input.role === "Architect") {
                assert.ok(!started.has("conflicting"));
                reviewing.resolve();
                await implemented.promise;
            }
            return { agree: true, feedback: "" };
        },
    });
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.deepEqual([...started], ["first", "independent", "conflicting"]);
});

test("invalid scheduling options fail explicitly without changing the original task kinds", async () => {
    for (const extra of [
        { estimatedMinutes: null }, { estimatedMinutes: { implementation: -1 } },
        { estimatedMinutes: { review: "10" } }, { estimatedMinutes: { integration: Infinity } },
        { estimatedMinutes: { guessing: 10 } }, { exclusiveResources: "db" },
        { exclusiveResources: ["db", "db"] }, { exclusiveResources: [" db"] }, { exclusiveResources: [""] },
    ]) {
        assert.throws(() => sprintTasks({ SprintPlan: { tasks: [{ ...task("bad"), ...extra }] } }), /Task bad/);
    }
    const f = fake({ args: { concurrency: { doers: 0 } } });
    await assert.rejects(createLoopRunner()(f.ctx), /concurrency/);
    assert.equal(f.calls.length, 0);
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

test("stagnation settings reach planning and implementation, with per-assignment counters and original dependency stop reporting", async () => {
    const f = fake({
        args: { maxNoProgressRounds: 10 },
        tasks: [task("dependent", "ui", ["stalled"]), task("stalled"), task("productive")],
    });
    const original = f.ctx.agent;
    const rounds = new Map();
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await original(prompt, options);
        const id = input.context.assignment?.id;
        if (input.kind === "reviewer") {
            return { ...result, agree: id === "stalled" ? false : result.agree, verifiedProgress: [] };
        }
        if (input.kind === "governance") return result;
        rounds.set(id ?? input.loop.id, (rounds.get(id ?? input.loop.id) ?? 0) + 1);
        return { ...result, status: id === "stalled" ? "rework" : result.status, progress: [] };
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "blocked");
    assert.equal(result.stopCause, "no-progress");
    assert.equal(result.stoppedAt, "AssignedWorkDeveloperLoop");
    assert.match(result.stoppedKey, /task\/stalled/);
    assert.equal(result.rounds, 10);
    assert.equal(result.progress.noProgressRounds, 10);
    assert.equal(rounds.get("productive"), 1);
    assert.equal(rounds.get("dependent"), undefined);
    assert.equal(rounds.get("ArchitectureLoop"), 1);
    assert.ok(!f.calls.some((call) => call.loop.id === "DevOpsWorkLoop"));
    const count = f.calls.length;
    const { outcomes: replayedOutcomes, ...replayed } = await createLoopRunner()(f.ctx);
    const { outcomes, ...initial } = result;
    assert.deepEqual(replayed, initial);
    const byKey = (a, b) => a.key.localeCompare(b.key);
    assert.deepEqual(replayedOutcomes.toSorted(byKey), outcomes.toSorted(byKey));
    assert.equal(f.calls.length, count);
});

test("productive planning and implementation exceed ten rounds and six sprints with only a stagnation limit", async () => {
    const f = fake({
        args: { maxNoProgressRounds: 10 }, tasks: [task("productive")],
        artifact: (input, output) => input.loop.id === "ReleasePlanLoop"
            ? { ReleasePlan: { sprints: Array.from({ length: 7 }, (_, index) => ({ id: `s${index + 1}` })) } } : output,
    });
    const original = f.ctx.agent;
    const rounds = new Map();
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await original(prompt, options);
        const key = `${input.context.sprint?.id ?? "release"}/${input.loop.id}`;
        if (input.kind === "governance") return result;
        if (input.kind === "doer") {
            const round = (rounds.get(key) ?? 0) + 1;
            rounds.set(key, round);
            return { ...result, status: round >= 12 ? "complete" : "rework",
                progress: [{ id: `check-${round}`, evidence: `Newly verified milestone ${round}` }] };
        }
        return { ...result, agree: rounds.get(key) >= 12, verifiedProgress: input.owner.progress.map((item) => item.id) };
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    assert.equal(result.completedSprints.length, 7);
    assert.ok(result.outcomes.every((outcome) => outcome.rounds === 12));
    assert.ok(result.outcomes.every((outcome) => outcome.governanceHistory.length === 11));
    const later = f.calls.find((call) => call.kind === "doer" && call.loop.id === "UserExperienceLoop");
    assert.ok(later.context.outcomes[0].governance.instructions.length);
    assert.equal(Object.hasOwn(later.context.outcomes[0], "governanceHistory"), false);
});

test("release dispositions reach later first turns and replanned dispatch inherits current plan decisions before plan acceptance", async () => {
    const f = fake({ tasks: [task("consumer")], artifact: (input, output) => input.loop.id === "ReleasePlanLoop"
        ? { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } } : output });
    const original = f.ctx.agent;
    let architectureRound = 0, planRound = 0;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await original(prompt, options);
        if (input.kind === "doer" && input.loop.id === "ArchitectureLoop") architectureRound++;
        if (input.kind === "doer" && input.loop.id === "SprintPlanLoop" && input.context.sprint.id === "s1") planRound++;
        const release = input.loop.id === "ArchitectureLoop";
        const planning = input.loop.id === "SprintPlanLoop" && input.context.sprint?.id === "s1";
        if (input.kind === "reviewer" && input.role === "Critic" &&
            ((release && architectureRound === 1) || (planning && planRound === 1))) {
            return { ...result, agree: false, feedback: "Additional optional scope proposed." };
        }
        if (input.stage === "triage" && (release || planning)) return {
            summary: "Resolve optional expansion without changing original scope.", requiredCorrections: [],
            scopeQuestions: (release ? ["later", "declined"] : ["planned-extra"]).map((id) =>
                ({ id, request: `Optional enhancement ${id}`, evidence: "Not necessary for original acceptance." })),
        };
        if (input.stage === "scope-decision") return { decisions: input.triage.scopeQuestions.map((item) => ({
            id: item.id, disposition: item.id === "declined" ? "decline" : "defer",
            rationale: "Original user requirements do not need this.",
            action: "", acceptance: "", taskBoundary: release ? "Release-wide optional dashboard polish only."
                : "Optional consumer display redesign for s1 only.",
        })) };
        return result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    const ux = f.calls.filter((input) => input.loop.id === "UserExperienceLoop");
    assert.ok(ux.some((input) => input.kind === "doer"));
    assert.ok(ux.some((input) => input.kind === "reviewer"));
    for (const input of ux) {
        assert.deepEqual(input.priorDispositions.map((item) => item.disposition), ["defer", "decline"]);
        assert.equal(input.priorDispositions[0].origin.loopId, "ArchitectureLoop");
    }
    const revisedDispatch = f.calls.filter((input) => input.context.assignment && input.options.label.includes("/plan-round/2/"));
    assert.ok(revisedDispatch.some((input) => input.kind === "doer"));
    assert.ok(revisedDispatch.some((input) => input.kind === "reviewer"));
    for (const input of revisedDispatch) {
        assert.equal(input.priorDispositions.find((item) => item.id === "planned-extra").disposition, "defer");
        assert.equal(input.priorDispositions.find((item) => item.id === "planned-extra").origin.sprintId, "s1");
    }
    const laterSprint = f.calls.filter((input) => input.context.assignment && input.context.sprint.id === "s2");
    assert.ok(laterSprint.some((input) => input.kind === "doer"));
    assert.ok(laterSprint.some((input) => input.kind === "reviewer"));
    for (const input of laterSprint) {
        assert.equal(input.priorDispositions.find((item) => item.id === "declined").disposition, "decline");
        assert.equal(input.priorDispositions.find((item) => item.id === "planned-extra").taskBoundary,
            "Optional consumer display redesign for s1 only.");
    }
});
