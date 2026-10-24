import test from "node:test";
import assert from "node:assert/strict";
import { fixtureBase } from "./evidence.fixture.mjs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { parseOptions, parseEnvelope, describeOutcome, formatOutcome, runWorkflow } from "../run.mjs";

const envelope = (status = "completed") => ({ status, runId: "synthetic-run" });
const stoppedResult = {
    status: "limit-reached", completedSprints: [], stoppedAt: "SprintArchitectureLoop", stoppedKey: "s1/architecture",
    outcomes: [{
        loopId: "SprintArchitectureLoop", key: "s1/architecture", status: "limit-reached", rounds: 3,
        summary: "The explicitly supplied limit was reached.",
        feedback: {
            owner: { summary: "Private routing still has an unresolved design issue." },
            reviews: [{ role: "Critic", agree: false, feedback: "Resolve the private route before implementation." }],
        },
    }],
};

test("options preserve repeated scoped add-dir grants and reject unknown or missing options", () => {
    assert.deepEqual(parseOptions(["--workflow", "lab-delivery", "--input", "input.json", "--add-dir", "..\\web", "--add-dir", "..\\api", "--check-only"]), {
        workflow: "lab-delivery", input: "input.json", addDirs: ["..\\web", "..\\api"], checkOnly: true,
    });
    assert.throws(() => parseOptions(["--input"]), /Missing value/);
    assert.throws(() => parseOptions(["--allow-all"]), /Unknown option/);
});

test("SDK completion does not mask application stops; final loop and decisive feedback stay visible", () => {
    const outcome = describeOutcome(envelope(), stoppedResult);
    assert.equal(outcome.status, "limit-reached");
    assert.equal(outcome.sdkStatus, "completed");
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.stoppedAt, "SprintArchitectureLoop");
    assert.equal(outcome.rounds, 3);
    assert.match(outcome.reason, /Private routing/);
    const text = formatOutcome(outcome, { outcome: "outcome.json", result: "result.json", stdout: "stdout.log", stderr: "stderr.log" });
    assert.match(text, /SDK: completed/);
    assert.match(text, /Stopped at: SprintArchitectureLoop, round 3/);
    assert.match(text, /Disagreement - Critic: Resolve the private route/);
    assert.ok(text.split("\n").length <= 12);
    assert.equal(describeOutcome(envelope(), { status: "completed" }).exitCode, 0);
    assert.equal(describeOutcome(envelope(), { status: "needs-input" }).exitCode, 2);
    assert.equal(describeOutcome(envelope(), { status: "needs-replan" }).exitCode, 2);
    assert.equal(describeOutcome(envelope(), { status: "blocked" }).exitCode, 2);
    assert.throws(() => describeOutcome(envelope(), {}), /no recognized application outcome/);
});

test("structured check review reporting ignores unsupported legacy votes and accepted observations", () => {
    const result = { status: "blocked", stoppedAt: "AssignedWorkDeveloperLoop", outcomes: [{
        loopId: "AssignedWorkDeveloperLoop", status: "blocked", feedback: { reviews: [
            { role: "Critic", accepted: true, checksValid: false, agree: false, feedback: "Uncited observation" },
            { role: "Architect", accepted: false, checksValid: false, feedback: "Command omits the assigned API probe" },
        ] },
    }] };
    const outcome = describeOutcome(envelope(), result);
    assert.deepEqual(outcome.reviewers.map((item) => item.role), ["Architect"]);
    assert.match(formatOutcome(outcome, { outcome: "outcome", stdout: "stdout", stderr: "stderr", result: "result" }),
        /Check review - Architect: Command omits/);
});

test("runtime error, pause, cancellation and unknown envelopes are never reported as success", () => {
    assert.deepEqual(parseEnvelope('{"type":"workflow.result","data":{"run":{"status":"completed","runId":"real-shape"}}}\n'), {
        status: "completed", runId: "real-shape",
    });

    assert.equal(describeOutcome({ ...envelope("error"), failure: { message: "SDK budget exhausted" } }).reason, "SDK budget exhausted");
    assert.equal(describeOutcome(envelope("paused")).exitCode, 3);
    assert.equal(describeOutcome(envelope("cancelled")).exitCode, 130);
    assert.equal(describeOutcome(envelope("halted")).exitCode, 1);
    assert.throws(() => describeOutcome({ status: "unknown" }), /recognized workflow run envelope/);
});

test("stagnation stop evidence survives concise reporting without treating SDK completion as work completion", () => {
    const progress = { noProgressRounds: 10, limit: 10, credited: [{ id: "check-1", evidence: "Resolved check", round: 1 }] };
    const outcome = describeOutcome(envelope(), {
        status: "blocked", stoppedKey: "task/stalled", outcomes: [{
            status: "blocked", loopId: "AssignedWorkDeveloperLoop", key: "task/stalled", rounds: 17,
            stopCause: "no-progress", progress,
            summary: "Stopped after 10 consecutive rounds without reviewer-verified new progress.",
            feedback: { reviews: [{ role: "Critic", agree: false, feedback: "Still blocked on the same failing test" }] },
        }],
    });
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.rounds, 17);
    assert.equal(outcome.stopCause, "no-progress");
    assert.deepEqual(outcome.progress, progress);
    const text = formatOutcome(outcome, {});
    assert.match(text, /10 consecutive rounds/);
    assert.match(text, /Still blocked on the same failing test/);
});

test("waiting reports retained construction and partial sprints without disguising incomplete delivery", () => {
    const delivery = { state: "waiting", waitReason: "work-exhausted", acceptedWork: [{ taskId: "api" }, { taskId: "ui" }],
        partialSprints: [{ id: "s1" }], pendingSprints: [{ id: "s2" }], blockedWork: [{ key: "classifier" }],
        continuationAudits: [{ key: "audit" }] };
    const outcome = describeOutcome(envelope(), { status: "needs-input", delivery });
    assert.equal(outcome.exitCode, 2);
    assert.deepEqual(outcome.delivery, delivery);
    assert.match(formatOutcome(outcome, {}), /2 accepted assignments; 1 partial sprints; 1 pending sprints; 1 unresolved blockers/);
    assert.match(formatOutcome(outcome, {}), /Waiting: work-exhausted/);
});

async function fixture(t) {
    const cwd = await mkdtemp(path.join(fixtureBase, ".workflow-report-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(path.join(cwd, "input with spaces.json"), JSON.stringify({ projectRoot: "." }));
    return { cwd, options: parseOptions(["--input", "input with spaces.json", "--add-dir", "..\\context with spaces"]) };
}
function fakeSpawn({ result = stoppedResult, sdk = envelope(), code = 0, signal = null, missing = false, stdout, fail } = {}) {
    return (command, args, options) => {
        assert.equal(command, "copilot");
        assert.ok(args.includes("--silent") && args.includes("--result-file"));
        assert.ok(!args.includes("--allow-all-tools"));
        assert.ok(!args.some((arg) => ["--allow-all-paths", "--allow-all-urls", "--allow-all"].includes(arg)));
        assert.equal(args[args.indexOf("--args") + 1], `@${path.join(options.cwd, "input with spaces.json")}`);
        assert.equal(options.env.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS, "true");
        const child = new EventEmitter();
        queueMicrotask(() => {
            if (fail) { child.emit("error", new Error(fail)); return; }
            if (!missing) writeFileSync(args[args.indexOf("--result-file") + 1], JSON.stringify(result));
            writeFileSync(options.stdio[1], stdout ?? `${JSON.stringify({ type: "workflow.result", data: { run: sdk } })}\n`);
            writeFileSync(options.stdio[2], "Full diagnostic output retained here.\n");
            child.emit("close", code, signal);
        });
        return child;
    };
}

test("launch saves full result/envelope/logs and concise durable outcome in unique ignored locations", async (t) => {
    const { cwd, options } = await fixture(t);
    let text = "";
    const execute = () => runWorkflow(options, { cwd, spawn: fakeSpawn(), write: (value) => { text += value; } });
    const first = await execute(), second = await execute();
    assert.equal(first.exitCode, 2);
    assert.notEqual(first.files.result, second.files.result);
    assert.match(text, /Stopped at: SprintArchitectureLoop/);
    assert.deepEqual(JSON.parse(await readFile(first.files.result, "utf8")), stoppedResult);
    assert.equal(JSON.parse(await readFile(first.files.outcome, "utf8")).status, "limit-reached");
    assert.equal(parseEnvelope(await readFile(first.files.stdout, "utf8")).status, "completed");
    assert.equal((await readdir(path.join(cwd, "gh-dynamic-workflows", ".delivery-runs"))).length, 2);
});

test("check-only reads config without spawning a CLI or creating run evidence", async (t) => {
    const { cwd, options } = await fixture(t);
    const checked = await runWorkflow({ ...options, checkOnly: true }, { cwd, spawn: () => assert.fail("No CLI in check-only"), write() {} });
    assert.equal(checked.status, "checked");
    await assert.rejects(readdir(path.join(cwd, "gh-dynamic-workflows")), { code: "ENOENT" });
});

test("missing/invalid results, malformed stdout, missing CLI and nonzero exit cannot reuse an earlier success", async (t) => {
    const { cwd, options } = await fixture(t);
    for (const settings of [
        { missing: true }, { result: {} }, { stdout: "not JSON\n" }, { fail: "spawn copilot ENOENT" },
        { result: { status: "completed" }, code: 7 },
    ]) {
        const result = await runWorkflow(options, { cwd, spawn: fakeSpawn(settings), write() {} });
        assert.equal(result.exitCode, 1);
        assert.notEqual(result.status, "completed");
        assert.match(await readFile(result.files.outcome, "utf8"), /"exitCode": 1/);
    }
});

test("an SDK failure needs no application result file and retains typed failure detail", async (t) => {
    const { cwd, options } = await fixture(t);
    const result = await runWorkflow(options, {
        cwd, spawn: fakeSpawn({ sdk: { ...envelope("error"), failure: { message: "Actual workflow failure" } }, missing: true }),
        write() {},
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.reason, /Actual workflow failure/);
});

test("an interrupted CLI without final JSON is cancellation, not a completed workflow or generic exit 1", async (t) => {
    const { cwd, options } = await fixture(t);
    const result = await runWorkflow(options, {
        cwd, spawn: fakeSpawn({ missing: true, stdout: "", code: null, signal: "SIGINT" }), write() {},
    });
    assert.equal(result.status, "interrupted");
    assert.equal(result.exitCode, 130);
    assert.match(result.reason, /SIGINT/);
});
