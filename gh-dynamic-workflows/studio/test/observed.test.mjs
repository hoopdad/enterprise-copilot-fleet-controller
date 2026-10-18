import { test } from "node:test";
import assert from "node:assert/strict";
import { observedFlow, outcome, stopReason, summarizeEvidence, queryTeam, taskLabel, processModel, tokenText, workOutcome } from "../observed.mjs";

const agent = (id, startedAt, completedAt, status = "completed") => ({
    id, startedAt, completedAt, status, agentType: "developer", label: `Developer: Build feature ${id}`, phaseId: "sprint",
});
const run = (agents = [], extra = {}) => ({
    runId: "test", status: "running", startedAt: 1, observedAt: 100, agents, terminal: false,
    phases: [{ id: "future", entries: 0, title: "Unobserved plan" }], ...extra,
});

test("renders only observed activities and interval-order fan-out/join, not the plan", () => {
    const flow = observedFlow(run([
        agent("plan", 2, 10), agent("ui", 11, 30), agent("api", 12, 40),
        agent("review", 41, null, "running"), agent("not-started", null, null, "queued"),
    ]));
    assert.deepEqual(flow.nodes.map((node) => node.id), ["start", "agent:plan", "agent:ui", "agent:api", "agent:review"]);
    assert.deepEqual(flow.edges, [
        { from: "start", to: "agent:plan", kind: "timing" },
        { from: "agent:plan", to: "agent:ui", kind: "timing" },
        { from: "agent:plan", to: "agent:api", kind: "timing" },
        { from: "agent:ui", to: "agent:review", kind: "timing" },
        { from: "agent:api", to: "agent:review", kind: "timing" },
    ]);
    const ui = flow.nodes.find((node) => node.id === "agent:ui");
    const api = flow.nodes.find((node) => node.id === "agent:api");
    assert.equal(ui.y, api.y);
    assert.notEqual(ui.x, api.x);
    assert.equal(ui.width, ui.height);
    assert.equal(flow.nodes.at(-1).tone, "waiting");
    assert.ok(flow.edges.every((edge) => edge.kind === "timing"));
});

test("keeps overlapping activity independent, handles ties, and ends only on retained terminal states", () => {
    const agents = [agent("a", 2, null, "running"), agent("b", 3, 5), agent("c", 6, null, "error")];
    const flow = observedFlow(run(agents, { terminal: true, status: "completed", result: { status: "blocked", reason: "Need approval" } }));
    assert.equal(flow.nodes.at(-1).kind, "end");
    assert.equal(flow.nodes.at(-1).tone, "waiting");
    assert.equal(flow.nodes.find((node) => node.id === "agent:c").tone, "error");
    assert.ok(!flow.edges.some((edge) => edge.from === "agent:a" && edge.to === "agent:c"));
    assert.ok(flow.edges.some((edge) => edge.from === "agent:a" && edge.to === "end"));
    const tied = observedFlow(run([agent("a", 2, 2), agent("b", 2, 2)]));
    assert.equal(tied.nodes[1].level, tied.nodes[2].level);
    assert.equal(observedFlow(run([], { stale: true })).nodes.length, 1);
    assert.equal(observedFlow(null).nodes.length, 0);
});

test("separates SDK completion from application success and explains actual stop reasons", () => {
    for (const status of ["needs-input", "limit-reached", "blocked"]) {
        const record = run([], { status: "completed", result: { status, reason: "Operator action required" } });
        assert.equal(outcome(record).tone, "waiting");
        assert.equal(outcome(record).label, status);
        assert.equal(stopReason(record), "Operator action required");
    }
    assert.equal(outcome({ status: "completed" }).tone, "waiting");
    assert.equal(outcome({ status: "completed", result: { status: "completed" } }).tone, "success");
    assert.equal(outcome({ status: "completed" }, { agent: true }).tone, "success");
    assert.equal(outcome({ status: "completed", result: { status: "success" } }).tone, "success");
    assert.equal(outcome({ status: "completed", error: "Broken" }).tone, "error");
    assert.equal(outcome({ status: "running", stale: true }).tone, "waiting");
    assert.match(stopReason({ status: "completed" }), /does not confirm/);
    assert.match(stopReason({ status: "running", stale: true }), /lease expired/);
});

test("bounds extractive text/JSON summaries to a short title, two sentences and two five-sentence paragraphs", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Evidence ${i} has been retained.`).join(" ");
    for (const value of [long, { details: long }, JSON.stringify({ details: long }), "{malformed JSON"]) {
        const summary = summarizeEvidence(value);
        assert.ok(summary.title.split(/\s+/).length <= 5);
        assert.equal(summary.description.match(/[.!?]+/g).length, 2);
        assert.ok(summary.paragraphs.length <= 2);
        assert.ok(summary.paragraphs.every((paragraph) => paragraph.match(/[.!?]+/g).length <= 5));
    }
    assert.equal(summarizeEvidence(null).paragraphs.length, 0);
    assert.ok(summarizeEvidence("x".repeat(10000)).title.length <= 100);
    assert.ok(taskLabel(agent("a", 1, null)).split(/\s+/).length <= 5);
});

test("answers supported team questions only from recorded local evidence", () => {
    const current = run([agent("ui", 2, null, "running"), agent("api", 3, 5)]);
    assert.match(JSON.stringify(queryTeam(current, "Who is working?")), /feature ui/);
    assert.doesNotMatch(JSON.stringify(queryTeam(current, "Who is working?")), /feature api/);
    assert.match(JSON.stringify(queryTeam(current, "What is done?")), /feature api/);
    assert.match(JSON.stringify(queryTeam(current, "developer: build feature ui")), /feature ui/);
    assert.match(JSON.stringify(queryTeam(run([], { result: { status: "needs-input", reason: "Choose region" } }), "Why did it stop?")), /Choose region/);
    assert.match(queryTeam(current, "Send a message to someone").title, /No matching/);
    assert.match(queryTeam(null, "Who is working?").title, /No run/);
});

test("uses recorded models/counters and distinguishes reviewer agreement from an actual PASS", () => {
    assert.equal(tokenText(0), "0");
    assert.equal(tokenText(1234567), "1,234,567");
    assert.equal(tokenText(null), "Not recorded");
    assert.equal(processModel({ requestedModel: "wanted" }), "wanted (requested)");
    assert.equal(processModel({ model: "fallback", usage: { models: ["actual-a", "actual-b"] } }), "actual-a / actual-b");
    assert.equal(workOutcome({ workResult: { kind: "review", agree: true, summary: "Agree with the reported FAIL." } }).title, "Reviewer agreed");
    assert.equal(workOutcome({ workResult: { kind: "review", agree: true, summary: "PASS: Customer Activity Screen is correct." } }).title, "Reviewer stated PASS");
    assert.equal(outcome({ status: "completed", workResult: { kind: "review", agree: false, summary: "Filtering drops the selected customer." } }, { agent: true }).tone, "error");
    assert.equal(taskLabel({ taskTitle: "Customer Activity Screen" }), "Customer Activity Screen");
});

test("describes unfinished tasks from recorded assignment, role and phase context instead of missing final output", () => {
    for (const status of ["running", "in-progress", "in_progress", "pending", "queued"]) {
        const result = workOutcome({
            status, taskTitle: "Customer Activity Screen",
            label: "yaml:sprint/1/S1/task/s1-ui/AssignedWorkUIDeveloperLoop:reviewer:Critic:2",
        }, { phase: { title: "Sprint Loop", detail: "Inspect filtering and the selected customer." } });
        assert.equal(result.title, ["pending", "queued"].includes(status) ? "Task pending" : "Work in progress");
        assert.equal(result.contextOnly, true);
        assert.equal(result.tone, "waiting");
        assert.match(result.summary, /Assigned task: Customer Activity Screen/);
        assert.match(result.summary, /Critic reviewer/);
        assert.match(result.summary, /Sprint Loop/);
        assert.match(result.summary, /Inspect filtering/);
        assert.match(result.summary, /not a final work outcome/);
        assert.doesNotMatch(JSON.stringify(summarizeEvidence(result.summary)), /No final work response|No further detail was retained/);
    }
});

test("uses recorded task IDs, full labels and phase names when no planning title is available", () => {
    assert.match(workOutcome({
        status: "running", label: "yaml:sprint/1/S1/task/s1-paired-framework/AssignedWorkDeveloperLoop:doer:10",
    }).summary, /Assigned task: s1-paired-framework/);
    assert.match(workOutcome({
        status: "pending", label: "Developer: Implement customer navigation with preserved search filters",
    }).summary, /with preserved search filters/);
    assert.match(workOutcome({ status: "queued" }, { phase: { title: "Package compatibility" } }).summary,
        /Assigned task: Package compatibility/);
    assert.match(workOutcome({ status: "running", label: "yaml:ArchitectureLoop:doer:1" }).summary,
        /Assigned task: Architecture doer/);
    assert.match(workOutcome({ status: "running" }).summary, /Assigned task: Recorded agent task/);
});

test("does not claim stale/paused activity is running or replace an actual outcome with assignment context", () => {
    for (const [status, title] of [["stale", "Task activity unconfirmed"], ["unsettled", "Task activity unconfirmed"],
        ["paused", "Work paused"], ["needs-input", "Awaiting input"]]) {
        assert.equal(workOutcome({ status, label: "Recorded assignment" }).title, title);
    }
    const review = { kind: "review", agree: false, summary: "Actual final review finding." };
    const work = { kind: "work", status: "complete", summary: "Actual final work summary." };
    for (const status of ["running", "pending", "completed"]) {
        for (const workResult of [review, work]) {
            const result = workOutcome({ status, taskTitle: "Assigned task", workResult });
            assert.equal(result.summary, workResult.summary);
            assert.equal(result.contextOnly, undefined);
        }
    }
    assert.equal(workOutcome({ status: "completed", taskTitle: "Assigned task" }).title, "Work outcome unavailable");
    assert.equal(workOutcome({ status: "error", taskTitle: "Assigned task" }).contextOnly, undefined);
});
