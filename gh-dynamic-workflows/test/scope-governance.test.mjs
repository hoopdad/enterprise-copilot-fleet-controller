import test from "node:test";
import assert from "node:assert/strict";
import { runLoop } from "../lab-loops.mjs";
import { definition, flattenLoops, workflowMetadata } from "../loop-source.mjs";
import { createAgentScheduler } from "../scheduling.mjs";
import { governanceResponse } from "./scope-governance.fixture.mjs";
import { dispositionContext } from "../scope-governance.mjs";

const loop = flattenLoops(definition.workflows.ReleaseLoop.steps).find((node) => node.id === "AssignedWorkDeveloperLoop");
function harness(respond, assignment = true) {
    const calls = [];
    let round = 0;
    const ctx = {
        step: async (_, fn) => fn(), parallel: (work) => Promise.all(work.map((fn) => fn())), log() {},
        agent: async (prompt, options) => {
            const input = JSON.parse(prompt);
            calls.push({ ...input, options });
            if (input.kind === "doer") round++;
            const result = await respond?.(input, options, round);
            if (result !== undefined) return result;
            if (input.kind === "governance") return governanceResponse(input);
            if (input.kind === "doer") return { status: "complete", summary: "Implemented original handoff.", artifact: {} };
            return { agree: round > 1, taskComplete: round > 1, unmetCriteria: round > 1 ? [] : ["Original failing criterion."],
                feedback: round > 1 ? "Original handoff accepted." : "Correct the existing defect." };
        },
    };
    return { calls, run: (options = {}) => runLoop({ ctx, loop, key: "governed", context: assignment
        ? { assignment: { id: "task", doneWhen: "Original handoff works.", exclusions: ["Optional polish."], handoff: "Working handoff." } }
        : {}, ...options }) };
}

test("every retry receives Scrum-only required correction without an opt-in guard or scope flags", async () => {
    const f = harness((input, options, round) => {
        if (input.kind === "reviewer") {
            if (round > 1) {
                assert.equal(input.feedback.governance.instructions[0].disposition, "required");
                assert.ok(input.feedback.governanceHistory.length);
                assert.match(input.instructions.join("\n"), /Deferred\/declined enhancements cannot block/);
            }
            return { agree: round === 3, taskComplete: round === 3, unmetCriteria: round === 3 ? [] : ["Original defect"],
                feedback: "Check original criterion." };
        }
        if (input.kind === "doer" && round > 1) {
            assert.equal(input.feedback.governance.instructions.length, 2);
            assert.match(input.instructions.join("\n"), /ONE reconciled set/);
        }
        if (input.kind === "governance") {
            assert.equal(input.stage, "triage");
            assert.equal(options.agent, "workflow-reviewer");
            assert.match(input.instructions.join("\n"), /even if nobody flags scope expansion/);
            assert.match(input.instructions.join("\n"), /Never rewrite requirements or waive actual/);
        }
    });
    const result = await f.run();
    assert.equal(result.status, "agreed");
    assert.equal(result.rounds, 3);
    assert.equal(result.governanceHistory.length, 2);
    assert.deepEqual(f.calls.map((input) => input.kind), [
        "doer", "reviewer", "reviewer", "governance", "doer", "reviewer", "reviewer", "governance",
        "doer", "reviewer", "reviewer",
    ]);
    assert.ok(!Object.hasOwn(result, "progress"));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("Architect advice then PO required/approve/defer/decline becomes one bounded actionable set for owner AND original reviewers", async () => {
    const ids = ["defect", "polish", "later", "unwanted"];
    const f = harness((input, _, round) => {
        if (input.kind === "governance" && input.stage === "triage") return {
            summary: "Conflicting feedback requires scope decisions.",
            requiredCorrections: [{ id: "clear", requirement: "Original handoff", evidence: "Existing test failure", action: "Fix the null case." }],
            scopeQuestions: ids.map((id) => ({ id, request: `Request ${id}`, evidence: `Reviewer evidence ${id}` })),
        };
        if (input.stage === "scope-advice") return { assessments: ids.map((id) => ({
            id, necessity: id === "defect" ? "required" : "enhancement",
            rationale: id === "defect" ? "Existing correctness criterion." : "Optional improvement.",
            simplestOption: "Local bounded correction, not a redesign.",
        })) };
        if (input.stage === "scope-decision") {
            assert.equal(input.role, "Product Owner");
            assert.equal(input.architecture.assessments.length, 4);
            return { decisions: ids.map((id, index) => ({
                id, disposition: ["required", "approve", "defer", "decline"][index],
                rationale: id === "defect" ? "Required by original handoff." : "Within original user authority.",
                action: index < 2 ? `Implement ${id} minimally.` : "",
                acceptance: index < 2 ? `Focused ${id} check passes.` : "",
                taskBoundary: index < 2 ? "This task only; no new authority or YAML stages." : "",
            })) };
        }
        if (round > 1 && input.kind !== "governance") {
            assert.deepEqual(input.feedback.governance.instructions.map((item) => item.id), ["clear", "defect", "polish"]);
            assert.deepEqual(input.feedback.governance.nonBlocking.map((item) => item.id), ["later", "unwanted"]);
            assert.equal(input.feedback.governanceHistory[0].reviews.length, 2);
        }
    });
    const result = await f.run();
    assert.equal(result.status, "agreed");
    assert.deepEqual(f.calls.filter((input) => input.kind === "governance").map((input) => input.role),
        ["Scrum Master", "Architect", "Product Owner"]);
    assert.equal(result.governanceHistory[0].governance.architecture.assessments[0].necessity, "required");
    assert.equal(new Set(f.calls.map((input) => input.options.label)).size, f.calls.length);
});

test("discarded enhancements do not block original completion or force an assigned needs-replan graph", async () => {
    const f = harness((input, _, round) => {
        if (input.kind === "doer" && round === 1) return {
            status: "needs-replan", summary: "A reviewer asked for optional polish.", artifact: { originalComplete: true },
        };
        if (input.kind === "reviewer") return {
            agree: true, taskComplete: round > 1, unmetCriteria: round === 1 ? ["Optional polish demand."] : [],
            feedback: round === 1 ? "Polish outside original handoff." : "Original acceptance met without polish.",
        };
        if (input.stage === "triage") return {
            summary: "Only optional scope expansion remains.", requiredCorrections: [],
            scopeQuestions: [{ id: "polish", request: "Optional polish", evidence: "Original handoff already works." }],
        };
        if (round === 2 && input.kind === "doer") {
            assert.deepEqual(input.feedback.governance.instructions, []);
            assert.equal(input.feedback.governance.nonBlocking[0].disposition, "defer");
        }
    });

    assert.equal((await f.run()).status, "agreed");
    assert.equal(f.calls.filter((input) => input.kind === "doer").length, 2);
});

test("adjudications persist into later Scrum-only rounds and cannot be silently reclassified as mandatory", async () => {
    for (const reintroduce of [false, true]) {
        const f = harness((input, _, round) => {
            if (input.stage === "triage" && round === 1) return {
                summary: "Optional request needs a decision.", requiredCorrections: [],
                scopeQuestions: [{ id: "optional", request: "Add optional feature.", evidence: "Outside original handoff." }],
            };
            if (input.stage === "triage") return {
                summary: "A real original defect still needs correction.",
                requiredCorrections: [{ id: reintroduce ? "optional" : "defect", requirement: "Original criterion",
                    evidence: "Failing focused check", action: "Fix only the original failure.",
                    ...(reintroduce ? { priorReference: input.priorDispositions.find((item) => item.id === "optional").reference } : {}) }],
                scopeQuestions: [],
            };
            if (input.kind === "reviewer") {
                if (round > 1) assert.equal(input.feedback.governance.nonBlocking[0].id, "optional");
                return { agree: round === 3, taskComplete: round === 3, unmetCriteria: round === 3 ? [] : ["Original defect"],
                    feedback: "Verify original criterion." };
            }
            if (input.kind === "doer" && round === 3) {
                assert.equal(input.feedback.governance.nonBlocking[0].disposition, "defer");
                assert.deepEqual(input.feedback.governance.instructions.map((item) => item.id), reintroduce ? [] : ["defect"]);
            }
        });
        const result = await f.run();
        assert.equal(result.status, "agreed");
        assert.equal(result.governanceHistory.length, 2);
        assert.equal(f.calls.filter((input) => input.role === "Product Owner").length, reintroduce ? 2 : 1);
    }
});

test("first downstream turns inherit bounded dispositions; referenced reintroduction routes PO without waiving an unrelated same-ID criterion", async () => {
    const ids = ["required", "approved", "deferred", "declined"];
    const source = harness((input) => {
        if (input.stage === "triage") return { summary: "Decide bounded scope.", requiredCorrections: [],
            scopeQuestions: ids.map((id) => ({ id, request: `Scope ${id}`, evidence: `Evidence ${id}` })) };
        if (input.stage === "scope-decision") return { decisions: ids.map((id, index) => ({
            id, disposition: ["required", "approve", "defer", "decline"][index],
            rationale: "Original scoped decision.", action: index < 2 ? `Implement ${id}.` : "",
            acceptance: index < 2 ? `Verify ${id}.` : "", taskBoundary: "Only source task's optional display features.",
        })) };
    });
    const original = await source.run({ key: "source" });
    const sourceContext = { outcomes: [{ key: "source", ...original }], sprint: { id: "s2" },
        assignment: { id: "consumer", doneWhen: "Required unrelated criterion", exclusions: [], handoff: "Consumer handoff" } };
    const downstream = harness((input, _, round) => {
        assert.ok(input.priorDispositions.length >= 4);
        assert.ok(input.priorDispositions.every((item) => item.origin.key && item.taskBoundary && item.reference));
        assert.ok(!JSON.stringify(input.priorDispositions).includes("governanceHistory"));
        if (round === 1 && input.kind !== "governance") {
            assert.equal(input.feedback, null);
            assert.deepEqual(input.priorDispositions.map((item) => item.disposition), ["required", "approve", "defer", "decline"]);
            assert.equal(input.priorDispositions[0].origin.assignment.id, "task");
            assert.match(input.instructions.join("\n"), /first turn of this invocation/);
            assert.match(input.instructions.join("\n"), /unrelated criterion remains required even if its short ID matches/);
        }
        if (input.stage === "triage") {
            assert.equal(input.priorDispositions.find((item) => item.id === "declined").disposition, "decline");
            return { summary: "Reconsider one optional feature, preserve an unrelated actual defect.",
                requiredCorrections: [
                    { id: "again", requirement: "Proposed new consumer acceptance", evidence: "New consumer request",
                        action: "Reintroduce the deferred feature.",
                        priorReference: input.priorDispositions.find((item) => item.id === "deferred").reference },
                    { id: "declined", requirement: "Required unrelated criterion", evidence: "Actual independent failure",
                        action: "Fix the unrelated defect; do not waive it due to the matching ID." },
                ], scopeQuestions: [] };
        }
        if (input.stage === "scope-advice") {
            assert.deepEqual(input.triage.scopeQuestions.map((item) => item.id), ["again"]);
            assert.deepEqual(input.triage.requiredCorrections.map((item) => item.id), ["declined"]);
        }
        if (input.stage === "scope-decision") return { decisions: [{
            id: "again", disposition: "approve", rationale: "Explicit reconsideration within user authority.",
            action: "Implement only consumer display.", acceptance: "Consumer display focused check passes.",
            taskBoundary: "Consumer task only; no change to unrelated criteria.",
        }] };
        if (round === 2 && input.kind !== "governance") {
            assert.ok(!input.priorDispositions.some((item) => item.id === "deferred"));
            assert.equal(input.priorDispositions.find((item) => item.id === "again").disposition, "approve");
            const sameIds = input.priorDispositions.filter((item) => item.id === "declined");
            assert.deepEqual(sameIds.map((item) => item.disposition), ["decline", "required"]);
            assert.notEqual(sameIds[0].reference, sameIds[1].reference);
        }
    });
    const result = await downstream.run({ key: "later", context: sourceContext });
    assert.equal(result.status, "agreed");
    assert.deepEqual(downstream.calls.filter((input) => input.kind === "governance").map((input) => input.role),
        ["Scrum Master", "Architect", "Product Owner"]);
    const effective = dispositionContext({ outcomes: [...sourceContext.outcomes, { ...result }] });
    assert.ok(!effective.some((item) => item.id === "deferred"));
    assert.equal(effective.filter((item) => item.id === "declined").length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    const third = harness((input) => {
        if (input.stage === "triage") return { summary: "Reconsider the already amended enhancement explicitly.",
            requiredCorrections: [], scopeQuestions: [{ id: "final", request: "Defer consumer enhancement again.",
                evidence: "New product prioritization within unchanged authority.",
                priorReference: input.priorDispositions.find((item) => item.id === "again").reference }] };
    });
    const thirdResult = await third.run({ key: "third", context: { outcomes: [...sourceContext.outcomes, result] } });
    const after = dispositionContext({ outcomes: [...sourceContext.outcomes, result, thirdResult] });
    assert.ok(!after.some((item) => ["deferred", "again"].includes(item.id)));
    assert.equal(after.find((item) => item.id === "final").disposition, "defer");
});

test("replacement requests supply disposition context without copying raw audits", async () => {
    const governance = {
        origin: { key: "original-task", loopId: loop.id, assignment: { id: "original", doneWhen: "Original bounded task." } },
        instructions: [], nonBlocking: [{ id: "extra", disposition: "decline", rationale: "Not original scope.",
            action: "", acceptance: "", taskBoundary: "Original bounded task." }],
    };
    const inherited = { assignment: { id: "original" }, request: { feedback: { governance, governanceHistory: [{ hugeRawAudit: true }] } } };
    for (const context of [{ inherited }, { scopeRevision: inherited }]) {
        const f = harness((input) => {
            assert.equal(input.priorDispositions[0].disposition, "decline");
            assert.equal(input.priorDispositions[0].origin.assignment.id, "original");
            assert.ok(!JSON.stringify(input.priorDispositions).includes("hugeRawAudit"));
            if (input.kind === "reviewer") return { agree: true, taskComplete: true, unmetCriteria: [], feedback: "Original scope complete." };
        });
        assert.equal((await f.run({ context })).status, "agreed");
    }
});

test("final hard-cap round skips needless triage while retaining raw feedback and original stagnation accounting", async () => {
    for (const guarded of [false, true]) {
        let joined = false;
        const f = harness((input) => {
            assert.notEqual(input.kind, "governance");
            if (input.kind === "doer") return { status: "complete", summary: "Unresolved original failure.", artifact: {}, progress: [] };
            return { agree: false, taskComplete: false, unmetCriteria: ["Actual defect."], feedback: "Fix actual defect.", verifiedProgress: [] };
        });

        const result = await f.run({
            attempts: 1, ...(guarded ? { maxNoProgressRounds: 1 } : {}),
            dispatch: async () => ({ context: { status: "dispatched" }, settle: async () => { joined = true; return []; } }),
        });
        assert.ok(joined);
        assert.equal(result.rounds, 1);
        assert.equal(result.status, guarded ? "blocked" : "limit-reached");
        assert.equal(result.feedback.reviews[0].feedback, "Fix actual defect.");
        if (guarded) assert.equal(result.progress.noProgressRounds, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    }
});

test("invalid prior references and ambiguous local ID collisions fail instead of waiving a criterion", async () => {
    for (const mode of ["unknown-reference", "duplicate-reference", "local-collision"]) {
        const f = harness((input, _, round) => {
            if (input.kind === "reviewer") return { agree: false, taskComplete: false, unmetCriteria: ["Real defect."], feedback: "Fix defect." };
            if (input.stage !== "triage") return;
            if (round === 1) return { summary: "Optional scope.", requiredCorrections: [],
                scopeQuestions: [{ id: "optional", request: "Add optional feature.", evidence: "Outside original criteria." }] };
            if (mode === "local-collision") return { summary: "Unrelated failure reused a local decision ID.", scopeQuestions: [],
                requiredCorrections: [{ id: "optional", requirement: "An unrelated required criterion",
                    evidence: "Actual failure.", action: "Fix this actual defect." }] };
            const reference = mode === "unknown-reference" ? "not-a-decision"
                : input.priorDispositions.find((item) => item.id === "optional").reference;
            return { summary: "Malformed reconsideration.", requiredCorrections: [],
                scopeQuestions: [1, ...(mode === "duplicate-reference" ? [2] : [])].map((index) => ({
                    id: `changed-${index}`, request: "Reconsider.", evidence: "Evidence.", priorReference: reference,
                })) };
        });
        await assert.rejects(f.run(), /Invalid .*priorReference|Invalid Scrum Master disposition ID collision/);
    }
});

test("accepted and confirmed human-input outcomes do not add governance calls", async () => {
    for (const status of ["complete", "needs-input"]) {
        const f = harness((input) => input.kind === "doer"
            ? { status, summary: "Reviewed actual outcome.", artifact: {} }
            : { agree: true, taskComplete: true, unmetCriteria: [], feedback: "Confirmed." });
        assert.equal((await f.run()).status, status === "complete" ? "agreed" : status);
        assert.ok(!f.calls.some((input) => input.kind === "governance"));
    }
});

test("joins settle before governance; only individual role calls consume independent reviewer slots", { timeout: 3000 }, async () => {
    const scheduler = createAgentScheduler({ doers: 1, reviewers: 1 });
    let joined = false, inCall = 0;
    const f = harness((input) => {
        inCall++;
        assert.equal(inCall, 1);
        if (input.kind === "governance") assert.ok(joined);
        inCall--;
    });
    const result = await f.run({
        scheduleAgent: scheduler,
        dispatch: async () => ({ context: { status: "dispatched" }, settle: async () => {
            await scheduler("doer", async () => { joined = true; });
            return [{ status: "agreed" }];
        } }),
    });
    assert.equal(result.status, "agreed");
    assert.deepEqual(result.governanceHistory[0].dispatchedWork, [{ status: "agreed" }]);
});

test("malformed/failed governance is an explicit error; PO cannot discard architect-confirmed required failures", async () => {
    for (const stage of ["triage", "scope-advice", "scope-decision"]) {
        for (const bad of [null, {}, "throw", "missing-id", "waive-required"]) {
            if (bad === "waive-required" && stage !== "scope-decision") continue;
            const f = harness((input) => {
                if (input.kind !== "governance") return;
                if (input.stage === stage) {
                    if (bad === "throw") throw new Error(`Failed role call: ${stage}`);
                    if (bad === "missing-id") return stage === "triage"
                        ? { summary: "Invalid", requiredCorrections: [{ action: "Missing fields" }], scopeQuestions: [] }
                        : { [stage === "scope-advice" ? "assessments" : "decisions"]: [] };
                    if (bad === "waive-required") return { decisions: [{
                        id: "scope", disposition: "defer", rationale: "Waive defect", action: "", acceptance: "", taskBoundary: "",
                    }] };
                    return bad;
                }
                if (input.stage === "triage") return {
                    summary: "Inspect scope", requiredCorrections: [],
                    scopeQuestions: [{ id: "scope", request: "Scope demand", evidence: "Existing failure" }],
                };
                if (input.stage === "scope-advice") return { assessments: [{
                    id: "scope", necessity: "required", rationale: "Safety failure in original requirement", simplestOption: "Fix defect",
                }] };
            });
            await assert.rejects(f.run(), /Invalid .*triage|Invalid Architect scope advice|Invalid Product Owner scope decision|Failed role call/);
            assert.equal(f.calls.filter((input) => input.kind === "doer").length, 1);
        }
    }
});

test("new owner default, explicit owner precedence and historical agents.doer compatibility preserve concrete roles and labels", async () => {
    for (const [agents, expected] of [
        [{}, "workflow-owner"], [{ doer: "legacy-writer" }, "legacy-writer"],
        [{ owner: "writer", doer: "legacy-writer", reviewer: "reader" }, "writer"],
    ]) {
        const f = harness();
        await f.run({ agents });
        for (const call of f.calls) {
            assert.equal(call.options.agent, call.kind === "doer" ? expected : agents.reviewer ?? "workflow-reviewer");
            if (call.kind === "doer") {
                assert.equal(call.role, "Developer");
                assert.match(call.options.label, /:doer:\d+$/);
            }
        }
    }
    const properties = workflowMetadata("test").argsSchema.properties.agents.properties;
    assert.ok(properties.owner && properties.doer && properties.reviewer);
});
