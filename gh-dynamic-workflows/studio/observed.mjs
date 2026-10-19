const active = new Set(["running", "queued", "pending", "in-progress", "needs-input", "awaiting-input", "paused"]);
const failed = new Set(["error", "failed", "failure", "cancelled"]);
const waiting = new Set(["needs-input", "needs-replan", "awaiting-input", "limit-reached", "blocked", "paused", "halted", "stale", "unsettled"]);

function words(value, count = 5) {
    return String(value ?? "").trim().split(/\s+/).slice(0, count).join(" ").slice(0, 100);
}

export function taskLabel(agent) {
    if (agent.taskTitle) return words(agent.taskTitle);
    const text = String(agent.label ?? "").replaceAll(/[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, "")
        .replaceAll(/:{2,}/g, ":").replace(/^:|:$/g, "");
    const governance = text.match(/:governance:([^:]+):([^:]+):\d+$/);
    if (governance) return words(`${governance[2]} ${governance[1].replaceAll("-", " ")}`);
    const loop = [...text.matchAll(/\b([A-Za-z][A-Za-z0-9]*Loop)\b/g)].at(-1)?.[1];
    if (loop) {
        const name = loop.replace(/Loop$/, "").replaceAll(/([a-z])([A-Z])/g, "$1 $2").replaceAll(/([A-Z])([A-Z][a-z])/g, "$1 $2");
        const role = text.match(/:(doer|reviewer):/)?.[1];
        return words(`${name}${role ? ` ${role}` : ""}`);
    }
    return words(text.replaceAll(/[:/_-]+/g, " ")) || words(agent.agentType) || "Agent activity";
}

export function processModel(agent) {
    if (agent.usage?.models?.length) return agent.usage.models.join(" / ");
    return agent.resolvedModel ?? (agent.requestedModel ? `${agent.requestedModel} (requested)` : agent.model) ?? "Not recorded";
}

export function tokenText(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("en-US") : "Not recorded";
}

export function workOutcome(agent, { phase } = {}) {
    const work = agent.workResult;
    if (work?.kind === "review") {
        if (!work.agree) return { title: "Changes requested", summary: work.summary, tone: "error" };
        const title = work.ownerStatus === "needs-replan" ? "Agrees: scoped replanning needed"
            : work.ownerStatus === "needs-input" ? "Agrees: human input needed"
            : work.ownerStatus === "rework" || work.taskComplete === false ? "Agrees: task still incomplete"
            : work.ownerStatus === "complete" ? "Completion report agreed" : "Report agreed; completion unconfirmed";
        return { title, summary: `${work.summary}\nReport agreement is not the assignment's combined acceptance or proof of live capability.`,
            tone: work.ownerStatus === "complete" && work.taskComplete !== false ? "success" : "waiting" };
    }
    if (work) return {
        title: work.status === "complete" ? "Work reported complete" : work.status === "needs-input" ? "Awaiting input"
            : work.status === "needs-replan" ? "Needs scoped replanning" : "Work needs revision",
        summary: work.summary, tone: work.status === "complete" ? "success" : "waiting",
    };
    const status = String(agent.status ?? "").toLowerCase().replaceAll(/[_\s]+/g, "-");
    if (active.has(status) || ["stale", "unsettled"].includes(status)) {
        const taskId = agent.label?.match(/\/task\/([^/:]+)/)?.[1];
        const reviewer = agent.label?.match(/:reviewer:([^:]+)/)?.[1];
        const governance = agent.label?.match(/:governance:([^:]+):([^:]+):\d+$/);
        const structured = /\b[A-Za-z][A-Za-z0-9]*Loop\b/.test(agent.label ?? "");
        const task = agent.taskTitle?.trim() || taskId ||
            (structured ? taskLabel(agent) : agent.label?.trim()) || phase?.title || agent.agentType || "Recorded agent task";
        const title = ["queued", "pending"].includes(status) ? "Task pending"
            : ["stale", "unsettled"].includes(status) ? "Task activity unconfirmed"
            : status === "paused" ? "Work paused"
            : ["needs-input", "awaiting-input"].includes(status) ? "Awaiting input" : "Work in progress";
        return {
            title,
            summary: [
                `Assigned task: ${task}.`,
                `Recorded execution state: ${status}.`,
                reviewer ? `Responsibility: ${reviewer} reviewer.` : null,
                governance ? `Responsibility: ${governance[2]} read-only ${governance[1]} feedback coordination, not an original acceptance vote.` : null,
                phase?.title ? `Recorded phase: ${phase.title}.` : null,
                phase?.detail ? `Phase context: ${phase.detail}` : null,
                "This is recorded task context, not a final work outcome or proof of completion.",
            ].filter(Boolean).join(" "),
            tone: "waiting", contextOnly: true,
        };
    }
    return {
        title: "Work outcome unavailable",
        summary: "The execution state is recorded, but this agent's final work outcome was not retained in a supported format.",
        tone: "waiting",
    };
}

export function outcome(record, { agent = false } = {}) {
    const applicationStatus = typeof record.result?.status === "string" ? record.result.status : null;
    const status = (applicationStatus ?? record.status ?? "unknown").toLowerCase().replaceAll("_", "-");
    if (record.error || failed.has(status) || failed.has(record.status)) return { tone: "error", label: applicationStatus ?? record.status ?? "Error" };
    if (record.stale) return { tone: "waiting", label: "Stale observation" };
    if (waiting.has(status)) return { tone: "waiting", label: applicationStatus ?? record.status };
    if (record.failure?.code === "workflow_limit_reached") return { tone: "waiting", label: "Limit reached" };
    if (record.failure) return { tone: "error", label: "Recorded failure" };
    if (agent && status === "completed" && record.workResult) {
        const work = workOutcome(record);
        return { tone: work.tone, label: work.title };
    }
    if (active.has(status)) return { tone: "waiting", label: applicationStatus ?? record.status };
    if (applicationStatus === "completed") return { tone: "success", label: "Application completed" };
    if (["success", "succeeded", "passed", "pass", "ok"].includes(status) ||
        (agent && status === "completed")) return { tone: "success", label: agent ? "Agent completed" : "Successful result" };
    return { tone: "waiting", label: status === "completed" ? "Completed; delivery unconfirmed" : status };
}

export function stopReason(run) {
    const result = run.result;
    const reason = run.error || run.failure?.message || run.failure?.reason ||
        (typeof result === "object" && result ? result.reason ?? result.message ?? result.stopReason : null) || run.reason;
    if (reason) return typeof reason === "string" ? reason : JSON.stringify(reason);
    if (run.stale) return "Execution lease expired; current activity cannot be confirmed.";
    if (run.status === "running") return "No stop recorded; showing the latest durable observations.";
    return outcome(run).label === "Completed; delivery unconfirmed"
        ? "SDK completion alone does not confirm successful delivery. No explicit application outcome was retained."
        : `Recorded outcome: ${outcome(run).label}.`;
}

export function observedFlow(run) {
    if (!run) return { nodes: [], edges: [], width: 0, height: 0 };
    const agents = run.agents.filter((agent) => Number.isFinite(agent.startedAt))
        .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    const nodes = [{ id: "start", kind: "start", title: run.startedAt ? "Start" : "Run recorded", level: 0,
        tone: run.startedAt ? "success" : "waiting" }];
    const edges = [];
    const tasks = [];
    for (const agent of agents) {
        // Interval order is observable; causal dependencies and spawning are not stored.
        const prior = tasks.filter((task) => Number.isFinite(task.agent.completedAt) &&
            task.agent.completedAt <= agent.startedAt && task.agent.startedAt < agent.startedAt);
        const level = prior.length ? Math.max(...prior.map((task) => task.level)) + 1 : 1;
        const parents = prior.filter((task) => task.level === level - 1);
        const node = { id: `agent:${agent.id}`, kind: "task", title: taskLabel(agent), agent,
            level, ...outcome(agent, { agent: true }) };
        for (const parent of parents.length ? parents : [nodes[0]]) {
            edges.push({ from: parent.id, to: node.id, kind: "timing" });
        }
        tasks.push(node);
        nodes.push(node);
    }
    if (run.terminal) {
        const end = { id: "end", kind: "end", title: outcome(run).label,
            level: tasks.length ? Math.max(...tasks.map((task) => task.level)) + 1 : 1, ...outcome(run) };
        const parents = tasks.filter((task) => !edges.some((edge) => edge.from === task.id));
        for (const parent of parents.length ? parents : [nodes[0]]) edges.push({ from: parent.id, to: end.id, kind: "boundary" });
        nodes.push(end);
    }
    const levels = new Map();
    for (const node of nodes) {
        if (!levels.has(node.level)) levels.set(node.level, []);
        levels.get(node.level).push(node);
    }
    const width = Math.max(300, ...[...levels.values()].map((row) => row.length * 212 + 24));
    for (const row of levels.values()) {
        row.forEach((node, index) => {
            node.width = node.kind === "task" ? 180 : 170;
            node.height = node.kind === "task" ? 180 : 58;
            node.x = (width - row.length * 212) / 2 + index * 212 + (212 - node.width) / 2;
            node.y = node.level === 0 ? 24 : 138 + (node.level - 1) * 236;
        });
    }
    return { nodes, edges, width, height: Math.max(...nodes.map((node) => node.y + node.height)) + 24 };
}

function evidenceText(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try { return evidenceText(JSON.parse(trimmed)); }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
        return value;
    }
    if (value && typeof value === "object") {
        if (Array.isArray(value)) return value.map(evidenceText).filter(Boolean).join("; ");
        return Object.entries(value).map(([key, item]) => [key, evidenceText(item)])
            .filter(([, text]) => text).map(([key, text]) => `${key}: ${text}`).join(". ");
    }
    return String(value ?? "");
}

export function summarizeEvidence(value) {
    const text = evidenceText(value).replace(/\s+/g, " ").trim();
    const sentences = (text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []).map((sentence) => {
        const trimmed = sentence.trim();
        if (trimmed.length > 360) return `${trimmed.slice(0, 357)}...`;
        const bounded = trimmed;
        return /[.!?]$/.test(bounded) ? bounded : `${bounded}.`;
    }).slice(0, 12);
    return {
        title: words(text, 5) || "No retained details",
        description: text
            ? [sentences[0], sentences[1] ?? "No further detail was retained."].join(" ")
            : "No additional details were retained. The observer cannot ask an agent for missing information.",
        paragraphs: [sentences.slice(2, 7).join(" "), sentences.slice(7, 12).join(" ")].filter(Boolean),
    };
}

export function queryTeam(run, question, progress = []) {
    if (!run) return { title: "No run selected", description: "Select a recorded run first. No agents were contacted.", paragraphs: [] };
    const query = question.trim().toLowerCase();
    if (/\b(why|blocked|input|stop|error|limit|fail)\b/.test(query)) {
        return summarizeEvidence({ outcome: outcome(run).label, reason: stopReason(run), result: run.result });
    }
    const agents = run.agents.filter((agent) => Number.isFinite(agent.startedAt));
    let matches;
    if (/\b(who|working|active|doing|happening|progress|now)\b|going on/.test(query)) {
        matches = agents.filter((agent) => active.has(agent.status) || ["stale", "unsettled"].includes(agent.status));
    } else if (/\b(done|finished|completed)\b/.test(query)) {
        matches = agents.filter((agent) => !active.has(agent.status) && !["stale", "unsettled"].includes(agent.status));
    } else {
        matches = agents.filter((agent) => `${agent.id} ${agent.label} ${agent.agentType} ${agent.taskTitle ?? ""}`.toLowerCase().includes(query));
    }
    if (!matches.length) return {
        title: "No matching recorded activity",
        description: "No matching tasks are visible in the retained evidence. Try an agent label, who is working, what is done, or why did it stop.",
        paragraphs: [],
    };
    return summarizeEvidence({
        observation: run.stale ? "Lease expired; not confirmed live" : `Observed at ${new Date(run.observedAt).toISOString()}`,
        tasks: matches.map((agent) => `${agent.taskTitle ?? (agent.label || agent.agentType)}: ${agent.status}${
            agent.workResult ? `. ${workOutcome(agent).title}: ${agent.workResult.summary}` : ""}`),
        "Recent run context (not agent replies)": progress.slice(-2).map((line) => line.text),
    });
}
