import test from "node:test";
import assert from "node:assert/strict";
import { definition, flattenLoops, parseWorkflow } from "../loop-source.mjs";
import { runLoop } from "../lab-loops.mjs";
import { owner, review, context, fixtureRoot, checks } from "./evidence.fixture.mjs";

const loops = flattenLoops(definition.workflows.ReleaseLoop.steps);
const loop = loops.find((node) => node.id === "AssignedWorkDeveloperLoop");
const packet = { projectRoot: fixtureRoot, assignment: { id: "api", doneWhen: "Deployed checks pass" } };
function run(agent, options = {}) {
    return runLoop({ ctx: context(agent), loop, key: "test", context: packet, ...options });
}
test("all original loops retain owners/reviewers and instruct executable evidence, not disposition governance", async () => {
    for (const current of loops.filter((node) => node.reviewers)) {
        const calls = [];
        const result = await run((input) => {
            calls.push(input);
            return input.kind === "doer" ? owner() : review();
        }, { loop: current });
        assert.equal(result.status, "agreed");
        assert.deepEqual(result.reviews.map((item) => item.role), current.reviewers);
        assert.ok(calls.every((call) => call.instructions.join("\n").includes("permission")));
        assert.match(calls[0].instructions.join("\n"), /completeWhen.*executable checks each round/);
        assert.match(calls[0].instructions.join("\n"), /No Scrum triage, Architect advice, Product Owner decision/);
        assert.ok(!calls.some((call) => call.kind === "governance"));
    }
});

test("every writing turn commits owned paths before review and preserves concurrent work", async () => {
    const calls = [];
    await run((input) => { calls.push(input); return input.kind === "doer" ? owner() : review(); });
    const instructions = calls[0].instructions.join("\n");
    assert.match(instructions, /every turn that changes files, including rework or needs-input/);
    assert.match(instructions, /git commit --only/);
    assert.match(instructions, /preserve concurrent changes/);
    assert.match(instructions, /never invent counters/);
    for (const call of calls.slice(1)) assert.match(call.instructions.join("\n"), /actual Git commits/);
});

test("planning instructions cover deployed-first contract handoffs and shared resource contention", async () => {
    let prompt;
    await run((input) => {
        if (input.kind === "doer") prompt = input;
        return input.kind === "doer" ? owner() : review();
    }, { loop: loops.find((node) => node.id === "SprintPlanLoop"), context: { projectRoot: fixtureRoot },
        dispatch: () => ({ context: { status: "dispatched" }, settle: async () => [] }) });
    assert.match(prompt.instructions.join("\n"), /walkingSkeleton:true,kind:devops/);
    assert.match(prompt.instructions.join("\n"), /transitively depends/);
    assert.match(prompt.instructions.join("\n"), /exclusiveResources.*mutable contention/);
    assert.match(prompt.instructions.join("\n"), /Plan completion requires dispatch-ready assignments/);
});

test("accurate rework and reviewer completion votes cannot promote owner status", async () => {
    let round = 0;
    const result = await run((input) => input.kind === "doer"
        ? owner({ status: ++round < 3 ? "rework" : "complete" })
        : review({ agree: true, taskComplete: true }));
    assert.equal(result.status, "agreed");
    assert.equal(result.rounds, 3);
});

test("execution scope changes return scoped needs-replan; planning resolves changes in its own loop", async () => {
    for (const current of [loop, loops.find((node) => node.id === "ArchitectureLoop")]) {
        let round = 0;
        const result = await run((input) => input.kind === "doer"
            ? owner({ status: ++round === 1 ? "needs-replan" : "complete" }) : review(), { loop: current });
        assert.equal(result.status, current === loop ? "needs-replan" : "agreed");
        assert.equal(result.rounds, current === loop ? 1 : 2);
        assert.equal(result.governanceHistory, undefined);
    }
});

test("workflow parser rejects malformed hierarchy and duplicate IDs without introducing new roles", () => {
    assert.ok(loops.some((node) => node.id === "ReleaseCloseoutLoop"));
    assert.throws(() => parseWorkflow("workflows: {}"), /requires/);
    assert.throws(() => parseWorkflow("workflows:\n  ReleaseLoop:\n    steps:\n      - {id: x, name: X, owner: Developer, reviewers: []}"), /do-er and reviewers/);
    assert.throws(() => parseWorkflow("workflows:\n  ReleaseLoop:\n    steps:\n      - {id: x, name: X, owner: Developer, reviewers: [Critic]}\n      - {id: x, name: X, owner: Developer, reviewers: [Critic]}"), /unique/);
});

test("check inadequacy retries the same doer and original reviewers; observations allow acceptance", async () => {
    let round = 0;
    const result = await run((input) => {
        if (input.kind === "doer") { round++; return owner(); }
        return review({ checksValid: round > 1 || ["Critic", "Red Team"].includes(input.role),
            findings: [{ type: "observation", summary: "Improve naming later", action: "Consider naming" }] });
    });
    assert.equal(result.status, "agreed");
    assert.equal(result.rounds, 2);
});

test("explicit attempt limits and genuine human-input outcomes never pass", async () => {
    for (const attempts of [0, -1, 1.5, "2"]) {
        await assert.rejects(run(() => {}, { attempts }), /positive integer/);
    }
    const limited = await run((input) => input.kind === "doer" ? owner({ status: "rework" }) : review(), { attempts: 2 });
    assert.equal(limited.status, "limit-reached");
    const human = await run((input) => input.kind === "doer"
        ? owner({ status: "needs-input", checks: [], nextAction: "Supply deployment authority" }) : review({ checksValid: false }));
    assert.equal(human.status, "needs-input");
});

test("invalid or failed subagents are explicit errors rather than agreement", async () => {
    for (const response of [null, {}, owner({ status: "PASS" }), owner({ checks: undefined }), owner({ progress: undefined })]) {
        await assert.rejects(run(() => response), /Invalid/);
    }
    await assert.rejects(run((input) => input.kind === "doer" ? owner() : { checksValid: "true" }), /Invalid/);
    await assert.rejects(run((input) => { if (input.kind === "reviewer") throw new Error("agent failed"); return owner(); }), /agent failed/);
    const ctx = context((input) => input.kind === "doer" ? owner() : review());
    ctx.parallel = async () => [null];
    await assert.rejects(runLoop({ ctx, loop, key: "null", context: packet }), /Reviewer execution failed/);
});

test("productive rounds have no total default cap; substantive verified advances can exceed ten rounds", async () => {
    let round = 0;
    const result = await run((input) => input.kind === "doer"
        ? owner({ status: ++round <= 12 ? "rework" : "complete", progress: [{ id: `step-${round}`, evidence: `New required output ${round}` }] })
        : review({ verifiedProgress: input.owner.progress.map((item) => item.id) }));
    assert.equal(result.status, "agreed");
    assert.equal(result.rounds, 13);
});

test("default bounded no-progress and explicit thresholds stop unresolved loops without fake completion", async () => {
    for (const limit of [undefined, 1, 4]) {
        const result = await run((input) => input.kind === "doer" ? owner({ status: "rework" }) : review(),
            { maxNoProgressRounds: limit });
        assert.equal(result.status, "blocked");
        assert.equal(result.rounds, limit ?? 3);
        assert.equal(result.stopCause, "no-progress");
    }
    await assert.rejects(run(() => {}, { maxNoProgressRounds: 0 }), /positive integer/);
});

test("threshold-round verified advance resets stagnation; IDs and relabeled evidence cannot be reclaimed", async () => {
    let round = 0;
    const result = await run((input) => {
        if (input.kind === "doer") {
            round++;
            return owner({ status: "rework", progress: round >= 2
                ? [{ id: `id-${round}`, evidence: round === 2 ? "New check passes" : " new   CHECK passes " }] : [] });
        }
        return review({ verifiedProgress: input.owner.progress.map((item) => item.id) });
    }, { maxNoProgressRounds: 2 });
    assert.equal(result.status, "blocked");
    assert.equal(result.rounds, 4);
    assert.equal(result.progress.credited.length, 1);
});

test("progress requires every original reviewer's independent confirmation", async () => {
    const result = await run((input) => input.kind === "doer"
        ? owner({ status: "rework", progress: [{ id: "new", evidence: "New test actually passes" }] })
        : review({ verifiedProgress: input.role === loop.reviewers[0] ? ["new"] : [] }), { maxNoProgressRounds: 2 });
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.progress.credited, []);
});

test("completion and human input take precedence over the no-progress threshold", async () => {
    for (const status of ["complete", "needs-input"]) {
        const result = await run((input) => input.kind === "doer" ? owner({ status }) : review(), { maxNoProgressRounds: 1 });
        assert.equal(result.status, status === "complete" ? "agreed" : status);
    }
});

test("dispatch is joined before plan retry, threshold stops and reviewer errors", async () => {
    let joined = false, round = 0;
    const result = await run((input) => {
        if (input.kind === "doer") {
            if (++round > 1) assert.ok(joined);
            return owner();
        }
        return review({ checksValid: false });
    }, {
        loop: { ...loop, id: "SprintPlanLoop", reviewers: ["Architect"] },
        context: { projectRoot: fixtureRoot }, maxNoProgressRounds: 2,
        dispatch: () => ({ context: { status: "dispatched" }, settle: async () => { joined = true; return [{ status: "agreed" }]; } }),
    });
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.feedback.dispatchedWork, [{ status: "agreed" }]);
    joined = false;
    await assert.rejects(run((input) => input.kind === "doer" ? owner() : review({ verifiedProgress: ["invented"] }), {
        context: { projectRoot: fixtureRoot },
        dispatch: () => ({ settle: async () => { joined = true; } }),
    }), /Invalid.*progress/);
    assert.ok(joined);
});

test("missing checks, failing checks and non-deployed assigned checks never dispatch or complete", async () => {
    for (const emitted of [[], checks({ exitCode: 1 }), checks({ environment: "local" })]) {
        let dispatched = false;
        const result = await run((input) => input.kind === "doer" ? owner({ checks: emitted }) : review(),
            { attempts: 1, dispatch: () => { dispatched = true; } });
        assert.equal(result.status, "limit-reached");
        assert.ok(result.feedback.transportIssue);
        assert.equal(dispatched, false);
    }
});

test("owner default and explicit legacy doer overrides retain original roles and labels", async () => {
    for (const [agents, expected] of [[{}, "workflow-owner"], [{ doer: "legacy" }, "legacy"], [{ owner: "owner", doer: "legacy" }, "owner"]]) {
        const calls = [];
        await run((input, options) => {
            calls.push({ input, options });
            return input.kind === "doer" ? owner() : review();
        }, { agents });
        assert.equal(calls[0].options.agent, expected);
        assert.equal(calls[0].input.role, loop.owner);
        assert.match(calls[0].options.label, /test:doer:1/);
        assert.ok(calls.slice(1).every((call) => call.options.agent === "workflow-reviewer"));
    }
});
