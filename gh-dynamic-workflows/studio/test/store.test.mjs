import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { WorkflowStore, workspaceCwd } from "../store.mjs";
import { fixture, SESSION, OUTSIDE_SESSION } from "./fixture.mjs";

test("reads YAML cwd forms without treating backslashes as escapes", () => {
    assert.equal(workspaceCwd("cwd: C:\\project\n"), "C:\\project");
    assert.equal(workspaceCwd('cwd: "C:\\\\project"\n'), "C:\\project");
    assert.equal(workspaceCwd("cwd: '/home/it''s'\n"), "/home/it's");
    assert.equal(workspaceCwd("other: x"), null);
});

test("lists only matching project sessions and leaves database bytes and files unchanged", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const before = await readFile(f.dbFile);
    const beforeFiles = await readdir(path.dirname(f.dbFile));
    const store = new WorkflowStore(f.project, { sessionsRoot: f.sessionsRoot });
    const listing = await store.listRuns();
    assert.equal(listing.runs.length, 3);
    assert.equal(listing.sessionCount, 1);
    assert.deepEqual(listing.warnings, []);
    assert.ok(listing.runs.every((run) => run.sessionId === SESSION));
    const detail = await store.detail(SESSION, "live-run");
    assert.equal(detail.status, "running");
    assert.equal(detail.liveAgentCount, 1);
    assert.ok(detail.consumed.activeMs >= 1500);
    assert.deepEqual(detail.phases.map((phase) => phase.status), ["visited", "running", "not_started"]);
    const serialized = JSON.stringify(detail);
    assert.ok(!serialized.includes("PRIVATE-ARGS"));
    assert.ok(!serialized.includes("PRIVATE-JOURNAL"));
    assert.ok(!serialized.includes("PRIVATE-MESSAGE"));
    assert.equal(detail.agents[0].usage.inputTokens, 1200);
    assert.equal(detail.agents[0].usage.cacheReadTokens, 0);
    assert.equal(detail.agents[0].usage.outputTokens, 240);
    assert.deepEqual(await readFile(f.dbFile), before);
    assert.deepEqual(await readdir(path.dirname(f.dbFile)), beforeFiles);
    await assert.rejects(store.detail(OUTSIDE_SESSION, "live-run"), /not in the selected project/);
});

test("pages durable progress without gaps and refreshes mutable run state", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const store = new WorkflowStore(f.project, { sessionsRoot: f.sessionsRoot });
    await store.listRuns();
    const first = await store.detail(SESSION, "live-run");
    assert.equal(first.progress.lines.length, 200);
    assert.equal(first.progress.oldestSeq, 206);
    const second = await store.detail(SESSION, "live-run", { beforeSeq: 206 });
    const third = await store.detail(SESSION, "live-run", { beforeSeq: second.progress.oldestSeq });
    assert.equal(third.progress.hasOlder, false);
    const lines = [...third.progress.lines, ...second.progress.lines, ...first.progress.lines];
    assert.deepEqual(lines.map((line) => line.seq), Array.from({ length: 405 }, (_, i) => i + 1));
    f.mutate((db) => db.exec("UPDATE workflow_runs SET revision = 8 WHERE run_id = 'live-run'"));
    assert.equal((await store.detail(SESSION, "live-run")).revision, 8);
});

test("stale leases are explicit and completed envelopes do not imply successful delivery", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const store = new WorkflowStore(f.project, { sessionsRoot: f.sessionsRoot });
    await store.listRuns();
    const stale = await store.detail(SESSION, "stale-run");
    assert.equal(stale.stale, true);
    assert.equal(stale.liveAgentCount, 0);
    assert.equal(stale.agents[0].status, "stale");
    assert.equal(stale.phases[1].status, "stale");
    assert.equal(stale.consumed.activeMs, 500);
    const past = await store.detail(SESSION, "past-run");
    assert.equal(past.status, "completed");
    assert.equal(past.result.status, "blocked");
    assert.equal(past.phases[1].status, "ended");
    assert.equal(past.liveAgentCount, 0);
    assert.equal(past.agents[0].status, "unsettled");
    assert.equal(past.agents[0].usage.inputTokens, null);
});

test("rejects schema changes, unsafe IDs and scope changes instead of silently hiding them", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const store = new WorkflowStore(f.project, { sessionsRoot: f.sessionsRoot });
    await store.listRuns();
    await assert.rejects(store.detail("../x", "live-run"), /Invalid/);
    await assert.rejects(store.detail(SESSION, "live-run", { beforeSeq: NaN }), /cursor/);
    f.mutate((db) => db.exec("UPDATE workflow_store_schema SET version = 2"));
    const result = await store.listRuns({ discover: false });
    assert.equal(result.runs.length, 0);
    assert.match(result.warnings[0], /Unsupported workflow storage schema 2/);
    await writeFile(path.join(path.dirname(f.dbFile), "workspace.yaml"), `cwd: ${f.base}\n`);
    await assert.rejects(store.detail(SESSION, "live-run"), /project changed/);
});
