export function criticalPathPriorities(tasks) {
    const children = new Map(tasks.map((task) => [task.id, []]));
    for (const task of tasks) for (const id of task.dependsOn) children.get(id).push(task.id);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const priorities = new Map();
    const remaining = (id) => {
        if (priorities.has(id)) return priorities.get(id);
        const own = Object.values(byId.get(id).estimatedMinutes ?? {}).reduce((sum, value) => sum + value, 0);
        const downstream = children.get(id).reduce((longest, child) => Math.max(longest, remaining(child)), 0);
        const duration = Math.min(Number.MAX_VALUE, own + downstream);
        priorities.set(id, duration);
        return duration;
    };
    tasks.forEach((task) => remaining(task.id));
    return priorities;
}

export function createAgentScheduler(concurrency = {}, signal) {
    if (!concurrency || typeof concurrency !== "object" || Array.isArray(concurrency) ||
        Object.entries(concurrency).some(([key, value]) =>
            !["doers", "reviewers"].includes(key) || !Number.isSafeInteger(value) || value < 1)) {
        throw new Error("concurrency accepts only positive integer doers and reviewers capacities");
    }
    const queues = { doer: [], reviewer: [] }, active = { doer: 0, reviewer: 0 };
    const capacity = { doer: concurrency.doers ?? Infinity, reviewer: concurrency.reviewers ?? Infinity };
    let sequence = 0, listening = false;
    const cleanup = () => {
        if (!active.doer && !active.reviewer && !queues.doer.length && !queues.reviewer.length) {
            signal?.removeEventListener("abort", abort);
            listening = false;
        }
    };
    const abort = () => {
        for (const queue of Object.values(queues)) for (const entry of queue.splice(0)) entry.reject(signal.reason);
        cleanup();
    };
    const drain = (kind) => {
        queues[kind].sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        while (queues[kind].length && active[kind] < capacity[kind]) {
            const entry = queues[kind].shift();
            if (signal?.aborted) { entry.reject(signal.reason); continue; }
            active[kind]++;
            const finish = () => { active[kind]--; drain(kind); cleanup(); };
            Promise.resolve().then(() => { signal?.throwIfAborted(); return entry.work(); }).then(
                (value) => { finish(); entry.resolve(value); },
                (error) => { finish(); entry.reject(error); },
            );
        }
    };
    return (kind, work, priority = 0) => new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        if (!listening && signal) { signal.addEventListener("abort", abort, { once: true }); listening = true; }
        queues[kind].push({ work, priority, sequence: sequence++, resolve, reject });
        drain(kind);
    });
}

export function createResourceScheduler(signal) {
    const held = new Set(), queue = [];
    let sequence = 0;
    const drain = () => {
        queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        for (let index = 0; index < queue.length;) {
            const entry = queue[index];
            if (signal?.aborted) { queue.splice(index, 1); entry.reject(signal.reason); continue; }
            if (entry.resources.some((name) => held.has(name))) { index++; continue; }
            queue.splice(index, 1);
            entry.resources.forEach((name) => held.add(name));
            const finish = () => { entry.resources.forEach((name) => held.delete(name)); drain(); };
            Promise.resolve().then(() => { signal?.throwIfAborted(); return entry.work(); }).then(
                (value) => { finish(); entry.resolve(value); },
                (error) => { finish(); entry.reject(error); },
            );
        }
    };
    return (resources, work, priority = 0) => new Promise((resolve, reject) => {
        queue.push({ resources, work, priority, sequence: sequence++, resolve, reject });
        drain();
    });
}

export function scheduleTasks(tasks, execute, { priorities = criticalPathPriorities(tasks), signal,
    resources = createResourceScheduler(signal), replan } = {}) {
    const pending = new Set(tasks.map((task) => task.id)), results = new Map(), failures = new Map();
    const order = tasks.map((task, index) => ({ task, index }))
        .sort((a, b) => priorities.get(b.task.id) - priorities.get(a.task.id) || a.index - b.index);
    let active = 0;
    return new Promise((resolve, reject) => {
        const pump = () => {
            if (signal?.aborted) {
                if (!active) reject(signal.reason);
                return;
            }
            let changed;
            do {
                changed = false;
                for (const { task } of order) {
                    if (!pending.has(task.id) || !task.dependsOn.every((id) => results.has(id))) continue;
                    const dependencies = task.dependsOn.map((id) => results.get(id));
                    const incomplete = dependencies.find((result) => result.status !== "agreed");
                    if (incomplete) {
                        pending.delete(task.id);
                        results.set(task.id, { status: "not-run", taskId: task.id, reason: "A dependency did not finish", dependency: incomplete });
                        changed = true;
                        continue;
                    }
                    pending.delete(task.id);
                    active++;
                    changed = true;
                    resources(task.exclusiveResources ?? [], () => execute(task, dependencies, priorities.get(task.id)),
                        priorities.get(task.id)).then(async (outcome) => {
                        const result = outcome?.status === "needs-replan" && replan
                            ? await replan(task, outcome, dependencies) : outcome;
                        if (!result || typeof result.status !== "string") throw new Error("No assignment outcome was recorded");
                        results.set(task.id, result);
                    }).catch((error) => {
                        failures.set(task.id, error);
                        results.set(task.id, { status: "error", taskId: task.id, reason: String(error?.message ?? error) });
                    }).finally(() => {
                        active--;
                        pump();
                    });
                }
            } while (changed && pending.size);
            if (!active) {
                if (failures.size) reject(new AggregateError([...failures.values()],
                    `Assigned work execution failed for ${[...failures.keys()].join(", ")}; no completion was recorded`));
                else if (pending.size) reject(new Error(`No ready assignments: ${[...pending].join(", ")}`));
                else resolve(tasks.map((task) => results.get(task.id)));
            }
        };
        pump();
    });
}
