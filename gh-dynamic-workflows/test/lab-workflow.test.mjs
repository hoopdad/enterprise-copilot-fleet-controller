import test, { after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createLoopRunner, sprintTasks, releasePlan } from "../loop-workflow.mjs";
import { governanceResponse } from "./scope-governance.fixture.mjs";
import { mkdtempSync } from "node:fs";

const temporaryRoots = [];
after(async () => {
    for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

const task = (id, kind = "developer", dependsOn = []) => ({
    id, title: id, kind, owner: kind === "designer" ? "Designer" : kind === "devops" ? "DevOps Engineer" : "Developer", dependsOn,
});
function fake({ tasks = [], artifact, review, args = {} } = {}) {
    const calls = [], phases = [], journal = new Map();
    const root = mkdtempSync(path.join(os.tmpdir(), "yaml-loop-context-"));
    temporaryRoots.push(root);
    const ctx = {
        runId: "synthetic-offline", args: { projectRoot: root, ...args },
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
            if (input.loop.id === "SprintPlanLoop" && input.context.continuation) output = {
                SprintPlan: { tasks: [] },
                Continuation: { disposition: "exhausted", summary: "No feasible authorized work remains.",
                    evidence: ["Inspected ready work, blocker splits, independent release backlog and bounded unlocking investigation."], resumes: [] },
            };
            if (input.loop.id === "EndToEndTestLoop") output = { EndToEndTest: { outcome: "FAIL", feedback: "Accurate actionable failure" } };
            return { status: "complete", summary: "actual synthetic work", artifact: await artifact?.(input, output) ?? output };
        },
    };
    return { ctx, calls, phases, journal };
}
const retainedRevision = "b".repeat(40);
const originalRevision = "a".repeat(40);
function qualificationScenario({ failure, directSourceResume = false, documentOnlyResumes = 0,
    recheckSourceResume = false } = {}) {
    const f = fake({ tasks: [task("original-source"), task("unrelated-source")],
        args: { attempts: { implementation: 1, planning: 1 } } });
    const agent = f.ctx.agent;
    let devops = 0, qualifications = 0;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        if (failure === "error" && input.kind === "doer" && input.context.e2eQualification) {
            f.calls.push({ ...input, options });
            throw new Error("Synthetic E2E execution failure");
        }
        const result = await agent(prompt, options);
        if (input.kind === "reviewer" && input.context.e2eQualification && failure === "reviewer-incomplete") {
            return { ...result, taskComplete: false, unmetCriteria: ["Actual qualification is incomplete."] };
        }
        if (input.kind !== "doer") return result;
        if (input.loop.id === "ReleasePlanLoop") return { ...result,
            artifact: { ReleasePlan: { sprints: [{ id: "s1" }, { id: "independent" }] } } };
        if (input.context.assignment) return { ...result, artifact: { DeveloperWork: {
            commit: input.context.assignment.id === "maintenance" ? retainedRevision :
                input.context.assignment.id === "workflow-repair" ? "f".repeat(40) : originalRevision,
            taskComplete: true,
        } } };
        if (input.loop.id === "EndToEndTestLoop") {
            const awaitingDocumentRepair = input.context.e2eQualification && ++qualifications <= documentOnlyResumes;
            return { ...result,
                ...(input.context.e2eQualification && ["needs-input", "rework"].includes(failure) ? { status: failure } : {}),
                ...(awaitingDocumentRepair ? { status: "needs-replan" } : {}),
                artifact: { "FAIL with feedback": {
                    taskComplete: failure !== "needs-input",
                    testedRevision: input.context.e2eQualification
                        ? (failure === "wrong-subject" ? "f".repeat(40) : retainedRevision) : originalRevision,
                    feedback: "Offline synthetic evidence only; no installed acceptance.",
                } } };
        }
        if (input.loop.id === "DevOpsWorkLoop" && input.context.sprint.id === "s1") {
            if (++devops === 1) return { ...result, status: "needs-replan",
                summary: "Changed maintenance needs applicable original E2E." };
        }
        if (input.loop.id === "SprintPlanLoop" && input.context.continuation) {
            const c = input.context.continuation;
            if (c.round <= 2) {
                const id = c.round === 1 ? "maintenance" : "workflow-repair";
                return { ...result, artifact: {
                    SprintPlan: { tasks: [{ ...task(id), sourceSprintId: "s1", sourceCriterion: "Original source qualification." }] },
                    Continuation: { disposition: "continue", summary: "Accepted changed-source original E2E.",
                        evidence: ["Synthetic accepted maintenance and current DevOps requirement."],
                        resumes: c.round === 1 ? (directSourceResume ? [{
                            key: c.blocked.find((item) => item.loopId === "DevOpsWorkLoop").key,
                            after: ["maintenance"], evidence: "Exact newly accepted source requires original E2E.",
                        }] : []) : [{
                            key: c.blocked.find((item) => item.loopId === "DevOpsWorkLoop").key,
                            after: ["workflow-repair"], evidence: "Source and executable routing changed.",
                            e2eSubject: c.sourceSubjects.find((item) => item.key.includes("/task/maintenance/")).key,
                            ...(recheckSourceResume ? { recheck: [c.recheckable[0].key] } : {}),
                        }] },
                } };
            }
            if (c.round <= 2 + documentOnlyResumes) return { ...result, artifact: {
                SprintPlan: { tasks: [] },
                Continuation: { disposition: "continue", summary: "Accepted document-only correction.",
                    evidence: [`Synthetic reviewed document correction ${c.round}; protected source is unchanged.`],
                    resumes: [{ key: c.blocked.find((item) => item.loopId === "EndToEndTestLoop").key,
                        after: [], evidence: "The exact E2E document condition materially changed; retain its source subject." }] },
            } };
        }
        return result;
    };
    return { f, run: () => createLoopRunner()(f.ctx) };
}

test("retained-source qualification uses fresh durable E2E attempts and canonical outcomes before affected DevOps", async () => {
    const { f, run } = qualificationScenario();
    const result = await run();
    assert.equal(result.status, "completed");
    const e2es = result.outcomes.filter((item) => item.loopId === "EndToEndTestLoop" && item.sprintId === "s1");
    assert.equal(e2es.length, 2);
    assert.equal(e2es[0].key, e2es[1].key);
    assert.equal(e2es[1].key, "sprint/1/s1/EndToEndTestLoop");
    assert.equal(e2es[0].artifact["FAIL with feedback"].testedRevision, originalRevision);
    assert.equal(e2es[1].artifact["FAIL with feedback"].testedRevision, retainedRevision);
    const qualified = f.calls.filter((call) => call.context.e2eQualification);
    assert.deepEqual(qualified.map((call) => [call.kind, call.role]), [
        ["doer", "Developer"], ["reviewer", "Architect"], ["reviewer", "Critic"], ["reviewer", "Product Owner"],
    ]);
    for (const call of qualified) {
        assert.equal(call.loop.id, "EndToEndTestLoop");
        assert.match(call.options.label, /\/requalification\/2\/EndToEndTestLoop:/);
        assert.equal(call.context.documents.DeveloperWork.commit, retainedRevision);
        assert.equal(call.context.e2eQualification.subject.artifact.DeveloperWork.commit, retainedRevision);
        assert.equal(call.context.dependencies[0].taskId, "maintenance");
        assert.equal(call.context.dependencies[0].reviews.length, 2);
        assert.deepEqual(call.options.schema.required.includes("taskComplete"), call.kind === "reviewer");
    }
    const resumed = f.calls.findLastIndex((call) => call.kind === "doer" && call.loop.id === "DevOpsWorkLoop" &&
        call.context.sprint.id === "s1");
    assert.ok(qualified.every((call) => f.calls.indexOf(call) < resumed));
    const packet = f.calls[resumed].context.outcomes.filter((item) => item.key === e2es[0].key);
    assert.equal(packet.length, 2);
    assert.notEqual(packet[0].audit.path, packet[1].audit.path);
    const history = await Promise.all(packet.map((item) =>
        readFile(path.join(f.ctx.args.projectRoot, item.audit.path), "utf8")));
    assert.deepEqual(history.map((content) => JSON.parse(content)), e2es);
    for (const id of ["original-source", "unrelated-source", "maintenance", "workflow-repair"]) {
        assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment?.id === id).length,
            id.endsWith("source") ? 2 : 1);
    }
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.loop.id === "EndToEndTestLoop" &&
        call.context.sprint.id === "independent").length, 1);
    const count = f.calls.length, steps = [...f.journal.keys()];
    const replayed = await run();
    assert.equal(replayed.status, result.status);
    assert.deepEqual(replayed.delivery, result.delivery);
    assert.deepEqual(replayed.outcomes.filter((item) => item.loopId === "EndToEndTestLoop"), result.outcomes.filter((item) =>
        item.loopId === "EndToEndTestLoop"));
    assert.equal(f.calls.length, count);
    assert.deepEqual([...f.journal.keys()], steps);
    assert.ok(steps.includes("yaml-loops-v1:sprint/1/s1/EndToEndTestLoop"));
    assert.ok(steps.includes("yaml-loops-v1:sprint/1/s1/requalification/2/EndToEndTestLoop"));
    for (const [index, report] of packet.entries()) {
        assert.equal(await readFile(path.join(f.ctx.args.projectRoot, report.audit.path), "utf8"), history[index]);
    }
});

test("document-only exact E2E resume gives the retained-source reassessment a fresh durable identity", async () => {
    const { f, run } = qualificationScenario({ documentOnlyResumes: 1 });
    const result = await run();
    assert.equal(result.status, "completed");
    const semanticKey = "sprint/1/s1/EndToEndTestLoop";
    const qualified = f.calls.filter((call) => call.context.e2eQualification &&
        ["doer", "reviewer"].includes(call.kind));
    const owners = qualified.filter((call) => call.kind === "doer");
    assert.equal(owners.length, 2);
    for (const [index, prefix] of ["requalification/2", "requalification/2/resume/1"].entries()) {
        const attempt = qualified.filter((call) => call.options.label.includes(`/${prefix}/EndToEndTestLoop:`));
        assert.deepEqual(attempt.map((call) => [call.kind, call.role]), [
            ["doer", "Developer"], ["reviewer", "Architect"], ["reviewer", "Critic"], ["reviewer", "Product Owner"],
        ]);
        for (const call of attempt) {
            assert.equal(call.context.e2eQualification.semanticKey, semanticKey);
            assert.equal(call.context.e2eQualification.testedRevision, retainedRevision);
            assert.equal(call.context.documents.DeveloperWork.commit, retainedRevision);
            assert.equal(call.context.dependencies[0].taskId, "maintenance");
        }
        if (index) {
            assert.equal(owners[index].context.resume.previous.key, semanticKey);
            assert.equal(owners[index].context.resume.previous.status, "needs-replan");
            assert.deepEqual(owners[index].context.resume.handoffs, []);
            assert.deepEqual(owners[index].context.resume.plan.continuation.resumes.map((resume) => resume.after), [[]]);
            assert.equal(owners[index].context.resume.plan.continuation.resumes[0].e2eSubject, undefined);
        }
        assert.ok(f.journal.has(`yaml-loops-v1:sprint/1/s1/${prefix}/EndToEndTestLoop`));
    }
    const resumedDevops = f.calls.findLast((call) => call.kind === "doer" &&
        call.loop.id === "DevOpsWorkLoop" && call.context.sprint.id === "s1");
    assert.ok(qualified.every((call) => f.calls.indexOf(call) < f.calls.indexOf(resumedDevops)));
    const reports = resumedDevops.context.outcomes.filter((outcome) => outcome.key === semanticKey);
    assert.deepEqual(reports.map((outcome) => outcome.status), ["agreed", "needs-replan", "agreed"]);
    assert.equal(new Set(reports.map((outcome) => outcome.audit.path)).size, 3);
    const history = await Promise.all(reports.map((outcome) =>
        readFile(path.join(f.ctx.args.projectRoot, outcome.audit.path), "utf8")));
    for (const [index, report] of reports.entries()) {
        assert.equal(JSON.parse(history[index]).key, semanticKey);
        assert.equal(JSON.parse(history[index]).artifact["FAIL with feedback"].testedRevision,
            index ? retainedRevision : originalRevision);
    }
    for (const id of ["maintenance", "workflow-repair"]) {
        assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment?.id === id).length, 1);
    }
    const count = f.calls.length, steps = [...f.journal.keys()];
    const replayed = await run();
    assert.equal(replayed.status, result.status);
    assert.deepEqual(replayed.delivery, result.delivery);
    assert.deepEqual(replayed.outcomes.filter((item) => item.key === semanticKey),
        result.outcomes.filter((item) => item.key === semanticKey));
    assert.equal(f.calls.length, count);
    assert.deepEqual([...f.journal.keys()], steps);
    for (const [index, report] of reports.entries()) {
        assert.equal(await readFile(path.join(f.ctx.args.projectRoot, report.audit.path), "utf8"), history[index]);
    }
});

for (const failure of ["needs-input", "rework", "wrong-subject", "error", "reviewer-incomplete"]) {
    test(`qualified original E2E ${failure} never falls through to DevOps or renews a failed stage`, async () => {
        const { f, run } = qualificationScenario({ failure });
        if (failure === "error") await assert.rejects(run(), /Synthetic E2E execution failure/);
        else {
            const result = await run();
            assert.notEqual(result.status, "completed");
            assert.equal(result.completedSprints.includes("s1"), false);
        }
        assert.equal(f.calls.filter((call) => call.kind === "doer" &&
            call.loop.id === "DevOpsWorkLoop" && call.context.sprint.id === "s1").length, 1);
        assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.e2eQualification).length, 1);
    });
}

test("legacy after-only changed-source resumes requalify original E2E instead of reusing the old step", async () => {
    const { f, run } = qualificationScenario({ directSourceResume: true });
    assert.equal((await run()).status, "completed");
    const qualified = f.calls.filter((call) => call.kind === "doer" && call.context.e2eQualification);
    assert.equal(qualified.length, 1);
    assert.match(qualified[0].options.label, /\/requalification\/1\/EndToEndTestLoop:/);
    assert.equal(qualified[0].context.e2eQualification.testedRevision, retainedRevision);
    assert.equal(f.calls.filter((call) => call.kind === "doer" &&
        call.context.assignment?.id === "workflow-repair").length, 0);
});

test("an explicit prerequisite recheck can retain its exact changed-source qualification", async () => {
    const { f, run } = qualificationScenario({ recheckSourceResume: true });
    assert.equal((await run()).status, "completed");
    const qualified = f.calls.filter((call) => call.kind === "doer" && call.context.e2eQualification);
    assert.equal(qualified.length, 1);
    assert.match(qualified[0].options.label, /\/requalification\/2\/resume\/1\/EndToEndTestLoop:/);
    assert.equal(qualified[0].context.e2eQualification.testedRevision, retainedRevision);
    assert.equal(qualified[0].context.resume.kind, "prerequisite-recheck");
});

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

test("an agreed unassigned DevOps replan stops honestly without a blocked-owner retry loop or later-stage acceptance", { timeout: 5000 }, async () => {
    const f = fake();
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && input.loop.id === "DevOpsWorkLoop"
            ? { status: "needs-replan", summary: "A retained production prerequisite needs a concrete scope decision.",
                artifact: {}, nextAction: "Reconcile affected work through the original Architect and Scrum Master." }
            : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-replan");
    assert.equal(result.stoppedAt, "DevOpsWorkLoop");
    assert.equal(result.rounds, 1);
    assert.deepEqual(result.completedSprints, []);
    assert.equal(result.documents.EndToEndTest.outcome, "FAIL");
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.loop.id === "DevOpsWorkLoop").length, 1);
    assert.ok(!f.calls.some((call) => call.kind === "doer" && call.loop.id === "SprintReviewLoop"));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("final closeout input keeps all accepted construction and the exact release blocker without pretending a sprint failed", async () => {
    const f = fake({ tasks: [task("accepted")] });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && input.loop.id === "ReleaseCloseoutLoop"
            ? { ...result, status: "needs-input", summary: "The final user-only release decision is missing." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.deepEqual(result.completedSprints, ["s1"]);
    assert.deepEqual(result.delivery.partialSprints, []);
    assert.deepEqual(result.delivery.remainingWork, []);
    assert.equal(result.delivery.waitReason, "release-closeout");
    assert.equal(result.delivery.blockedWork.length, 1);
    assert.equal(result.delivery.blockedWork[0].key, "ReleaseCloseoutLoop");
    assert.ok(result.delivery.acceptedWork.some((work) => work.taskId === "accepted"));
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
                assert.equal(input.context.scopeRevision.request.governanceHistory, undefined);
                assert.ok(input.context.scopeRevision.request.feedback.governanceRounds);
                assert.ok(input.context.scopeRevision.audit.path);
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

for (const boundary of ["assignment", "architecture", "planning"]) {
    test(`continuation reassesses the exact scoped ${boundary} without rerunning accepted siblings or the superseded parent`, { timeout: 5000 }, async () => {
        const f = fake({
            args: { concurrency: { doers: 2, reviewers: 2 } },
            tasks: [{ ...task("parent"), exclusiveResources: ["contract"] }, task("independent"), task("consumer", "developer", ["parent"])],
            artifact: (input, output) => {
                if (input.loop.id === "ReleasePlanLoop") return { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } };
                if (input.loop.id === "SprintPlanLoop" && input.context.scopeRevision) return {
                    SprintPlan: { tasks: ["stable-child", "blocked-child"].map((id) => ({
                        ...task(id), exclusiveResources: ["contract"], doneWhen: `Complete the original ${id} contract.`,
                    })) },
                };
                if (input.loop.id === "SprintPlanLoop" && input.context.continuation?.round === 1) {
                    assert.equal(input.context.continuation.blocked.length, 1);
                    return { SprintPlan: { tasks: [] }, Continuation: {
                        disposition: "continue", summary: "New evidence unlocks only the exact scoped blocker.",
                        evidence: ["New authoritative contract/operation evidence was inspected."],
                        resumes: [{ key: input.context.continuation.blocked[0].key, after: [], evidence: "Verify the new observation." }],
                    } };
                }
                return output;
            },
        });
        const agent = f.ctx.agent;
        f.ctx.agent = async (prompt, options) => {
            const input = JSON.parse(prompt);
            const result = await agent(prompt, options);
            if (input.kind !== "doer" || input.context.sprint?.id !== "s1") return result;
            if (input.context.assignment?.id === "parent") return { ...result, status: "needs-replan",
                summary: "The parent requires a self-contained replacement contract graph." };
            const blocked = boundary === "assignment" ? input.context.assignment?.id === "blocked-child"
                : input.context.scopeRevision && input.loop.id === (boundary === "architecture" ? "SprintArchitectureLoop" : "SprintPlanLoop");
            return blocked && !input.context.resume ? { ...result, status: "needs-input", summary: "Specific scoped evidence is unavailable." } : result;
        };
        const result = await createLoopRunner()(f.ctx);
        assert.equal(result.status, "completed");
        assert.deepEqual(result.completedSprints, ["s2", "s1"]);
        const owners = f.calls.filter((call) => call.kind === "doer" && call.context.sprint?.id === "s1");
        for (const id of ["parent", "stable-child", "independent", "consumer"]) {
            assert.equal(owners.filter((call) => call.context.assignment?.id === id).length, 1, id);
        }
        assert.equal(owners.filter((call) => call.context.assignment?.id === "blocked-child").length, boundary === "assignment" ? 2 : 1);
        const resumed = owners.filter((call) => call.context.resume);
        assert.equal(resumed.length, 1);
        assert.equal(resumed[0].context.resume.previous.key, result.delivery.continuationAudits[0].continuation.resumes[0].key);
        const count = f.calls.length;
        assert.deepEqual((await createLoopRunner()(f.ctx)).delivery, result.delivery);
        assert.equal(f.calls.length, count);
    });
}

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
    const rootsStarted = Promise.withResolvers();
    let releasePackage, planReviewed = false, packageFinished = false;
    const packageWait = new Promise((resolve) => { releasePackage = resolve; });
    const f = fake({
        args: { projectRoot: root, attempts: { planning: 3, implementation: 5 } },
        artifact: async (input, output) => {
            if (input.loop.id === "SprintPlanLoop") return { SprintPlan: { path: "SprintPlan.json", tasksPreserved: 11 } };
            const id = input.context.assignment?.id;
            if (id) started.add(id);
            if (["package", "platform", "design"].every((name) => started.has(name))) rootsStarted.resolve();
            if (id === "package") { await packageWait; packageFinished = true; }
            if (id === "contracts") assert.ok(packageFinished);
            if (input.loop.id === "DevOpsWorkLoop") {
                assert.ok(planReviewed);
                assert.ok(started.has("integration"));
            }
            return output;
        },
        review: async (input) => {
            if (input.loop.id === "SprintPlanLoop") {
                await rootsStarted.promise;
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

test("a blocked classifier branch does not abandon the current independent task or a later approved sprint", async () => {
    const f = fake({ artifact: (input, output) => {
        if (input.loop.id === "ReleasePlanLoop") return { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } };
        if (input.loop.id === "SprintPlanLoop" && !input.context.continuation) return {
            SprintPlan: { tasks: input.context.sprint.id === "s1"
                ? [task("classifier"), task("classifier-consumer", "developer", ["classifier"]), task("independent-ui", "ui")]
                : [task("persistence")] },
        };
        return output;
    } });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && input.context.assignment?.id === "classifier"
            ? { ...result, status: "needs-input", summary: "Original classifier effect remains uncertain; no replay is authorized." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.deepEqual(result.completedSprints, ["s2"]);
    assert.equal(result.delivery.state, "waiting");
    assert.deepEqual(result.delivery.partialSprints.map((sprint) => sprint.id), ["s1"]);
    assert.ok(result.delivery.acceptedWork.some((work) => work.taskId === "independent-ui"));
    assert.ok(result.delivery.acceptedWork.some((work) => work.taskId === "persistence"));
    assert.ok(result.delivery.blockedWork.some((work) => work.taskId === "classifier"));
    const owners = f.calls.filter((call) => call.kind === "doer");
    assert.equal(owners.filter((call) => call.context.assignment?.id === "classifier").length, 1);
    assert.ok(!owners.some((call) => call.context.assignment?.id === "classifier-consumer"));
    assert.ok(!owners.some((call) => call.loop.id === "ReleaseCloseoutLoop"));
    assert.ok(!owners.some((call) => call.loop.id === "DevOpsWorkLoop" && call.context.sprint.id === "s1"));
    assert.ok(owners.some((call) => call.role === "Scrum Master" && call.context.continuation));
    const count = f.calls.length;
    const replayed = await createLoopRunner()(f.ctx);
    assert.deepEqual(replayed.delivery, result.delivery);
    assert.equal(f.calls.length, count);
});

test("blocked DevOps retains live acceptance while other approved sprint construction and reviews finish", async () => {
    const f = fake({ tasks: [task("source")], artifact: (input, output) =>
        input.loop.id === "ReleasePlanLoop" ? { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } } : output });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && input.loop.id === "DevOpsWorkLoop" && input.context.sprint.id === "s1"
            ? { ...result, status: "needs-input", summary: "Live operation requires actual permission." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.equal(result.stoppedAt, "DevOpsWorkLoop");
    assert.deepEqual(result.completedSprints, ["s2"]);
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.loop.id === "DevOpsWorkLoop" &&
        call.context.sprint.id === "s1").length, 1);
    assert.ok(!f.calls.some((call) => call.loop.id === "SprintReviewLoop" && call.context.sprint.id === "s1"));
});

test("continuation audits discover and build additional approved source work before waiting without accepting the blocker", async () => {
    const f = fake({ tasks: [task("live")], artifact: (input, output) => {
        if (input.loop.id === "SprintPlanLoop" && input.context.continuation?.round === 1) return {
            SprintPlan: { tasks: [{ ...task("offline-adapter"), sourceSprintId: "s1", sourceCriterion: "Build the approved adapter contract.",
                doneWhen: "Fixture-backed adapter and local error-path tests.", exclusions: ["Live registration."], handoff: "Adapter source and test evidence." }] },
            Continuation: { disposition: "continue", summary: "Live registration does not block adapter construction.",
                evidence: ["Approved adapter contract and source module inspection identify unfinished offline construction."], resumes: [] },
        };
        return output;
    } });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && input.context.assignment?.id === "live"
            ? { ...result, status: "needs-input", summary: "Permission is needed only for live registration." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.deepEqual(result.completedSprints, []);
    assert.ok(result.delivery.acceptedWork.some((work) => work.taskId === "offline-adapter"));
    assert.equal(result.delivery.continuationAudits.length, 2);
    assert.equal(result.delivery.continuationAudits.at(-1).continuation.disposition, "exhausted");
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment?.id === "live").length, 1);
    assert.ok(!f.calls.some((call) => call.loop.id === "ReleaseCloseoutLoop"));
    const count = f.calls.length;
    const replayed = await createLoopRunner()(f.ctx);
    assert.deepEqual(replayed.delivery, result.delivery);
    assert.equal(f.calls.length, count);
});

test("accepted continuation handoffs reassess only their exact blocker and unlock descendants without rerunning independent accepted work", async () => {
    const f = fake({
        tasks: [task("binding"), task("consumer", "developer", ["binding"]), task("independent")],
        artifact: (input, output) => {
            if (input.loop.id === "SprintPlanLoop" && input.context.continuation) return {
                SprintPlan: { tasks: [{ ...task("readback"), sourceSprintId: "s1", sourceCriterion: "Resolve original binding using supported readback." }] },
                Continuation: { disposition: "continue", summary: "Supported readback is now available.",
                    evidence: ["Inspected the original operation and a newly available supported readback source."],
                    resumes: [{ key: input.context.continuation.blocked.find((work) => work.taskId === "binding").key,
                        after: ["readback"], evidence: "The readback handoff will establish the original operation's actual outcome without replay." }] },
            };
            if (input.context.assignment?.id === "binding" && input.context.resume) {
                assert.equal(input.context.resume.previous.status, "needs-input");
                assert.equal(input.context.resume.handoffs[0].taskId, "readback");
            }
            return output;
        },
    });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && input.context.assignment?.id === "binding" && !input.context.resume
            ? { ...result, status: "needs-input", summary: "Original operation is uncertain." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.completedSprints, ["s1"]);
    const owners = f.calls.filter((call) => call.kind === "doer" && call.context.assignment);
    assert.equal(owners.filter((call) => call.context.assignment.id === "binding").length, 2);
    assert.equal(owners.filter((call) => call.context.assignment.id === "consumer").length, 1);
    assert.equal(owners.filter((call) => call.context.assignment.id === "independent").length, 1);
    assert.deepEqual(result.delivery.blockedWork, []);
    assert.ok(result.outcomes.some((work) => work.taskId === "binding" && work.status === "needs-input"));
    assert.ok(result.outcomes.some((work) => work.taskId === "binding" && work.status === "agreed" && /\/resume\/1\//.test(work.key)));
    const count = f.calls.length;
    const replayed = await createLoopRunner()(f.ctx);
    assert.deepEqual(replayed.delivery, result.delivery);
    assert.equal(f.calls.length, count);
});

test("an unrelated blocked continuation task does not prevent reassessment after the necessary handoff succeeds", async () => {
    const f = fake({ tasks: [task("original")], artifact: (input, output) => {
        if (input.loop.id === "SprintPlanLoop" && input.context.continuation?.round === 1) return {
            SprintPlan: { tasks: ["needed", "other-live"].map((id) =>
                ({ ...task(id), sourceSprintId: "s1", sourceCriterion: `Approved ${id} handoff.` })) },
            Continuation: { disposition: "continue", summary: "Two independent approved branches remain.",
                evidence: ["Only the needed contract is a prerequisite of the original source task."],
                resumes: [{ key: input.context.continuation.blocked[0].key, after: ["needed"], evidence: "Accepted contract unlocks source construction." }] },
        };
        return output;
    } });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && (input.context.assignment?.id === "other-live" ||
            input.context.assignment?.id === "original" && !input.context.resume)
            ? { ...result, status: "needs-input", summary: "Specific live evidence remains unavailable." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.ok(result.delivery.acceptedWork.some((work) => work.taskId === "original"));
    assert.ok(result.delivery.blockedWork.some((work) => work.taskId === "other-live"));
    assert.ok(!result.delivery.blockedWork.some((work) => work.taskId === "original"));
    assert.deepEqual(result.completedSprints, []);
});

for (const handoffAccepted of [true, false]) {
    for (const e2eReady of handoffAccepted ? [true, false] : [true]) {
        test(`changed-source E2E recheck preserves original stages: handoff=${handoffAccepted}, E2E=${e2eReady}`, async () => {
            const f = fake({ tasks: [task("accepted-source")], artifact: (input, output) => {
                if (input.loop.id === "SprintPlanLoop" && input.context.continuation?.round === 1) {
                    const { blocked, recheckable } = input.context.continuation;
                    assert.equal(recheckable.length, 1);
                    assert.equal(recheckable[0].loopId, "EndToEndTestLoop");
                    assert.equal(recheckable[0].status, "agreed");
                    assert.equal(recheckable[0].blockedKey, blocked[0].key);
                    return {
                        SprintPlan: { tasks: [{ ...task("discovery-fix"), sourceSprintId: "s1",
                            sourceCriterion: "Repair the original Linux discovery layout." }] },
                        Continuation: { disposition: "continue", summary: "Accepted source join needs original E2E again.",
                            evidence: ["The helper-layout correction invalidates the earlier integration evidence."],
                            resumes: [{ key: blocked[0].key, after: ["discovery-fix"],
                                recheck: [recheckable[0].key], evidence: "Verify the exact corrected source join before DevOps." }] },
                    };
                }
                if (input.loop.id === "EndToEndTestLoop") {
                    return { EndToEndTest: { outcome: "PASS", sourceJoin: input.context.resume ? "corrected" : "previous" } };
                }
                return output;
            } });
            const original = f.ctx.agent;
            f.ctx.agent = async (prompt, options) => {
                const input = JSON.parse(prompt);
                const result = await original(prompt, options);
                if (input.kind !== "doer") return result;
                if (input.context.assignment?.id === "discovery-fix" && !handoffAccepted) {
                    return { ...result, status: "needs-input", summary: "Correction handoff is incomplete." };
                }
                if (input.loop.id === "EndToEndTestLoop" && input.context.resume) {
                    assert.equal(input.context.resume.kind, "prerequisite-recheck");
                    assert.equal(input.context.resume.previous.loopId, "EndToEndTestLoop");
                    assert.equal(input.context.resume.previous.status, "agreed");
                    assert.equal(input.context.resume.blocked.loopId, "DevOpsWorkLoop");
                    assert.equal(input.context.resume.handoffs[0].taskId, "discovery-fix");
                    assert.match(input.instructions.join("\n"), /exact changed sources/);
                    if (!e2eReady) return { ...result, status: "needs-input", summary: "Exact-source integration cannot execute." };
                }
                if (input.loop.id === "DevOpsWorkLoop") {
                    if (!input.context.resume) return { ...result, status: "needs-replan",
                        summary: "Linux discovery exposed a source-join defect." };
                    assert.equal(input.context.documents.EndToEndTest.sourceJoin, "corrected");
                    assert.equal(input.context.resume.rechecks[0].loopId, "EndToEndTestLoop");
                    const reviews = f.calls.filter(call => call.kind === "reviewer" &&
                        call.loop.id === "EndToEndTestLoop" && call.context.resume);
                    assert.deepEqual(reviews.map(call => call.role).sort(), ["Architect", "Critic", "Product Owner"]);
                    assert.ok(reviews.every(call => call.context.resume.kind === "prerequisite-recheck"));
                    assert.match(input.loop.completeWhen, /cloud-deployed system passes tests/);
                }
                return result;
            };
            const result = await createLoopRunner()(f.ctx);
            assert.equal(result.status, handoffAccepted ? e2eReady ? "completed" : "needs-input" : "needs-replan");
            const owners = f.calls.filter(call => call.kind === "doer");
            assert.equal(owners.filter(call => call.context.assignment?.id === "accepted-source").length, 1);
            assert.equal(owners.filter(call => call.context.assignment?.id === "discovery-fix").length, 1);
            assert.equal(owners.filter(call => call.loop.id === "EndToEndTestLoop").length, handoffAccepted ? 2 : 1);
            assert.equal(owners.filter(call => call.loop.id === "DevOpsWorkLoop").length, handoffAccepted && e2eReady ? 2 : 1);
            assert.ok(result.outcomes.some(work => work.loopId === "EndToEndTestLoop" && work.status === "agreed" &&
                !work.key.includes("/resume/")));
            if (handoffAccepted) assert.ok(result.outcomes.some(work => work.loopId === "EndToEndTestLoop" &&
                /\/resume\/1\//.test(work.key)));
            if (!e2eReady) {
                assert.deepEqual(result.completedSprints, []);
                assert.ok(result.delivery.blockedWork.some(work => work.loopId === "EndToEndTestLoop"));
                assert.ok(!owners.some(call => call.loop.id === "SprintReviewLoop"));
            }
            const count = f.calls.length;
            assert.deepEqual((await createLoopRunner()(f.ctx)).delivery, result.delivery);
            assert.equal(f.calls.length, count);
        });
    }
}

test("no-progress DevOps cannot be resumed under a new key or offered an accepted E2E recheck", async () => {
    const f = fake({ args: { maxNoProgressRounds: 1 }, artifact: (input, output) => {
        if (input.context.continuation) {
            assert.deepEqual(input.context.continuation.recheckable, []);
            assert.equal(input.context.continuation.blocked[0].stopCause, "no-progress");
        }
        return output;
    } });
    const original = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await original(prompt, options);
        if (input.kind === "governance") return result;
        if (input.kind === "reviewer") return { ...result, verifiedProgress: [] };
        return { ...result, progress: [], ...(input.loop.id === "DevOpsWorkLoop"
            ? { status: "rework", summary: "No verified advance." } : {}) };
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "blocked");
    assert.equal(result.stopCause, "no-progress");
    assert.equal(result.rounds, 1);
    assert.equal(f.calls.filter(call => call.kind === "doer" && call.loop.id === "DevOpsWorkLoop").length, 1);
    assert.equal(f.calls.filter(call => call.kind === "doer" && call.loop.id === "EndToEndTestLoop").length, 1);
});

test("independent accepted work does not reopen a no-progress-capped continuation audit", async () => {
    const f = fake({ args: { maxNoProgressRounds: 1 }, artifact: (input, output) => {
        if (input.loop.id === "ReleasePlanLoop") return { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } };
        if (input.loop.id === "SprintPlanLoop" && input.context.continuation?.round === 1 &&
            input.context.sprint.id === "s2") return {
            SprintPlan: { tasks: [{ ...task("independent-fix"), sourceSprintId: "s2", sourceCriterion: "Original source repair." }] },
            Continuation: { disposition: "continue", summary: "Independent useful source work remains.",
                evidence: ["Inspected source."], resumes: [] },
        };
        return output;
    } });
    const original = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await original(prompt, options);
        if (input.kind === "governance") return result;
        if (input.kind === "reviewer") return { ...result, verifiedProgress: [] };
        return { ...result, progress: [],
            ...(input.loop.id === "DevOpsWorkLoop" ? { status: "needs-input", summary: "Original live prerequisite is missing." } : {}),
            ...(input.loop.id === "SprintPlanLoop" && input.context.continuation && input.context.sprint.id === "s1"
                ? { status: "rework", summary: "No executable continuation." } : {}),
        };
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "blocked");
    assert.equal(result.stopCause, "no-progress");
    assert.ok(result.delivery.acceptedWork.some(work => work.taskId === "independent-fix"));
    assert.equal(f.calls.filter(call => call.kind === "doer" && call.loop.id === "SprintPlanLoop" &&
        call.context.continuation && call.context.sprint.id === "s1").length, 1);
    assert.equal(result.delivery.continuationAudits.filter(work => work.sprintId === "s1").length, 1);
});

test("new evidence may trigger one reassessment but unchanged failed conditions do not create a retry/polling loop", async () => {
    const f = fake({ tasks: [task("uncertain")], artifact: (input, output) => {
        if (input.loop.id === "SprintPlanLoop" && input.context.continuation) return {
            SprintPlan: { tasks: [] },
            Continuation: { disposition: "continue", summary: "Assess newly published authoritative evidence.",
                evidence: ["New authoritative observation, not permission to replay the operation."],
                resumes: [{ key: input.context.continuation.blocked[0].key, after: [], evidence: "Inspect the new observation." }] },
        };
        return output;
    } });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && input.context.assignment?.id === "uncertain"
            ? { ...result, status: "needs-input", summary: "Observation is insufficient; original uncertainty remains." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.assignment?.id === "uncertain").length, 2);
    assert.equal(result.delivery.continuationAudits.length, 1);
});

test("partial sprints consume explicit sprint capacity and continuation cannot pull capped future sprints under another label", async () => {
    const f = fake({ args: { maxSprints: 1 }, tasks: [task("blocked")], artifact: (input, output) => {
        if (input.loop.id === "ReleasePlanLoop") return { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } };
        if (input.context.continuation) assert.deepEqual(input.context.continuation.availableSprints, ["s1"]);
        return output;
    } });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && input.context.assignment
            ? { ...result, status: "needs-input", summary: "User-only action." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "limit-reached");
    assert.equal(result.limit, 1);
    assert.deepEqual(result.completedSprints, []);
    assert.deepEqual(result.delivery.partialSprints.map((sprint) => sprint.id), ["s1"]);
    assert.deepEqual(result.delivery.pendingSprints.map((sprint) => sprint.id), ["s2"]);
    assert.ok(!f.calls.some((call) => call.context.sprint?.id === "s2"));
});

test("whole-sprint prerequisites remain binding while unrelated approved sprints continue", async () => {
    const f = fake({ tasks: [task("work")], artifact: (input, output) => {
        if (input.context.continuation) assert.deepEqual(input.context.continuation.availableSprints, ["s1", "independent"]);
        return input.loop.id === "ReleasePlanLoop"
            ? { ReleasePlan: { sprints: [{ id: "s1" }, { id: "dependent", dependsOn: ["s1"] }, { id: "independent" }] } } : output;
    } });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && input.context.assignment && input.context.sprint.id === "s1"
            ? { ...result, status: "needs-input", summary: "Missing actual prerequisite." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.deepEqual(result.completedSprints, ["independent"]);
    assert.deepEqual(result.delivery.pendingSprints, [{ id: "dependent", dependsOn: ["s1"] }]);
    assert.ok(!f.calls.some((call) => call.context.sprint?.id === "dependent"));
    assert.throws(() => releasePlan({ ReleasePlan: { sprints: [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }] } }), /Circular sprint/);
    assert.throws(() => releasePlan({ ReleasePlan: { sprints: [{ id: "a", dependsOn: ["missing"] }] } }), /dependsOn/);
});

test("branch execution errors remain explicit after independent later release work finishes", async () => {
    const f = fake({ tasks: [task("work")], artifact: (input, output) => input.loop.id === "ReleasePlanLoop"
        ? { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } } : output });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        if (input.kind === "doer" && input.context.assignment && input.context.sprint.id === "s1") {
            throw new Error("Malformed original response.");
        }
        return agent(prompt, options);
    };
    let checkpointPath;
    await assert.rejects(createLoopRunner()(f.ctx), (error) => {
        assert.match(error.message, /Assigned work execution failed for work.*Malformed original response/);
        assert.deepEqual(error.delivery.completedSprints, ["s2"]);
        assert.ok(error.delivery.blockedWork.some((work) => work.status === "error"));
        checkpointPath = error.message.match(/; checkpoint: (.+)$/)?.[1];
        assert.ok(checkpointPath);
        return true;
    });
    const checkpoint = JSON.parse(await readFile(path.join(f.ctx.args.projectRoot, checkpointPath), "utf8"));
    assert.equal(checkpoint.status, "error");
    assert.deepEqual(checkpoint.delivery.completedSprints, ["s2"]);
    assert.ok(checkpoint.failures.some((message) => message.includes("Malformed original response")));
});

test("earlier file-backed sprint audits survive later work and exact stage reassessment without rerunning accepted construction", async () => {
    const f = fake({ artifact: (input, output) => {
        if (input.loop.id === "ReleasePlanLoop") return { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } };
        if (input.loop.id === "SprintPlanLoop" && !input.context.continuation) {
            return { SprintPlan: { path: `${input.context.sprint.id}.json` } };
        }
        if (input.loop.id === "SprintPlanLoop" && input.context.continuation?.round === 1) return {
            SprintPlan: { tasks: [] }, Continuation: {
                disposition: "continue", summary: "A new authoritative readback permits reassessment.",
                evidence: ["Inspected the newly available deployed-system test evidence."],
                resumes: [{ key: input.context.continuation.blocked[0].key, after: [],
                    evidence: "Inspect the readback; do not blindly replay deployment." }],
            },
        };
        return output;
    } });
    for (const id of ["s1", "s2"]) await writeFile(path.join(f.ctx.args.projectRoot, `${id}.json`),
        JSON.stringify({ tasks: [task(`${id}-source`)] }));
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        if (input.kind === "doer" && input.context.assignment?.id === "s1-source") {
            return { ...result, summary: "ARCHIVED-ACCEPTED-REPORT ".repeat(5000) };
        }
        if (input.context.sprint?.id === "s2") {
            assert.doesNotMatch(JSON.stringify(input.context.delivery), /ARCHIVED-ACCEPTED-REPORT/);
        }
        return input.kind === "doer" && input.loop.id === "DevOpsWorkLoop" &&
            input.context.sprint.id === "s1" && !input.context.resume
            ? { ...result, status: "needs-input", summary: "Live system test readback is unavailable." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.completedSprints, ["s2", "s1"]);
    const resumed = f.calls.find((call) => call.kind === "doer" &&
        call.loop.id === "DevOpsWorkLoop" && call.context.resume);
    assert.ok(resumed.options.label.includes("/resume/1/DevOpsWorkLoop:"));
    assert.equal(resumed.context.documents.SprintPlan.path, "s1.json");
    const audit = resumed.context.documents.SprintPlan.audit;
    const original = JSON.parse(await readFile(path.join(f.ctx.args.projectRoot, audit.path), "utf8"));
    assert.equal(original.sprintId, "s1");
    assert.equal(original.loopId, "SprintPlanLoop");
    assert.ok(result.outcomes.some((work) => work.summary?.includes("ARCHIVED-ACCEPTED-REPORT")));
    for (const id of ["s1-source", "s2-source"]) assert.equal(f.calls.filter((call) =>
        call.kind === "doer" && call.context.assignment?.id === id).length, 1);
    const count = f.calls.length;
    assert.deepEqual((await createLoopRunner()(f.ctx)).delivery, result.delivery);
    assert.equal(f.calls.length, count);
});

test("capped continuation coordination is retained as a limit, not restarted or declared exhausted", async () => {
    const f = fake({ args: { attempts: { planning: 1 } }, tasks: [task("blocked")],
        artifact: (input, output) => input.loop.id === "ReleasePlanLoop"
            ? { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } } : output });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        if (input.kind !== "doer") return result;
        if (input.context.continuation) return { ...result, status: "rework", summary: "Continuation assessment is not yet complete." };
        return input.context.assignment && input.context.sprint.id === "s1"
            ? { ...result, status: "needs-input", summary: "Original authority is still missing." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "limit-reached");
    assert.equal(result.delivery.waitReason, "explicit-limit");
    assert.deepEqual(result.completedSprints, ["s2"]);
    assert.equal(result.delivery.continuationAudits.length, 1);
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.continuation).length, 1);
    assert.ok(result.delivery.blockedWork.some((work) => work.status === "limit-reached"));
});

test("an entered partial sprint cannot be silently removed from later release planning", async () => {
    const f = fake({ args: { attempts: { planning: 1 } }, tasks: [task("blocked")], artifact: (input, output) => {
        if (input.loop.id === "ReleasePlanLoop") return { ReleasePlan: { sprints: [{ id: "s1" }, { id: "s2" }] } };
        if (input.loop.id === "SprintRetroLoop" && input.context.sprint.id === "s2") {
            return { ReleasePlan: { sprints: [{ id: "s2" }] } };
        }
        return output;
    } });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        return input.kind === "doer" && input.context.assignment && input.context.sprint.id === "s1"
            ? { ...result, status: "needs-input", summary: "Missing scoped permission." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.deepEqual(result.documents.ReleasePlan.sprints.map((sprint) => sprint.id), ["s1", "s2"]);
    const retro = result.outcomes.find((work) => work.loopId === "SprintRetroLoop");
    assert.equal(retro.status, "limit-reached");
    assert.match(retro.reason, /preserve entered incomplete sprints/);
});

test("resumed planning preserves identical accepted and blocked assignments instead of relabeling their effects", async () => {
    let planningTurns = 0;
    const f = fake({ tasks: [task("accepted"), task("uncertain")], artifact: (input, output) => {
        if (input.loop.id === "SprintPlanLoop" && input.context.continuation?.round === 1) return {
            SprintPlan: { tasks: [] }, Continuation: {
                disposition: "continue", summary: "Clarification unlocks the planning stage only.",
                evidence: ["Authoritative clarification of the original plan."],
                resumes: [{ key: input.context.continuation.blocked.find((work) => work.loopId === "SprintPlanLoop").key,
                    after: [], evidence: "Plan scope is clarified; the uncertain external operation remains blocked." }],
            },
        };
        return output;
    } });
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        if (input.loop.id === "SprintPlanLoop" && !input.context.continuation && !input.context.resume) {
            if (input.kind === "doer") {
                planningTurns++;
                if (planningTurns === 2) return { ...result, status: "needs-input", summary: "Plan needs authoritative clarification." };
            }
            if (input.kind === "reviewer" && planningTurns === 1) return {
                ...result, agree: false, feedback: "Clarify the existing plan boundary.",
            };
        }
        return input.kind === "doer" && input.context.assignment?.id === "uncertain"
            ? { ...result, status: "needs-input", summary: "Do not repeat this uncertain external operation." } : result;
    };
    const result = await createLoopRunner()(f.ctx);
    assert.equal(result.status, "needs-input");
    assert.equal(result.delivery.blockedWork[0].taskId, "uncertain");
    assert.ok(f.calls.some((call) => call.kind === "doer" && call.loop.id === "SprintPlanLoop" &&
        call.options.label.includes("/resume/1/SprintPlanLoop:")));
    for (const id of ["accepted", "uncertain"]) assert.equal(f.calls.filter((call) =>
        call.kind === "doer" && call.context.assignment?.id === id).length, 1);
    assert.ok(!f.calls.some((call) => call.loop.id === "DevOpsWorkLoop"));
});

test("cancellation during continuation propagates without starting a replacement audit or closeout", async () => {
    const controller = new AbortController();
    const reason = new Error("User cancelled while reviewing continuation.");
    const f = fake({ tasks: [task("blocked")] });
    f.ctx.signal = controller.signal;
    const agent = f.ctx.agent;
    f.ctx.agent = async (prompt, options) => {
        const input = JSON.parse(prompt);
        const result = await agent(prompt, options);
        if (input.kind === "doer" && input.context.continuation) {
            controller.abort(reason);
            throw reason;
        }
        return input.kind === "doer" && input.context.assignment
            ? { ...result, status: "needs-input", summary: "Specific authority is missing." } : result;
    };
    await assert.rejects(createLoopRunner()(f.ctx), (error) => error === reason);
    assert.equal(f.calls.filter((call) => call.kind === "doer" && call.context.continuation).length, 1);
    assert.ok(!f.calls.some((call) => call.loop.id === "ReleaseCloseoutLoop"));
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
    assert.ok(later.context.priorDispositions.length);
    assert.ok(later.context.outcomes[0].audit.path);
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
