import path from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { definition as installedDefinition, loadWorkflow, flattenLoops } from "./loop-source.mjs";
import { runLoop, CORRECTION_CONTRACT } from "./lab-loops.mjs";
import { validateWorkCard } from "./work-cards.mjs";
import { archiveContext, documentContext, historyLocation, outcomeContext, outcomeIndex } from "./task-context.mjs";
import { createAgentScheduler, createResourceScheduler, criticalPathPriorities, scheduleTasks } from "./scheduling.mjs";

export const ENGINE = "yaml-loops-v2";
export const DELIVERY_CONTRACT = "work-conserving-v1";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = (value) => typeof value === "string" && !!value.trim() && value === value.trim() &&
    ![".", ".."].includes(value) && !/[\\/:\u0000-\u001f\u007f]/.test(value);
const taskKinds = {
    ui: ["Developer", "AssignedWorkUIDeveloperLoop"],
    developer: ["Developer", "AssignedWorkDeveloperLoop"],
    designer: ["Designer", "SprintDesignLoop"],
    devops: ["DevOps Engineer", "DevOpsWorkLoop"],
};
async function engineHistory(history) {
    if (!history) return;
    const directory = path.dirname(path.join(history.root, history.directory));
    const marker = path.join(directory, "engine.json");
    const validateMarker = async () => {
        const recorded = JSON.parse(await readFile(marker, "utf8"));
        if (recorded.engine !== ENGINE || recorded.correctionContract !== CORRECTION_CONTRACT ||
            recorded.deliveryContract !== DELIVERY_CONTRACT) {
            throw new Error("This run uses an older workflow engine or correction contract. Preserve its history and explicitly start a new yaml-loops-v2 run.");
        }
    };
    try { await validateMarker(); return; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    try {
        if ((await readdir(path.join(history.root, history.directory))).length) {
            throw new Error("This unversioned run has historical context from the older workflow engine. Preserve it and explicitly start a new yaml-loops-v2 run.");
        }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(directory, { recursive: true });
    try {
        await writeFile(marker, JSON.stringify({ engine: ENGINE, correctionContract: CORRECTION_CONTRACT,
            deliveryContract: DELIVERY_CONTRACT }) + "\n", { flag: "wx" });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await validateMarker();
    }
}
export function releasePlan(artifact) {
    const plan = artifact.ReleasePlan;
    if (!object(plan) || !Array.isArray(plan.sprints) || !plan.sprints.length ||
        plan.sprints.some((sprint) => !object(sprint) || !safeId(sprint.id)) ||
        new Set(plan.sprints.map((sprint) => sprint.id)).size !== plan.sprints.length) {
        throw new Error("ReleasePlan needs a nonempty sprints array with safe unique string ids (no separators or control characters)");
    }
    const byId = new Map(plan.sprints.map((sprint) => [sprint.id, sprint]));
    const visited = new Set(), visiting = new Set();
    const visit = (sprint) => {
        if (visited.has(sprint.id)) return;
        if (visiting.has(sprint.id)) throw new Error(`Circular sprint dependency: ${sprint.id}`);
        if (sprint.dependsOn !== undefined && (!Array.isArray(sprint.dependsOn) ||
            sprint.dependsOn.some((id) => typeof id !== "string" || !byId.has(id)) ||
            new Set(sprint.dependsOn).size !== sprint.dependsOn.length)) {
            throw new Error(`Sprint ${sprint.id} dependsOn must name unique existing sprints`);
        }
        visiting.add(sprint.id);
        for (const id of sprint.dependsOn ?? []) visit(byId.get(id));
        visiting.delete(sprint.id);
        visited.add(sprint.id);
    };
    plan.sprints.forEach(visit);
    return plan;
}
export function sprintTasks(artifact, { firstSprint = false } = {}) {
    const tasks = artifact.SprintPlan?.tasks;
    if (!Array.isArray(tasks)) throw new Error("SprintPlan needs a tasks array");
    const byId = new Map();
    for (const task of tasks) {
        if (!object(task) || !safeId(task.id) || byId.has(task.id) ||
            typeof task.title !== "string" || typeof task.kind !== "string" || !Object.hasOwn(taskKinds, task.kind) ||
            task.owner !== taskKinds[task.kind][0] ||
            !Array.isArray(task.dependsOn) || task.dependsOn.some((id) => typeof id !== "string")) {
            throw new Error("Every task needs a safe unique id (no separators or control characters), title, kind, assigned owner and dependsOn array");
        }
        byId.set(task.id, task);
        validateWorkCard(task.workCard, `SprintPlan task ${task.id}`);
        if (task.workCard && (task.workCard.role !== task.owner || task.workCard.action !== task.title ||
            task.workCard.doneWhen !== task.doneWhen)) {
            throw new Error(`Task ${task.id} workCard must match its owner, title and doneWhen`);
        }
        if (task.doneWhen !== undefined && (typeof task.doneWhen !== "string" || !task.doneWhen.trim()) ||
            task.handoff !== undefined && (typeof task.handoff !== "string" || !task.handoff.trim()) ||
            task.exclusions !== undefined && (!Array.isArray(task.exclusions) ||
                task.exclusions.some((item) => typeof item !== "string" || !item.trim()))) {
            throw new Error(`Task ${task.id} needs a nonempty doneWhen/handoff and string exclusions when supplied`);
        }
        if (task.estimatedMinutes !== undefined && (!object(task.estimatedMinutes) ||
            Object.entries(task.estimatedMinutes).some(([key, value]) =>
                !["implementation", "review", "integration"].includes(key) || !Number.isFinite(value) || value < 0))) {
            throw new Error(`Task ${task.id} estimatedMinutes accepts nonnegative implementation, review and integration durations`);
        }
        if (task.exclusiveResources !== undefined && (!Array.isArray(task.exclusiveResources) ||
            task.exclusiveResources.some((name) => typeof name !== "string" || !name.trim() || name !== name.trim()) ||
            new Set(task.exclusiveResources).size !== task.exclusiveResources.length)) {
            throw new Error(`Task ${task.id} exclusiveResources needs unique nonempty resource names`);
        }
    }
    const visited = new Set(), visiting = new Set();
    const walk = (task) => {
        if (visited.has(task.id)) return;
        if (visiting.has(task.id)) throw new Error(`Circular task dependency: ${task.id}`);
        visiting.add(task.id);
        for (const id of task.dependsOn) {
            const dependency = byId.get(id);
            if (!dependency) throw new Error(`Unknown task dependency: ${id}`);
            walk(dependency);
        }
        visiting.delete(task.id);
        visited.add(task.id);
    };
    tasks.forEach(walk);
    if (firstSprint) {
        const skeleton = tasks[0];
        if (!skeleton || skeleton.walkingSkeleton !== true || skeleton.kind !== "devops" ||
            skeleton.owner !== "DevOps Engineer" || skeleton.dependsOn.length ||
            typeof skeleton.doneWhen !== "string" || !/\bdeployed\b/i.test(skeleton.doneWhen) ||
            !/\bpass(?:es|ing)?\b/i.test(skeleton.doneWhen) ||
            typeof skeleton.handoff !== "string" || !skeleton.handoff.trim() ||
            tasks.slice(1).some((task) => task.walkingSkeleton === true)) {
            throw new Error("First sprint must start with one DevOps walkingSkeleton, no dependencies, a deployed-pass doneWhen and an explicit handoff");
        }
        const reachesSkeleton = (task) => task.dependsOn.some((id) =>
            id === skeleton.id || reachesSkeleton(byId.get(id)));
        if (tasks.slice(1).some((task) => !reachesSkeleton(task))) {
            throw new Error("Every other first-sprint task must transitively depend on the walking skeleton");
        }
    }
    return tasks;
}

async function planningDocuments(artifact, root) {
    for (const [name, field] of [["ReleasePlan", "sprints"], ["SprintPlan", "tasks"]]) {
        const reference = artifact[name];
        if (object(reference) && !Array.isArray(reference[field]) && typeof reference.path === "string") {
            const saved = JSON.parse(await readFile(path.resolve(root, reference.path), "utf8"));
            const document = saved[name] ?? saved;
            if (!object(document)) throw new Error(`${name} file must contain a JSON planning object`);
            artifact[name] = { ...reference, ...document };
        }
    }
}

async function specification(args, root) {
    if (typeof args.specification === "string") return readFile(path.resolve(root, args.specification), "utf8");
    if (args.specification?.path) {
        const repo = args.repositories?.find((candidate) => candidate.id === args.specification.repository);
        if (args.specification.repository && !repo) throw new Error(`Unknown specification repository: ${args.specification.repository}`);
        return readFile(path.resolve(root, repo?.path ?? ".", args.specification.path), "utf8");
    }
    if (args.input?.path && args.input.path !== ".") {
        const file = path.resolve(root, args.input.path);
        if ((await stat(file)).isFile()) return readFile(file, "utf8");
    }
    return args.input?.goal ?? "";
}

export async function taskContext(common, documents, outcomes, extra = {}, audits = new Map(), documentAudits = new Map()) {
    const currentOutcomes = [...outcomes], currentDocuments = { ...documents };
    for (const outcome of currentOutcomes) {
        if (!audits.has(outcome.key)) {
            audits.set(outcome.key, await archiveContext(common.history, `outcome ${outcome.key}`, outcome));
        }
    }
    const handoff = async (outcome) => outcomeContext(outcome,
        audits.get(outcome.key) ?? await archiveContext(common.history, "dependency outcome", outcome));
    const scoped = async (scope) => ({
        ...(scope.assignment ? { assignment: scope.assignment } : {}),
        ...(scope.request ? { request: outcomeContext(scope.request,
            await archiveContext(common.history, "scope request", scope.request)) } : {}),
        ...(scope.dependencies ? { dependencies: await Promise.all(scope.dependencies.map(handoff)) } : {}),
        ...(scope.inherited?.assignment ? { inherited: { assignment: scope.inherited.assignment } } : {}),
    });
    const { priorDispositions: _priorDispositions, governance: _governance, governanceHistory: _governanceHistory,
        ...currentExtra } = extra;
    return structuredClone({
        ...common,
        documents: Object.fromEntries(Object.entries(currentDocuments).map(([name, document]) =>
            [name, documentContext(document, documentAudits.get(name))])),
        outcomes: currentOutcomes.map((outcome) => outcomeIndex(outcome, audits.get(outcome.key))),
        ...currentExtra,
        ...(extra.dependencies ? { dependencies: await Promise.all(extra.dependencies.map(handoff)) } : {}),
        ...(extra.inherited ? { inherited: await scoped(extra.inherited) } : {}),
        ...(extra.scopeRevision ? { scopeRevision: await scoped(extra.scopeRevision) } : {}),
    });
}

export function createLoopRunner() {
    return async (ctx) => {
        const args = ctx.args;
        if (!object(args) || typeof args.projectRoot !== "string" || !args.projectRoot.trim()) throw new Error("projectRoot is required");
        if (args.maxSprints !== undefined && (!Number.isSafeInteger(args.maxSprints) || args.maxSprints < 1)) {
            throw new Error("An explicitly supplied maxSprints must be a positive integer");
        }
        const root = path.resolve(args.projectRoot);
        const history = typeof ctx.runId === "string" ? historyLocation(root, ctx.runId) : undefined;
        const scheduleAgent = createAgentScheduler(args.concurrency, ctx.signal);
        const resources = createResourceScheduler(ctx.signal);
        if (typeof ctx.runId === "string") {
            try {
                await stat(path.join(root, ".delivery-runs", ctx.runId, "lab-state.json"));
                throw new Error("This run belongs to the retired native engine. Preserve it as history and explicitly start a new YAML-loop run.");
            } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        await engineHistory(history);
        const source = args.workflowPath ? loadWorkflow(path.resolve(root, args.workflowPath)) : installedDefinition;
        const steps = source.workflows.ReleaseLoop.steps;
        const all = new Map(flattenLoops(steps).map((node) => [node.id, node]));
        const documents = {}, outcomes = [], completed = [], audits = new Map(), documentAudits = new Map();
        const entered = new Map(), failures = [];
        const delivery = () => ({
            completedSprints: [...completed],
            partialSprints: [...entered.values()].filter((state) => !completed.includes(state.sprint.id))
                .map((state) => ({ id: state.sprint.id })),
            pendingSprints: (documents.ReleasePlan?.sprints ?? []).filter((sprint) => !entered.has(sprint.id))
                .map((sprint) => ({ id: sprint.id, dependsOn: sprint.dependsOn ?? [] })),
            acceptedWork: outcomes.filter((outcome) => outcome.status === "agreed" && outcome.taskId)
                .map((outcome) => outcomeIndex(outcome, audits.get(outcome.key))),
            remainingWork: [...entered.values()].flatMap((state) => state.tasks.flatMap((task, index) => {
                const result = state.results[index];
                return result?.status === "agreed" ? [] : [{ sprintId: state.sprint.id, task,
                    outcome: result ? outcomeIndex(result, audits.get(result.key)) : { status: "pending" } }];
            })),
            blockedWork: [...entered.values()].flatMap((state) =>
                [...new Set([state.blocker, ...state.results].filter((result) =>
                    result && !["agreed", "not-run"].includes(result.status)))].map((result) => ({
                    ...outcomeIndex(result, audits.get(result.key)),
                    sprintId: state.sprint.id, summary: result.summary ?? result.reason,
                    ...(result.nextAction ? { nextAction: result.nextAction } : {}),
                }))),
        });
        const common = {
            projectRoot: root, request: args, specification: await specification(args, root),
            ...(history ? { history } : {}),
            roleDescriptions: source.roles, engine: ENGINE,
            orchestration: "Repository docs/requirements and tests are the scope ledger, not authority to invent scope. Every role's mandatory correction needs an original user requirement or explicitly approved amendment citation and a falsifiable failure reason; demonstrated defects additionally need evidence. Owners assess corrections and original reviewers verify those assessments. checksValid:false and unsupported suggestions alone never block. Continue independent approved work around localized blockers. Construction may run concurrently; shared-environment mutation and its DevOps-then-E2E verification are serialized. Every accepted assignment still requires passing deployed verification. Replan only material dependency/scope changes through existing roles, not a mandatory work-exhaustion ceremony. No disposition ledger, extra arbiter or feedback governance chain.",
        };
        const context = (extra = {}) => taskContext(common, documents, outcomes,
            { delivery: delivery(), ...extra }, audits, documentAudits);
        const attemptsFor = (id) => args.attempts?.[id] ?? args.attempts?.[
            ["AssignedWorkUIDeveloperLoop", "AssignedWorkDeveloperLoop", "DevOpsWorkLoop"].includes(id) ? "implementation" : "planning"];
        const perform = async (node, key, extra = {}, decode, phase = true, dispatch, verify) => {
            if (phase) ctx.phase(node.name);
            const result = await runLoop({
                ctx, loop: node, key: `${ENGINE}:${key}`, context: await context(extra),
                decode: async (artifact) => {
                    await planningDocuments(artifact, root);
                    if (Object.hasOwn(artifact, "ReleasePlan")) {
                        const plan = releasePlan(artifact);
                        if ([...entered.keys()].some((id) => !plan.sprints.some((sprint) => sprint.id === id))) {
                            throw new Error("ReleasePlan must preserve entered sprints and their acceptance criteria");
                        }
                    }
                    await decode?.(artifact);
                },
                attempts: attemptsFor(node.id), maxNoProgressRounds: args.maxNoProgressRounds, agents: args.agents, dispatch, verify,
                scheduleAgent: (kind, work, priority) => kind === "doer" && extra.scopeRevision
                    ? resources(["workflow:scope-planning-edits"], () => scheduleAgent(kind, work, priority), priority)
                    : scheduleAgent(kind, work, priority),
                priority: extra.scheduling?.criticalPathMinutes ?? 0,
            });
            const outcome = { loopId: node.id,
                ...(extra.sprint ? { sprintId: extra.sprint.id } : {}),
                ...(extra.assignment ? { taskId: extra.assignment.id } : {}), ...result, key,
                ...(result.key && result.key !== key ? { failedVerification: result.key } : {}) };
            audits.set(key, await archiveContext(common.history, `outcome ${key}`, outcome));
            outcomes.push(outcome);
            if (result.status === "agreed") {
                const accepted = { ...result.artifact };
                if (extra.scopeRevision) delete accepted.SprintPlan;
                Object.assign(documents, accepted);
                for (const name of Object.keys(accepted)) documentAudits.set(name, audits.get(key));
            }
            return outcome;
        };
        const stopped = (result) => Object.fromEntries(Object.entries({
            status: result.status, engine: ENGINE, runId: ctx.runId, summary: result.summary ?? result.reason,
            stoppedAt: result.loopId, stoppedKey: result.key, reason: result.reason, nextAction: result.nextAction,
            workCard: result.workCard, limitation: result.limitation,
            rounds: result.rounds, limit: result.limit,
            ...(result.progress ? { stopCause: result.stopCause, progress: result.progress } : {}),
            completedSprints: [...completed], documents, outcomes,
            delivery: { state: "waiting", waitReason: result.status === "limit-reached" ? "explicit-limit" : "work-exhausted",
                ...delivery() },
        }).filter(([, value]) => value !== undefined));
        const assignedWork = async (container, sprint, tasks, iteration, planRound = 1, scope = "", inherited = {}) => {
            ctx.phase(container.name);
            return scheduleTasks(tasks.map((task) => ({ ...task,
                exclusiveResources: (task.exclusiveResources ?? []).filter((name) => name !== "workflow:deployed-environment") })),
            async (task, dependencies, criticalPathMinutes) => {
                const locksEnvironment = task.kind === "devops" ||
                    tasks.find((original) => original.id === task.id).exclusiveResources?.includes("workflow:deployed-environment");
                const loop = all.get(taskKinds[task.kind][1]);
                const taskKey = `sprint/${iteration}/${sprint.id}${scope}/task/${task.id}${planRound > 1 ? `/plan-round/${planRound}` : ""}`;
                const execute = () => perform(loop, `${taskKey}/${loop.id}`,
                    { sprint, assignment: task, dependencies, inherited,
                        deploymentManaged: task.kind !== "devops", scheduling: { criticalPathMinutes } }, undefined, false, undefined,
                    async (owner, round) => {
                        const verify = async () => {
                            const verification = [];
                            for (const id of ["DevOpsWorkLoop", "EndToEndTestLoop"]) {
                                const outcome = await perform(all.get(id),
                                    `${taskKey}/continuous${round > 1 ? `/round/${round}` : ""}/${id}`,
                                    { sprint, acceptedAssignment: task, candidate: owner, dependencies,
                                        continuousVerification: true }, undefined, false);
                                verification.push(outcome);
                                if (outcome.status !== "agreed") return { ...outcome, verification };
                            }
                            return { status: "agreed", verification };
                        };
                        return locksEnvironment ? verify()
                            : resources(["workflow:deployed-environment"], verify, criticalPathMinutes);
                    });
                return locksEnvironment
                    ? resources(["workflow:deployed-environment"], execute, criticalPathMinutes) : execute();
            }, {
                priorities: criticalPathPriorities(tasks), signal: ctx.signal, resources, settleErrors: true,
                replan: async (task, request, dependencies) => {
                    const revisionKey = `sprint/${iteration}/${sprint.id}${scope}/replan/${task.id}/plan-${planRound}`;
                    const scopeRevision = { assignment: task, request, dependencies, inherited };
                    const architecture = await perform(all.get("SprintArchitectureLoop"),
                        `${revisionKey}/SprintArchitectureLoop`, { sprint, scopeRevision }, undefined, false);
                    if (architecture.status !== "agreed") return architecture;
                    let settle;
                    const planning = await perform(all.get("SprintPlanLoop"),
                        `${revisionKey}/SprintPlanLoop`, { sprint, scopeRevision }, (artifact) => {
                            if (!artifact.SprintPlan.tasks.length) throw new Error("A scope revision needs at least one bounded replacement handoff");
                            sprintTasks(artifact, { firstSprint: task.walkingSkeleton === true });
                        }, false, (artifact, revisionRound) => {
                            const replacements = sprintTasks(artifact);
                            const pending = assignedWork(container, sprint, replacements, iteration, revisionRound,
                                `${scope}/replan/${task.id}/plan-${planRound}`, scopeRevision)
                                .then((results) => ({ results }), (error) => ({ error }));
                            settle = async () => {
                                const outcome = await pending;
                                if (outcome.error) throw outcome.error;
                                return outcome.results;
                            };
                            return { context: { status: "dispatched", taskIds: replacements.map((item) => item.id),
                                replacesTask: task.id, preservesUnrelatedWork: true }, settle };
                        });
                    if (planning.status !== "agreed") return planning;
                    const results = settle ? await settle() : await assignedWork(container, sprint,
                        sprintTasks(planning.artifact), iteration, planning.rounds,
                        `${scope}/replan/${task.id}/plan-${planRound}`, scopeRevision);
                    const incomplete = results.find((result) => result.status !== "agreed");
                    if (incomplete) return incomplete;
                    return { status: "agreed", taskId: task.id, summary: "Scoped replacement handoffs accepted with deployed verification.",
                        artifact: Object.assign({}, ...results.map((result) => result.artifact)),
                        replacements: results.map((result) => ({ key: result.key, status: result.status })) };
                },
            });
        };
        for (const node of steps) {
            if (!node.substeps) {
                const result = await perform(node, node.id, {}, node.id === "ReleasePlanLoop" ? releasePlan : undefined);
                if (result.status !== "agreed") return stopped(result);
                continue;
            }
            let cap;
            while (true) {
                ctx.signal?.throwIfAborted();
                const plan = releasePlan({ ReleasePlan: documents.ReleasePlan });
                const sprint = plan.sprints.find((candidate) => !entered.has(candidate.id) &&
                    (candidate.dependsOn ?? []).every((id) => completed.includes(id)));
                if (!sprint) break;
                if (args.maxSprints !== undefined && entered.size >= args.maxSprints) {
                    cap = {
                        status: "limit-reached", loopId: node.id, key: node.id, limit: args.maxSprints,
                        summary: `The explicitly supplied ${args.maxSprints}-sprint limit was reached.`,
                        reason: `Next planned sprint: ${sprint.id}; partial sprints also count.`,
                        nextAction: "Inspect retained work and blockers; change the explicit sprint limit only if desired.",
                    };
                    break;
                }
                const iteration = entered.size + 1;
                const state = { sprint, tasks: [], results: [], blocker: null };
                entered.set(sprint.id, state);
                let tasks = [];
                let workDispatched = false;
                let settleAssignments;
                const dispatchAssignments = (artifact, round) => {
                    const assignments = sprintTasks(artifact, { firstSprint: iteration === 1 });
                    state.tasks = assignments;
                    const pending = assignedWork(node, sprint, assignments, iteration, round)
                        .then((results) => ({ results }), (error) => ({ error }));
                    const settle = async () => {
                        const outcome = await pending;
                        if (outcome.error) throw outcome.error;
                        state.results = outcome.results;
                        return outcome.results;
                    };
                    settleAssignments = settle;
                    return {
                        context: {
                            status: "dispatched",
                            taskIds: assignments.map((task) => task.id),
                            sequencing: "Independent construction runs concurrently; shared deployments and their E2E checks are serialized. Every assignment passes deployed verification before acceptance or dependency release.",
                        },
                        settle,
                    };
                };
                try {
                    for (const substep of node.substeps) {
                        if (["EndToEndTestLoop", "DevOpsWorkLoop"].includes(substep.id)) continue;
                        if (["AssignedWorkUIDeveloperLoop", "AssignedWorkDeveloperLoop"].includes(substep.id)) {
                            if (!workDispatched) {
                                const results = settleAssignments ? await settleAssignments() : await assignedWork(node, sprint, tasks, iteration);
                                state.results = results;
                                const incomplete = results.find((result) => result.status !== "agreed" && result.status !== "not-run") ??
                                    results.find((result) => result.status !== "agreed");
                                if (incomplete) { state.blocker = incomplete; break; }
                                workDispatched = true;
                            }
                            continue;
                        }
                        const result = await perform(substep, `sprint/${iteration}/${sprint.id}/${substep.id}`,
                            { sprint, assignments: tasks, completedSprints: [...completed] },
                            substep.id === "SprintPlanLoop" ? (artifact) => sprintTasks(artifact, { firstSprint: iteration === 1 }) : undefined, true,
                            substep.id === "SprintPlanLoop" ? dispatchAssignments : undefined);
                        if (result.status !== "agreed") {
                            await settleAssignments?.();
                            state.blocker = result;
                            break;
                        }
                        if (substep.id === "SprintPlanLoop") tasks = sprintTasks(result.artifact);
                    }
                } catch (error) {
                    try { await settleAssignments?.(); }
                    catch (settleError) { if (settleError !== error) failures.push(settleError); }
                    ctx.signal?.throwIfAborted();
                    failures.push(error);
                    ctx.log(`Sprint ${sprint.id} failed; continuing independent approved work: ${error.message}`);
                    state.blocker = { status: "error", key: `sprint/${iteration}/${sprint.id}/error`,
                        loopId: node.id, reason: error.message, nextAction: "Repair this invocation; do not replay uncertain effects." };
                }
                for (const result of state.results.filter((result) => result.status === "error")) {
                    failures.push(new Error(`Assignment ${result.taskId}: ${result.reason}`));
                    ctx.log(`Assignment ${result.taskId} failed: ${result.reason}`);
                }
                if (!state.blocker) completed.push(sprint.id);
            }
            if (failures.length) {
                const checkpoint = await archiveContext(common.history, "release execution failure checkpoint",
                    { status: "error", documents, outcomes, delivery: delivery(), failures: failures.map((error) => error.message) });
                const error = new AggregateError(failures,
                    `Release execution failed: ${failures.map((failure) => failure.message).join("; ")}${checkpoint ? `; checkpoint: ${checkpoint.path}` : ""}`);
                error.delivery = delivery();
                throw error;
            }
            if (cap) return stopped(cap);
            const blocker = [...entered.values()].find((state) => state.blocker)?.blocker;
            if (blocker) return stopped(blocker);
            if (delivery().pendingSprints.length) throw new Error("Release has pending sprints without executable prerequisites");
        }
        return { status: "completed", engine: ENGINE, runId: ctx.runId, completedSprints: completed, documents, outcomes,
            delivery: { state: "completed", ...delivery() } };
    };
}
