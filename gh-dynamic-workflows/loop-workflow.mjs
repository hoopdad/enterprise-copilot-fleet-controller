import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { definition as installedDefinition, loadWorkflow, flattenLoops } from "./loop-source.mjs";
import { runLoop } from "./lab-loops.mjs";
import { dispositionContext, scopeContext } from "./scope-governance.mjs";
import { archiveContext, documentContext, historyLocation, outcomeContext, outcomeIndex } from "./task-context.mjs";
import { createAgentScheduler, createResourceScheduler, criticalPathPriorities, scheduleTasks } from "./scheduling.mjs";

export const ENGINE = "yaml-loops-v1";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const taskKinds = {
    ui: ["Developer", "AssignedWorkUIDeveloperLoop"],
    developer: ["Developer", "AssignedWorkDeveloperLoop"],
    designer: ["Designer", "SprintDesignLoop"],
    devops: ["DevOps Engineer", "DevOpsWorkLoop"],
};
export function releasePlan(artifact) {
    const plan = artifact.ReleasePlan;
    if (!object(plan) || !Array.isArray(plan.sprints) || !plan.sprints.length ||
        plan.sprints.some((sprint) => !object(sprint) || typeof sprint.id !== "string" || !sprint.id.trim()) ||
        new Set(plan.sprints.map((sprint) => sprint.id)).size !== plan.sprints.length) {
        throw new Error("ReleasePlan needs a nonempty sprints array with unique string ids");
    }
    return plan;
}
export function sprintTasks(artifact) {
    const tasks = artifact.SprintPlan?.tasks;
    if (!Array.isArray(tasks)) throw new Error("SprintPlan needs a tasks array");
    const byId = new Map();
    for (const task of tasks) {
        if (!object(task) || typeof task.id !== "string" || !task.id.trim() || byId.has(task.id) ||
            typeof task.title !== "string" || typeof task.kind !== "string" || !Object.hasOwn(taskKinds, task.kind) ||
            task.owner !== taskKinds[task.kind][0] ||
            !Array.isArray(task.dependsOn) || task.dependsOn.some((id) => typeof id !== "string")) {
            throw new Error("Every task needs a unique id, title, kind, assigned owner and dependsOn array");
        }
        byId.set(task.id, task);
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
            if (task.kind !== "devops" && dependency.kind === "devops") {
                throw new Error("Implementation cannot depend on DevOps work that the YAML orders after E2E");
            }
            walk(dependency);
        }
        visiting.delete(task.id);
        visited.add(task.id);
    };
    tasks.forEach(walk);
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
    const priorDispositions = dispositionContext({ outcomes: currentOutcomes, ...extra });
    for (const outcome of currentOutcomes) {
        if (!audits.has(outcome.key)) {
            audits.set(outcome.key, await archiveContext(common.history, `outcome ${outcome.key}`, outcome));
        }
    }
    const handoff = async (outcome) => outcomeContext(outcome,
        audits.get(outcome.key) ?? await archiveContext(common.history, "dependency outcome", outcome));
    return structuredClone({
        ...common,
        documents: Object.fromEntries(Object.entries(currentDocuments).map(([name, document]) =>
            [name, documentContext(document, documentAudits.get(name))])),
        outcomes: currentOutcomes.map((outcome) => outcomeIndex(outcome, audits.get(outcome.key))),
        ...extra,
        ...(extra.dependencies ? { dependencies: await Promise.all(extra.dependencies.map(handoff)) } : {}),
        ...(extra.inherited ? { inherited: await scopeContext(common, extra.inherited) } : {}),
        ...(extra.scopeRevision ? { scopeRevision: await scopeContext(common, extra.scopeRevision) } : {}),
        priorDispositions,
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
        const scheduleAgent = createAgentScheduler(args.concurrency, ctx.signal);
        const resources = createResourceScheduler(ctx.signal);
        if (typeof ctx.runId === "string") {
            try {
                await stat(path.join(root, ".delivery-runs", ctx.runId, "lab-state.json"));
                throw new Error("This run belongs to the retired native engine. Preserve it as history and explicitly start a new YAML-loop run.");
            } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        const source = args.workflowPath ? loadWorkflow(path.resolve(root, args.workflowPath)) : installedDefinition;
        const steps = source.workflows.ReleaseLoop.steps;
        const all = new Map(flattenLoops(steps).map((node) => [node.id, node]));
        const documents = {}, outcomes = [], completed = [], audits = new Map(), documentAudits = new Map();
        const common = {
            projectRoot: root, request: args, specification: await specification(args, root),
            ...(ctx.runId ? { history: historyLocation(root, ctx.runId) } : {}),
            roleDescriptions: source.roles, engine: ENGINE,
            orchestration: "Original YAML owners and reviewers govern acceptance. Every unresolved round receives read-only Scrum Master feedback triage, with Architect advice and Product Owner decisions for ambiguous scope, before retry or scoped replanning. No new YAML stages. Former ticket, hash, lease, frozen-input, native-receipt and admission protocols are retired. Ordinary CLI permissions and actual project authority still apply.",
        };
        const context = (extra = {}) => taskContext(common, documents, outcomes, extra, audits, documentAudits);
        const attemptsFor = (id) => args.attempts?.[id] ?? args.attempts?.[
            ["AssignedWorkUIDeveloperLoop", "AssignedWorkDeveloperLoop", "DevOpsWorkLoop"].includes(id) ? "implementation" : "planning"];
        const perform = async (node, key, extra = {}, decode, phase = true, dispatch) => {
            if (phase) ctx.phase(node.name);
            const result = await runLoop({
                ctx, loop: node, key: `${ENGINE}:${key}`, context: await context(extra),
                decode: async (artifact) => {
                    await planningDocuments(artifact, root);
                    if (Object.hasOwn(artifact, "ReleasePlan")) releasePlan(artifact);
                    await decode?.(artifact);
                },
                attempts: attemptsFor(node.id), maxNoProgressRounds: args.maxNoProgressRounds, agents: args.agents, dispatch,
                scheduleAgent: (kind, work, priority) => kind === "doer" && extra.scopeRevision
                    ? resources(["workflow:scope-planning-edits"], () => scheduleAgent(kind, work, priority), priority)
                    : scheduleAgent(kind, work, priority),
                priority: extra.scheduling?.criticalPathMinutes ?? 0,
            });
            const outcome = { loopId: node.id, key, ...result };
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
            rounds: result.rounds, limit: result.limit,
            ...(result.progress ? { stopCause: result.stopCause, progress: result.progress } : {}),
            completedSprints: [...completed], documents, outcomes,
        }).filter(([, value]) => value !== undefined));
        const assignedWork = async (container, sprint, tasks, iteration, planRound = 1, scope = "", inherited = {}, priorDispositions = []) => {
            ctx.phase(container.name);
            const assignments = tasks.filter((task) => task.kind !== "devops");
            return scheduleTasks(assignments, (task, dependencies, criticalPathMinutes) => {
                const loop = all.get(taskKinds[task.kind][1]);
                return perform(loop, `sprint/${iteration}/${sprint.id}${scope}/task/${task.id}${planRound > 1 ? `/plan-round/${planRound}` : ""}/${loop.id}`,
                    { sprint, assignment: task, dependencies, inherited, priorDispositions, scheduling: { criticalPathMinutes } }, undefined, false);
            }, {
                priorities: criticalPathPriorities(tasks), signal: ctx.signal, resources,
                replan: async (task, request, dependencies) => {
                    const revisionKey = `sprint/${iteration}/${sprint.id}${scope}/replan/${task.id}/plan-${planRound}`;
                    const scopeRevision = { assignment: task, request, dependencies, inherited, priorDispositions };
                    const architecture = await perform(all.get("SprintArchitectureLoop"),
                        `${revisionKey}/SprintArchitectureLoop`, { sprint, scopeRevision }, undefined, false);
                    if (architecture.status !== "agreed") return architecture;
                    let settle;
                    const planning = await perform(all.get("SprintPlanLoop"),
                        `${revisionKey}/SprintPlanLoop`, { sprint, scopeRevision }, (artifact) => {
                            if (sprintTasks(artifact).some((item) => item.kind === "devops")) {
                                throw new Error("Scoped replacements must keep DevOps in its original later stage");
                            }
                            if (!artifact.SprintPlan.tasks.length) throw new Error("A scope revision needs at least one bounded replacement handoff");
                        }, false, (artifact, revisionRound, dispositions) => {
                            const replacements = sprintTasks(artifact);
                            const pending = assignedWork(container, sprint, replacements, iteration, revisionRound,
                                `${scope}/replan/${task.id}/plan-${planRound}`, scopeRevision, dispositions)
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
                    return { status: "agreed", taskId: task.id, summary: "Scoped replacement handoffs accepted; capability readiness remains separate.",
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
            let iteration = 0;
            while (true) {
                ctx.signal?.throwIfAborted();
                const plan = releasePlan({ ReleasePlan: documents.ReleasePlan });
                const sprint = plan.sprints.find((candidate) => !completed.includes(candidate.id));
                if (!sprint) break;
                if (args.maxSprints !== undefined && completed.length >= args.maxSprints) {
                    return stopped({
                        status: "limit-reached", loopId: node.id, key: node.id, limit: args.maxSprints,
                        summary: `The explicitly supplied ${args.maxSprints}-sprint limit was reached.`,
                        reason: `Next planned sprint: ${sprint.id}.`,
                        nextAction: "Continue from the completed sprints in a new run; change the explicit sprint limit only if desired.",
                    });
                }
                iteration++;
                let tasks = [];
                let workDispatched = false;
                let settleAssignments;
                const dispatchAssignments = (artifact, round, dispositions) => {
                    const assignments = sprintTasks(artifact);
                    const pending = assignedWork(node, sprint, assignments, iteration, round, "", {}, dispositions)
                        .then((results) => ({ results }), (error) => ({ error }));
                    const settle = async () => {
                        const outcome = await pending;
                        if (outcome.error) throw outcome.error;
                        return outcome.results;
                    };
                    settleAssignments = settle;
                    return {
                        context: {
                            status: "dispatched",
                            taskIds: assignments.filter((task) => task.kind !== "devops").map((task) => task.id),
                            deferredDevOps: assignments.filter((task) => task.kind === "devops").map((task) => task.id),
                            sequencing: "Independent original work loops are dispatched in parallel; dependencies wait for their own reviews. DevOps executes in its original later loop.",
                        },
                        settle,
                    };
                };
                for (const substep of node.substeps) {
                    if (["AssignedWorkUIDeveloperLoop", "AssignedWorkDeveloperLoop"].includes(substep.id)) {
                        if (!workDispatched) {
                            const results = settleAssignments ? await settleAssignments() : await assignedWork(node, sprint, tasks, iteration);
                            const incomplete = results.find((result) => result.status !== "agreed" && result.status !== "not-run") ??
                                results.find((result) => result.status !== "agreed");
                            if (incomplete) return stopped(incomplete);
                            workDispatched = true;
                        }
                        continue;
                    }
                    const result = await perform(substep, `sprint/${iteration}/${sprint.id}/${substep.id}`,
                        { sprint, assignments: tasks, completedSprints: [...completed] },
                        substep.id === "SprintPlanLoop" ? sprintTasks : undefined, true,
                        substep.id === "SprintPlanLoop" ? dispatchAssignments : undefined);
                    if (result.status !== "agreed") return stopped(result);
                    if (substep.id === "SprintPlanLoop") tasks = sprintTasks(result.artifact);
                }
                completed.push(sprint.id);
            }
        }
        return { status: "completed", engine: ENGINE, runId: ctx.runId, completedSprints: completed, documents, outcomes };
    };
}
