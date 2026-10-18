import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SESSION = "11111111-1111-4111-8111-111111111111";
export const OUTSIDE_SESSION = "22222222-2222-4222-8222-222222222222";
export const usageEvent = (id, agentId, inputTokens = 1200, cacheReadTokens = 0, outputTokens = 240, model = "test-model") => ({
    id, type: "session.usage_record", agentId,
    data: { usage: { model, inputTokens, cacheReadTokens, outputTokens, parentToolCallId: agentId } },
});
export const workEvent = (id, agentId, result) => ({
    id, type: "assistant.message", agentId,
    data: { phase: "final_answer", toolRequests: [], content: `<<<WORKFLOW_JSON>>>\n${JSON.stringify(result)}\n<<<END_WORKFLOW_JSON>>>` },
});
export const SOURCE = `globalThis.__studioExecuted = true;
export const metadata = {
  name: "example",
  description: "Fixture workflow",
  phases: ["Intake", "Build", "Review"].map(title => ({title})),
  argsSchema: {type: "object"},
};
export function run(ctx) {
  ctx.phase("Intake");
  ctx.parallel([() => ctx.agent("never execute")]);
  ctx.step("result", () => ({ok: true}));
}
`;

export async function fixture() {
    const base = await mkdtemp(path.join(os.tmpdir(), "workflow-studio-test-"));
    const project = path.join(base, "project");
    const otherProject = path.join(base, "other");
    const sessionsRoot = path.join(base, "sessions");
    const folder = path.join(sessionsRoot, SESSION);
    await mkdir(path.join(project, ".github", "extensions", "example"), { recursive: true });
    await mkdir(path.join(project, "gh-dynamic-workflows"), { recursive: true });
    await mkdir(path.join(project, "docs"), { recursive: true });
    await mkdir(folder, { recursive: true });
    await mkdir(otherProject);
    await writeFile(path.join(project, "gh-dynamic-workflows", "workflow.mjs"), SOURCE);
    await writeFile(path.join(project, ".github", "extensions", "example", "extension.mjs"),
        `import "../../../gh-dynamic-workflows/workflow.mjs";`);
    await writeFile(path.join(project, "docs", "lab-flow.json"), JSON.stringify({
        flowId: "fixture", evidenceClass: "expected-source-contract-not-live-proof",
        steps: [{ id: "intake", inputs: ["spec"], processing: "Validate", outputs: ["plan"] }],
    }));
    await writeFile(path.join(folder, "workspace.yaml"), `cwd: ${project}\n`);
    await writeFile(path.join(folder, "events.jsonl"), [
        { id: "start-a1", type: "subagent.started", agentId: "a1", data: { toolCallId: "a1", workflowRunId: "live-run" } },
        { id: "private", type: "user.message", data: { content: "PRIVATE-MESSAGE" } },
        usageEvent("usage-a1", "a1"),
        usageEvent("other-agent", "unrelated", 99999, 99999, 99999),
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const dbFile = path.join(folder, "session.db");
    const db = new DatabaseSync(dbFile);
    db.exec(`
        CREATE TABLE workflow_store_schema (singleton INTEGER PRIMARY KEY, version INTEGER);
        INSERT INTO workflow_store_schema VALUES (1, 1);
        CREATE TABLE workflow_runs (
            run_id TEXT PRIMARY KEY, workflow_name TEXT, description TEXT, status TEXT,
            attempt INTEGER, revision INTEGER, created_at_ms INTEGER, started_at_ms INTEGER,
            updated_at_ms INTEGER, completed_at_ms INTEGER, current_phase_id TEXT,
            consumed_subagents INTEGER, consumed_nano_aiu INTEGER, elapsed_ms INTEGER,
            active_segment_started_at_ms INTEGER, lease_expires_at_ms INTEGER,
            declared_phases_json TEXT, declared_limits_json TEXT, approved_limits_json TEXT,
            result_json TEXT, error TEXT, failure_json TEXT, reason TEXT, args_json TEXT
        );
        CREATE TABLE workflow_phases (
            run_id TEXT, phase_id TEXT, ordinal INTEGER, title TEXT, detail TEXT,
            entry_count INTEGER, last_entered_attempt INTEGER, started_at_ms INTEGER,
            completed_at_ms INTEGER, accumulated_active_ms INTEGER, active_started_at_ms INTEGER
        );
        CREATE TABLE workflow_agents (
            run_id TEXT, agent_id TEXT, phase_id TEXT, label TEXT, agent_type TEXT,
            status TEXT, requested_model TEXT, resolved_model TEXT, started_at_ms INTEGER,
            completed_at_ms INTEGER, active_ms INTEGER
        );
        CREATE TABLE workflow_progress (
            run_id TEXT, seq INTEGER, attempt INTEGER, phase_id TEXT, kind TEXT, text TEXT, recorded_at INTEGER
        );
        CREATE TABLE workflow_journal (journal_key TEXT, result_json TEXT);
        INSERT INTO workflow_journal VALUES ('never-read', '"PRIVATE-JOURNAL"');
    `);
    const now = Date.now();
    const insert = db.prepare("INSERT INTO workflow_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const [runId, status, ago, lease, result] of [
        ["live-run", "running", 10000, now + 3600000, null],
        ["past-run", "completed", 20000, null, '{"status":"blocked","reason":"Missing approval"}'],
        ["stale-run", "running", 30000, now - 1000, null],
    ]) {
        insert.run(runId, "example", "Fixture workflow", status, 2, 7, now - ago, now - ago,
            now - 500, status === "completed" ? now - 1000 : null, "p1", 2, 12345, 500,
            status === "running" ? now - 1000 : null, lease,
            '[{"title":"Intake"},{"title":"Build"},{"title":"Review"}]', "{}", "{}", result, null, null, null, '"PRIVATE-ARGS"');
        db.prepare("INSERT INTO workflow_phases VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(runId, "p0", 0, "Intake", null, 2, 2, now - ago, now - ago + 1000, 1000, null);
        db.prepare("INSERT INTO workflow_phases VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(runId, "p1", 1, "Build", null, 1, 2, now - ago + 1000, null, 100, now - 1000);
        db.prepare("INSERT INTO workflow_phases VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(runId, "p2", 2, "Review", null, 0, 0, null, null, 0, null);
        db.prepare("INSERT INTO workflow_agents VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(runId, "a1", "p1", "reviewer:<script>globalThis.injected=true</script>", "reader", "running",
                "test-model", null, now - ago + 1000, null, 0);
    }
    const line = db.prepare("INSERT INTO workflow_progress VALUES (?,?,?,?,?,?,?)");
    for (let seq = 1; seq <= 405; seq++) {
        line.run("live-run", seq, seq < 200 ? 1 : 2, "p1", "log", `progress ${seq}`, now - 10000 + seq);
    }
    db.close();
    const outsideFolder = path.join(sessionsRoot, OUTSIDE_SESSION);
    await mkdir(outsideFolder);
    await writeFile(path.join(outsideFolder, "workspace.yaml"), `cwd: ${otherProject}\n`);
    await writeFile(path.join(outsideFolder, "session.db"), "not a database and must never be opened");
    return {
        base, project, sessionsRoot, dbFile,
        cleanup: () => rm(base, { recursive: true, force: true }),
        mutate: (fn) => {
            const writable = new DatabaseSync(dbFile);
            try { fn(writable); } finally { writable.close(); }
        },
    };
}
