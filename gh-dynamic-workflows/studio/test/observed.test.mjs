import { test } from "node:test";
import assert from "node:assert/strict";
import { observedFlow, outcome, stopReason, summarizeEvidence, queryTeam, taskLabel, processModel, tokenText, workOutcome, cardContext, cardLocation, cardFields } from "../observed.mjs";
import { workCard } from "./fixture.mjs";

test("semantic headings retain the full role/action and expose scoped goals, failure evidence and unverified state", () => {
    const record = { id: "api", startedAt: 2, status: "completed", taskCard: workCard(), taskCardSource: "Structured final agent response",
        workResult: { kind: "work", status: "rework", summary: "Permission denied." } };
    assert.equal(taskLabel(record), "Developer: Fix database-write access in QuestionAnswer API");
    const fields = cardFields(record);
    assert.equal(fields.Components, "QuestionAnswer API");
    assert.equal(fields.Flows, "Question-Answer");
    assert.equal(fields["Failure category"], "Identity/access");
    assert.equal(fields.Location, "infra\\");
    assert.equal(fields.Verification, "Not yet verified");
    assert.equal(fields["Action required from you"], "");
    assert.equal(outcome(record, { agent: true }).tone, "waiting");
    assert.match(JSON.stringify(queryTeam(run([record]), "Question-Answer")), /database-write/);
    const human = cardFields({ ...record, taskCard: workCard({
        humanAction: "Approve the requested scope.", humanActionEvidence: "The requested scope exceeds authorized deployment.",
    }) });
    assert.equal(human["Action required from you"], "Approve the requested scope.");
    assert.equal(cardFields({ taskCard: workCard({ humanAction: "Unsupported request." }) })["Action required from you"], "");
});

test("pending reviews and triage identify their own work rather than pretending to implement the plan", () => {
    const planned = { taskCard: workCard(), taskCardSource: "Recorded assignment" };
    assert.equal(taskLabel({ ...planned, label: "yaml:DeveloperLoop:reviewer:Critic:2" }),
        "Critic: Review Fix database-write access in QuestionAnswer API");
    assert.equal(cardContext({ ...planned, label: "yaml:DeveloperLoop:reviewer:Critic:2" }).mustAct, "");
    assert.equal(taskLabel({ ...planned, label: "yaml:DeveloperLoop:governance:triage:Scrum Master:2" }),
        "Scrum Master: Reconcile feedback for Fix database-write access in QuestionAnswer API");
    assert.equal(taskLabel({ taskTitle: "Fix database-write access in QuestionAnswer API",
        label: "yaml:AssignedWorkDeveloperLoop:doer:1" }),
        "Fix database-write access in QuestionAnswer API");
});

test("code location is one file or one meaningful folder, not an overly broad shared ancestor", () => {
    assert.equal(cardLocation(["api\\write.ts"]), "api\\write.ts");
    assert.equal(cardLocation(["api\\write.ts", "api\\read.ts"]), "api\\");
    assert.equal(cardLocation(["api/write.ts", "api/read.ts"]), "api\\");
    assert.equal(cardLocation(["api\\one\\write.ts", "api\\two\\read.ts"]), "");
    assert.equal(cardLocation(["api\\one\\", "api\\two\\"]), "");
    assert.equal(cardLocation(["one.ts", "two.ts"]), "");
    assert.equal(cardLocation([]), "");
});

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
    assert.equal(workOutcome({ workResult: { kind: "review", agree: true, summary: "Agree with the reported FAIL." } }).title, "Report agreed; completion unconfirmed");
    assert.equal(workOutcome({ workResult: { kind: "review", agree: true, summary: "PASS: Customer Activity Screen is correct.", ownerStatus: "rework" } }).title, "Agrees: task still incomplete");
    assert.equal(outcome({ status: "completed", workResult: { kind: "review", agree: false, summary: "Filtering drops the selected customer." } }, { agent: true }).tone, "error");
    assert.equal(taskLabel({ taskTitle: "Customer Activity Screen" }), "Customer Activity Screen");
});

test("new owner profiles retain historical doer attribution; read-only feedback roles are not acceptance reviewers", () => {
    const label = "yaml-loops-v1:sprint/1/s1/task/api/AssignedWorkDeveloperLoop";
    for (const agentType of ["workflow-doer", "workflow-owner"]) {
        assert.equal(taskLabel({ agentType, label: `${label}:doer:2` }), "Assigned Work Developer doer");
    }
    for (const [stage, role, title] of [
        ["triage", "Scrum Master", "Scrum Master triage"],
        ["scope-advice", "Architect", "Architect scope advice"],
        ["scope-decision", "Product Owner", "Product Owner scope decision"],
    ]) {
        const record = { status: "running", agentType: "workflow-reviewer", label: `${label}:governance:${stage}:${role}:2` };
        assert.equal(taskLabel(record), title);
        const result = workOutcome(record);
        assert.match(result.summary, new RegExp(`${role} read-only ${stage} feedback coordination`));
        assert.match(result.summary, /not an original acceptance vote/);
    }
});

test("check reviews judge suitability without treating raw blocking claims as validated acceptance", () => {
    for (const checksValid of [true, false]) {
        for (const findings of [[], [{ type: "observation", summary: "No live evidence.", action: "Retain limitation." }],
            [{ type: "blocking", summary: "Null input fails.", action: "Handle null.",
                requirement: { path: "docs/spec.md", line: 12 }, failingCheck: "null-input", scope: "API handoff" }]]) {
            const record = { status: "completed", workResult: { kind: "review", checksValid, findings,
                summary: "Review submitted.", agree: true, taskComplete: true, ownerStatus: "complete" } };
            const result = workOutcome(record);
            assert.equal(result.title, !checksValid ? "Check suitability changes requested"
                : findings[0]?.type === "blocking" ? "Checks suitable; blocking claims submitted"
                    : "Checks suitable; acceptance unconfirmed");
            assert.equal(result.tone, checksValid ? "waiting" : "error");
            assert.match(result.summary, /assessment of check suitability, not task completion or final acceptance/);
            assert.match(result.summary, /not runtime-verified by Studio/);
            assert.match(result.summary, /blocking claims require runtime validation/);
            assert.equal(outcome(record, { agent: true }).tone, result.tone);
            if (findings.length) {
                assert.match(result.summary, /Submitted (observation|blocking claim):/);
                assert.match(result.summary, new RegExp(findings[0].action));
            }
            if (findings[0]?.type === "blocking") {
                assert.match(result.summary, /Requirement: docs\/spec.md:12/);
                assert.match(result.summary, /Submitted failing check: null-input/);
                assert.match(result.summary, /Scope: API handoff/);
            }
        }
    }
    const bounded = workOutcome({ workResult: { kind: "review", checksValid: true, findings: [],
        summary: "x".repeat(20_000) } });
    assert.equal(bounded.summary.length, 12_000);
    assert.match(bounded.summary, /not runtime-verified by Studio/);
});

test("completed governance shows its retained outcome without becoming an acceptance vote", () => {
    for (const [stage, title] of [["triage", "Feedback reconciled"], ["scope-advice", "Scope advice recorded"],
        ["scope-decision", "Scope decision recorded"]]) {
        const result = workOutcome({ status: "completed", workResult: {
            kind: "governance", stage, summary: "Original acceptance remains binding.",
        } });
        assert.equal(result.title, title);
        assert.equal(result.tone, "waiting");
        assert.match(result.summary, /Original acceptance remains binding/);
        assert.match(result.summary, /not an original acceptance vote/);
        assert.doesNotMatch(result.summary, /unavailable|not retained/);
    }
    assert.match(workOutcome({ status: "completed", workOutcomeState: "unsupported" }).summary, /final response is retained.*display limitation/);
    assert.match(workOutcome({ status: "completed", workOutcomeState: "malformed" }).summary, /retained.*could not be parsed/);
    assert.match(workOutcome({ status: "completed", workOutcomeState: "missing" }).summary, /No final response was found/);
});

test("review agreement keeps task acceptance and live capability separate", () => {
    for (const [ownerStatus, title] of [["rework", "Agrees: task still incomplete"],
        ["needs-replan", "Agrees: scoped replanning needed"], ["needs-input", "Agrees: human input needed"]]) {
        const result = workOutcome({ workResult: { kind: "review", agree: true, ownerStatus, summary: "PASS: accurate finding." } });
        assert.equal(result.title, title);
        assert.equal(result.tone, "waiting");
        assert.match(result.summary, /not the assignment's combined acceptance or proof of live capability/);
    }
    assert.equal(workOutcome({ workResult: { kind: "review", agree: true, ownerStatus: "complete",
        taskComplete: true, summary: "Bounded research complete; liveReady:false." } }).title, "Completion report agreed");
    assert.equal(workOutcome({ workResult: { kind: "review", agree: true, ownerStatus: "complete",
        taskComplete: false, summary: "Accurate report, missing handoff." } }).tone, "waiting");
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
