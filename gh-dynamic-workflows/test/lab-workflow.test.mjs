import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createLoopRunner, sprintTasks, releasePlan, ENGINE } from "../loop-workflow.mjs";
import { CORRECTION_CONTRACT, SECURITY_ROLE } from "../lab-loops.mjs";
import { definition, flattenLoops } from "../loop-source.mjs";
import { owner, review, project, authorityProject, correction, assessCorrections, checks, skeletonChecks, task, skeleton, context } from "./evidence.fixture.mjs";

async function fake(t, { tasks = [skeleton(), task("api", "developer", ["skeleton"])], artifact, inspect, args = {}, withAuthority = false } = {}) {
    const root = await (withAuthority ? authorityProject(t) : project(t));
    const calls = [], phases = [], journal = new Map();
    const ctx = {
        ...context(async (input, options) => {
            calls.push({ ...input, options });
            const override = await inspect?.(input, options);
            if (override) return override;
            if (input.kind === "reviewer") return review();
            let output = {};
            if (input.loop.id === "ReleasePlanLoop") output = { ReleasePlan: { sprints: [{ id: "s1" }] } };
            if (input.loop.id === "SprintPlanLoop") output = { SprintPlan: { tasks } };
            return owner({ checks: input.context.assignment?.walkingSkeleton ? skeletonChecks("checks.log") : checks({ evidence: "checks.log" }),
                correctionAssessments: assessCorrections(input.feedback),
                artifact: await artifact?.(input, output) ?? output });
        }),
        runId: "synthetic-offline", args: { projectRoot: root, ...args },
        phase: (value) => phases.push(value),
        step: async (key, fn) => {
            if (!journal.has(key)) journal.set(key, await fn());
            return journal.get(key);
        },
    };
    return { ctx, root, calls, phases, journal };
}

test("first sprint starts with deployed azd skeleton; E2E/DevOps run after each accepted assignment and not as late stages", async (t) => {
    const f = await fake(t, { tasks: [skeleton(), task("ui", "ui", ["skeleton"]), task("api", "developer", ["ui"])] });
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    assert.deepEqual(f.calls.filter((call) => call.kind === "doer").map((call) => [call.loop.id, call.context.assignment?.id]), [
        ["ArchitectureLoop", undefined], ["UserExperienceLoop", undefined], ["ReleasePlanLoop", undefined],
        ["SprintDesignLoop", undefined], ["SprintArchitectureLoop", undefined], ["SprintPlanLoop", undefined],
        ["DevOpsWorkLoop", "skeleton"], ["DevOpsWorkLoop", undefined], ["EndToEndTestLoop", undefined],
        ["AssignedWorkUIDeveloperLoop", "ui"], ["DevOpsWorkLoop", undefined], ["EndToEndTestLoop", undefined],
        ["AssignedWorkDeveloperLoop", "api"], ["DevOpsWorkLoop", undefined], ["EndToEndTestLoop", undefined],
        ["SprintReviewLoop", undefined], ["SprintRetroLoop", undefined], ["ReleaseCloseoutLoop", undefined],
    ]);
    assert.equal(result.outcomes.filter((item) => item.key.includes("/continuous/")).length, 6);
    assert.ok(result.outcomes.every((item) => item.checks.length && item.checks.every((check) => check.exitCode === 0)));
    const planning = f.calls.find((call) => call.kind === "reviewer" && call.loop.id === "SprintPlanLoop");
    assert.deepEqual(planning.dispatch.taskIds, ["skeleton", "ui", "api"]);
    assert.equal(planning.dispatch.deferredDevOps, undefined);
    assert.ok(!f.calls.some((call) => call.kind === "governance"));
    assert.ok(!JSON.stringify(result).includes("priorDispositions"));
});

test("deployment failure blocks dependents even when reviewers accept the accuracy of FAIL", async (t) => {
    const f = await fake(t, { args: { attempts: { EndToEndTestLoop: 1 } },
        inspect: (input) => input.kind === "doer" && input.loop.id === "EndToEndTestLoop"
            ? owner({ artifact: { EndToEndTest: { outcome: "FAIL" } }, checks: checks({ evidence: "checks.log", exitCode: 1 }) }) : undefined });
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "limit-reached");
    assert.equal(result.stoppedAt, "EndToEndTestLoop");
    assert.ok(!f.calls.some((call) => call.context.assignment?.id === "api"));
    assert.ok(!f.calls.some((call) => call.kind === "doer" && call.loop.id === "SprintReviewLoop"));
    assert.match(result.outcomes.find((item) => item.loopId === "EndToEndTestLoop").feedback.transportIssue, /failed/);
});

test("E2E verifies the latest DevOps deployment before dependent assignment starts", async (t) => {
    let deployedGeneration = 0, verifiedGeneration = 0;
    const f = await fake(t, { inspect: (input) => {
        if (input.kind !== "doer") return;
        if (input.context.continuousVerification && input.loop.id === "DevOpsWorkLoop") deployedGeneration++;
        if (input.context.continuousVerification && input.loop.id === "EndToEndTestLoop") {
            assert.ok(deployedGeneration > verifiedGeneration);
            verifiedGeneration = deployedGeneration;
        }
        if (input.context.assignment?.id === "api") {
            assert.equal(deployedGeneration, 1);
            assert.equal(verifiedGeneration, deployedGeneration);
        }
    } });
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.equal(deployedGeneration, 2);
    assert.equal(verifiedGeneration, deployedGeneration);
});

test("continuous checks require deployed environment, not local-only success", async (t) => {
    const f = await fake(t, { args: { attempts: { EndToEndTestLoop: 1, DevOpsWorkLoop: 1 } },
        inspect: (input) => input.kind === "doer" && input.context.continuousVerification
            ? owner({ checks: checks({ evidence: "checks.log", environment: "local" }) }) : undefined });
    const result = await createLoopRunner()(f.ctx);
    assert.notEqual(result.status, "completed");
    assert.match(result.outcomes.find((item) => item.status !== "agreed").feedback.transportIssue, /deployed/);
});

test("all task kinds share dependency scheduling with per-assignment deployed verification", async (t) => {
    const events = [];
    const f = await fake(t, {
        tasks: [skeleton(), task("infra", "devops", ["skeleton"]), task("design", "designer", ["skeleton"]), task("ui", "ui", ["infra"])],
        inspect: (input) => {
            if (input.kind === "doer") events.push([input.context.assignment?.id ?? input.context.acceptedAssignment?.id, input.loop.id]);
        },
    });
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    for (const id of ["skeleton", "infra", "design", "ui"]) {
        assert.deepEqual(events.filter(([taskId]) => taskId === id).slice(-2).map(([, loopId]) => loopId),
            ["DevOpsWorkLoop", "EndToEndTestLoop"]);
    }
    const ui = f.calls.find((call) => call.kind === "doer" && call.context.assignment?.id === "ui");
    assert.equal(ui.context.dependencies[0].status, "agreed");
    assert.ok(ui.context.dependencies[0].checks.some((check) => check.environment === "deployed"));
});

test("independent construction overlaps while deployment and E2E remain serialized through exact candidates", async (t) => {
    let startApi, releaseApi;
    const apiStarted = new Promise((resolve) => { startApi = resolve; });
    const apiReleased = new Promise((resolve) => { releaseApi = resolve; });
    let environmentOwner, overlap = false;
    const f = await fake(t, {
        tasks: [skeleton(), task("api", "developer", ["skeleton"]), task("ui", "ui", ["skeleton"])],
        inspect: async (input) => {
            if (input.kind !== "doer") return;
            const id = input.context.assignment?.id;
            if (id === "api") {
                startApi();
                await apiReleased;
                return owner({ artifact: { DeveloperWork: { commit: "a".repeat(40) } },
                    checks: checks({ evidence: "checks.log", environment: "local" }) });
            }
            if (id === "ui") {
                await apiStarted;
                overlap = true;
                releaseApi();
                return owner({ artifact: { UIWork: { commit: "b".repeat(40) } },
                    checks: checks({ evidence: "checks.log", environment: "local" }) });
            }
            if (input.context.continuousVerification) {
                const taskId = input.context.acceptedAssignment.id;
                if (input.loop.id === "DevOpsWorkLoop") {
                    assert.equal(environmentOwner, undefined);
                    environmentOwner = taskId;
                    if (taskId !== "skeleton") {
                        const artifact = input.context.candidate.artifact;
                        assert.ok((artifact.DeveloperWork ?? artifact.UIWork).commit);
                    }
                    await new Promise((resolve) => setTimeout(resolve, 2));
                } else {
                    assert.equal(environmentOwner, taskId);
                    environmentOwner = undefined;
                }
            }
        },
    });
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.equal(overlap, true);
    assert.equal(environmentOwner, undefined);
    for (const call of f.calls.filter((call) => call.kind === "reviewer" && call.context.deploymentManaged)) {
        assert.equal(call.owner.verification.length, 2);
        assert.ok(call.owner.checks.some((check) => check.environment === "deployed"));
    }
});

test("local construction never becomes accepted work when deployed verification fails", async (t) => {
    const f = await fake(t, { args: { attempts: { EndToEndTestLoop: 1 } },
        inspect: (input) => {
            if (input.kind !== "doer") return;
            if (input.context.assignment?.id === "api") {
                return owner({ checks: checks({ evidence: "checks.log", environment: "local" }) });
            }
            if (input.context.acceptedAssignment?.id === "api" && input.loop.id === "EndToEndTestLoop") {
                return owner({ checks: checks({ evidence: "checks.log", exitCode: 1 }) });
            }
        },
    });
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "limit-reached");
    assert.deepEqual(result.delivery.acceptedWork.map((item) => item.taskId), ["skeleton"]);
    assert.equal(result.delivery.remainingWork[0].task.id, "api");
    assert.equal(result.delivery.partialSprints[0].id, "s1");
});

test("localized blockers retain partial work and drain independent later sprints without exhaustion ceremonies", async (t) => {
    const f = await fake(t, {
        inspect: (input) => input.kind === "doer" && input.context.assignment?.id === "blocked"
            ? owner({ status: "needs-input", checks: [], summary: "Missing external credential", nextAction: "Supply credential" }) : undefined,
        artifact: (input, output) => input.loop.id === "ReleasePlanLoop"
            ? { ReleasePlan: { sprints: [{ id: "s1" }, { id: "dependent", dependsOn: ["s1"] }, { id: "independent" }] } }
            : input.loop.id === "SprintPlanLoop" ? { SprintPlan: { tasks: input.context.sprint.id === "s1"
                ? [skeleton(), task("blocked", "developer", ["skeleton"]), task("useful", "developer", ["skeleton"])]
                : [task("later")] } } : output,
    });
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.deepEqual(result.completedSprints, ["independent"]);
    assert.deepEqual(result.delivery.acceptedWork.map((item) => item.taskId).sort(), ["later", "skeleton", "useful"]);
    assert.deepEqual(result.delivery.pendingSprints.map((item) => item.id), ["dependent"]);
    assert.deepEqual(result.delivery.partialSprints, [{ id: "s1" }]);
    assert.equal(result.delivery.blockedWork[0].nextAction, "Supply credential");
    assert.ok(!f.calls.some((call) => call.context.continuation || call.kind === "governance"));
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.loop.id === "SprintArchitectureLoop").length, 2);
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment?.id === "blocked").length, 1);
    assert.ok(!f.calls.some((call) => call.loop.id === "ReleaseCloseoutLoop"));
});

test("partial sprints count against explicit caps and do not pull later work around them", async (t) => {
    const f = await fake(t, { args: { maxSprints: 1 },
        inspect: (input) => input.kind === "doer" && input.context.assignment?.id === "api"
            ? owner({ status: "needs-input", checks: [], summary: "Missing identity" }) : undefined,
        artifact: (input, output) => input.loop.id === "ReleasePlanLoop"
            ? { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } } : output,
    });
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "limit-reached");
    assert.deepEqual(result.delivery.partialSprints, [{ id: "s1" }]);
    assert.deepEqual(result.delivery.pendingSprints.map((item) => item.id), ["s2"]);
    assert.ok(!f.calls.some((call) => call.context.sprint?.id === "s2"));
});

test("execution errors remain errors after independent later work drains with a durable checkpoint", async (t) => {
    const f = await fake(t, {
        inspect: (input) => {
            if (input.kind === "doer" && input.context.assignment?.id === "api" && input.context.sprint.id === "s1") {
                throw new Error("Broken API tool");
            }
        },
        artifact: (input, output) => input.loop.id === "ReleasePlanLoop"
            ? { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } } : output,
    });
    await assert.rejects(createLoopRunner()(f.ctx), (error) => {
        assert.match(error.message, /api.*Broken API tool.*checkpoint:/);
        assert.deepEqual(error.delivery.completedSprints, ["s2"]);
        return true;
    });
});

test("explicit deployment resource declarations do not deadlock nested verification", { timeout: 5000 }, async (t) => {
    const f = await fake(t, { tasks: [skeleton(), {
        ...task("api", "developer", ["skeleton"]), exclusiveResources: ["workflow:deployed-environment"],
    }] });
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
});

test("sprint dependencies reject missing, duplicate and cyclic edges", () => {
    for (const sprints of [
        [{ id: "s1", dependsOn: ["missing"] }],
        [{ id: "s1", dependsOn: ["s1"] }],
        [{ id: "s1", dependsOn: ["s2", "s2"] }, { id: "s2" }],
        [{ id: "s1", dependsOn: ["s2"] }, { id: "s2", dependsOn: ["s1"] }],
    ]) assert.throws(() => releasePlan({ ReleasePlan: { sprints } }), /dependency|dependsOn/);
});

test("source uses targeted infrastructure security while preserving existing review positions", () => {
    const loops = flattenLoops(definition.workflows.ReleaseLoop.steps);
    assert.deepEqual(loops.filter((loop) => loop.reviewers?.includes(SECURITY_ROLE)).map((loop) => loop.id),
        ["ArchitectureLoop", "SprintArchitectureLoop", "SprintReviewLoop", "SprintRetroLoop"]);
    assert.ok(!loops.some((loop) => loop.reviewers?.includes("Red Team")));
    assert.match(definition.roles.find((role) => role.name === SECURITY_ROLE).description,
        /No broad adversarial campaigns or invented controls/);
});

test("old v2 assignment acceptance cannot bypass new verification through replay", async (t) => {
    for (const deliveryContract of [undefined, "old-delivery"]) {
        const f = await fake(t);
        const directory = path.join(f.root, "gh-dynamic-workflows", ".delivery-runs", f.ctx.runId);
        await mkdir(directory, { recursive: true });
        const marker = JSON.stringify({ engine: ENGINE, correctionContract: CORRECTION_CONTRACT,
            ...(deliveryContract ? { deliveryContract } : {}) });
        await writeFile(path.join(directory, "engine.json"), marker);
        f.journal.set(`${ENGINE}:sprint/1/s1/task/api/AssignedWorkDeveloperLoop`, {
            status: "agreed", artifact: { DeveloperWork: { unverified: true } },
        });
        await assert.rejects(createLoopRunner()(f.ctx), /older workflow engine or correction contract/);
        assert.equal(f.calls.length, 0);
        assert.equal(await readFile(path.join(directory, "engine.json"), "utf8"), marker);
    }
});

test("all independent blockers survive a JSON-safe incomplete checkpoint", async (t) => {
    const f = await fake(t, {
        tasks: [skeleton(), task("api", "developer", ["skeleton"]), task("ui", "ui", ["skeleton"])],
        inspect: (input) => input.kind === "doer" && ["api", "ui"].includes(input.context.assignment?.id)
            ? owner({ status: "needs-input", checks: [], summary: `Missing ${input.context.assignment.id} authority` }) : undefined,
    });
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.equal(result.delivery.blockedWork.length, 2);
    assert.deepEqual(result.delivery.remainingWork.map((item) => item.task.id), ["api", "ui"]);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("first-sprint metadata and transitive deployed-first dependencies are enforced, later sprints need no new skeleton", () => {
    const valid = [skeleton(), task("contract", "developer", ["skeleton"]), task("api", "developer", ["contract"])];
    assert.deepEqual(sprintTasks({ SprintPlan: { tasks: valid } }, { firstSprint: true }), valid);
    assert.doesNotThrow(() => sprintTasks({ SprintPlan: { tasks: [
        { ...skeleton(), doneWhen: "passes in deployed environment", handoff: "azd deployment URL" },
    ] } }, { firstSprint: true }));
    for (const tasks of [
        [], [task("api")], [task("api"), skeleton()], [{ ...skeleton(), dependsOn: ["api"] }, task("api")],
        [{ ...skeleton(), walkingSkeleton: false }], [{ ...skeleton(), owner: "Developer" }],
        [{ ...skeleton(), doneWhen: "Local tests pass" }], [{ ...skeleton(), handoff: "" }],
        [skeleton(), task("independent")], [skeleton(), { ...task("other", "devops", ["skeleton"]), walkingSkeleton: true }],
    ]) assert.throws(() => sprintTasks({ SprintPlan: { tasks } }, { firstSprint: true }), /walking|First sprint|assigned owner|doneWhen\/handoff/);
    assert.deepEqual(sprintTasks({ SprintPlan: { tasks: [task("later")] } }), [task("later")]);
    assert.doesNotThrow(() => sprintTasks({ SprintPlan: { tasks: [task("infra", "devops"), task("app", "developer", ["infra"])] } }));
});

test("invalid task graph, owner, resources, estimates and work criteria return concrete validation errors", () => {
    for (const tasks of [
        [task("a"), task("a")], [task("a", "developer", ["missing"])],
        [task("a", "developer", ["b"]), task("b", "developer", ["a"])],
        [{ ...task("a"), owner: "Invented" }], [{ ...task("a"), kind: "invented" }],
        [{ ...task("a"), exclusiveResources: ["same", "same"] }], [{ ...task("a"), exclusiveResources: [" spaced"] }],
        [{ ...task("a"), estimatedMinutes: { review: -1 } }], [{ ...task("a"), estimatedMinutes: { typo: 2 } }],
        [{ ...task("a"), doneWhen: "" }], [{ ...task("a"), exclusions: [42] }],
    ]) assert.throws(() => sprintTasks({ SprintPlan: { tasks } }));
    for (const plan of [{}, { sprints: [] }, { sprints: [{ id: "s" }, { id: "s" }] }]) assert.throws(() => releasePlan({ ReleasePlan: plan }));
});

test("task and sprint identifiers cannot collide with durable assignment or continuous-step key segments", () => {
    for (const id of ["api/continuous", "api\\continuous", "api:continuous", ".", "..", "api\ncontinuous", "api\u0000continuous", " api "]) {
        assert.throws(() => sprintTasks({ SprintPlan: { tasks: [
            task("api"), task(id, "devops", ["api"]),
        ] } }), /safe unique id/, JSON.stringify(id));
        assert.throws(() => releasePlan({ ReleasePlan: { sprints: [{ id }] } }), /safe unique string ids/, JSON.stringify(id));
    }
    assert.doesNotThrow(() => sprintTasks({ SprintPlan: { tasks: [
        task("api"), task("api-continuous", "devops", ["api"]),
    ] } }));
    assert.doesNotThrow(() => releasePlan({ ReleasePlan: { sprints: [{ id: "sprint-1.2" }] } }));
});

test("invalid first-sprint plan retries original owner before any assignment dispatch", async (t) => {
    let round = 0;
    const f = await fake(t, { artifact: (input, output) => {
        if (input.loop.id !== "SprintPlanLoop") return output;
        round++;
        if (round === 1) return { SprintPlan: { tasks: [task("unsafe")] } };
        assert.match(input.feedback.transportIssue, /First sprint/);
        return output;
    } });
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.equal(round, 2);
    assert.ok(!f.calls.some((call) => call.context.assignment?.id === "unsafe"));
});

test("file-backed plans dispatch before plan agreement without waiting for implementation completion", async (t) => {
    const f = await fake(t);
    const tasks = [skeleton(), ...Array.from({ length: 10 }, (_, index) => task(`task-${index}`, "developer", ["skeleton"]))];
    await writeFile(path.join(f.root, "plan.json"), JSON.stringify({ tasks }));
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        if (input.kind === "doer" && input.loop.id === "SprintPlanLoop") result.artifact = { SprintPlan: { path: "plan.json" } };
        if (input.kind === "reviewer" && input.loop.id === "SprintPlanLoop") {
            assert.equal(input.dispatch.status, "dispatched");
            assert.equal(input.dispatch.taskIds.length, 11);
        }
        return result;
    };
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment).length, 11);
});

test("plan retries join already dispatched work and use new assignment step keys", async (t) => {
    let planRound = 0;
    const f = await fake(t, {
        withAuthority: true,
        inspect: (input) => {
            if (input.kind === "doer" && input.loop.id === "SprintPlanLoop") {
                planRound++;
                if (planRound === 2) assert.ok(input.feedback.dispatchedWork.every((item) => item.status === "agreed"));
            }
            if (input.kind === "reviewer" && input.loop.id === "SprintPlanLoop") return review({
                checksValid: planRound > 1,
                findings: planRound === 1 && input.role === "Architect" ? [correction()] : [],
            });
        },
    });
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.equal(planRound, 2);
    assert.ok([...f.journal.keys()].some((key) => key.includes("/plan-round/2/")));
});

test("scoped replanning replaces only the affected assignment and retains DevOps eligibility", async (t) => {
    const f = await fake(t, {
        inspect: (input) => input.kind === "doer" && input.context.assignment?.id === "api"
            ? owner({ status: "needs-replan", checks: checks({ evidence: "checks.log" }), summary: "Need different deployed adapter" }) : undefined,
        artifact: (input, output) => input.loop.id === "SprintPlanLoop" && input.context.scopeRevision
            ? { SprintPlan: { tasks: [task("replacement", "devops")] } } : output,
    });
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment?.id === "skeleton").length, 1);
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment?.id === "replacement").length, 1);
    const amendment = f.calls.find((call) => call.kind === "doer" && call.context.scopeRevision);
    assert.equal(amendment.context.scopeRevision.assignment.id, "api");
    assert.equal(result.documents.SprintPlan.tasks[1].id, "api");
});

test("SDK replay preserves accepted evidence using new engine keys; legacy acceptance cannot bypass checks", async (t) => {
    const f = await fake(t);
    f.journal.set("yaml-loops-v1:ArchitectureLoop", { status: "agreed", artifact: { Architecture: { legacy: true } } });
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    const count = f.calls.length;
    assert.equal((await createLoopRunner()(f.ctx)).status, "completed");
    assert.equal(f.calls.length, count);
    assert.ok([...f.journal.keys()].some((key) => key.startsWith(`${ENGINE}:`)));
    assert.ok(f.calls.some((call) => call.kind === "doer" && call.loop.id === "ArchitectureLoop"));
});

test("older engines or v2 correction contracts require a new run without modifying history", async (t) => {
    for (const version of [undefined, "yaml-loops-v1", "yaml-loops-v2"]) {
        const f = await fake(t);
        const directory = path.join(f.root, "gh-dynamic-workflows", ".delivery-runs", f.ctx.runId);
        await mkdir(path.join(directory, "context"), { recursive: true });
        const audit = '{"status":"agreed","artifact":{"legacy":true}}\n';
        await writeFile(path.join(directory, "context", "old.json"), audit);
        if (version) await writeFile(path.join(directory, "engine.json"), JSON.stringify({ engine: version }) + "\n");
        await assert.rejects(createLoopRunner()(f.ctx), /older workflow engine.*new yaml-loops-v2 run/);
        assert.equal(await readFile(path.join(directory, "context", "old.json"), "utf8"), audit);
        if (version) assert.equal(JSON.parse(await readFile(path.join(directory, "engine.json"), "utf8")).engine, version);
        assert.equal(f.calls.length, 0);
    }
});

test("only explicit sprint caps stop additional planned work, and retrospective changes reach the next sprint", async (t) => {
    for (const maxSprints of [undefined, 2]) {
        const f = await fake(t, {
            args: { ...(maxSprints ? { maxSprints } : {}) },
            artifact: (input, output) => input.loop.id === "ReleasePlanLoop"
                ? { ReleasePlan: { sprints: Array.from({ length: 7 }, (_, index) => ({ id: `s${index + 1}` })) } }
                : input.loop.id === "SprintRetroLoop" ? { Retrospective: { learned: input.context.sprint.id } } : output,
        });
        const result = await createLoopRunner()(f.ctx);
        assert.equal(result.status, maxSprints ? "limit-reached" : "completed");
        assert.equal(result.completedSprints.length, maxSprints ?? 7);
        const second = f.calls.find((call) => call.kind === "doer" && call.context.sprint?.id === "s2");
        assert.equal(second.context.documents.Retrospective.learned, "s1");
    }
});

test("retired native history is not reinterpreted or modified", async (t) => {
    const f = await fake(t);
    const dir = path.join(f.root, ".delivery-runs", f.ctx.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "lab-state.json"), '{"retained":true}\n');
    await assert.rejects(createLoopRunner()(f.ctx), /retired native engine/);
    assert.equal(await readFile(path.join(dir, "lab-state.json"), "utf8"), '{"retained":true}\n');
    assert.equal(f.calls.length, 0);
});

test("dependency human-input failure reports original cause and never dispatches descendants", async (t) => {
    const f = await fake(t, { inspect: (input) => input.kind === "doer" && input.context.assignment?.id === "skeleton"
        ? owner({ status: "needs-input", checks: [], summary: "Missing deploy identity", nextAction: "Grant deployment access" }) : undefined });
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.equal(result.summary, "Missing deploy identity");
    assert.equal(result.nextAction, "Grant deployment access");
    assert.ok(!f.calls.some((call) => call.context.assignment?.id === "api"));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("failed assignment names its task and bounded stagnation propagates without acceptance", async (t) => {
    const f = await fake(t, { inspect: (input) => {
        if (input.kind === "doer" && input.context.assignment?.id === "api") throw new Error("API tool failure");
    } });
    await assert.rejects(createLoopRunner()(f.ctx), /api.*API tool failure/);
    const stagnant = await fake(t, { args: { maxNoProgressRounds: 2 },
        inspect: (input) => input.kind === "doer" && input.context.assignment?.id === "api"
            ? owner({ status: "rework", checks: checks({ evidence: "checks.log" }) }) : undefined });
    const stopped = await createLoopRunner()(stagnant.ctx);
    assert.equal(stopped.status, "blocked");
    assert.equal(stopped.stopCause, "no-progress");
    assert.equal(stopped.rounds, 2);
});

test("invalid runtime scheduling and root options fail before agents run", async (t) => {
    for (const args of [{ maxSprints: 0 }, { concurrency: { doers: 0 } }, { concurrency: { typo: 1 } }]) {
        const f = await fake(t, { args });
        await assert.rejects(createLoopRunner()(f.ctx));
        assert.equal(f.calls.length, 0);
    }
    await assert.rejects(createLoopRunner()({ args: {} }), /projectRoot/);
});
