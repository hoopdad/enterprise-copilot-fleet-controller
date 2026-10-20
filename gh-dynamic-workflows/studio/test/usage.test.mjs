import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { UsageReader, agentUsage, agentWork } from "../usage.mjs";
import { usageEvent, workEvent, workCard } from "./fixture.mjs";

async function logFixture(t) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "studio-usage-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return path.join(dir, "events.jsonl");
}
const lines = (events, newline = "\n") => events.map((event) => JSON.stringify(event)).join(newline) + newline;
const started = (agentId, toolCallId, workflowRunId = "run") => ({
    type: "subagent.started", agentId, data: { toolCallId, workflowRunId },
});

test("projects bounded semantic cards, drops unrelated fields and preserves uncertainty and explicit human action", async (t) => {
    const file = await logFixture(t);
    await writeFile(file, lines([
        started("owner", "owner-call"),
        workEvent("result", "owner", { status: "rework", summary: "Write access is unresolved.",
            workCard: { ...workCard(), secret: "PRIVATE-CARD-EXTRA" }, artifact: { secret: "PRIVATE-ARTIFACT" } }),
    ]));
    const reader = new UsageReader();
    const state = await reader.read(file);
    const projected = agentWork(state, "run", { id: "owner-call" });
    assert.equal(projected.taskCard.action, "Fix database-write access in QuestionAnswer API");
    assert.equal(projected.taskCardSource, "Structured final agent response");
    assert.match(projected.taskCard.cause, /not yet identified/);
    assert.equal(projected.taskCard.verification.status, "not-yet-verified");
    assert.equal(projected.taskCard.humanAction, "");
    assert.doesNotMatch(JSON.stringify([...state.results]), /PRIVATE-/);
    assert.equal(agentWork(state, "other-run", { id: "owner-call" }).taskCard, null);
    await appendFile(file, lines([workEvent("bad-card", "owner", {
        status: "rework", summary: "Actual outcome is still retained.",
        workCard: workCard({ verification: { status: "passed", evidence: "" } }),
    })]));
    const updated = await reader.read(file);
    assert.equal(agentWork(updated, "run", { id: "owner-call" }).taskCard, null);
    assert.equal(agentWork(updated, "run", { id: "owner-call" }).workResult.summary, "Actual outcome is still retained.");
    assert.match([...updated.warnings].join(), /Malformed work-card metadata/);
});

test("pending assignment cards use only their exact sprint, replacement scope and plan round; final cards supersede plans", async (t) => {
    const file = await logFixture(t);
    const prefix = "yaml-loops-v1:sprint/1/S1/replan/old/plan-1";
    const pendingCard = workCard({ failureCategories: [], evidence: "", cause: "" });
    await writeFile(file, lines([
        started("plan", "plan-call"), started("plan-old", "old-plan-call"),
        workEvent("plan-result", "plan", { status: "complete", summary: "Assigned.",
            artifact: { SprintPlan: { path: "docs/sprint-plan.json" } },
            taskCards: [{ id: "api", workCard: pendingCard }] }),
        workEvent("old-plan-result", "plan-old", { status: "complete", summary: "Old plan.", artifact: {
            SprintPlan: { tasks: [{ id: "api", title: "Unrelated older task", workCard: workCard({ action: "Unrelated older task" }) }] },
        } }),
    ]));
    const reader = new UsageReader();
    const agents = [
        { id: "plan-call", label: `${prefix}/SprintPlanLoop:doer:2` },
        { id: "old-plan-call", label: `${prefix}/SprintPlanLoop:doer:1` },
        { id: "task", label: `${prefix}/task/api/plan-round/2/AssignedWorkDeveloperLoop:doer:1` },
    ];
    const state = await reader.read(file);
    const projected = agentWork(state, "run", agents[2], agents);
    assert.deepEqual(projected.taskCard, pendingCard);
    assert.equal(projected.taskCardSource, "Recorded assignment");
    assert.equal(agentWork(state, "run", { ...agents[2], label: agents[2].label.replace("/S1/", "/S2/") }, agents).taskCard, null);
    assert.equal(agentWork(state, "run", { ...agents[2], label: agents[2].label.replace("/plan-round/2/", "/plan-round/3/") }, agents).taskCard, null);
    assert.equal(agentWork(state, "run", { ...agents[2], label: agents[2].label.replace("/replan/old/plan-1", "") }, agents).taskCard, null);
    await appendFile(file, lines([workEvent("task-result", "task", {
        status: "rework", summary: "Write denied.", workCard: workCard({ action: "Investigate database-write permission failure" }),
    })]));
    assert.equal(agentWork(await reader.read(file), "run", agents[2], agents).taskCard.action,
        "Investigate database-write permission failure");
});

test("attributes exact agent usage, excludes parents/nested/other runs, preserves zero and deduplicates event IDs", async (t) => {
    const file = await logFixture(t);
    const first = usageEvent("one", "alias", 100, 0, 20, "model-a");
    first.data.usage.parentToolCallId = "tool-a";
    await writeFile(file, lines([
        started("alias", "tool-a"), first, first,
        usageEvent("two", "alias", 200, 100, 30, "model-b"),
        { ...usageEvent("nested", "nested-agent", 9999, 9999, 9999), data: { usage: { ...first.data.usage, inputTokens: 9999 } } },
        usageEvent("parent", null, 9999, 9999, 9999),
        { type: "user.message", data: { content: "PRIVATE-PROMPT", usage: { inputTokens: 9999 } } },
    ]));
    const before = await readFile(file);
    const reader = new UsageReader();
    const state = await reader.read(file);
    const usage = agentUsage(state, "run", { id: "a", toolCallId: "tool-a" });
    assert.equal(usage.inputTokens, 300);
    assert.equal(usage.cacheReadTokens, 100);
    assert.equal(usage.outputTokens, 50);
    assert.equal(usage.records, 2);
    assert.deepEqual(usage.models, ["model-a", "model-b"]);
    assert.equal(agentUsage(state, "different-run", { id: "a", toolCallId: "tool-a" }).inputTokens, null);
    assert.equal(agentUsage(state, "run", { id: "unknown" }).inputTokens, null);
    assert.equal(agentUsage(await reader.read(file), "run", { id: "a", toolCallId: "tool-a" }).inputTokens, 300);
    assert.deepEqual(await readFile(file), before);
    assert.ok(!JSON.stringify([...state.groups]).includes("PRIVATE-PROMPT"));
});

test("reads append-only CRLF/Unicode records incrementally and waits for incomplete lines", async (t) => {
    const file = await logFixture(t);
    await writeFile(file, lines([{ type: "user.message", data: { content: "\u00e9 PRIVATE-TEXT" } }, usageEvent("one", "a", 1, 0, 2)], "\r\n"));
    const reader = new UsageReader();
    assert.equal(agentUsage(await reader.read(file), "run", { id: "a" }).inputTokens, 1);
    const next = JSON.stringify(usageEvent("two", "a", 3, 1, 4));
    await appendFile(file, next.slice(0, 30));
    assert.equal(agentUsage(await reader.read(file), "run", { id: "a" }).inputTokens, 1);
    await appendFile(file, next.slice(30) + "\r\n");
    const [first, second] = await Promise.all([reader.read(file), reader.read(file)]);
    assert.equal(agentUsage(first, "run", { id: "a" }).inputTokens, 4);
    assert.equal(agentUsage(second, "run", { id: "a" }).records, 2);
    await writeFile(file, lines([usageEvent("replacement", "a", 8, 0, 1)]));
    assert.equal(agentUsage(await reader.read(file), "run", { id: "a" }).inputTokens, 8);
});

test("does not turn missing/invalid counters into zero and reports malformed metadata explicitly", async (t) => {
    const file = await logFixture(t);
    const absent = usageEvent("missing", "a");
    delete absent.data.usage.cacheReadTokens;
    const invalid = usageEvent("invalid", "a");
    invalid.data.usage.inputTokens = -1;
    await writeFile(file, lines([absent, invalid]) + '{"type":"session.usage_record","data":broken}\n');
    const state = await new UsageReader().read(file);
    const usage = agentUsage(state, "run", { id: "a" });
    assert.equal(usage.inputTokens, null);
    assert.equal(usage.cacheReadTokens, null);
    assert.equal(usage.outputTokens, 480);
    assert.equal(usage.status, "partial");
    assert.match([...state.warnings][0], /Malformed/);
});

test("projects structured final outcomes and unambiguous task names, never prompts, reasoning or artifacts", async (t) => {
    const file = await logFixture(t);
    await writeFile(file, lines([
        started("planner", "plan"), started("reviewer", "review"), started("other", "other", "other-run"),
        workEvent("plan", "planner", { status: "complete", summary: "Tasks assigned.", artifact: {
            SprintPlan: { tasks: [{ id: "s1-ui", title: "Customer Activity Screen" }] },
            secret: "PRIVATE-ARTIFACT",
        } }),
        workEvent("review", "reviewer", { agree: false, feedback: "Reviewer found a processing bug in s1-ui. Filtering loses the selected customer." }),
        workEvent("other", "other", { status: "complete", summary: "Other run.", artifact: {
            SprintPlan: { tasks: [{ id: "s1-ui", title: "Other Project Screen" }] },
        } }),
        { type: "assistant.message", agentId: "reviewer", data: { phase: "commentary", content: "PRIVATE-INTERMEDIATE" } },
        { type: "user.message", data: { content: "PRIVATE-PROMPT" } },
    ]));
    const state = await new UsageReader().read(file);
    const result = agentWork(state, "run", { id: "review", label: "sprint/1/S1/task/s1-ui/SomeLoop:reviewer:Critic:1" });
    assert.equal(result.taskTitle, "Customer Activity Screen");
    assert.equal(result.workResult.agree, false);
    assert.match(result.workResult.summary, /processing bug in Customer Activity Screen/);
    assert.doesNotMatch(JSON.stringify([...state.results]), /PRIVATE-/);
    assert.equal(agentWork(state, "other-run", { id: "review" }).workResult, null);
});

test("correlates review with the exact owner's round without importing other task or run outcomes", async (t) => {
    const file = await logFixture(t);
    await writeFile(file, lines([
        started("owner", "owner-call"), started("reviewer", "review-call"),
        workEvent("owner-result", "owner", { status: "needs-replan", summary: "Research scope needs correction.", artifact: {} }),
        workEvent("review-result", "reviewer", { agree: true, taskComplete: false, unmetCriteria: ["Clarify bounded handoff."], feedback: "Accurate scope finding." }),
    ]));
    const state = await new UsageReader().read(file);
    const agents = [
        { id: "owner-call", label: "yaml:sprint/1/S1/task/research/DeveloperLoop:doer:3" },
        { id: "review-call", label: "yaml:sprint/1/S1/task/research/DeveloperLoop:reviewer:Critic:3" },
    ];
    const projected = agentWork(state, "run", agents[1], agents).workResult;
    assert.equal(projected.ownerStatus, "needs-replan");
    assert.equal(projected.taskComplete, false);
    assert.equal(agentWork(state, "run", { ...agents[1], label: agents[1].label.replace(":3", ":4") }, agents).workResult.ownerStatus, null);
    assert.equal(agentWork(state, "different-run", agents[1], agents).workResult, null);
});

test("projects all governance formats without artifacts, acceptance votes or cross-run attribution", async (t) => {
    const file = await logFixture(t);
    const cases = [
        ["triage", { summary: "Original defect remains.", requiredCorrections: [
            { id: "null", requirement: "Safe handoff", evidence: "Failing null check", action: "Handle null." },
        ], scopeQuestions: [{ id: "polish", request: "Add polish", evidence: "Outside handoff" }],
        reusedDispositions: [{ priorReference: "original-reference", evidence: "Unchanged original boundary." }] }, /Handle null[\s\S]*Add polish[\s\S]*Unchanged original boundary/],
        ["scope-advice", { assessments: [{ id: "polish", necessity: "enhancement",
            rationale: "Not required.", simplestOption: "Keep current behavior." }] }, /enhancement.*Not required.*Keep current behavior/],
        ["scope-decision", { decisions: [{ id: "polish", disposition: "defer", rationale: "Outside handoff.",
            action: "", acceptance: "", taskBoundary: "" }] }, /defer.*Outside handoff/],
    ];
    await writeFile(file, lines(cases.flatMap(([stage, result]) => [
        started(stage, `${stage}-call`),
        workEvent(stage, stage, { ...result, workCard: workCard({ role: "Scrum Master", action: "Reconcile Question-Answer feedback" }),
            artifact: { secret: "PRIVATE-ARTIFACT" } }),
    ])));
    const state = await new UsageReader().read(file);
    for (const [stage, , summary] of cases) {
        const agent = { id: `${stage}-call`, label: `yaml:DeveloperLoop:governance:${stage}:Role:1` };
        const projected = agentWork(state, "run", agent);
        const work = projected.workResult;
        assert.equal(projected.taskCard.action, "Reconcile Question-Answer feedback");
        assert.equal(work.kind, "governance");
        assert.equal(work.stage, stage);
        assert.match(work.summary, summary);
        assert.equal(work.agree, undefined);
        assert.equal(work.taskComplete, undefined);
        assert.equal(agentWork(state, "different-run", agent).workResult, null);
        assert.equal(agentWork(state, "run", { ...agent, label: "yaml:DeveloperLoop:reviewer:Critic:1" }).workResult, null);
    }
    assert.doesNotMatch(JSON.stringify([...state.results]), /PRIVATE-/);
});

test("distinguishes missing, unsupported and malformed final responses and replaces them after append", async (t) => {
    const file = await logFixture(t);
    const malformed = workEvent("bad", "bad", {});
    malformed.data.content = "<<<WORKFLOW_JSON>>>{broken<<<END_WORKFLOW_JSON>>>";
    await writeFile(file, lines([
        workEvent("unknown", "unknown", { unrecognized: "PRIVATE-UNSUPPORTED" }), malformed,
        workEvent("invalid", "invalid", { assessments: [{ id: "bad", necessity: "invented", rationale: "No.", simplestOption: "No." }] }),
        workEvent("null", "null", null),
    ]));
    const reader = new UsageReader();
    const state = await reader.read(file);
    for (const [id, expected] of [["missing", "missing"], ["unknown", "unsupported"], ["bad", "malformed"], ["invalid", "unsupported"], ["null", "unsupported"]]) {
        const projected = agentWork(state, "run", { id });
        assert.equal(projected.workOutcomeState, expected);
        assert.equal(projected.workResult, null);
    }
    assert.doesNotMatch(JSON.stringify([...state.results]), /PRIVATE-UNSUPPORTED/);
    await appendFile(file, lines([workEvent("fixed", "bad", { status: "complete", summary: "Fixed.", artifact: {} })]));
    assert.equal(agentWork(await reader.read(file), "run", { id: "bad" }).workResult.summary, "Fixed.");
});
