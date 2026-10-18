import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

const fields = ["inputTokens", "cacheReadTokens", "outputTokens"];
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => typeof value === "string" && value.length > 0 ? value : null;

function emptyState(stat) {
    return {
        dev: stat.dev, ino: stat.ino, size: 0, mtimeMs: null, offset: 0, discarding: false,
        groups: new Map(), bindings: new Map(), seen: new Set(), warnings: new Set(), results: new Map(),
    };
}

function ingest(state, line) {
    // Only usage, attribution and structured final work outcomes are projected.
    if (!line.includes('"session.usage_record"') && !line.includes('"subagent.started"') &&
        !(line.includes('"assistant.message"') && line.includes('"final_answer"'))) return;
    let event;
    try { event = JSON.parse(line); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        state.warnings.add("Malformed usage/correlation metadata was skipped; token totals may be incomplete.");
        return;
    }
    if (event.type === "subagent.started") {
        const agentId = identifier(event.agentId);
        const toolCallId = identifier(event.data?.toolCallId);
        const runId = identifier(event.data?.workflowRunId);
        if (agentId && toolCallId && runId) state.bindings.set(agentId, { toolCallId, runId });
        return;
    }
    if (event.type === "assistant.message") {
        if (event.data?.phase !== "final_answer" || event.data?.toolRequests?.length || !identifier(event.agentId)) return;
        const content = event.data.content;
        if (typeof content !== "string") return;
        const candidate = content.match(/<<<WORKFLOW_JSON>>>\s*([\s\S]*?)\s*<<<END_WORKFLOW_JSON>>>/)?.[1] ??
            content.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "");
        let result;
        try { result = JSON.parse(candidate); }
        catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            if (content.includes("<<<WORKFLOW_JSON>>>") || content.trim().startsWith("{") || content.trim().startsWith("```json")) {
                state.warnings.add("Malformed structured final outcome was skipped; a work outcome may be unavailable.");
            }
            return;
        }
        const review = typeof result?.agree === "boolean" && typeof result.feedback === "string";
        const work = ["complete", "rework", "needs-input"].includes(result?.status) && typeof result.summary === "string";
        if (!review && !work) return;
        const names = [];
        for (const item of [...(Array.isArray(result.artifact?.ReleasePlan?.sprints) ? result.artifact.ReleasePlan.sprints : []),
            ...(Array.isArray(result.artifact?.SprintPlan?.tasks) ? result.artifact.SprintPlan.tasks : [])]) {
            if (identifier(item?.id) && identifier(item.title ?? item.name)) names.push([item.id, item.title ?? item.name]);
        }
        state.results.set(event.agentId, {
            kind: review ? "review" : "work", agree: review ? result.agree : null,
            status: work ? result.status : null,
            summary: (review ? result.feedback : result.summary).slice(0, 12_000), names,
        });
        return;
    }
    if (event.type !== "session.usage_record") return;
    const usage = event.data?.usage;
    if (!usage || typeof usage !== "object") {
        state.warnings.add("A usage record has no counters; token totals may be incomplete.");
        return;
    }
    const eventId = identifier(event.id);
    if (eventId && state.seen.has(eventId)) return;
    if (eventId) state.seen.add(eventId);
    const agentId = identifier(event.agentId);
    const toolCallId = identifier(usage.parentToolCallId);
    if (!agentId && !toolCallId) return;
    const model = identifier(usage.model);
    const key = JSON.stringify([agentId, toolCallId, model]);
    let group = state.groups.get(key);
    if (!group) {
        group = { agentId, toolCallId, model, records: 0,
            totals: Object.fromEntries(fields.map((field) => [field, 0])), missing: new Set() };
        state.groups.set(key, group);
    }
    group.records++;
    for (const field of fields) {
        if (!counter(usage[field]) || !counter(group.totals[field] + usage[field])) group.missing.add(field);
        else group.totals[field] += usage[field];
    }
}

export class UsageReader {
    constructor() {
        this.files = new Map();
        this.pending = new Map();
    }

    async read(file) {
        if (this.pending.has(file)) return this.pending.get(file);
        const pending = this.scan(file);
        this.pending.set(file, pending);
        try { return await pending; }
        finally { this.pending.delete(file); }
    }

    async scan(file) {
        const stat = await lstat(file);
        if (!stat.isFile()) throw new Error("Usage metadata source is not a regular file");
        let state = this.files.get(file);
        if (!state || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.size ||
            (stat.size === state.size && stat.mtimeMs !== state.mtimeMs)) {
            state = emptyState(stat);
            this.files.set(file, state);
        }
        if (stat.size <= state.offset) return state;
        let buffer = "";
        let cursor = state.offset;
        let discarding = state.discarding;
        for await (const chunk of createReadStream(file, { start: state.offset, end: stat.size - 1, encoding: "utf8" })) {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                cursor += Buffer.byteLength(line) + 1;
                if (!discarding) {
                    if (Buffer.byteLength(line) <= MAX_LINE_BYTES) ingest(state, line);
                    else state.warnings.add("Oversized event metadata was skipped; token totals may be incomplete.");
                }
                discarding = false;
                // Commit only complete lines; a concurrent append may leave a partial record.
                state.offset = cursor;
                state.discarding = false;
            }
            if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
                cursor += Buffer.byteLength(buffer);
                buffer = "";
                discarding = true;
                state.offset = cursor;
                state.discarding = true;
                state.warnings.add("Oversized event metadata was skipped; token totals may be incomplete.");
            }
        }
        state.size = stat.size;
        state.mtimeMs = stat.mtimeMs;
        return state;
    }
}

export function unavailableUsage(message = "No per-agent usage records retained.") {
    return { inputTokens: null, cacheReadTokens: null, outputTokens: null,
        records: 0, models: [], status: "unavailable", message };
}

export function agentUsage(state, runId, agent) {
    const ids = new Set([agent.id, agent.toolCallId].filter(Boolean));
    const groups = [...state.groups.values()].filter((group) => {
        const binding = state.bindings.get(group.agentId);
        if (binding) return binding.runId === runId && ids.has(binding.toolCallId);
        // An explicit different agent wins over an ancestor's tool-call id.
        return group.agentId ? ids.has(group.agentId) : ids.has(group.toolCallId);
    });
    if (!groups.length) return unavailableUsage();
    const totals = Object.fromEntries(fields.map((field) => {
        const total = groups.reduce((sum, group) => sum + group.totals[field], 0);
        return [field, groups.some((group) => group.missing.has(field)) || !counter(total) ? null : total];
    }));
    const partial = fields.some((field) => totals[field] === null) || state.warnings.size > 0;
    return {
        ...totals, records: groups.reduce((sum, group) => sum + group.records, 0),
        models: [...new Set(groups.map((group) => group.model).filter(Boolean))],
        status: partial ? "partial" : "recorded",
        message: partial ? "Some usage metadata is missing or invalid; totals may be incomplete."
            : "Recorded request totals so far. Cached means cache-read tokens; reported input is not adjusted or added to cached.",
    };
}

export function agentWork(state, runId, agent) {
    const ids = new Set([agent.id, agent.toolCallId].filter(Boolean));
    const matches = (id) => {
        const binding = state.bindings.get(id);
        return binding ? binding.runId === runId && ids.has(binding.toolCallId) : ids.has(id);
    };
    const result = [...state.results].find(([id]) => matches(id))?.[1];
    const names = new Map();
    for (const [id, work] of state.results) {
        if (state.bindings.get(id)?.runId !== runId) continue;
        for (const [key, title] of work.names) {
            if (!names.has(key)) names.set(key, new Set());
            names.get(key).add(title);
        }
    }
    const known = [...names].filter(([, titles]) => titles.size === 1).map(([id, titles]) => [id, [...titles][0]]);
    const taskId = agent.label?.match(/\/task\/([^/:]+)/)?.[1];
    const sprintId = agent.label?.match(/sprint\/\d+\/([^/:]+)/)?.[1];
    const taskTitle = known.find(([id]) => id === (taskId ?? sprintId))?.[1] ?? null;
    if (!result) return { taskTitle, workResult: null };
    let summary = result.summary;
    const replacements = new Map(known);
    if (known.length) {
        const alternatives = known.map(([id]) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
        const pattern = new RegExp(`(?<![\\w-])(?:${alternatives.join("|")})(?![\\w-])`, "g");
        summary = summary.replace(pattern, (id) => replacements.get(id));
    }
    return { taskTitle, workResult: {
        kind: result.kind, agree: result.agree, status: result.status, summary,
        source: "Structured final agent response",
    } };
}
