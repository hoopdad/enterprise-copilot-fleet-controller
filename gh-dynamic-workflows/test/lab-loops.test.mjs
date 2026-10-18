import test from "node:test";
import assert from "node:assert/strict";
import { definition, flattenLoops, parseWorkflow } from "../loop-source.mjs";
import { runLoop } from "../lab-loops.mjs";

const loops = flattenLoops(definition.workflows.ReleaseLoop.steps);
function context(agent) {
    return { agent, step: async (_, fn) => fn(), parallel: (thunks) => Promise.all(thunks.map((fn) => fn())), log() {} };
}
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
