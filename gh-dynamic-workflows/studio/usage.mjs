import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

const fields = ["inputTokens", "cacheReadTokens", "outputTokens"];
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => typeof value === "string" && value.length > 0 ? value : null;
const text = (value) => typeof value === "string";
const entries = (value, fields) => Array.isArray(value) && value.every((item) =>
    item !== null && typeof item === "object" && fields.every((field) => text(item[field])));

// Deliberately project only display fields, never arbitrary report artifacts.
function projectCard(value, state) {
    if (value === undefined) return null;
    const scalar = ["role", "action", "goal", "doneWhen", "mustAct", "evidence", "cause", "humanAction", "humanActionEvidence"];
    const lists = ["components", "flows", "flowSteps", "locations", "failureCategories"];
    const categories = ["Identity/access", "Network/connectivity", "Configuration", "Deployment/build",
        "Application logic", "UI/presentation", "Data", "Unknown"];
    if (!value || scalar.some((key) => !text(value[key])) ||
        ["role", "action", "goal", "doneWhen"].some((key) => !value[key].trim()) ||
        lists.some((key) => !Array.isArray(value[key]) || value[key].some((item) => !text(item) || !item.trim())) ||
        value.failureCategories.some((category) => !categories.includes(category)) ||
        !["not-yet-verified", "passed", "failed", "partial"].includes(value.verification?.status) ||
        !text(value.verification.evidence) ||
        (value.verification.status !== "not-yet-verified" && !value.verification.evidence.trim()) ||
        (Boolean(value.humanAction.trim()) !== Boolean(value.humanActionEvidence.trim()))) {
        state.warnings.add("Malformed work-card metadata was skipped; component/flow context may be unavailable.");
        return null;
    }
    return {
        ...Object.fromEntries(scalar.map((key) => [key, value[key].slice(0, 4000)])),
        ...Object.fromEntries(lists.map((key) => [key, value[key].slice(0, 100).map((item) => item.slice(0, 1000))])),
        verification: { status: value.verification.status, evidence: value.verification.evidence.slice(0, 4000) },
    };
}

function governanceResult(result) {
    if (text(result?.summary) &&
        entries(result.requiredCorrections, ["id", "requirement", "evidence", "action"]) &&
        entries(result.scopeQuestions, ["id", "request", "evidence"]) &&
        (result.reusedDispositions === undefined || entries(result.reusedDispositions, ["priorReference", "evidence"]))) {
        return { stage: "triage", summary: [
            result.summary,
            ...result.requiredCorrections.map((item) => `Required correction ${item.id}: ${item.action} Criterion: ${item.requirement} Evidence: ${item.evidence}`),
            ...result.scopeQuestions.map((item) => `Unresolved scope ${item.id}: ${item.request} Evidence: ${item.evidence}`),
            ...(result.reusedDispositions ?? []).map((item) => `Prior disposition reused: ${item.priorReference}. Evidence: ${item.evidence}`),
            ...(!result.requiredCorrections.length && !result.scopeQuestions.length ? ["No new corrections or scope questions."] : []),
        ].join("\n") };
    }
    if (entries(result?.assessments, ["id", "necessity", "rationale", "simplestOption"]) &&
        result.assessments.every((item) => ["required", "enhancement"].includes(item.necessity))) {
        return { stage: "scope-advice", summary: result.assessments.map((item) =>
            `${item.id}: ${item.necessity}. ${item.rationale} Simplest option: ${item.simplestOption}`
        ).join("\n") || "No scope assessments." };
    }
    if (entries(result?.decisions, ["id", "disposition", "rationale", "action", "acceptance", "taskBoundary"]) &&
        result.decisions.every((item) => ["required", "approve", "defer", "decline"].includes(item.disposition))) {
        return { stage: "scope-decision", summary: result.decisions.map((item) => [
            `${item.id}: ${item.disposition}. ${item.rationale}`,
            item.action ? `Action: ${item.action}` : null,
            item.acceptance ? `Acceptance: ${item.acceptance}` : null,
            item.taskBoundary ? `Task boundary: ${item.taskBoundary}` : null,
        ].filter(Boolean).join(" ")).join("\n") || "No scope decisions." };
    }
    return null;
}

function projectCheckReview(result) {
    if (typeof result?.checksValid !== "boolean" || !text(result.feedback) ||
        !entries(result.findings, ["type", "summary", "action"]) ||
        result.findings.some((item) => !["observation", "blocking"].includes(item.type))) return null;
    return {
        checksValid: result.checksValid,
        summary: result.feedback.slice(0, 12_000),
        findings: result.findings.slice(0, 100).map((item) => ({
            type: item.type, summary: item.summary.slice(0, 4000), action: item.action.slice(0, 4000),
            ...(["original-requirement", "approved-amendment", "demonstrated-defect"].includes(item.basis)
                ? { basis: item.basis } : {}),
            ...(text(item.reason) ? { reason: item.reason.slice(0, 4000) } : {}),
            ...(text(item.evidence) ? { evidence: item.evidence.slice(0, 1000) } : {}),
            ...(text(item.requirement?.path) && Number.isSafeInteger(item.requirement.line) && item.requirement.line > 0
                ? { requirement: { path: item.requirement.path.slice(0, 1000), line: item.requirement.line } } : {}),
            ...(text(item.failingCheck) ? { failingCheck: item.failingCheck.slice(0, 1000) } : {}),
            ...(text(item.scope) ? { scope: item.scope.slice(0, 1000) } : {}),
        })),
    };
}

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
        state.results.set(event.agentId, { kind: "unavailable", status: "unsupported", names: [] });
        const candidate = content.match(/<<<WORKFLOW_JSON>>>\s*([\s\S]*?)\s*<<<END_WORKFLOW_JSON>>>/)?.[1] ??
            content.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "");
        let result;
        try { result = JSON.parse(candidate); }
        catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            if (content.includes("<<<WORKFLOW_JSON>>>") || content.trim().startsWith("{") || content.trim().startsWith("```json")) {
                state.results.set(event.agentId, { kind: "unavailable", status: "malformed", names: [] });
                state.warnings.add("Malformed structured final outcome was skipped; a work outcome may be unavailable.");
            }
            return;
        }
        const checkReview = projectCheckReview(result);
        const review = result?.checksValid === undefined && typeof result?.agree === "boolean" && typeof result.feedback === "string";
        const work = ["complete", "rework", "needs-replan", "needs-input"].includes(result?.status) && typeof result.summary === "string";
        const governance = governanceResult(result);
        if (!checkReview && !review && !work && !governance) return;
        const card = projectCard(result.workCard, state);
        if (checkReview) {
            state.results.set(event.agentId, { kind: "review", ...checkReview, names: [], assignments: [], card });
            return;
        }
        if (!review && !work) {
            state.results.set(event.agentId, { kind: "governance", ...governance,
                summary: governance.summary.slice(0, 12_000), names: [], card });
            return;
        }
        const names = [];
        const assignments = [];
        for (const item of [...(Array.isArray(result.artifact?.ReleasePlan?.sprints) ? result.artifact.ReleasePlan.sprints : []),
            ...(Array.isArray(result.artifact?.SprintPlan?.tasks) ? result.artifact.SprintPlan.tasks : [])]) {
            if (identifier(item?.id) && identifier(item.title ?? item.name)) names.push([item.id, item.title ?? item.name]);
        }
        const taskMetadata = Array.isArray(result.taskCards) ? result.taskCards
            : Array.isArray(result.artifact?.SprintPlan?.tasks) ? result.artifact.SprintPlan.tasks : [];
        for (const task of taskMetadata) {
            const plannedCard = projectCard(task?.workCard, state);
            if (identifier(task?.id) && plannedCard) {
                assignments.push([task.id, plannedCard]);
                if (!names.some(([id]) => id === task.id)) names.push([task.id, plannedCard.action]);
            }
        }
        let correctionAssessments;
        if (work && result.correctionAssessments !== undefined) {
            if (entries(result.correctionAssessments, ["correctionId", "verdict", "reason", "evidence"]) &&
                result.correctionAssessments.every((item) => ["confirmed", "refuted", "unresolved"].includes(item.verdict))) {
                correctionAssessments = result.correctionAssessments.slice(0, 100).map((item) => ({
                    correctionId: item.correctionId.slice(0, 1000), verdict: item.verdict,
                    reason: item.reason.slice(0, 4000), evidence: item.evidence.slice(0, 1000),
                }));
            } else state.warnings.add("Malformed correction assessments were skipped; owner judgments may be unavailable.");
        }
        state.results.set(event.agentId, {
            kind: review ? "review" : "work", agree: review ? result.agree : null,
            status: work ? result.status : null,
            taskComplete: review && typeof result.taskComplete === "boolean" ? result.taskComplete : null,
            summary: (review ? result.feedback : result.summary).slice(0, 12_000), names, card, assignments,
            ...(correctionAssessments ? { correctionAssessments } : {}),
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

export function agentWork(state, runId, agent, agents = []) {
    const resultFor = (target) => {
        const ids = new Set([target.id, target.toolCallId].filter(Boolean));
        return [...state.results].find(([id]) => {
            const binding = state.bindings.get(id);
            return binding ? binding.runId === runId && ids.has(binding.toolCallId) : ids.has(id);
        })?.[1];
    };
    const result = resultFor(agent);
    const ownerLabel = agent.label?.replace(/:reviewer:[^:]+:(\d+)$/, ":doer:$1");
    const owner = ownerLabel !== agent.label ? agents.find((candidate) => candidate.label === ownerLabel) : null;
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
    const assignment = agent.label?.match(/^(.*)\/task\/([^/:]+)(?:\/plan-round\/(\d+))?(?:\/resume\/\d+)?\/[^:]+:/);
    const planner = assignment ? agents.find((candidate) =>
        candidate.label === `${assignment[1]}/SprintPlanLoop:doer:${assignment[3] ?? 1}`) : null;
    const plannedCard = planner ? resultFor(planner)?.assignments?.find(([id]) => id === taskId)?.[1] : null;
    const taskCard = result?.card ?? plannedCard ?? null;
    if (!result || result.kind === "unavailable") return {
        taskTitle, taskCard, taskCardSource: taskCard ? "Recorded assignment" : null,
        workResult: null, workOutcomeState: result?.status ?? "missing",
    };
    if (result.kind === "governance" && agent.label?.match(/:governance:([^:]+):[^:]+:\d+$/)?.[1] !== result.stage) {
        return { taskTitle, taskCard: null, workResult: null, workOutcomeState: "unsupported" };
    }
    let summary = result.summary;
    const replacements = new Map(known);
    if (known.length) {
        const alternatives = known.map(([id]) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
        const pattern = new RegExp(`(?<![\\w-])(?:${alternatives.join("|")})(?![\\w-])`, "g");
        summary = summary.replace(pattern, (id) => replacements.get(id));
    }
    return { taskTitle, taskCard, taskCardSource: result.card ? "Structured final agent response"
        : taskCard ? "Recorded assignment" : null, workResult: {
        kind: result.kind, ...(typeof result.checksValid === "boolean" ? {} : { agree: result.agree }), status: result.status, summary,
        ...(result.kind === "governance" ? { stage: result.stage } : {}),
        ...(result.correctionAssessments ? { correctionAssessments: result.correctionAssessments } : {}),
        ...(result.kind === "review" && typeof result.checksValid === "boolean"
            ? { checksValid: result.checksValid, findings: result.findings }
            : result.kind === "review" ? { taskComplete: result.taskComplete, ownerStatus: owner ? resultFor(owner)?.status ?? null : null } : {}),
        source: "Structured final agent response",
    } };
}
