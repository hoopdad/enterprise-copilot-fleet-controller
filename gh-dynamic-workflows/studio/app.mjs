import { observedFlow, outcome, stopReason, summarizeEvidence, queryTeam, processModel, tokenText, workOutcome, taskLabel, cardContext, cardScope, cardFields } from "./observed.mjs";

const $ = (id) => document.getElementById(id);
const state = {
    design: null, snapshot: null, workflow: null, view: "live", filter: "all",
    selection: null, phase: null, follow: true, drafts: new Map(), sourceFile: null,
    progress: [], progressKey: null, oldestSeq: null, hasOlder: false, polling: false, task: null, graphZoom: 100,
    activityView: "flowchart",
};

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function empty(container, text) {
    container.replaceChildren(element("div", text, "empty"));
}
function error(message) {
    $("error").textContent = message ?? "";
    $("error").hidden = !message;
}
async function api(route, options = {}) {
    const response = await fetch(`api/${route}`, {
        ...options, headers: { "Content-Type": "application/json", ...options.headers },
        signal: AbortSignal.timeout(12_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
}
async function action(fn) {
    try { await fn(); error(null); }
    catch (cause) { error(cause.message); }
}
const shortId = (id) => id?.slice(0, 8) ?? "none";
const date = (value) => value ? new Date(value).toLocaleString() : "Not recorded";
const time = (value) => value ? new Date(value).toLocaleTimeString() : "--";
function duration(ms) {
    if (!Number.isFinite(ms)) return "--";
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function label(text) {
    return text.replaceAll(/[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, "")
        .replaceAll(/:{2,}/g, ":").replace(/^:|:$/g, "");
}
function statusText(run) {
    return run.stale ? "STALE LEASE" : run.status.replaceAll("_", " ").toUpperCase();
}
function activeBlueprint() {
    const original = state.design?.workflows.find((workflow) => workflow.name === state.workflow);
    if (!original) return null;
    const draft = state.drafts.get(original.file);
    return draft?.analysis?.workflows.find((workflow) => workflow.binding === original.binding) ?? original;
}
function runsForWorkflow() {
    return state.snapshot?.runs.filter((run) => run.workflowName === state.workflow) ?? [];
}
function detail() {
    const current = state.snapshot?.detail;
    return current?.workflowName === state.workflow ? current : null;
}
function selectedPhase() {
    if (state.view === "design") {
        return $("graph-layer").value === "contract"
            ? state.design?.contract?.steps.find((step) => step.id === state.phase)
            : activeBlueprint()?.phases.find((phase) => phase.id === state.phase);
    }
    return detail()?.phases.find((phase) => phase.id === state.phase);
}
function download(name, content, type = "application/json") {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = element("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderRunList() {
    const container = $("run-list");
    const search = $("run-search").value.toLowerCase();
    const runs = runsForWorkflow().filter((run) => {
        const isLive = run.status === "running" && !run.stale;
        return (state.filter === "all" || (state.filter === "running" ? isLive : !isLive)) &&
            `${run.status} ${run.runId} ${run.sessionId}`.toLowerCase().includes(search);
    });
    container.replaceChildren();
    for (const run of runs) {
        const selected = detail()?.runId === run.runId && detail()?.sessionId === run.sessionId;
        const button = element("button", null, `run-card${selected ? " active" : ""}`);
        button.setAttribute("aria-label", `${run.workflowName} ${run.status} ${run.runId}`);
        button.setAttribute("aria-pressed", String(selected));
        const top = element("span", null, "run-top");
        top.append(element("strong", statusText(run), "small"), element("span", `#${run.attempt}`, "small muted"));
        button.append(top, element("code", shortId(run.runId)), element("time", date(run.createdAt)),
            element("span", `Session ${shortId(run.sessionId)} / ${run.consumed.subagents} agents`, "small muted"));
        button.addEventListener("click", () => action(async () => {
            state.selection = { runId: run.runId, sessionId: run.sessionId };
            state.follow = false;
            state.phase = null;
            if (state.view !== "design") state.view = run.status === "running" && !run.stale ? "live" : "history";
            await poll(true);
        }));
        container.append(button);
    }
    if (!runs.length) empty(container, "No matching runs. Source design is still available.");
    document.querySelectorAll("[data-filter]").forEach((button) => button.classList.toggle("active", button.dataset.filter === state.filter));
}

function renderHeading() {
    const current = detail();
    const blueprint = activeBlueprint();
    const design = state.view === "design";
    $("view-kicker").textContent = design ? "STATIC DESIGN / UNSAVED DRAFT" : state.view === "live" ? "OBSERVED EXECUTION" : "DURABLE RUN HISTORY";
    $("view-title").textContent = design ? blueprint?.name ?? state.workflow ?? "No static metadata found" : current?.workflowName ?? "No recorded run";
    $("view-subtitle").textContent = design
        ? "Inspect installed source, edit a draft, and preview its phase outline. The running workflow is never changed."
        : current ? `Run ${current.runId} / session ${shortId(current.sessionId)} / attempt ${current.attempt}`
            : "Choose a workflow or open Design & build to inspect its installed source.";
    const outcomeSuffix = current?.result && typeof current.result.status === "string" ? ` / ${current.result.status.toUpperCase()}` : "";
    $("run-status").textContent = design ? "DRAFT ONLY" : current ? `${statusText(current)}${outcomeSuffix}` : "NO RUN";
    $("export-run").hidden = design;
    $("export-run").disabled = !current;
    $("design-panel").hidden = !design;
    $("runtime-panel").hidden = design;
    $("graph-layer").hidden = !design;
    $("graph-layer").querySelector('[value="contract"]').disabled = !state.design?.contract;
    $("results-panel").hidden = state.view !== "history";
    renderActivityView();
    $("stop-notice").hidden = design || !current;
    $("graph-legend").hidden = design;
    $("clear-phase").textContent = design ? "All phases" : "Clear selection";
    if (current) {
        $("stop-notice").replaceChildren(element("strong", `${outcome(current).label}: `),
            document.createTextNode(stopReason(current)));
    }
    $("detail-title").textContent = design ? "Source workbench" : "Agent activity";
    $("follow").setAttribute("aria-pressed", String(state.follow));
    $("follow").classList.toggle("active", state.follow);
    document.querySelectorAll("[data-view]").forEach((button) => {
        button.classList.toggle("active", button.dataset.view === state.view);
        button.setAttribute("aria-current", button.dataset.view === state.view ? "page" : "false");
    });
    const metrics = design ? [
        ["Declared phases", blueprint?.phases.length ?? 0], ["Source modules", state.design?.files.length ?? 0],
        ["Static operations", state.design?.files.reduce((total, file) => total + file.operations.length, 0) ?? 0],
        ["Saved changes", "None"],
    ] : [
        ["Current phase", current?.phases.find((phase) => phase.id === current.currentPhaseId)?.title ?? "--"],
        ["Workflow active time", duration(current?.consumed.activeMs)],
        ["Agents live / spawned", current ? `${current.liveAgentCount} / ${current.consumed.subagents}` : "--"],
        ["Recorded runs", runsForWorkflow().length],
    ];
    $("metrics").replaceChildren(...metrics.map(([title, value]) => {
        const card = element("div", null, "metric");
        card.append(element("span", title), element("strong", String(value)));
        return card;
    }));
    const warnings = [...(state.design?.warnings ?? []), ...(state.snapshot?.warnings ?? []), ...(current?.usageWarnings ?? [])];
    if (current?.stale && !design) warnings.unshift("This run is still recorded as running, but its lease has expired. It is not confirmed live. No status was rewritten.");
    if (current && state.view === "live" && current.status !== "running") warnings.unshift(`This attempt is ${current.status}, not live. Select History & results to inspect its outcome.`);
    $("warnings").textContent = warnings.join("\n");
    $("warnings").hidden = !warnings.length;
    $("data-notice").textContent = design ? state.design?.graphNotice ?? "" :
        `${current?.notice ?? "No workflow data available."} Cross-session adapter: experimental local storage schema v1, not a supported cross-session SDK connection.`;
}

function renderActivityView() {
    const design = state.view === "design";
    $("activity-views").hidden = design;
    for (const button of document.querySelectorAll("[data-activity-view]")) {
        const selected = button.dataset.activityView === state.activityView;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-pressed", String(selected));
        const visible = design
            ? ["flowchart", "agents", "inspector"].includes(button.dataset.activityView)
            : selected;
        $(button.getAttribute("aria-controls")).hidden = !visible;
    }
    $("detail-grid").hidden = !design && !["agents", "inspector"].includes(state.activityView);
    $("detail-grid").classList.toggle("single-view", !design);
}

function setGraphZoom(value, pointer) {
    const graph = $("graph");
    const surface = graph.querySelector(".flow-surface, .phase-map");
    const previous = state.graphZoom;
    state.graphZoom = Math.max(50, Math.min(200, value));
    $("zoom-reset").textContent = `${state.graphZoom}%`;
    $("zoom-out").disabled = state.graphZoom === 50;
    $("zoom-in").disabled = state.graphZoom === 200;
    if (!surface) return;
    const before = surface.getBoundingClientRect();
    const viewport = graph.getBoundingClientRect();
    const anchor = pointer ?? { x: viewport.left + graph.clientWidth / 2, y: viewport.top + graph.clientHeight / 2 };
    surface.style.zoom = state.graphZoom / 100;
    const after = surface.getBoundingClientRect();
    const ratio = state.graphZoom / previous;
    graph.scrollLeft += after.left - before.left + (anchor.x - before.left) * (ratio - 1);
    graph.scrollTop += after.top - before.top + (anchor.y - before.top) * (ratio - 1);
}

function renderGraph() {
    const design = state.view === "design";
    $("graph").className = design ? "design-map" : "execution-map";
    $("observed-phases").hidden = design;
    if (!design) { renderObservedGraph(); return; }
    $("graph").setAttribute("aria-label", "Declared workflow phase outline");
    const contract = design && $("graph-layer").value === "contract";
    const nodes = contract ? state.design?.contract?.steps ?? [] : design ? activeBlueprint()?.phases ?? [] : detail()?.phases ?? [];
    $("graph-title").textContent = contract ? "Expected process contract" : design ? "Declared phase outline" : "Observed phase map";
    $("graph-caption").textContent = contract ? "Contract order, not runtime proof or inferred control-flow edges"
        : design ? activeBlueprint()?.binding?.startsWith("yaml:")
            ? "Original YAML hierarchy. Select a loop to inspect its do-er, reviewers and completion condition."
            : "Declaration order only. Branches, fan-out and loops are not statically inferred."
            : "Retained run phases, not today's source. Visited does not mean accepted.";
    const graph = $("graph");
    graph.replaceChildren();
    const surface = element("div", null, "phase-map");
    surface.style.zoom = state.graphZoom / 100;
    graph.append(surface);
    for (const [index, node] of nodes.entries()) {
        const status = node.status ?? "not_started";
        const button = element("button", null, `phase-node ${status}${state.phase === node.id ? " selected" : ""}`);
        if (design && node.depth) button.style.marginInlineStart = `${node.depth * 16}px`;
        button.dataset.phase = node.id;
        button.setAttribute("aria-pressed", String(state.phase === node.id));
        const top = element("span", null, "node-top");
        top.append(element("span", `${String(index + 1).padStart(2, "0")} /`),
            element("span", design ? contract ? "CONTRACT" : "SOURCE" : status.replaceAll("_", " ").toUpperCase()));
        const title = node.title ?? node.id;
        button.append(top, element("strong", title));
        const agents = detail()?.agents.filter((agent) => agent.phaseId === node.id).length ?? 0;
        button.append(element("span", design ? contract ? `${node.inputs?.length ?? 0} inputs / ${node.outputs?.length ?? 0} outputs`
            : `Line ${node.line}` : `${duration(node.activeMs)} / ${agents} agents / ${node.entries} entries`, "node-meta"));
        button.addEventListener("click", () => {
            state.phase = state.phase === node.id ? null : node.id;
            renderGraph(); renderAgents(); renderInspector(); renderProgress();
        });
        surface.append(button);
    }
    if (!nodes.length) empty(surface, design ? "No statically resolvable phases. Use the source workbench; dynamic metadata is not guessed." : "No observed phases for this run.");
    $("clear-phase").hidden = !state.phase;
}

function renderObservedGraph() {
    const current = detail();
    const graph = $("graph");
    const scroll = { left: graph.scrollLeft, top: graph.scrollTop };
    const focusedTask = graph.contains(document.activeElement) ? document.activeElement.dataset.task : null;
    const flow = observedFlow(current);
    $("graph-title").textContent = "Team activity flowchart";
    $("graph-caption").textContent = "Observed tasks only. Dashed arrows show timestamp order, not proven dependencies or spawning. Side-by-side tasks may overlap.";
    graph.setAttribute("aria-label", "Observed workflow task flowchart");
    graph.replaceChildren();
    const phases = $("observed-phases");
    phases.replaceChildren();
    for (const phase of current?.phases.filter((item) => item.entries > 0) ?? []) {
        const chip = element("button", phase.title, `phase-chip ${phase.status}${state.phase === phase.id ? " active" : ""}`);
        chip.dataset.phase = phase.id;
        chip.setAttribute("aria-pressed", String(state.phase === phase.id));
        chip.addEventListener("click", () => {
            state.phase = state.phase === phase.id ? null : phase.id;
            state.task = null;
            renderGraph(); renderAgents(); renderInspector(); renderProgress();
        });
        phases.append(chip);
    }
    $("clear-phase").hidden = !state.phase && !state.task;
    if (!current) { empty(graph, "No recorded run selected."); return; }
    const surface = element("div", null, "flow-surface");
    surface.style.zoom = state.graphZoom / 100;
    surface.style.width = `${flow.width}px`;
    surface.style.height = `${flow.height}px`;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", flow.width);
    svg.setAttribute("height", flow.height);
    svg.setAttribute("aria-hidden", "true");
    const defs = document.createElementNS(svg.namespaceURI, "defs");
    const marker = document.createElementNS(svg.namespaceURI, "marker");
    for (const [key, value] of Object.entries({ id: "flow-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5",
        markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" })) marker.setAttribute(key, value);
    const tip = document.createElementNS(svg.namespaceURI, "path");
    tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    marker.append(tip); defs.append(marker); svg.append(defs);
    const byId = new Map(flow.nodes.map((node) => [node.id, node]));
    for (const edge of flow.edges) {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        const x1 = from.x + from.width / 2;
        const y1 = from.y + from.height;
        const x2 = to.x + to.width / 2;
        const y2 = to.y;
        const path = document.createElementNS(svg.namespaceURI, "path");
        path.setAttribute("d", `M ${x1} ${y1} V ${(y1 + y2) / 2} H ${x2} V ${y2 - 3}`);
        path.setAttribute("class", `flow-edge ${edge.kind}`);
        path.setAttribute("marker-end", "url(#flow-arrow)");
        svg.append(path);
    }
    surface.append(svg);
    for (const node of flow.nodes) {
        const button = element("button", null, `flow-node ${node.kind} ${node.tone}${state.task === node.id ? " selected" : ""}`);
        button.dataset.task = node.id;
        button.style.left = `${node.x}px`;
        button.style.top = `${node.y}px`;
        button.style.width = `${node.width}px`;
        button.style.height = `${node.height}px`;
        button.setAttribute("aria-pressed", String(state.task === node.id));
        const status = element("span", null, `task-dot ${node.tone}`);
        status.setAttribute("aria-hidden", "true");
        button.append(status, element("strong", node.title));
        if (node.agent) {
            const card = cardContext(node.agent);
            if (card) {
                button.append(element("span", cardScope(node.agent), "task-scope"));
                if (card.failureCategories.length) button.append(element("span", card.failureCategories.join(", "), "task-category"));
                if (card.mustAct) button.append(element("span", `Must act: ${card.mustAct}`, "task-model"));
            }
            button.append(element("span", node.label, "task-status"),
                element("span", `Model: ${processModel(node.agent)}`, "task-model"));
            const tokens = element("span", null, "task-usage");
            for (const [title, field] of [["Input", "inputTokens"], ["Cached", "cacheReadTokens"], ["Output", "outputTokens"]]) {
                const row = element("span");
                row.append(element("span", title), element("span", tokenText(node.agent.usage?.[field])));
                tokens.append(row);
            }
            tokens.title = node.agent.usage?.message ?? "No per-agent token records retained.";
            button.append(tokens);
            button.title = `${node.title}\n${cardScope(node.agent)}\n${node.label}\n${node.agent.label}\nModel: ${processModel(node.agent)}`;
        }
        button.setAttribute("aria-label", `${node.kind === "task" ? `${node.agent.agentType} ${node.agent.id}: ` : ""}${node.title} / ${node.label ?? "Run started"}`);
        if (state.phase && node.agent && node.agent.phaseId !== state.phase) button.classList.add("dimmed");
        button.addEventListener("click", () => {
            state.task = state.task === node.id ? null : node.id;
            renderGraph(); renderInspector();
        });
        surface.append(button);
    }
    graph.append(surface);
    graph.scrollLeft = scroll.left;
    graph.scrollTop = scroll.top;
    if (focusedTask) [...surface.querySelectorAll("[data-task]")].find((button) => button.dataset.task === focusedTask)?.focus({ preventScroll: true });
}

function inspectFields(container, fields) {
    const dl = element("dl");
    for (const [key, value] of Object.entries(fields)) {
        if (value === null || value === undefined || value === "") continue;
        dl.append(element("dt", key), element("dd", typeof value === "string" ? value : JSON.stringify(value, null, 2)));
    }
    container.append(dl);
}
function appendSummary(container, summary, source = "EXTRACTIVE LOCAL EVIDENCE / NOT AN AGENT REPLY") {
    const card = element("div", null, "evidence-summary");
    card.append(element("span", source, "eyebrow"),
        element("h3", summary.title), element("p", summary.description, "small muted"),
        ...summary.paragraphs.map((paragraph) => element("p", paragraph)));
    container.append(card);
}

function renderTaskInspector(container, current) {
    const selectedAgent = current.agents.find((agent) => `agent:${agent.id}` === state.task);
    const node = observedFlow(current).nodes.find((item) => item.id === state.task) ??
        (selectedAgent ? { kind: "task", agent: selectedAgent, title: taskLabel(selectedAgent) } : null);
    if (!node) { state.task = null; return false; }
    $("task-drawer-title").textContent = node.kind === "task" ? node.title : node.kind === "start" ? "Workflow started" : "Workflow stop";
    if (node.agent) {
        const agent = node.agent;
        const phase = current.phases.find((item) => item.id === agent.phaseId);
        const result = workOutcome(agent, { phase });
        inspectFields(container, cardFields(agent));
        const summary = summarizeEvidence(result.summary);
        summary.title = result.title;
        appendSummary(container, summary, agent.workResult ? "RECORDED AGENT OUTCOME"
            : result.contextOnly ? "RECORDED TASK CONTEXT" : "RECORDED EXECUTION");
        const role = agent.label?.match(/:reviewer:([^:]+)/)?.[1];
        inspectFields(container, {
            Agent: role ? `${role} reviewer` : agent.agentType, Execution: agent.status,
            Model: processModel(agent), "Input tokens": tokenText(agent.usage?.inputTokens),
            "Cached tokens": tokenText(agent.usage?.cacheReadTokens), "Output tokens": tokenText(agent.usage?.outputTokens),
            "Usage records": agent.usage?.records ?? 0,
            "Observed elapsed": Number.isFinite(agent.startedAt)
                ? duration((agent.completedAt ?? (current.stale || current.terminal ? current.updatedAt : current.observedAt)) - agent.startedAt)
                : "Not started",
        });
        container.append(element("p", agent.usage?.message ?? "No per-agent token records retained.", "small muted"));
        const technical = element("details", null, "technical-details");
        technical.append(element("summary", "Technical details"));
        inspectFields(technical, {
            "Agent ID": agent.id, Label: agent.label, Phase: phase?.title ?? agent.phaseId,
            Started: date(agent.startedAt), Completed: agent.completedAt ? date(agent.completedAt) : "Not recorded",
            "Requested model": agent.requestedModel, "Resolved model": agent.resolvedModel,
            "Outcome source": agent.workResult?.source ?? "No structured final work response retained",
            "Code locations": agent.taskCard?.locations,
        });
        container.append(technical, element("p", "An agent's completion is not proof of successful delivery. Reviewer agreement is not automatically a PASS.", "small muted"));
    } else if (node.kind === "end") {
        appendSummary(container, summarizeEvidence({ outcome: outcome(current).label, reason: stopReason(current), result: current.result }));
    } else {
        inspectFields(container, { Started: date(current.startedAt), Run: current.runId, Attempt: current.attempt });
    }
    return true;
}

function renderInspector() {
    const container = $("inspector");
    const current = detail();
    const phase = selectedPhase();
    container.replaceChildren();
    const sameTask = $("task-drawer").dataset.selection === state.task;
    const technicalOpen = sameTask && $("task-details").querySelector("details")?.open;
    const technicalFocused = sameTask && document.activeElement === $("task-details").querySelector("details summary");
    const drawerScroll = sameTask ? $("task-details").scrollTop : 0;
    $("task-details").replaceChildren();
    if (state.view !== "design" && current && state.task && renderTaskInspector($("task-details"), current)) {
        $("task-drawer").dataset.selection = state.task;
        const technical = $("task-details").querySelector("details");
        if (technical) technical.open = Boolean(technicalOpen);
        if (!$("task-drawer").open) $("task-drawer").showModal();
        $("task-details").scrollTop = drawerScroll;
        if (technicalFocused) technical?.querySelector("summary").focus({ preventScroll: true });
    } else if ($("task-drawer").open) $("task-drawer").close();
    $("inspector-tag").textContent = phase ? "SELECTED NODE" : state.view === "design" ? "INSTALLED SOURCE" : "SELECTED RUN";
    if (phase) {
        container.append(element("h3", phase.title ?? phase.id));
        if (state.view === "design" && $("graph-layer").value === "contract") {
            inspectFields(container, {
                Processing: phase.processing, Inputs: phase.inputs, Outputs: phase.outputs,
                "Failure modes": phase.failures, "Side effects": phase.sideEffects, Detector: phase.detector,
                "Evidence class": state.design.contract.evidenceClass,
            });
        } else if (state.view === "design") {
            inspectFields(container, {
                Detail: phase.detail, "Do-er": phase.owner, Reviewers: phase.reviewers,
                "Complete when": phase.completeWhen, "Parent loop": phase.parentId,
                Inputs: phase.inputs, Outputs: phase.outputs, File: activeBlueprint()?.file, "Source line": phase.line,
            });
            const file = activeBlueprint().file;
            const draft = state.drafts.get(file);
            if (phase.sourceStart !== null && phase.sourceStart !== undefined && draft) {
                const titleLabel = element("label", "Draft phase title", "editor-label");
                titleLabel.htmlFor = "phase-title";
                const titleInput = element("input");
                titleInput.id = "phase-title";
                titleInput.value = phase.title;
                const rename = element("button", "Preview title change");
                rename.disabled = draft.source !== draft.validatedSource;
                rename.title = rename.disabled ? "Preview pending source edits first so source ranges are current" : "Changes only the declaration literal in your draft";
                rename.addEventListener("click", () => action(async () => {
                    if (draft.source !== draft.validatedSource) throw new Error("Preview pending source edits before editing a phase title");
                    if (!titleInput.value.trim()) throw new Error("Phase title must not be empty");
                    const source = draft.source.slice(0, phase.sourceStart) + JSON.stringify(titleInput.value) +
                        draft.source.slice(phase.sourceEnd);
                    draft.source = source;
                    selectSource(file);
                    await previewDraft(file);
                }));
                container.append(titleLabel, titleInput, rename,
                    element("p", "Declaration only. Matching phase() calls and other references must be updated separately in the source draft.", "small muted"));
            }
            const jump = element("button", "Jump to source");
            jump.addEventListener("click", () => {
                selectSource(activeBlueprint().file);
                const editor = $("source-editor");
                const offset = editor.value.split("\n").slice(0, phase.line - 1).join("\n").length + (phase.line > 1 ? 1 : 0);
                editor.focus();
                editor.setSelectionRange(offset, editor.value.indexOf("\n", offset) < 0 ? editor.value.length : editor.value.indexOf("\n", offset));
                editor.scrollTop = Math.max(0, (phase.line - 5) * 20);
            });
            container.append(jump);
        } else {
            inspectFields(container, {
                Status: phase.status, "First entered": date(phase.startedAt), "Last exited": phase.completedAt ? date(phase.completedAt) : null,
                "Observed active time": duration(phase.activeMs), Entries: phase.entries, "Last run attempt": phase.lastAttempt,
                Detail: phase.detail,
            });
        }
    } else if (state.view === "design") {
        const blueprint = activeBlueprint();
        inspectFields(container, {
            Description: blueprint?.description, File: blueprint?.file, "Declared limits": blueprint?.limits ?? "Not declared",
            "Argument schema": blueprint?.argsSchema,
        });
        if (blueprint) {
            const section = element("div", null, "inspect-section");
            section.append(element("h3", "Static SDK call sites"));
            const file = state.drafts.get(blueprint.file)?.analysis ?? state.design.files.find((candidate) => candidate.file === blueprint.file);
            for (const operation of file?.operations ?? []) {
                const row = element("p", `L${operation.line} / ${operation.kind}${operation.label ? ` / ${operation.label}` : " / dynamic expression"}`, "small");
                row.title = operation.expression;
                section.append(row);
            }
            container.append(section);
        }
    } else if (current) {
        inspectFields(container, {
            Status: statusText(current), Started: date(current.startedAt), Updated: date(current.updatedAt),
            Completed: current.completedAt ? date(current.completedAt) : null, "Run attempt": current.attempt,
            "Durable revision": current.revision, "Effective limits": current.approvedLimits ?? current.declaredLimits,
            "Raw billing (nano AIU)": current.consumed.nanoAiu,
            "Billing note": "Raw stored units, not converted to credits or currency.",
            "Phase model": "Visited means entered and exited, not successful acceptance. Not-entered phases may be skipped or still pending.",
        });
    } else empty(container, "Select a phase or a recorded run.");
}

function renderAgents() {
    if (state.view === "design") { $("agent-count").textContent = "UNSAVED / EXPORT ONLY"; return; }
    const current = detail();
    const search = $("agent-search").value.toLowerCase();
    const agents = current?.agents.filter((agent) => (!state.phase || agent.phaseId === state.phase) &&
        `${taskLabel(agent)} ${cardScope(agent)} ${agent.label} ${agent.agentType} ${agent.status}`.toLowerCase().includes(search)) ?? [];
    $("agent-count").textContent = `${agents.length} shown / ${current?.agents.length ?? 0} total`;
    const container = $("agents");
    container.replaceChildren();
    const start = current?.startedAt ?? current?.createdAt ?? Date.now();
    const end = current?.completedAt ?? (current?.stale ? current.updatedAt : current?.observedAt) ?? Date.now();
    const span = Math.max(1, end - start);
    for (const agent of agents) {
        const row = element("div", null, "agent-row");
        const title = element("div", null, "agent-label");
        const name = element("button", agent.taskCard || agent.taskTitle
            ? taskLabel(agent) : label(agent.label) || agent.agentType, "agent-open");
        name.dataset.agentTask = `agent:${agent.id}`;
        name.title = agent.label;
        name.addEventListener("click", () => {
            state.task = `agent:${agent.id}`;
            renderGraph(); renderInspector();
        });
        title.append(name, element("div", `${agent.agentType} / ${processModel(agent)}`, "small"));
        const status = element("div", null, "status");
        status.append(element("span", agent.status), element("div", duration((agent.completedAt ?? end) - (agent.startedAt ?? end)), "small"));
        const timeline = element("div", null, "agent-timeline");
        const bar = element("span", null, outcome(agent, { agent: true }).tone);
        const left = Math.min(100, Math.max(0, ((agent.startedAt ?? start) - start) / span * 100));
        const width = Math.min(100 - left, Math.max(.25, ((agent.completedAt ?? end) - (agent.startedAt ?? end)) / span * 100));
        bar.style.left = `${left}%`;
        bar.style.width = `${width}%`;
        timeline.append(bar);
        timeline.title = `${date(agent.startedAt)} - ${agent.completedAt ? date(agent.completedAt) : "no completion recorded"}`;
        row.append(title, status, timeline);
        container.append(row);
    }
    if (!agents.length) empty(container, current ? "No matching agent activity in this phase." : "No recorded run selected.");
}

function mergeProgress(snapshot) {
    const current = snapshot.detail;
    const key = current ? `${current.sessionId}/${current.runId}` : null;
    if (key !== state.progressKey) {
        state.task = null;
        state.phase = null;
        state.progress = [];
        state.progressKey = key;
        state.oldestSeq = null;
        state.hasOlder = false;
    }
    if (!current) return;
    const bySeq = new Map(state.progress.map((line) => [line.seq, line]));
    current.progress.lines.forEach((line) => bySeq.set(line.seq, line));
    state.progress = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    if (state.oldestSeq === null) {
        state.oldestSeq = current.progress.oldestSeq;
        state.hasOlder = current.progress.hasOlder;
    }
}
function renderProgress() {
    const selectedAttempt = $("attempt").value;
    const attempts = [...new Set(state.progress.map((line) => line.attempt))].sort((a, b) => a - b);
    $("attempt").replaceChildren(new Option("All log attempts", ""), ...attempts.map((attempt) => new Option(String(attempt), String(attempt))));
    $("attempt").value = attempts.includes(Number(selectedAttempt)) ? selectedAttempt : "";
    const lines = state.progress.filter((line) => (!state.phase || line.phaseId === state.phase) &&
        (!$("attempt").value || line.attempt === Number($("attempt").value)));
    const container = $("progress");
    container.replaceChildren(...lines.map((line) => {
        const row = element("div", null, "progress-row");
        row.append(element("time", time(line.recordedAt)), element("span", `#${line.attempt} / ${line.kind}`), element("p", line.text));
        return row;
    }));
    if (!lines.length) empty(container, "No durable progress lines for this selection. Agent activity is shown separately.");
    $("older-progress").hidden = !state.hasOlder;
    const current = detail();
    $("results").textContent = current ? JSON.stringify({
        status: current.status, stale: current.stale, result: current.result, error: current.error,
        failure: current.failure, reason: current.reason,
        note: current.terminal ? "Retained workflow outcome. Inspect result.status as well as the workflow envelope."
            : "No terminal outcome recorded for this attempt.",
    }, null, 2) : "No run selected.";
}

function selectSource(file) {
    state.sourceFile = file;
    $("source-file").value = file;
    const original = state.design.files.find((candidate) => candidate.file === file);
    if (!original) return;
    if (!state.drafts.has(file)) state.drafts.set(file, { source: original.source, analysis: null, validatedSource: original.source });
    $("source-editor").value = state.drafts.get(file).source;
    $("draft-message").textContent = "Source draft loaded. Edits are in-memory only; export before closing or reloading this pane.";
    updateDraftStatus();
}
function updateDraftStatus() {
    const original = state.design?.files.find((candidate) => candidate.file === state.sourceFile);
    const draft = state.drafts.get(state.sourceFile);
    $("draft-status").textContent = draft?.source !== original?.source ? "/ modified, not saved" : "/ original, not modified";
    $("export-source").disabled = !draft;
}
async function previewDraft(file) {
    const draft = state.drafts.get(file);
    if (!draft) throw new Error("Select a source module first");
    const source = draft.source;
    try {
        const analysis = await api("analyze", { method: "POST", body: JSON.stringify({ file, source }) });
        if (draft.source !== source) throw new Error("Draft changed during preview; preview the current edits again");
        draft.analysis = analysis;
        draft.validatedSource = source;
        $("draft-message").textContent = `Syntax parsed without execution. ${analysis.workflows.length} workflow metadata object(s), ${analysis.operations.length} static SDK calls. Semantic behavior is not validated.`;
        state.phase = null;
        renderGraph(); renderInspector(); renderHeading();
    } catch (cause) {
        $("draft-message").textContent = `Preview failed: ${cause.message}. The phase outline retains the last successful preview.`;
        throw cause;
    }
}
function render() {
    const description = state.design?.workflows.find((workflow) => workflow.name === state.workflow)?.description;
    $("workflow-description").textContent = description ?? "Workflow observed in retained run records. Static metadata may be dynamic or unavailable.";
    renderHeading(); renderRunList(); renderGraph(); renderAgents(); renderInspector(); renderProgress(); renderTeamAnswer();
}
function workflowOptions() {
    const names = new Set([...(state.design?.workflows.map((workflow) => workflow.name) ?? []),
        ...(state.snapshot?.runs.map((run) => run.workflowName) ?? [])]);
    $("workflow").replaceChildren(...[...names].map((name) => new Option(name, name)));
    if (!state.workflow || !names.has(state.workflow)) {
        state.workflow = state.snapshot?.detail?.workflowName ?? [...names][0] ?? null;
    }
    $("workflow").value = state.workflow ?? "";
}
async function poll(force = false) {
    if (state.polling) return;
    if (!force && document.hidden) return;
    state.polling = true;
    try {
        const expectedWorkflow = state.workflow;
        const selection = state.selection;
        let query = selection ? `?${new URLSearchParams(selection)}` : "";
        let snapshot = await api(`snapshot${query}`);
        if (state.selection !== selection || state.workflow !== expectedWorkflow) return;
        const candidates = state.workflow ? snapshot.runs.filter((run) => run.workflowName === state.workflow) : snapshot.runs;
        const preferred = state.follow ? candidates.find((run) => run.status === "running" && !run.stale) ?? candidates[0] : null;
        if (preferred && (snapshot.detail?.runId !== preferred.runId || snapshot.detail?.sessionId !== preferred.sessionId)) {
            query = `?${new URLSearchParams({ runId: preferred.runId, sessionId: preferred.sessionId })}`;
            snapshot = await api(`snapshot${query}`);
        }
        if (state.selection !== selection || state.workflow !== expectedWorkflow) return;
        state.snapshot = snapshot;
        mergeProgress(snapshot);
        workflowOptions();
        render();
        $("connection").textContent = "Connected / refreshing every 2s";
        $("last-updated").textContent = `Observed ${time(snapshot.observedAt)} / ${snapshot.sessionCount} sessions`;
        error(null);
    } catch (cause) {
        $("connection").textContent = "Disconnected / retrying";
        error(`Refresh failed: ${cause.message}. Last observed data is retained; it may be out of date.`);
    } finally { state.polling = false; }
}

function renderTheme() {
    const dark = document.documentElement.dataset.theme === "dark";
    $("theme").textContent = dark ? "Midnight blue / copper" : "Cream / espresso";
    $("theme").setAttribute("aria-label", `Toggle theme: ${dark ? "Midnight blue / copper" : "Cream / espresso"}`);
}
$("theme").addEventListener("click", () => {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    renderTheme();
});
renderTheme();
function closeTaskDetails() {
    const selected = state.task;
    state.task = null;
    if ($("task-drawer").open) $("task-drawer").close();
    renderGraph(); renderInspector();
    const button = state.activityView === "agents"
        ? [...$("agents").querySelectorAll("[data-agent-task]")].find((item) => item.dataset.agentTask === selected)
        : [...$("graph").querySelectorAll("[data-task]")].find((item) => item.dataset.task === selected);
    button?.focus({ preventScroll: true });
}
$("close-task").addEventListener("click", closeTaskDetails);
$("task-drawer").addEventListener("cancel", (event) => { event.preventDefault(); closeTaskDetails(); });
$("task-drawer").addEventListener("click", (event) => {
    if (event.target !== $("task-drawer")) return;
    const rect = $("task-drawer").getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeTaskDetails();
});
$("task-drawer").addEventListener("close", () => {
    if (!$("task-drawer").open && state.task) closeTaskDetails();
});
function renderTeamAnswer() {
    const question = $("team-question").value.trim();
    $("team-answer").replaceChildren();
    if (question) appendSummary($("team-answer"), queryTeam(detail(), question, state.progress));
}
$("team-query").addEventListener("submit", (event) => { event.preventDefault(); renderTeamAnswer(); });
$("workflow").addEventListener("change", () => action(async () => {
    state.workflow = $("workflow").value;
    state.selection = null;
    state.phase = null;
    state.follow = true;
    const blueprint = activeBlueprint();
    if (blueprint) selectSource(blueprint.file);
    render();
    await poll(true);
}));
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    state.phase = null;
    state.task = null;
    render();
}));
document.querySelectorAll("[data-activity-view]").forEach((button) => button.addEventListener("click", () => {
    state.activityView = button.dataset.activityView;
    renderActivityView();
}));
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    renderRunList();
}));
$("run-search").addEventListener("input", renderRunList);
$("agent-search").addEventListener("input", renderAgents);
$("toggle-workspace").addEventListener("click", () => {
    const collapsed = document.querySelector(".workspace").classList.toggle("workspace-collapsed");
    $("workspace-panel").hidden = collapsed;
    const button = $("toggle-workspace");
    button.textContent = collapsed ? ">>" : "<<";
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", collapsed ? "Show workspace" : "Hide workspace");
    button.title = collapsed ? "Show workspace" : "Hide workspace";
});
$("zoom-in").addEventListener("click", () => setGraphZoom(state.graphZoom + 10));
$("zoom-out").addEventListener("click", () => setGraphZoom(state.graphZoom - 10));
$("zoom-reset").addEventListener("click", () => setGraphZoom(100));
$("graph").addEventListener("wheel", (event) => {
    if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
    event.preventDefault();
    setGraphZoom(state.graphZoom + (event.deltaY < 0 ? 10 : -10), { x: event.clientX, y: event.clientY });
}, { passive: false });
$("attempt").addEventListener("change", renderProgress);
$("graph-layer").addEventListener("change", () => { state.phase = null; renderGraph(); renderInspector(); });
$("clear-phase").addEventListener("click", () => { state.phase = null; state.task = null; render(); });
$("follow").addEventListener("click", () => action(async () => {
    state.follow = !state.follow;
    if (state.follow) state.selection = null;
    else if (detail()) state.selection = { runId: detail().runId, sessionId: detail().sessionId };
    await poll(true);
    renderHeading();
}));
$("source-file").addEventListener("change", () => selectSource($("source-file").value));
$("source-editor").addEventListener("input", () => {
    const draft = state.drafts.get(state.sourceFile);
    if (!draft) return;
    draft.source = $("source-editor").value;
    $("draft-message").textContent = "Unpreviewed edits. The phase outline still shows the last successful preview.";
    updateDraftStatus();
    renderInspector();
});
$("preview-source").addEventListener("click", () => action(() => previewDraft(state.sourceFile)));
$("export-source").addEventListener("click", () => {
    const draft = state.drafts.get(state.sourceFile);
    if (draft) {
        const yaml = /\.ya?ml$/i.test(state.sourceFile);
        const name = state.sourceFile.split(/[\\/]/).at(-1).replace(/(\.m?js|\.ya?ml)$/i, ".draft$1");
        download(name, draft.source, yaml ? "text/yaml" : "text/javascript");
    }
});
$("export-run").addEventListener("click", () => {
    if (detail()) download(`workflow-${detail().runId}.json`, JSON.stringify({ ...detail(), exportedAt: new Date().toISOString() }, null, 2));
});
$("older-progress").addEventListener("click", () => action(async () => {
    const current = detail();
    if (!current || !state.oldestSeq) return;
    const key = state.progressKey;
    const page = await api(`progress?${new URLSearchParams({
        sessionId: current.sessionId, runId: current.runId, beforeSeq: state.oldestSeq,
    })}`);
    if (state.progressKey !== key) return;
    const bySeq = new Map([...page.lines, ...state.progress].map((line) => [line.seq, line]));
    state.progress = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    state.oldestSeq = page.oldestSeq;
    state.hasOlder = page.hasOlder;
    renderProgress();
}));
$("refresh").addEventListener("click", () => action(async () => {
    $("refresh").disabled = true;
    try {
        state.design = await api("design/refresh", { method: "POST" });
        workflowOptions();
        // Keep all unsaved buffers, even when source on disk has changed.
        $("source-file").replaceChildren(...state.design.files.map((file) => new Option(file.file, file.file)));
        if (state.sourceFile && state.design.files.some((file) => file.file === state.sourceFile)) selectSource(state.sourceFile);
        await poll(true);
    } finally { $("refresh").disabled = false; }
}));
window.addEventListener("beforeunload", (event) => {
    if ([...state.drafts].some(([file, draft]) => draft.source !== state.design.files.find((candidate) => candidate.file === file)?.source)) {
        event.preventDefault();
        event.returnValue = "";
    }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });

await action(async () => {
    state.design = await api("design");
    $("project-name").textContent = state.design.root.split(/[\\/]/).at(-1);
    $("project-path").textContent = state.design.root;
    $("project-path").title = state.design.root;
    await poll(true);
    $("source-file").replaceChildren(...state.design.files.map((file) => new Option(file.file, file.file)));
    const file = activeBlueprint()?.file ?? state.design.files[0]?.file;
    if (file) selectSource(file);
});
setInterval(() => void poll(), 2000);
