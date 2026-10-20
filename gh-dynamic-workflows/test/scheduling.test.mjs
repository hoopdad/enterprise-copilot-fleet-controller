import test from "node:test";
import assert from "node:assert/strict";
import { createAgentScheduler, criticalPathPriorities, scheduleTasks } from "../scheduling.mjs";

const task = (id, dependsOn = [], extra = {}) => ({ id, dependsOn, ...extra });
const deferred = () => Promise.withResolvers();

test("critical paths include implementation, review and integration, taking the longest downstream branch", () => {
    const tasks = [
        task("contract", [], { estimatedMinutes: { implementation: 2, review: 3 } }),
        task("ui", ["contract"], { estimatedMinutes: { implementation: 10, review: 2, integration: 3 } }),
        task("api", ["contract"], { estimatedMinutes: { implementation: 4, review: 2 } }),
        task("integrate", ["ui", "api"], { estimatedMinutes: { integration: 7 } }),
        task("unestimated"),
    ];
    const priorities = criticalPathPriorities(tasks);
    assert.equal(priorities.get("contract"), 27);
    assert.equal(priorities.get("ui"), 22);
    assert.equal(priorities.get("api"), 13);
    assert.equal(priorities.get("integrate"), 7);
    assert.equal(priorities.get("unestimated"), 0);
});

test("bounded do-er queues prioritize ready work and reserve independent reviewer capacity", async () => {
    const schedule = createAgentScheduler({ doers: 1, reviewers: 1 });
    const held = deferred(), started = deferred(), events = [];
    const first = schedule("doer", async () => { events.push("first"); started.resolve(); await held.promise; });
    await started.promise;
    const low = schedule("doer", () => events.push("low"), 1);
    const high = schedule("doer", () => events.push("high"), 10);
    await schedule("reviewer", () => events.push("review"));
    assert.deepEqual(events, ["first", "review"]);
    held.resolve();
    await Promise.all([first, low, high]);
    assert.deepEqual(events, ["first", "review", "high", "low"]);
});

test("capacity is released after failures and omitted capacities do not insert a concurrency cap", async () => {
    const schedule = createAgentScheduler({ doers: 1 });
    const error = new Error("Actual command failure");
    const failed = schedule("doer", () => { throw error; });
    const next = schedule("doer", () => "continued");
    await assert.rejects(failed, (actual) => actual === error);
    assert.equal(await next, "continued");
    const unlimited = createAgentScheduler(), held = deferred();
    let started = 0;
    const work = Array.from({ length: 20 }, () => unlimited("doer", async () => {
        started++;
        if (started === 20) held.resolve();
        await held.promise;
    }));
    await Promise.all(work);
    assert.equal(started, 20);
});

test("invalid concurrency fails explicitly, including misspelled capacities", () => {
    for (const concurrency of [null, [], 2, { doers: 0 }, { reviewers: -1 }, { doers: 1.5 }, { doers: "2" },
        { doer: 2 }, { doers: Infinity }, { doers: Number.MAX_SAFE_INTEGER + 1 }]) {
        assert.throws(() => createAgentScheduler(concurrency), /concurrency.*positive integer/);
    }
});

test("abort rejects queued agents without launching them and running work can settle", async () => {
    const controller = new AbortController();
    const schedule = createAgentScheduler({ doers: 1 }, controller.signal), held = deferred(), started = deferred();
    let queuedRan = false;
    const active = schedule("doer", () => { started.resolve(); return held.promise; });
    await started.promise;
    const queued = schedule("doer", () => { queuedRan = true; });
    const rejected = assert.rejects(queued, /Stop requested/);
    controller.abort(new Error("Stop requested"));
    await rejected;
    held.resolve();
    await active;
    assert.equal(queuedRan, false);
    await assert.rejects(schedule("reviewer", () => assert.fail("Aborted agent launched")), /Stop requested/);
});

test("only dependency-ready tasks execute, and a blocked branch does not stop unrelated descendants", async () => {
    const tasks = [task("after-blocked", ["blocked"]), task("after-free", ["free"]), task("blocked"), task("free")];
    const started = [];
    const results = await scheduleTasks(tasks, async (assignment, dependencies) => {
        started.push(assignment.id);
        assert.ok(dependencies.every((result) => result.status === "agreed"));
        return { status: assignment.id === "blocked" ? "needs-input" : "agreed" };
    });
    assert.deepEqual(started, ["blocked", "free", "after-free"]);
    assert.equal(results[0].status, "not-run");
    assert.equal(results[1].status, "agreed");
});

test("exclusive resources serialize conflicting assignments, but not unrelated work", async () => {
    const held = deferred(), started = [];
    const tasks = [
        task("first", [], { exclusiveResources: ["test-db"] }),
        task("second", [], { exclusiveResources: ["test-db"] }),
        task("independent"),
    ];
    const results = await scheduleTasks(tasks, async (assignment) => {
        started.push(assignment.id);
        if (assignment.id === "first") await held.promise;
        if (assignment.id === "independent") {
            assert.deepEqual(started, ["first", "independent"]);
            held.resolve();
        }
        return { status: "agreed" };
    });
    assert.deepEqual(started, ["first", "independent", "second"]);
    assert.ok(results.every((result) => result.status === "agreed"));
});

test("assignment errors are named, independent work is joined, and descendants are not dispatched", async () => {
    let joined = false;
    await assert.rejects(scheduleTasks([
        task("failed"), task("dependent", ["failed"]), task("independent"),
    ], async (assignment) => {
        assert.notEqual(assignment.id, "dependent");
        if (assignment.id === "failed") throw new Error("Actual failure");
        await Promise.resolve();
        joined = true;
        return { status: "agreed" };
    }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Assigned work execution failed for failed/);
        assert.match(error.message, /failed: Actual failure/);
        assert.equal(error.errors[0].message, "Actual failure");
        return true;
    });
    assert.ok(joined);
});
