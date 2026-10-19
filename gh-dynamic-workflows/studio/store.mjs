import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inside } from "./source.mjs";
import { UsageReader, agentUsage, agentWork, unavailableUsage } from "./usage.mjs";

const sessionIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const runIdPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const json = (text) => text == null ? null : JSON.parse(text);
const activeStatuses = new Set(["running", "queued", "pending"]);
const terminalStatuses = new Set(["completed", "error", "halted", "cancelled"]);

export function workspaceCwd(text) {
    const raw = text.match(/^cwd:\s*(.+)$/m)?.[1]?.trim();
    if (!raw) return null;
    if (raw.startsWith('"')) return JSON.parse(raw);
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
    return raw;
}

function database(file, callback) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 100;");
        const version = db.prepare("SELECT version FROM workflow_store_schema WHERE singleton = 1").get()?.version;
        if (version !== 1) throw new Error(`Unsupported workflow storage schema ${version ?? "unknown"}; expected 1`);
        db.exec("BEGIN");
        try {
            const result = callback(db);
            db.exec("COMMIT");
            return result;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
}

function summary(row, sessionId, now) {
    const stale = row.status === "running" && (!row.lease_expires_at_ms || row.lease_expires_at_ms < now);
    return {
        sessionId, runId: row.run_id, workflowName: row.workflow_name, description: row.description,
        status: row.status, stale, attempt: row.attempt, revision: row.revision,
        createdAt: row.created_at_ms, startedAt: row.started_at_ms,
        updatedAt: row.updated_at_ms, completedAt: row.completed_at_ms, currentPhaseId: row.current_phase_id,
        consumed: {
            subagents: row.consumed_subagents, nanoAiu: row.consumed_nano_aiu,
            // Keep raw billing units; do not guess an AI-credit conversion.
            activeMs: row.elapsed_ms + (!stale && row.active_segment_started_at_ms
                ? Math.max(0, now - row.active_segment_started_at_ms) : 0),
        },
    };
}
const columns = `run_id, workflow_name, description, status, attempt, revision, created_at_ms,
    started_at_ms, updated_at_ms, completed_at_ms, current_phase_id, consumed_subagents,
    consumed_nano_aiu, elapsed_ms, active_segment_started_at_ms, lease_expires_at_ms`;

export class WorkflowStore {
    constructor(projectRoot, { sessionsRoot = path.join(os.homedir(), ".copilot", "session-state") } = {}) {
        this.projectRoot = projectRoot;
        this.sessionsRoot = sessionsRoot;
        this.sessions = new Map();
        this.usage = new UsageReader();
    }

    async discover() {
        const root = await realpath(this.projectRoot);
        const entries = await readdir(this.sessionsRoot, { withFileTypes: true });
        const sessions = new Map();
        const warnings = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !sessionIdPattern.test(entry.name)) continue;
            const folder = path.join(this.sessionsRoot, entry.name);
            try {
                const cwd = workspaceCwd(await readFile(await inside(folder, "workspace.yaml"), "utf8"));
                if (!cwd) continue;
                let resolved;
                try { resolved = await realpath(cwd); }
                catch (error) { if (error.code === "ENOENT") continue; throw error; }
                if (resolved !== root) continue;
                const file = await inside(folder, "session.db");
                if (!(await lstat(file)).isFile()) throw new Error("session.db is not a regular file");
                sessions.set(entry.name, file);
            } catch (error) {
                if (error.code !== "ENOENT") warnings.push(`${entry.name}: ${error.message}`);
            }
        }
        this.sessions = sessions;
        return warnings;
    }

    async listRuns({ discover = true } = {}) {
        const warnings = discover ? await this.discover() : [];
        const now = Date.now();
        const runs = [];
        for (const [sessionId, file] of this.sessions) {
            try {
                runs.push(...database(file, (db) => db.prepare(`SELECT ${columns} FROM workflow_runs
                    ORDER BY created_at_ms DESC, run_id DESC`).all()).map((row) => summary(row, sessionId, now)));
            } catch (error) { warnings.push(`${sessionId}: ${error.message}`); }
        }
        runs.sort((a, b) => b.createdAt - a.createdAt || a.runId.localeCompare(b.runId));
        return { runs, warnings, observedAt: now, source: "read-only local workflow storage v1", sessionCount: this.sessions.size };
    }

    async detail(sessionId, runId, { beforeSeq, limit = 200 } = {}) {
        if (!sessionIdPattern.test(sessionId) || !runIdPattern.test(runId)) throw new Error("Invalid session or run identifier");
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Progress limit must be 1-1000");
        if (beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) throw new Error("Invalid progress cursor");
        const file = this.sessions.get(sessionId);
        if (!file) throw new Error("Session is not in the selected project; refresh session discovery");
        // Revalidate both scope and physical location before every database open.
        const folder = path.join(this.sessionsRoot, sessionId);
        const cwd = workspaceCwd(await readFile(await inside(folder, "workspace.yaml"), "utf8"));
        if (!cwd || await realpath(cwd) !== await realpath(this.projectRoot) || await inside(folder, "session.db") !== file) {
            throw new Error("Session location or selected project changed");
        }
        const now = Date.now();
        const detail = database(file, (db) => {
            const row = db.prepare(`SELECT ${columns}, declared_phases_json, declared_limits_json,
                approved_limits_json, result_json, error, failure_json, reason FROM workflow_runs WHERE run_id = ?`).get(runId);
            if (!row) throw new Error("Workflow run not found");
            const run = summary(row, sessionId, now);
            const phases = db.prepare(`SELECT phase_id, ordinal, title, detail, entry_count, last_entered_attempt,
                started_at_ms, completed_at_ms, accumulated_active_ms, active_started_at_ms
                FROM workflow_phases WHERE run_id = ? ORDER BY COALESCE(ordinal, 2147483647), started_at_ms, phase_id`).all(runId)
                .map((phase) => ({
                    id: phase.phase_id, title: phase.title, detail: phase.detail,
                    entries: phase.entry_count, lastAttempt: phase.last_entered_attempt,
                    startedAt: phase.started_at_ms, completedAt: phase.completed_at_ms,
                    activeMs: phase.accumulated_active_ms + (!run.stale && run.status === "running" && phase.active_started_at_ms
                        ? Math.max(0, now - phase.active_started_at_ms) : 0),
                    status: phase.entry_count === 0 ? "not_started" : phase.phase_id !== row.current_phase_id ? "visited"
                        : run.stale ? "stale" : row.status === "completed" ? "ended" : row.status,
                }));
            const agentColumns = new Set(db.prepare("PRAGMA table_info(workflow_agents)").all().map((column) => column.name));
            const toolCallId = agentColumns.has("tool_call_id") ? "tool_call_id" : "NULL AS tool_call_id";
            const agents = db.prepare(`SELECT agent_id, ${toolCallId}, phase_id, label, agent_type, status, requested_model, resolved_model,
                started_at_ms, completed_at_ms, active_ms FROM workflow_agents WHERE run_id = ?
                ORDER BY started_at_ms, agent_id`).all(runId).map((agent) => ({
                    id: agent.agent_id, toolCallId: agent.tool_call_id, phaseId: agent.phase_id, label: agent.label, agentType: agent.agent_type,
                    status: activeStatuses.has(agent.status) && (run.stale || row.status !== "running")
                        ? run.stale ? "stale" : "unsettled" : agent.status,
                    model: agent.resolved_model ?? agent.requested_model,
                    requestedModel: agent.requested_model, resolvedModel: agent.resolved_model, startedAt: agent.started_at_ms,
                    completedAt: agent.completed_at_ms, activeMs: agent.active_ms,
                }));
            const progress = db.prepare(`SELECT seq, attempt, phase_id, kind, text, recorded_at FROM workflow_progress
                WHERE run_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`).all(runId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1);
            const hasOlder = progress.length > limit;
            const lines = progress.slice(0, limit).reverse().map((line) => ({
                seq: line.seq, attempt: line.attempt, phaseId: line.phase_id, kind: line.kind,
                text: line.text, recordedAt: line.recorded_at,
            }));
            return {
                ...run, observedAt: now, phases, agents,
                declaredPhases: json(row.declared_phases_json), declaredLimits: json(row.declared_limits_json),
                approvedLimits: json(row.approved_limits_json),
                result: json(row.result_json), error: row.error, failure: json(row.failure_json), reason: row.reason,
                progress: { lines, hasOlder, oldestSeq: lines[0]?.seq ?? null },
                terminal: terminalStatuses.has(row.status), liveAgentCount: agents.filter((agent) => activeStatuses.has(agent.status)).length,
                notice: "Read-only local evidence. Session logs supply usage, exact agent attribution and structured final outcomes/task titles only. Prompts, reasoning, tool arguments, other message text and journal payloads are not retained or exposed. Agent completion alone is not review acceptance.",
            };
        });
        detail.usageWarnings = [];
        try {
            const usageFile = await inside(folder, "events.jsonl");
            const usage = await this.usage.read(usageFile);
            detail.agents.forEach((agent) => {
                agent.usage = agentUsage(usage, runId, agent);
                Object.assign(agent, agentWork(usage, runId, agent, detail.agents));
            });
            detail.usageWarnings = [...usage.warnings];
        } catch (error) {
            const message = error.code === "ENOENT" ? "Session usage log is not available."
                : `Token usage unavailable: ${error.message}`;
            detail.agents.forEach((agent) => { agent.usage = unavailableUsage(message); });
            if (error.code !== "ENOENT") detail.usageWarnings.push(message);
        }
        return detail;
    }
}
