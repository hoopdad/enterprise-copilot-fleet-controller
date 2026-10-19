import test from "node:test";
import assert from "node:assert/strict";
import { definition, flattenLoops, parseWorkflow } from "../loop-source.mjs";
import { runLoop } from "../lab-loops.mjs";

const loops = flattenLoops(definition.workflows.ReleaseLoop.steps);
function context(agent) {
    return { agent, step: async (_, fn) => fn(), parallel: (thunks) => Promise.all(thunks.map((fn) => fn())), log() {} };
}
test("every writing turn commits before review, and the existing Scrum Master reviews Git reconciliation", async () => {
    const calls = [];
    const ctx = context(async (prompt) => {
        const input = JSON.parse(prompt);
        calls.push(input);
        return input.kind === "doer"
            ? { status: "complete", summary: "Committed own changes as abc123 on feature/work", artifact: {} }
            : { agree: true, feedback: "Inspected committed changes" };
    });
    await runLoop({ ctx, loop: loops.find((node) => node.id === "SprintReviewLoop"), key: "git", context: {} });
    const owner = calls.find((call) => call.kind === "doer");
    assert.match(owner.instructions.join("\n"), /every turn that changes files.*rework or needs-input/);
    assert.match(owner.instructions.join("\n"), /git commit --only/);
    assert.match(owner.instructions.join("\n"), /retain its code commits on a named branch/);
    assert.match(owner.instructions.join("\n"), /abandonment reason in a commit message on the feature branch/);
    for (const review of calls.filter((call) => call.kind === "reviewer")) {
        assert.equal(review.owner.summary, "Committed own changes as abc123 on feature/work");
        assert.match(review.instructions.join("\n"), /actual Git commits/);
    }
    const scrum = calls.find((call) => call.kind === "reviewer" && call.role === "Scrum Master");
    assert.match(scrum.instructions.join("\n"), /accountable for Git reconciliation/);
    assert.match(scrum.instructions.join("\n"), /remain read-only yourself/);
});

test("planning and its original reviewers favor contract handoffs, critical paths and economical integration", async () => {
    const calls = [];
    await runLoop({
        ctx: context(async (prompt) => {
            const input = JSON.parse(prompt);
            calls.push(input);
            return input.kind === "doer" ? { status: "complete", summary: "Plan ready", artifact: {} }
                : { agree: true, feedback: "" };
        }),
        loop: loops.find((node) => node.id === "SprintPlanLoop"), key: "planning", context: {},
        dispatch: async () => ({ context: { status: "dispatched" }, settle: async () => [] }),
    });
    assert.equal(calls[0].role, "Scrum Master");
    assert.match(calls[0].instructions.join("\n"), /critical-path analysis/);
    assert.match(calls[0].instructions.join("\n"), /smallest useful accepted handoff/);
    assert.match(calls[0].instructions.join("\n"), /explicit integration\/refactoring tasks/);
    assert.match(calls[0].instructions.join("\n"), /request.git.featureBranch/);
    for (const call of calls.filter((input) => input.kind === "reviewer")) {
        assert.match(call.instructions.join("\n"), /agreed interface\/fixture or the whole implementation/);
        assert.match(call.instructions.join("\n"), /File overlap alone is not a dependency/);
        assert.match(call.instructions.join("\n"), /Plan review does not wait/);
    }
});

test("the original YAML's hierarchy, roles, reviewer order and completion conditions are retained", () => {
    assert.deepEqual(definition.workflows.ReleaseLoop.steps.map((node) => node.id),
        ["ArchitectureLoop", "UserExperienceLoop", "ReleasePlanLoop", "SprintLoop", "ReleaseCloseoutLoop"]);
    const expected = [
        ["ArchitectureLoop", "Architect", ["Product Owner", "Red Team", "Critic"]],
        ["UserExperienceLoop", "Designer", ["Product Owner", "Critic"]],
        ["ReleasePlanLoop", "Product Owner", ["Stakeholder", "Architect", "Designer", "Critic"]],
        ["SprintDesignLoop", "Designer", ["Product Owner", "Critic"]],
        ["SprintArchitectureLoop", "Architect", ["Product Owner", "Critic", "Red Team"]],
        ["SprintPlanLoop", "Scrum Master", ["Product Owner", "Architect", "Critic"]],
        ["AssignedWorkUIDeveloperLoop", "Developer", ["Architect", "Designer", "Critic"]],
        ["AssignedWorkDeveloperLoop", "Developer", ["Architect", "Critic"]],
        ["EndToEndTestLoop", "Developer", ["Architect", "Critic", "Product Owner"]],
        ["DevOpsWorkLoop", "DevOps Engineer", ["Architect", "Critic", "Developer"]],
        ["SprintReviewLoop", "Product Owner", ["Scrum Master", "Critic", "Architect", "Red Team"]],
        ["SprintRetroLoop", "Product Owner", ["Scrum Master", "Critic", "Architect", "Red Team", "Designer", "Developer"]],
        ["ReleaseCloseoutLoop", "Product Owner", ["Stakeholder", "Architect", "Critic"]],
    ];
    assert.deepEqual(loops.filter((node) => !node.substeps).map((node) => [node.id, node.owner, node.reviewers]), expected);
    assert.equal(loops.find((node) => node.id === "DevOpsWorkLoop").completeWhen,
        "Owner and reviewers agree and cloud-deployed system passes tests.");
    assert.equal(loops.find((node) => node.id === "EndToEndTestLoop").completeWhen,
        "Owner and reviewers agree test outcomes are accurate and actionable.");
});
test("disagreement loops back to the same do-er and original reviewers; agreeing feedback is allowed", async () => {
    const calls = [];
    let owners = 0;
    const ctx = context(async (prompt, options) => {
        const input = JSON.parse(prompt);
        calls.push({ input, options });
        if (input.kind === "doer") {
            owners++;
            if (owners === 2) assert.match(JSON.stringify(input.feedback), /fix this/);
            return { status: "complete", summary: "done", artifact: {} };
        }
        return { agree: owners > 1 || input.role !== "Critic", feedback: owners > 1 ? "Minor observation remains" : "fix this" };
    });
    const result = await runLoop({ ctx, loop: loops[0], key: "architecture", context: {} });
    assert.equal(result.status, "agreed");
    assert.equal(result.rounds, 2);
    assert.equal(calls.filter((call) => call.input.kind === "reviewer").length, 6);
    assert.ok(calls.every((call) => call.options.agent.startsWith("workflow-")));
    assert.equal(new Set(calls.map((call) => call.options.label)).size, calls.length);
});
test("there is no engine default round cap", async () => {
    let rounds = 0;
    const ctx = context(async (prompt) => {
        const input = JSON.parse(prompt);
        if (input.kind === "doer") { rounds++; return { status: "complete", summary: "working", artifact: {} }; }
        return { agree: rounds >= 12, feedback: "continue" };
    });
    const result = await runLoop({ ctx, loop: loops[0], key: "no-default", context: {} });
    assert.equal(result.rounds, 12);
});
test("explicit attempt limits and genuine human-input outcomes are reported, never passed", async () => {
    const limit = await runLoop({
        ctx: context(async (p) => JSON.parse(p).kind === "doer"
            ? { status: "complete", summary: "work", artifact: {} } : { agree: false, feedback: "not yet" }),
        loop: loops[0], key: "limit", context: {}, attempts: 2,
    });
    assert.equal(limit.status, "limit-reached");
    assert.equal(limit.rounds, 2);
    assert.equal(limit.limit, 2);
    assert.match(limit.summary, /ArchitectureLoop.*2-round limit/);
    assert.match(limit.reason, /Reviewers still disagreed.*Critic/);
    assert.ok(limit.feedback.reviews.every((review) => review.feedback === "not yet"));
    const blocked = await runLoop({
        ctx: context(async (p) => JSON.parse(p).kind === "doer"
            ? { status: "needs-input", summary: "User must authorize another resource", artifact: {} }
            : { agree: true, feedback: "Requires user authority" }),
        loop: loops[0], key: "human", context: {},
    });
    assert.equal(blocked.status, "needs-input");
    assert.match(blocked.summary, /User must authorize another resource/);
    assert.ok(blocked.nextAction);
});
test("invalid or failed subagents are explicit failures, not agreement", async () => {
    await assert.rejects(runLoop({ ctx: context(async () => null), loop: loops[0], key: "null", context: {} }), /Invalid do-er/);
    await assert.rejects(runLoop({
        ctx: context(async (p) => JSON.parse(p).kind === "doer"
            ? { status: "complete", summary: "", artifact: {} } : null),
        loop: loops[0], key: "review-null", context: {},
    }), /Invalid .*reviewer/);
    assert.throws(() => parseWorkflow("workflows: {}"), /ReleaseLoop/);
});

function progressContext({ owner, review } = {}) {
    let round = 0;
    return context(async (prompt, options) => {
        const input = JSON.parse(prompt);
        if (input.kind === "doer") {
            round++;
            assert.ok(options.schema.required.includes("progress"));
            return { status: "rework", summary: "Continuing", artifact: {}, progress: [], ...await owner?.(round, input) };
        }
        assert.ok(options.schema.required.includes("verifiedProgress"));
        return { agree: false, feedback: "More work remains", verifiedProgress: [], ...await review?.(round, input) };
    });
}
test("productive rework can exceed ten rounds, with progress independently verified by the original reviewers", async () => {
    const ctx = progressContext({
        owner: (round, input) => {
            assert.equal(input.progressState.credited.length, round - 1);
            assert.equal(input.progressState.noProgressRounds, 0);
            return {
                status: round === 25 ? "complete" : "rework",
                progress: [{ id: `check-${round}`, evidence: `Newly resolved failing check ${round}` }],
            };
        },
        review: (round, input) => ({
            agree: round === 25, verifiedProgress: input.owner.progress.map((item) => item.id),
        }),
    });
    const result = await runLoop({ ctx, loop: loops[0], key: "productive", context: {}, maxNoProgressRounds: 10 });
    assert.equal(result.status, "agreed");
    assert.equal(result.rounds, 25);
});
test("ten consecutive unverified rounds stop as blocked, not successful completion or a total-round limit", async () => {
    const ctx = progressContext({ owner: (round) => ({
        summary: `A different claim ${round}`, artifact: { changed: round },
        progress: [{ id: `claim-${round}`, evidence: `Unverified claim ${round}` }],
    }) });
    const result = await runLoop({ ctx, loop: loops[0], key: "stalled", context: {}, maxNoProgressRounds: 10 });
    assert.equal(result.status, "blocked");
    assert.equal(result.stopCause, "no-progress");
    assert.equal(result.rounds, 10);
    assert.deepEqual(result.progress, { noProgressRounds: 10, limit: 10, credited: [] });
    assert.equal(result.feedback.owner.summary, "A different claim 10");
    assert.match(result.summary, /10 consecutive rounds/);
    assert.ok(result.nextAction);
});
test("verified progress on the threshold round resets the consecutive counter; reused IDs never reset it", async () => {
    const ctx = progressContext({
        owner: (round, input) => {
            if (round === 20) assert.equal(input.progressState.noProgressRounds, 9);
            return { progress: round >= 10 ? [{ id: "resolved-check", evidence: `Evidence prose version ${round}` }] : [] };
        },
        review: (_, input) => ({ verifiedProgress: input.owner.progress.map((item) => item.id) }),
    });
    const result = await runLoop({ ctx, loop: loops[0], key: "reset", context: {}, maxNoProgressRounds: 10 });
    assert.equal(result.status, "blocked");
    assert.equal(result.rounds, 20);
    assert.equal(result.progress.noProgressRounds, 10);
    assert.deepEqual(result.progress.credited, [{ id: "resolved-check", evidence: "Evidence prose version 10", round: 10 }]);
});
test("one reviewer's progress claim is not enough and disjoint verified IDs are not consensus", async () => {
    for (const disjoint of [false, true]) {
        const ctx = progressContext({
            owner: () => ({ progress: [{ id: "a", evidence: "Check A" }, { id: "b", evidence: "Check B" }] }),
            review: (_, input) => ({ verifiedProgress: input.role === "Critic" ? (disjoint ? ["b"] : []) : ["a"] }),
        });
        const result = await runLoop({ ctx, loop: loops[0], key: `no-consensus-${disjoint}`, context: {}, maxNoProgressRounds: 1 });
        assert.equal(result.status, "blocked");
        assert.equal(result.progress.credited.length, 0);
    }
});
test("relabeling identical evidence cannot reset stagnation even when reviewers endorse a fresh ID", async () => {
    const ctx = progressContext({
        owner: (round) => ({ progress: [{ id: `new-label-${round}`, evidence: round % 2 ? " Check A passed " : "check   a PASSED" }] }),
        review: (_, input) => ({ verifiedProgress: input.owner.progress.map((item) => item.id) }),
    });
    const result = await runLoop({ ctx, loop: loops[0], key: "relabeled", context: {}, maxNoProgressRounds: 10 });
    assert.equal(result.status, "blocked");
    assert.equal(result.rounds, 11);
    assert.equal(result.progress.credited.length, 1);
});
test("completion and genuine human input take precedence over stagnation on the threshold round", async () => {
    for (const status of ["complete", "needs-input"]) {
        const ctx = progressContext({
            owner: () => ({ status, summary: "Accurately reviewed outcome", nextAction: "Supply missing authority" }),
            review: () => ({ agree: true }),
        });
        const result = await runLoop({ ctx, loop: loops[0], key: status, context: {}, maxNoProgressRounds: 1 });
        assert.equal(result.status, status === "complete" ? "agreed" : "needs-input");
        assert.equal(result.rounds, 1);
    }
});
test("unconfirmed human-input claims are still bounded by stagnation", async () => {
    const ctx = progressContext({ owner: () => ({ status: "needs-input" }) });
    const result = await runLoop({ ctx, loop: loops[0], key: "unconfirmed", context: {}, maxNoProgressRounds: 2 });
    assert.equal(result.status, "blocked");
    assert.equal(result.rounds, 2);
});
test("dispatch is settled before a stagnation stop and its actual result is retained", async () => {
    let settled = false;
    const ctx = progressContext({ owner: () => ({ status: "complete" }) });
    const result = await runLoop({
        ctx, loop: loops[0], key: "dispatch-stall", context: {}, maxNoProgressRounds: 1,
        dispatch: async () => ({
            context: { status: "dispatched" },
            settle: async () => { settled = true; return [{ status: "agreed" }]; },
        }),
    });
    assert.ok(settled);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.feedback.dispatchedWork, [{ status: "agreed" }]);
});
test("malformed progress cannot silently become verified progress, and dispatched work is joined on reviewer errors", async () => {
    for (const progress of [undefined, null, {}, [{ id: "", evidence: "x" }], [{ id: "x", evidence: " " }],
        [{ id: " x ", evidence: "x" }], [{ id: "x", evidence: "a" }, { id: "x", evidence: "b" }]]) {
        await assert.rejects(runLoop({
            ctx: progressContext({ owner: () => ({ progress }) }),
            loop: loops[0], key: "invalid-owner", context: {}, maxNoProgressRounds: 10,
        }), /Invalid do-er progress/);
    }
    for (const verifiedProgress of [undefined, null, {}, [7], ["unknown"], ["x", "x"]]) {
        let settled = false;
        await assert.rejects(runLoop({
            ctx: progressContext({
                owner: () => ({ status: "complete", progress: [{ id: "x", evidence: "Check X" }] }),
                review: () => ({ verifiedProgress }),
            }),
            loop: loops[0], key: "invalid-reviewer", context: {}, maxNoProgressRounds: 10,
            dispatch: async () => ({ context: {}, settle: async () => { settled = true; } }),
        }), /Invalid .*reviewer progress/);
        assert.ok(settled);
    }
});
test("stagnation is opt-in and explicit legacy round caps remain independent ceilings", async () => {
    for (const maxNoProgressRounds of [0, -1, 1.5, NaN, null, "10", Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(runLoop({
            ctx: context(() => assert.fail("Invalid settings must not launch an agent")),
            loop: loops[0], key: "invalid-limit", context: {}, maxNoProgressRounds,
        }), /maxNoProgressRounds.*positive integer/);
    }
    const result = await runLoop({
        ctx: progressContext({
            owner: (round) => ({ progress: [{ id: `check-${round}`, evidence: "Newly resolved check" }] }),
            review: (_, input) => ({ verifiedProgress: input.owner.progress.map((item) => item.id) }),
        }),
        loop: loops[0], key: "explicit-cap", context: {}, attempts: 2, maxNoProgressRounds: 10,
    });
    assert.equal(result.status, "limit-reached");
    assert.equal(result.rounds, 2);
});
