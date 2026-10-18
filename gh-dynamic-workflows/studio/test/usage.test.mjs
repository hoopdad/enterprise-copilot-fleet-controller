import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { UsageReader, agentUsage, agentWork } from "../usage.mjs";
import { usageEvent, workEvent } from "./fixture.mjs";

async function logFixture(t) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "studio-usage-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return path.join(dir, "events.jsonl");
}
const lines = (events, newline = "\n") => events.map((event) => JSON.stringify(event)).join(newline) + newline;
const started = (agentId, toolCallId, workflowRunId = "run") => ({
    type: "subagent.started", agentId, data: { toolCallId, workflowRunId },
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
