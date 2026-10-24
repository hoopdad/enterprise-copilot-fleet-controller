import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { definition as installedDefinition, loadWorkflow, flattenLoops } from "./loop-source.mjs";
import { runLoop } from "./lab-loops.mjs";
import { validateWorkCard } from "./work-cards.mjs";
import { dispositionContext, scopeContext } from "./scope-governance.mjs";
import { archiveContext, documentContext, historyLocation, outcomeContext, outcomeIndex } from "./task-context.mjs";
import { createAgentScheduler, createResourceScheduler, criticalPathPriorities, scheduleTasks } from "./scheduling.mjs";
import { terminalInvocation, validateContinuation } from "./continuation.mjs";

export const ENGINE = "yaml-loops-v1";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const e2eReport = (outcome) => outcome?.artifact?.PASS ?? outcome?.artifact?.["FAIL with feedback"];
const sourceSubject = (outcome) => outcome.status === "agreed" && outcome.taskId &&
    outcome.loopId === "AssignedWorkDeveloperLoop" &&
    outcome.artifact?.DeveloperWork?.taskComplete === true &&
    /^[0-9a-f]{40}$/.test(outcome.artifact.DeveloperWork.commit ?? "") &&
    outcome.reviews?.length === 2 &&
    ["Architect", "Critic"].every((role) => outcome.reviews.some((review) =>
        review.role === role && review.agree === true && review.taskComplete === true));
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
        if (!audits.has(outcome)) {
            audits.set(outcome, await archiveContext(common.history, `outcome ${outcome.key}`, outcome));
        }
    }
    const handoff = async (outcome) => outcomeContext(outcome,
        audits.get(outcome) ?? audits.get(outcome.key) ?? await archiveContext(common.history, "dependency outcome", outcome));
    return structuredClone({
        ...common,
        documents: Object.fromEntries(Object.entries(currentDocuments).map(([name, document]) =>
            [name, documentContext(document, documentAudits.get(name))])),
        outcomes: currentOutcomes.map((outcome) => outcomeIndex(outcome, audits.get(outcome))),
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
        const sprintStates = new Map(), continuationAudits = [], failures = [];
        let workVersion = 0;
        const brief = (outcome) => Object.fromEntries(Object.entries({
            ...outcomeIndex(outcome, audits.get(outcome) ?? audits.get(outcome.key)), sprintId: outcome.sprintId,
            taskId: outcome.taskId, summary: outcome.summary ?? outcome.reason,
            nextAction: outcome.nextAction, workCard: outcome.workCard, blockedBy: outcome.blockedBy,
            continuation: outcome.artifact?.Continuation, stopCause: outcome.stopCause, progress: outcome.progress,
        }).filter(([, value]) => value !== undefined));
        const graphs = (state) => {
            const visit = (work) => work ? [work, ...[...work.replacements.values()]
                .flatMap((replacement) => visit(replacement.work))] : [];
            return [state.graph, ...state.additional].flatMap(visit);
        };
        const blockers = (state) => [...new Map([
            ...[...state.stages.values()].filter((result) => result.status !== "agreed"),
            ...graphs(state).flatMap((graph) => [...graph.results.values()])
                .filter((result) => !["agreed", "not-run"].includes(result.status)),
        ].map((result) => [result.key, result])).values()];
        const latestContinuationAudits = () => [...new Map(continuationAudits.map((outcome) =>
            [outcome.sprintId, outcome])).values()];
        const delivery = () => ({
            completedSprints: [...completed],
            partialSprints: [...sprintStates.values()].filter((state) => !completed.includes(state.sprint.id))
                .map((state) => ({ id: state.sprint.id, blockedKeys: blockers(state).map((result) => result.key) })),
            pendingSprints: (documents.ReleasePlan?.sprints ?? []).filter((sprint) => !sprintStates.has(sprint.id))
                .map((sprint) => ({ id: sprint.id, dependsOn: sprint.dependsOn ?? [] })),
            acceptedWork: outcomes.filter((outcome) => outcome.status === "agreed" && outcome.taskId)
                .toSorted((left, right) => left.key.localeCompare(right.key)).map((outcome) => ({
                    ...outcomeIndex(outcome, audits.get(outcome)),
                    ...(outcome.workCard ? { scope: {
                        action: outcome.workCard.action, components: outcome.workCard.components,
                        flows: outcome.workCard.flows, locations: outcome.workCard.locations,
                    } } : {}),
                })),
            remainingWork: [...sprintStates.values()].flatMap((state) => graphs(state).flatMap((work) =>
                work.tasks.filter((task) => task.kind !== "devops" && work.results.get(task.id)?.status !== "agreed")
                    .map((task) => ({ sprintId: state.sprint.id, scope: work.scope, task,
                        outcome: work.results.has(task.id) ? outcomeIndex(work.results.get(task.id),
                            audits.get(work.results.get(task.id))) : { status: "pending" } })))),
            blockedWork: [...sprintStates.values()].flatMap(blockers).concat(latestContinuationAudits()
                .filter((outcome) => outcome.status !== "agreed" && !completed.includes(outcome.sprintId))).map(brief),
            continuationAudits: continuationAudits.map(brief),
        });
        const common = {
            projectRoot: root, request: args, specification: await specification(args, root),
            ...(ctx.runId ? { history: historyLocation(root, ctx.runId) } : {}),
            roleDescriptions: source.roles, engine: ENGINE,
            orchestration: "Original YAML owners and reviewers govern acceptance. A blocked branch does not stop useful authorized release construction. Drain independent approved sprints and use existing Architect/Scrum Master continuation amendments before waiting. Preserve incomplete sprints and original acceptance, DevOps placement, permissions and explicit limits. Feedback triage and scoped replanning remain in their original roles; retired native admission/receipt protocols are not restored.",
        };
        const context = ({ sprintDocuments, sprintDocumentAudits, ...extra } = {}) => {
            const packet = delivery();
            packet.continuationAudits = latestContinuationAudits().map((outcome) => ({
                ...outcomeIndex(outcome, audits.get(outcome)),
                ...(outcome.artifact?.Continuation ? { disposition: outcome.artifact.Continuation.disposition } : {}),
            }));
            return taskContext(common, { ...documents, ...sprintDocuments }, outcomes,
                { delivery: packet, ...extra }, audits, new Map([...documentAudits, ...(sprintDocumentAudits ?? [])]));
        };
        const attemptsFor = (id) => args.attempts?.[id] ?? args.attempts?.[
            ["AssignedWorkUIDeveloperLoop", "AssignedWorkDeveloperLoop", "DevOpsWorkLoop"].includes(id) ? "implementation" : "planning"];
        const retain = async (outcome) => {
            const previous = outcomes.findLast((item) => item.key === outcome.key && isDeepStrictEqual(item, outcome));
            if (previous) return previous;
            const audit = await archiveContext(common.history, `outcome ${outcome.key}`, outcome);
            audits.set(outcome, audit);
            audits.set(outcome.key, audit);
            outcomes.push(outcome);
            return outcome;
        };
        const perform = async (node, key, extra = {}, decode, phase = true, dispatch, executionKey = key) => {
            if (phase) ctx.phase(node.name);
            const result = await runLoop({
                ctx, loop: node, key: `${ENGINE}:${executionKey}`, context: await context(extra),
                decode: async (artifact) => {
                    await planningDocuments(artifact, root);
                    if (Object.hasOwn(artifact, "ReleasePlan")) {
                        const plan = releasePlan(artifact);
                        if ([...sprintStates.keys()].some((id) => !completed.includes(id) &&
                            !plan.sprints.some((sprint) => sprint.id === id))) {
                            throw new Error("ReleasePlan must preserve entered incomplete sprints and their unmet acceptance");
                        }
                    }
                    await decode?.(artifact);
                },
                attempts: attemptsFor(node.id), maxNoProgressRounds: args.maxNoProgressRounds, agents: args.agents, dispatch,
                scheduleAgent: (kind, work, priority) => kind === "doer" && extra.scopeRevision
                    ? resources(["workflow:scope-planning-edits"], () => scheduleAgent(kind, work, priority), priority)
                    : scheduleAgent(kind, work, priority),
                priority: extra.scheduling?.criticalPathMinutes ?? 0,
            });
            const outcome = await retain({ loopId: node.id, key,
                ...(extra.sprint ? { sprintId: extra.sprint.id } : {}),
                ...(extra.assignment ? { taskId: extra.assignment.id } : {}), ...result });
            if (result.status === "agreed") {
                const accepted = { ...result.artifact };
                if (extra.scopeRevision || extra.continuation) delete accepted.SprintPlan;
                delete accepted.Continuation;
                Object.assign(documents, accepted);
                for (const name of Object.keys(accepted)) documentAudits.set(name, audits.get(key));
                if (extra.assignment || extra.resume ||
                    ["EndToEndTestLoop", "DevOpsWorkLoop"].includes(node.id)) workVersion++;
            }
            return outcome;
        };
        const stopped = (result) => {
            const checkpoint = delivery();
            if (!checkpoint.blockedWork.some((blocked) => blocked.key === result.key)) checkpoint.blockedWork.push(brief(result));
            return Object.fromEntries(Object.entries({
                status: result.status, engine: ENGINE, runId: ctx.runId, summary: result.summary ?? result.reason,
                stoppedAt: result.loopId, stoppedKey: result.key, reason: result.reason, nextAction: result.nextAction,
                workCard: result.workCard,
                rounds: result.rounds, limit: result.limit,
                ...(result.progress ? { stopCause: result.stopCause, progress: result.progress } : {}),
                completedSprints: [...completed], documents, outcomes, delivery: { state: "waiting",
                    waitReason: result.status === "limit-reached" ? "explicit-limit"
                        : result.key?.includes("/continuation/") ? "continuation-review"
                        : result.loopId === "ReleaseCloseoutLoop" ? "release-closeout"
                        : sprintStates.size ? "work-exhausted" : "prerequisite-planning", ...checkpoint },
            }).filter(([, value]) => value !== undefined));
        };
        const assignedWork = async (container, sprint, tasks, iteration, planRound = 1, scope = "", inherited = {}, priorDispositions = [],
            retainedResults = new Map(), revisions = new Map(), reassessments = new Map(), sprintDocuments = {},
            sprintDocumentAudits = new Map(), workGraph) => {
            ctx.phase(container.name);
            const assignments = tasks.filter((task) => task.kind !== "devops");
            const taskKey = (task) => `sprint/${iteration}/${sprint.id}${scope}/task/${task.id}${planRound > 1 ? `/plan-round/${planRound}` : ""}${revisions.has(task.id) ? `/resume/${revisions.get(task.id)}` : ""}/${taskKinds[task.kind][1]}`;
            const results = await scheduleTasks(assignments, (task, dependencies, criticalPathMinutes) => {
                if (workGraph?.replacements.has(task.id)) return workGraph.replacements.get(task.id).request;
                const loop = all.get(taskKinds[task.kind][1]);
                return perform(loop, taskKey(task),
                    { sprint, assignment: task, dependencies, inherited, priorDispositions, sprintDocuments, sprintDocumentAudits,
                        ...(reassessments.has(task.id) ? { resume: reassessments.get(task.id) } : {}),
                        scheduling: { criticalPathMinutes } }, undefined, false);
            }, {
                priorities: criticalPathPriorities(tasks), signal: ctx.signal, resources, retainedResults, settleErrors: true,
                replan: async (task, request, dependencies) => {
                    const revisionKey = `sprint/${iteration}/${sprint.id}${scope}/replan/${task.id}/plan-${planRound}`;
                    let replacement = workGraph?.replacements.get(task.id);
                    if (!replacement) {
                        replacement = { request, scopeRevision: { assignment: task, request, dependencies, inherited, priorDispositions },
                            revisions: new Map(), reassessments: new Map() };
                        workGraph?.replacements.set(task.id, replacement);
                    }
                    const { scopeRevision } = replacement;
                    const suffixFor = (id) => replacement.revisions.has(id) ? `/resume/${replacement.revisions.get(id)}` : "";
                    const resumeFor = (id) => replacement.reassessments.has(id)
                        ? { resume: replacement.reassessments.get(id) } : {};
                    const architectureId = "SprintArchitectureLoop", planId = "SprintPlanLoop";
                    replacement.architecture ??= await perform(all.get(architectureId),
                        `${revisionKey}${suffixFor(architectureId)}/${architectureId}`,
                        { sprint, scopeRevision, sprintDocuments, sprintDocumentAudits, ...resumeFor(architectureId) }, undefined, false);
                    if (replacement.architecture.status !== "agreed") return replacement.architecture;
                    const scopedDocuments = { ...sprintDocuments, ...replacement.architecture.artifact };
                    const scopedAudits = new Map([...sprintDocumentAudits, ...Object.keys(replacement.architecture.artifact)
                        .map((name) => [name, audits.get(replacement.architecture.key)])]);
                    const state = sprintStates.get(sprint.id);
                    replacement.planning ??= await perform(all.get(planId),
                        `${revisionKey}${suffixFor(planId)}/${planId}`, { sprint, scopeRevision,
                            sprintDocuments: scopedDocuments, sprintDocumentAudits: scopedAudits, ...resumeFor(planId) }, (artifact) => {
                            if (sprintTasks(artifact).some((item) => item.kind === "devops")) {
                                throw new Error("Scoped replacements must keep DevOps in its original later stage");
                            }
                            if (!artifact.SprintPlan.tasks.length) throw new Error("A scope revision needs at least one bounded replacement handoff");
                        }, false, (artifact, revisionRound, dispositions) => {
                            const previous = replacement.work;
                            replacement.work = graph(sprintTasks(artifact), revisionRound,
                                `${scope}/replan/${task.id}/plan-${planRound}${suffixFor(planId)}`, dispositions);
                            replacement.work.inherited = scopeRevision;
                            replacement.work.documents = scopedDocuments;
                            replacement.work.documentAudits = scopedAudits;
                            if (suffixFor(planId) && previous) retainIdenticalTasks(previous, replacement.work);
                            const dispatched = dispatchGraph(container, state, replacement.work);
                            return { ...dispatched, context: { ...dispatched.context,
                                replacesTask: task.id, preservesUnrelatedWork: true } };
                        });
                    if (replacement.work?.pending) await settleGraph(container, state, replacement.work);
                    if (replacement.planning.status !== "agreed") return replacement.planning;
                    if (!replacement.work) {
                        replacement.work = graph(sprintTasks(replacement.planning.artifact), replacement.planning.rounds,
                            `${scope}/replan/${task.id}/plan-${planRound}${suffixFor(planId)}`);
                        replacement.work.inherited = scopeRevision;
                        replacement.work.documents = scopedDocuments;
                        replacement.work.documentAudits = scopedAudits;
                    }
                    const results = await settleGraph(container, state, replacement.work);
                    const incomplete = results.find((result) => result.status !== "agreed");
                    if (incomplete) return incomplete;
                    return { status: "agreed", taskId: task.id, summary: "Scoped replacement handoffs accepted; capability readiness remains separate.",
                        artifact: Object.assign({}, ...results.map((result) => result.artifact)),
                        replacements: results.map((result) => ({ key: result.key, status: result.status })) };
                },
            });
            return Promise.all(results.map(async (result, index) => {
                if (result.key) return result;
                const task = assignments[index];
                const outcome = { ...result, key: `${taskKey(task)}/${result.status}`,
                    loopId: taskKinds[task.kind][1], taskId: task.id, sprintId: sprint.id,
                    ...(result.dependency?.key ? { blockedBy: [result.dependency.key] } : {}) };
                if (result.status === "error") {
                    ctx.log(`Assignment ${task.id} failed; continuing independent release work: ${result.reason}`);
                    failures.push(new Error(`Assigned work execution failed for ${task.id}: ${result.reason}`));
                }
                return retain(outcome);
            }));
        };
        const graph = (tasks, round = 1, scope = "", dispositions = []) => ({
            tasks, round, scope, dispositions, results: new Map(), revisions: new Map(), reassessments: new Map(), replacements: new Map(),
        });
        const retainIdenticalTasks = (previous, work) => {
            for (const task of work.tasks) {
                if (isDeepStrictEqual(task, previous.tasks.find((previousTask) => previousTask.id === task.id)) &&
                    previous.results.has(task.id) && previous.results.get(task.id).status !== "not-run") {
                    work.results.set(task.id, previous.results.get(task.id));
                    if (previous.replacements.has(task.id)) work.replacements.set(task.id, previous.replacements.get(task.id));
                }
            }
        };
        const executeGraph = async (container, state, work) => {
            const results = await assignedWork(container, state.sprint, work.tasks, state.iteration, work.round,
                work.scope, work.inherited ?? {}, work.dispositions, work.results, work.revisions, work.reassessments,
                work.documents ?? state.documents, work.documentAudits ?? state.documentAudits, work);
            work.results = new Map(work.tasks.filter((task) => task.kind !== "devops")
                .map((task, index) => [task.id, results[index]]));
            return results;
        };
        const dispatchGraph = (container, state, work) => {
            work.pending = executeGraph(container, state, work).then(
                (results) => ({ results }), (error) => ({ error }));
            const settle = async () => {
                const settled = await work.pending;
                if (settled.error) throw settled.error;
                return settled.results;
            };
            return {
                context: { status: "dispatched",
                    taskIds: work.tasks.filter((task) => task.kind !== "devops").map((task) => task.id),
                    deferredDevOps: work.tasks.filter((task) => task.kind === "devops").map((task) => task.id),
                    sequencing: "Independent original work loops run in parallel; only their own prerequisites block them. DevOps remains in its original later stage." },
                settle,
            };
        };
        const settleGraph = async (container, state, work) => {
            if (!work.pending) return executeGraph(container, state, work);
            const settled = await work.pending;
            work.pending = null;
            if (settled.error) throw settled.error;
            return settled.results;
        };
        const stage = async (node, key, extra, decode, dispatch, executionKey = key) => {
            try { return await perform(node, key, extra, decode, true, dispatch, executionKey); }
            catch (error) {
                ctx.signal?.throwIfAborted();
                ctx.log(`${node.name} failed; retaining the failure while other release work continues: ${error.message}`);
                failures.push(error);
                return retain({ key, loopId: node.id, sprintId: extra.sprint.id,
                    status: "error", reason: error.message, summary: error.message,
                    nextAction: "Repair this failed invocation before reassessment; do not replay uncertain effects." });
            }
        };
        const runSprint = async (container, state) => {
            const sprint = state.sprint;
            for (const substep of container.substeps) {
                ctx.signal?.throwIfAborted();
                if (["AssignedWorkUIDeveloperLoop", "AssignedWorkDeveloperLoop"].includes(substep.id)) {
                    if (state.graph) await settleGraph(container, state, state.graph);
                    if (graphs(state).some((work) => [...work.results.values()].some((result) => result.status !== "agreed"))) return;
                    continue;
                }
                const previous = state.stages.get(substep.id);
                if (previous) {
                    if (previous.status !== "agreed") return;
                    continue;
                }
                const suffix = state.revisions.has(substep.id) ? `/resume/${state.revisions.get(substep.id)}` : "";
                const qualification = substep.id === "EndToEndTestLoop" ? state.e2eQualification : undefined;
                const canonicalKey = `sprint/${state.iteration}/${sprint.id}/${substep.id}`;
                const executionKey = qualification
                    ? `sprint/${state.iteration}/${sprint.id}/requalification/${qualification.round}${suffix}/${substep.id}`
                    : `sprint/${state.iteration}/${sprint.id}${suffix}/${substep.id}`;
                const result = await stage(substep, qualification ? canonicalKey : executionKey,
                    { sprint, assignments: state.graph?.tasks ?? [], completedSprints: [...completed],
                        sprintDocuments: qualification ? { ...state.documents,
                            DeveloperWork: qualification.subject.artifact.DeveloperWork } : state.documents,
                        sprintDocumentAudits: qualification ? new Map([...state.documentAudits,
                            ["DeveloperWork", audits.get(qualification.subject)]]) : state.documentAudits,
                        ...(qualification ? { e2eQualification: {
                            semanticKey: canonicalKey, testedRevision: qualification.commit,
                            subject: outcomeContext(qualification.subject, audits.get(qualification.subject)),
                            previous: brief(qualification.previous),
                        }, dependencies: [qualification.subject] } : {}),
                        ...(state.reassessments.has(substep.id) ? { resume: state.reassessments.get(substep.id) } : {}) },
                    qualification ? (artifact) => {
                        const report = e2eReport({ artifact });
                        if (Object.keys(artifact).length !== 1 || !object(report) ||
                            report.taskComplete !== true || report.testedRevision !== qualification.commit) {
                            throw new Error("Original E2E must report taskComplete and the exact retained testedRevision under PASS or FAIL with feedback");
                        }
                    } : substep.id === "SprintPlanLoop" ? sprintTasks : undefined,
                    substep.id === "SprintPlanLoop" ? (artifact, round, dispositions) => {
                        const previousGraph = state.graph;
                        state.graph = graph(sprintTasks(artifact), round, suffix, dispositions);
                        if (suffix && previousGraph) retainIdenticalTasks(previousGraph, state.graph);
                        return dispatchGraph(container, state, state.graph);
                    } : undefined, executionKey);
                state.stages.set(substep.id, result);
                if (state.graph?.pending) await settleGraph(container, state, state.graph);
                if (result.status !== "agreed") return;
                if (substep.id === "SprintPlanLoop" && !state.graph) {
                    state.graph = graph(sprintTasks(result.artifact), result.rounds, suffix);
                }
                for (const name of ["SprintDesign", "SprintArchitecture", "SprintPlan"]) {
                    if (result.artifact[name] !== undefined) {
                        state.documents[name] = result.artifact[name];
                        state.documentAudits.set(name, audits.get(result.key));
                    }
                }
            }
            if (!completed.includes(sprint.id)) { completed.push(sprint.id); workVersion++; }
        };
        const continueSprint = async (container, state) => {
            const blocked = blockers(state);
            if (!blocked.length || state.auditLimited || state.auditedAt === workVersion) return;
            state.auditedAt = workVersion;
            const round = ++state.continuationRound;
            const key = `sprint/${state.iteration}/${state.sprint.id}/continuation/${round}`;
            const priorE2E = state.stages.get("EndToEndTestLoop");
            const dependent = state.stages.get("DevOpsWorkLoop");
            const continuation = {
                round, blocked: blocked.map(brief),
                sourceSubjects: outcomes.filter(sourceSubject).map((outcome) => ({
                    key: outcome.key, sprintId: outcome.sprintId, commit: outcome.artifact.DeveloperWork.commit,
                    ...(audits.get(outcome) ? { audit: audits.get(outcome) } : {}),
                })),
                ...(state.stages.has("EndToEndTestLoop") ? { e2e: {
                    ...brief(state.stages.get("EndToEndTestLoop")),
                    ...(e2eReport(state.stages.get("EndToEndTestLoop"))?.testedRevision ? {
                        testedRevision: e2eReport(state.stages.get("EndToEndTestLoop")).testedRevision,
                    } : {}),
                } } : {}),
                recheckable: priorE2E?.status === "agreed" && dependent && dependent.status !== "agreed" &&
                    !terminalInvocation(dependent) ? [{ ...brief(priorE2E), blockedKey: dependent.key }] : [],
                scheduledTaskIds: graphs(state).flatMap((work) => work.tasks.map((task) => task.id)),
                availableSprints: releasePlan({ ReleasePlan: documents.ReleasePlan }).sprints
                    .filter((sprint) => sprintStates.has(sprint.id) ||
                        args.maxSprints === undefined && (sprint.dependsOn ?? []).every((id) => completed.includes(id)))
                    .map((sprint) => sprint.id),
            };
            ctx.log(`Continuing around blockers in ${state.sprint.id}: auditing splits, independent release work and changed evidence`);
            const extra = { sprint: state.sprint, continuation,
                sprintDocuments: state.documents, sprintDocumentAudits: state.documentAudits };
            const architecture = await stage(all.get("SprintArchitectureLoop"), `${key}/SprintArchitectureLoop`, extra);
            if (architecture.status !== "agreed") {
                continuationAudits.push(architecture);
                state.auditLimited = terminalInvocation(architecture);
                return;
            }
            if (architecture.artifact.SprintArchitecture !== undefined) {
                state.documents.SprintArchitecture = architecture.artifact.SprintArchitecture;
                state.documentAudits.set("SprintArchitecture", audits.get(architecture.key));
            }
            let work;
            const planning = await stage(all.get("SprintPlanLoop"), `${key}/SprintPlanLoop`, extra,
                (artifact) => validateContinuation(artifact, continuation, sprintTasks(artifact)),
                (artifact, planRound, dispositions) => {
                    work = graph(sprintTasks(artifact), planRound, `/continuation/${round}`, dispositions);
                    return dispatchGraph(container, state, work);
                });
            continuationAudits.push(planning);
            if (!work && planning.status === "agreed") {
                work = graph(sprintTasks(planning.artifact), planning.rounds, `/continuation/${round}`);
            }
            if (work) {
                state.additional.push(work);
                await settleGraph(container, state, work);
            }
            if (planning.status !== "agreed") {
                state.auditLimited = terminalInvocation(planning);
                return;
            }
            const report = planning.artifact.Continuation;
            if (report.disposition === "exhausted") {
                ctx.log(`${state.sprint.id}: reviewed work-exhaustion assessment: ${report.summary}`);
                return;
            }
            for (const resume of report.resumes) {
                if (!resume.after.every((id) => work.results.get(id)?.status === "agreed")) continue;
                const previous = blocked.find((result) => result.key === resume.key);
                const evidence = { previous: brief(previous), evidence: resume.evidence,
                    handoffs: resume.after.map((id) => brief(work.results.get(id))),
                    assessment: brief(architecture), plan: brief(planning),
                    ...(resume.recheck?.length ? { rechecks: continuation.recheckable
                        .filter((prior) => resume.recheck.includes(prior.key)) } : {}) };
                const rechecks = (resume.recheck ?? []).map((key) =>
                    [...state.stages].find(([, result]) => result.key === key));
                const entry = [...state.stages].find(([, result]) => result.key === resume.key);
                if (entry) {
                    // Legacy after-only plans must not reuse E2E for older source.
                    const changedSources = entry[0] === "DevOpsWorkLoop"
                        ? resume.after.map((id) => work.results.get(id)).filter((outcome) =>
                            sourceSubject(outcome) && outcome.artifact.DeveloperWork.commit !==
                                e2eReport(state.stages.get("EndToEndTestLoop"))?.testedRevision)
                        : [];
                    if (resume.e2eSubject === undefined && changedSources.length > 1) {
                        throw new Error("Multiple changed source subjects require an explicit accepted e2eSubject; never guess latest DeveloperWork");
                    }
                    const subjectKey = resume.e2eSubject ?? changedSources[0]?.key;
                    if (subjectKey !== undefined) {
                        const subject = outcomes.find((outcome) => outcome.key === subjectKey && sourceSubject(outcome));
                        validateContinuation({ Continuation: { ...report, resumes: [{ ...resume, e2eSubject: subjectKey }] } }, {
                            ...continuation,
                            sourceSubjects: outcomes.filter(sourceSubject).map((outcome) => ({
                                key: outcome.key, sprintId: outcome.sprintId, commit: outcome.artifact.DeveloperWork.commit,
                            })),
                            e2e: { status: state.stages.get("EndToEndTestLoop")?.status,
                                testedRevision: e2eReport(state.stages.get("EndToEndTestLoop"))?.testedRevision },
                        }, work.tasks);
                        state.e2eQualification = { subject, commit: subject.artifact.DeveloperWork.commit,
                            previous: state.stages.get("EndToEndTestLoop"), round };
                        state.stages.delete("EndToEndTestLoop");
                    }
                    state.stages.delete(entry[0]);
                    state.revisions.set(entry[0], (state.revisions.get(entry[0]) ?? 0) + 1);
                    state.reassessments.set(entry[0], evidence);
                } else {
                    for (const existing of graphs(state)) for (const replacement of existing.replacements.values()) {
                        for (const [field, id] of [["architecture", "SprintArchitectureLoop"], ["planning", "SprintPlanLoop"]]) {
                            if (replacement[field]?.key !== resume.key) continue;
                            replacement[field] = undefined;
                            replacement.revisions.set(id, (replacement.revisions.get(id) ?? 0) + 1);
                            replacement.reassessments.set(id, evidence);
                        }
                    }
                    for (const existing of graphs(state)) {
                        const task = [...existing.results].find(([, result]) => result.key === resume.key);
                        if (!task) continue;
                        existing.results.delete(task[0]);
                        if (!existing.replacements.has(task[0])) {
                            existing.revisions.set(task[0], (existing.revisions.get(task[0]) ?? 0) + 1);
                            existing.reassessments.set(task[0], evidence);
                        }
                    }
                }
                for (const [id, prior] of rechecks) {
                    state.stages.delete(id);
                    state.revisions.set(id, (state.revisions.get(id) ?? 0) + 1);
                    state.reassessments.set(id, { ...evidence, previous: brief(prior),
                        blocked: brief(previous), kind: "prerequisite-recheck" });
                }
            }
            for (const existing of graphs(state)) await settleGraph(container, state, existing);
            await runSprint(container, state);
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
                cap = undefined;
                let sprint;
                while ((sprint = releasePlan({ ReleasePlan: documents.ReleasePlan }).sprints.find((candidate) =>
                    !sprintStates.has(candidate.id) && (candidate.dependsOn ?? []).every((id) => completed.includes(id))))) {
                    if (args.maxSprints !== undefined && sprintStates.size >= args.maxSprints) {
                        cap = { status: "limit-reached", loopId: node.id, key: node.id, limit: args.maxSprints,
                            summary: `The explicitly supplied ${args.maxSprints}-sprint limit was reached.`,
                            reason: `Next planned sprint: ${sprint.id}; entered partial sprints also count.`,
                            nextAction: "Continue from retained accepted and partial work in a new run; change the explicit sprint limit only if desired." };
                        break;
                    }
                    const state = { sprint, iteration: sprintStates.size + 1, graph: null, additional: [],
                        stages: new Map(), documents: {}, documentAudits: new Map(), revisions: new Map(), reassessments: new Map(),
                        continuationRound: 0, auditedAt: -1 };
                    sprintStates.set(sprint.id, state);
                    await runSprint(node, state);
                }
                const pendingAudits = [...sprintStates.values()].filter((state) =>
                    !completed.includes(state.sprint.id) && !state.auditLimited &&
                    blockers(state).length && state.auditedAt !== workVersion);
                if (!pendingAudits.length) break;
                for (const state of pendingAudits) await continueSprint(node, state);
            }
            if (failures.length) {
                const checkpoint = await archiveContext(common.history, "release execution failure checkpoint", {
                    status: "error", engine: ENGINE, runId: ctx.runId, documents, outcomes, delivery: delivery(),
                    failures: failures.map((failure) => failure.message),
                });
                if (checkpoint) ctx.log(`Incomplete release checkpoint retained at ${checkpoint.path}`);
                const error = new AggregateError(failures,
                    `Release work exhausted with execution failures: ${failures.map((failure) => failure.message).join("; ")}${checkpoint ? `; checkpoint: ${checkpoint.path}` : ""}`);
                error.delivery = delivery();
                throw error;
            }
            const unresolved = [...sprintStates.values()].flatMap(blockers);
            if (cap) return stopped(cap);
            const coordinationBlocker = latestContinuationAudits().find((outcome) =>
                outcome.status !== "agreed" && !completed.includes(outcome.sprintId));
            if (coordinationBlocker) return stopped(coordinationBlocker);
            if (unresolved.length) return stopped(unresolved[0]);
            if (delivery().pendingSprints.length) throw new Error("Release has pending sprints without executable prerequisites");
        }
        return { status: "completed", engine: ENGINE, runId: ctx.runId, completedSprints: completed, documents, outcomes,
            delivery: { state: "completed", ...delivery() } };
    };
}
