import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { EXECUTION_ACK, runCommand, validateInput } from "../runtime.mjs";
import { createDeliveryRunner } from "../workflow.mjs";

const feature = "export const feature = 'release-ready';\n";
const nativeCommand = (phase, generated = false) => ({
    executable: "node",
    args: [generated ? "scripts/delivery.mjs" : "tools/local.mjs", phase],
    cwd: ".",
    timeoutMs: 10000,
});
const adapter = () => ({
    changes: [{
        path: "scripts/delivery.mjs",
        content: "import { run } from '../tools/local.mjs';\nawait run(process.argv[2]);\n",
    }],
    command: nativeCommand("deploy", true),
    verify: nativeCommand("verify", true),
    smoke: [nativeCommand("smoke", true)],
    reconcile: nativeCommand("reconcile", true),
});

const localScript = String.raw`
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export async function run(phase) {
    const target = process.env.DELIVERY_TARGET || process.argv[3];
    assert.ok(target, "Every local command has a scoped test target");
    const read = async (name) => JSON.parse(await readFile(path.join(target, name), "utf8"));
    const control = await read("control.json");
    const events = (await readFile(path.join(target, "events.ndjson"), "utf8"))
        .trim().split("\n").filter(Boolean).map(JSON.parse);
    const attempt = events.filter((event) => event.phase === phase).length + 1;
    const identity = {
        runId: process.env.DELIVERY_RUN_ID,
        source: process.env.DELIVERY_SOURCE_FINGERPRINT,
        build: process.env.DELIVERY_BUILD_FINGERPRINT,
        target: process.env.DELIVERY_TARGET,
    };
    await appendFile(path.join(target, "events.ndjson"), JSON.stringify({ phase, attempt, ...identity }) + "\n");
    const source = () => import(pathToFileURL(path.resolve("src/feature.mjs")).href);
    if (phase === "baseline") {
        assert.equal(await readFile("src/legacy.mjs", "utf8"), "export const legacy = true;\n");
    } else if (phase === "test") {
        assert.equal((await source()).feature, "release-ready");
    } else if (phase === "build") {
        await mkdir("dist", { recursive: true });
        await writeFile("dist/bundle.json", JSON.stringify({ content: (await source()).feature }));
    } else {
        assert.equal(identity.target, target);
        assert.ok(identity.runId, "Deployment commands must receive the durable run identity");
        assert.match(identity.source, /^[a-f0-9]{64}$/);
        assert.match(identity.build, /^[a-f0-9]{64}$/);
        if (phase === "deploy") {
            if (attempt <= (control.deployAbsentFailures || 0)) process.exit(7);
            const bundle = JSON.parse(await readFile("dist/bundle.json", "utf8"));
            await writeFile(path.join(target, "revision.json"), JSON.stringify({ ...identity, ...bundle }));
            if (control.deployFailAfterWrite) process.exit(7);
        } else if (phase === "reconcile") {
            if (control.reconcileExit !== undefined) process.exit(control.reconcileExit);
            let revision;
            try { revision = await read("revision.json"); }
            catch (error) { if (error.code === "ENOENT") process.exit(10); throw error; }
            assert.deepEqual(revision, { ...identity, content: "release-ready" });
        } else if (phase === "verify" || phase === "smoke") {
            assert.deepEqual(await read("revision.json"), { ...identity, content: "release-ready" });
            if (control.mutateOnVerify && phase === "verify") {
                await writeFile(control.mutateOnVerify, "unexpected drift");
            }
            if (attempt <= (control[phase + "Failures"] || 0)) process.exit(8);
        } else {
            throw new Error("Unexpected local phase: " + phase);
        }
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await run(process.argv[2]);
}
`;

async function fixture(t, control = {}) {
    const sandbox = path.resolve("gh-dynamic-workflows", "test", `.nonprod-${randomUUID()}`);
    t.after(() => rm(sandbox, { recursive: true, force: true }));
    const root = path.join(sandbox, "project");
    const target = path.join(sandbox, "target");
    await Promise.all(["src", "tools"].map((name) => mkdir(path.join(root, name), { recursive: true })));
    await mkdir(target);
    await Promise.all([
        writeFile(path.join(root, "spec.md"), "Deliver a tested release to the existing isolated test target."),
        writeFile(path.join(root, "src", "legacy.mjs"), "export const legacy = true;\n"),
        writeFile(path.join(root, "tools", "local.mjs"), localScript),
        writeFile(path.join(target, "control.json"), JSON.stringify(control)),
        writeFile(path.join(target, "events.ndjson"), ""),
    ]);
    const local = (phase) => {
        const command = nativeCommand(phase);
        command.args.push(target);
        return command;
    };
    const args = {
        schemaVersion: 1,
        projectRoot: root,
        input: { kind: "product", path: "spec.md", goal: "Deliver the feature to the test target" },
        scope: ["src/feature.mjs", "scripts"],
        generatedPaths: ["dist"],
        acceptance: ["Feature works without changing the legacy module"],
        attempts: { planning: 1, implementation: 2, repair: 0 },
        execution: { authorized: true, acknowledgement: EXECUTION_ACK },
        commands: { baseline: [local("baseline")], test: [local("test")], build: [local("build")] },
        deployment: {
            environment: "test", target, authorized: true,
            adapterPaths: ["scripts"],
            acceptance: ["The target contains this run's exact built feature revision"],
            retry: { deployAttempts: 3, verifyAttempts: 3, smokeAttempts: 3, delayMs: 0 },
            command: nativeCommand("deploy"),
            verify: nativeCommand("verify"),
            smoke: [nativeCommand("smoke")],
            reconcile: nativeCommand("reconcile"),
        },
    };
    const events = async () => (await readFile(path.join(target, "events.ndjson"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const artifact = async (runId, name) => JSON.parse(await readFile(
        path.join(root, ".delivery-runs", runId, name), "utf8",
    ));
    return { root, target, args, events, artifact };
}

function harness(args, answer = () => undefined) {
    const journal = new Map();
    const cachedAgents = new Map();
    const calls = [];
    const ctx = {
        args, runId: randomUUID(), signal: new AbortController().signal,
        phase() {}, log() {},
        async step(key, producer, options) {
            if (options?.volatile) return producer();
            if (!journal.has(key)) journal.set(key, await producer());
            return journal.get(key);
        },
        async parallel(thunks) {
            return Promise.all(thunks.map(async (thunk) => {
                try { return await thunk(); } catch { return null; }
            }));
        },
        async pause() { assert.fail("Nonproduction delivery must not introduce a manual pause"); },
        async agent(prompt, options) {
            const key = JSON.stringify([prompt, options]);
            if (cachedAgents.has(key)) return cachedAgents.get(key);
            calls.push({ label: options.label, prompt });
            let value = await answer(options.label, prompt);
            if (value === undefined) {
                if (options.label.includes(":plan:")) {
                    value = {
                        architecture: "Preserve the legacy module and deliver a separate feature",
                        ux: { applicable: false, rationale: "The acceptance target is a native Node module" },
                        tasks: [{ id: "feature", title: "Implement feature", paths: ["src/feature.mjs"], dependsOn: [] }],
                        requirements: args.acceptance.map((criterion) => ({
                            criterion, approach: "Add a feature module", verification: "Run native Node assertions",
                        })),
                        risks: [], decisions: ["Do not alter the legacy module"],
                    };
                } else if (options.label.includes(":implement:")) {
                    value = { changes: [{ path: "src/feature.mjs", content: feature }] };
                } else if (options.label.includes(":adapter:")) {
                    value = adapter();
                } else if (options.label.includes("-critic:")) {
                    value = {
                        verdict: "pass", findings: [],
                        ...(options.label.includes(":delivery-critic:") ? {
                            coverage: args.acceptance.map((criterion) => ({
                                criterion, status: "verified", paths: ["src/feature.mjs", "tools/local.mjs"],
                            })),
                        } : {}),
                    };
                } else {
                    assert.fail(`Unexpected agent request: ${options.label}`);
                }
            }
            cachedAgents.set(key, value);
            return value;
        },
    };
    return { ctx, calls };
}

function requestGeneratedAdapter(args) {
    for (const name of ["command", "verify", "smoke", "reconcile"]) delete args.deployment[name];
}

test("deployment must be intentional: no missing policy fallback and no unauthorized target", async (t) => {
    const { args } = await fixture(t);
    delete args.deployment;
    assert.throws(() => validateInput(args), /deployment|build-only/i);
    args.deployment = { environment: "test", target: "isolated-target", authorized: false };
    assert.throws(() => validateInput(args), /authoriz/i);
});

test("invalid retry policies cannot admit unbounded deployment or check commands", async (t) => {
    const { args } = await fixture(t);
    for (const field of ["deployAttempts", "verifyAttempts", "smokeAttempts", "delayMs"]) {
        for (const value of field === "delayMs" ? [-1, 0.5, 60001] : [0, 1.5, 11]) {
            const invalid = structuredClone(args);
            invalid.deployment.retry[field] = value;
            assert.throws(() => validateInput(invalid), /retry|attempt|delay/i);
        }
    }
});

test("explicit build-only executes real regression and build commands without deployment or adapters", async (t) => {
    const f = await fixture(t);
    f.args.deployment = { mode: "build-only" };
    const { ctx, calls } = harness(f.args);
    const report = await createDeliveryRunner()(ctx);
    assert.equal(report.status, "built");
    assert.equal(report.deployed, false);
    assert.deepEqual((await f.events()).map((event) => event.phase), ["baseline", "test", "build"]);
    assert.equal(calls.some(({ label }) => label.includes(":adapter")), false);
    await assert.rejects(readFile(path.join(f.target, "revision.json")), { code: "ENOENT" });
});

test("configured nonproduction defaults to autonomous real deployment, exact revision verification and smoke", async (t) => {
    const f = await fixture(t);
    const { ctx } = harness(f.args);
    const report = await createDeliveryRunner()(ctx);
    assert.equal(report.status, "deployed");
    assert.equal(report.deployed, true);
    const events = await f.events();
    assert.deepEqual(events.map((event) => event.phase), ["baseline", "test", "build", "deploy", "verify", "smoke"]);
    const revision = JSON.parse(await readFile(path.join(f.target, "revision.json"), "utf8"));
    assert.deepEqual(revision, {
        runId: ctx.runId,
        source: report.validation.sourceFingerprint,
        build: report.validation.buildFingerprint,
        target: f.target,
        content: "release-ready",
    });
    for (const event of events.filter(({ phase }) => ["deploy", "verify", "smoke"].includes(phase))) {
        assert.equal(event.source, revision.source);
        assert.equal(event.build, revision.build);
        assert.equal(event.runId, ctx.runId);
        assert.equal(event.target, f.target);
    }
    assert.equal((await f.artifact(ctx.runId, "closeout.json")).status, "deployed");
});

test("DevOps proposals and independent adapter review precede real build, retry checks and acceptance", async (t) => {
    const f = await fixture(t, { verifyFailures: 1, smokeFailures: 1 });
    requestGeneratedAdapter(f.args);
    const { ctx, calls } = harness(f.args);
    const run = createDeliveryRunner();
    const report = await run(ctx);
    assert.equal(report.status, "deployed");
    const labels = calls.map(({ label }) => label);
    assert.ok(labels.findIndex((label) => label.includes(":adapter:")) <
        labels.findIndex((label) => label.includes(":adapter-critic:")));
    assert.ok(labels.findIndex((label) => label.includes(":adapter-critic:")) <
        labels.findIndex((label) => label.includes(":delivery-critic:")));
    assert.match(calls.find(({ label }) => label.includes(":adapter:")).prompt, /exact built feature revision/);
    assert.deepEqual((await f.events()).map(({ phase }) => phase),
        ["baseline", "test", "build", "deploy", "verify", "verify", "smoke", "smoke"]);
    assert.match(await readFile(path.join(f.root, "scripts", "delivery.mjs"), "utf8"), /await run/);
    const attempts = await f.artifact(ctx.runId, "deployment-attempts.json");
    assert.ok(Array.isArray(attempts));
    assert.ok(attempts.some((attempt) => JSON.stringify(attempt).includes('"exitCode":8')),
        "Persisted evidence must retain the transient failing check, not only the final pass");
    assert.ok(attempts.some((attempt) => JSON.stringify(attempt).includes('"exitCode":0')));
    const adapterCalls = calls.filter(({ label }) => label.includes(":adapter")).length;
    assert.equal((await run(ctx)).status, "deployed", "Resume can use the remaining live-check allowance");
    assert.equal(calls.filter(({ label }) => label.includes(":adapter")).length, adapterCalls);
    const resumedEvents = await f.events();
    assert.equal(resumedEvents.filter(({ phase }) => phase === "deploy").length, 1);
    assert.equal(resumedEvents.filter(({ phase }) => phase === "verify").length, f.args.deployment.retry.verifyAttempts);
    assert.equal(resumedEvents.filter(({ phase }) => phase === "smoke").length, f.args.deployment.retry.smokeAttempts);
});

test("missing, rejected and out-of-scope DevOps adapters cannot deploy or write rejected scripts", async (t) => {
    for (const failure of ["null", "rejected", "out-of-scope", "unapproved-executable"]) {
        await t.test(failure, async (t) => {
            const f = await fixture(t);
            requestGeneratedAdapter(f.args);
            const { ctx } = harness(f.args, (label) => {
                if (label.includes(":adapter:")) {
                    if (failure === "null") return null;
                    const proposal = adapter();
                    if (failure === "out-of-scope") proposal.changes[0].path = "outside.mjs";
                    if (failure === "unapproved-executable") proposal.command.executable = process.execPath;
                    return proposal;
                }
                if (failure === "rejected" && label.includes(":adapter-critic:")) {
                    return { verdict: "block", findings: ["Adapter cannot prove target revision"] };
                }
            });
            let report;
            try { report = await createDeliveryRunner()(ctx); }
            catch (error) { assert.match(error.message, /agent failed|adapter|scope|allow|executable/i); }
            if (report) assert.ok(["blocked", "failed"].includes(report.status));
            assert.equal((await f.events()).some(({ phase }) => phase === "deploy"), false);
            await assert.rejects(readFile(path.join(f.root, "scripts", "delivery.mjs")), { code: "ENOENT" });
            await assert.rejects(readFile(path.join(f.root, "outside.mjs")), { code: "ENOENT" });
        });
    }
});

test("an interrupted deploy reconciled as the desired revision is accepted without redeployment", async (t) => {
    const f = await fixture(t, { deployFailAfterWrite: true });
    const { ctx } = harness(f.args);
    const report = await createDeliveryRunner()(ctx);
    assert.equal(report.status, "deployed");
    const phases = (await f.events()).map(({ phase }) => phase);
    assert.equal(phases.filter((phase) => phase === "deploy").length, 1);
    assert.ok(phases.includes("reconcile"));
    assert.equal(phases.at(-1), "smoke");
});

test("only positive absence permits a bounded redeploy; unknown reconciliation blocks", async (t) => {
    await t.test("absent then deployed", async (t) => {
        const f = await fixture(t, { deployAbsentFailures: 1 });
        const { ctx } = harness(f.args);
        assert.equal((await createDeliveryRunner()(ctx)).status, "deployed");
        const phases = (await f.events()).map(({ phase }) => phase);
        assert.equal(phases.filter((phase) => phase === "deploy").length, 2);
        assert.ok(phases.indexOf("reconcile") > phases.indexOf("deploy"));
        assert.ok(phases.indexOf("reconcile") < phases.lastIndexOf("deploy"));
    });
    await t.test("unknown state", async (t) => {
        const f = await fixture(t, { deployAbsentFailures: 3, reconcileExit: 4 });
        const { ctx } = harness(f.args);
        const report = await createDeliveryRunner()(ctx);
        assert.equal(report.status, "blocked");
        const phases = (await f.events()).map(({ phase }) => phase);
        assert.equal(phases.filter((phase) => phase === "deploy").length, 1);
        assert.ok(phases.includes("reconcile"));
        assert.equal(phases.includes("smoke"), false);
    });
});

test("deployment and failed check allowances remain consumed across resume", async (t) => {
    for (const phase of ["deploy", "verify", "smoke"]) {
        await t.test(phase, async (t) => {
            const f = await fixture(t, phase === "deploy" ? { deployAbsentFailures: 20 } : { [`${phase}Failures`]: 20 });
            f.args.deployment.retry = { deployAttempts: 2, verifyAttempts: 2, smokeAttempts: 2, delayMs: 0 };
            const { ctx } = harness(f.args);
            const run = createDeliveryRunner();
            const first = await run(ctx);
            assert.ok(["blocked", "failed"].includes(first.status));
            const count = () => f.events().then((events) => events.filter((event) => event.phase === phase).length);
            assert.equal(await count(), 2);
            const second = await run(ctx);
            assert.ok(["blocked", "failed"].includes(second.status));
            assert.equal(await count(), 2, "Resume must not reset the durable attempt allowance");
            if (phase !== "deploy") {
                assert.equal((await f.events()).filter((event) => event.phase === "deploy").length, 1);
            }
        });
    }
});

test("source or build drift during live verification cannot be reported as accepted", async (t) => {
    for (const relative of ["src/feature.mjs", "dist/bundle.json"]) {
        await t.test(relative, async (t) => {
            const f = await fixture(t, { mutateOnVerify: relative });
            const { ctx } = harness(f.args);
            const run = createDeliveryRunner();
            const report = await run(ctx);
            assert.equal(report.status, "blocked");
            assert.match(report.reason, /drift|changed/i);
            assert.equal((await f.events()).some(({ phase }) => phase === "smoke"), false);
            const deploys = (await f.events()).filter(({ phase }) => phase === "deploy").length;
            const resumed = await run(ctx);
            assert.ok(["blocked", "failed"].includes(resumed.status));
            assert.equal((await f.events()).filter(({ phase }) => phase === "deploy").length, deploys);
        });
    }
});

test("cancellation after a real deployment prevents later live commands and acceptance", async (t) => {
    const f = await fixture(t);
    const { ctx } = harness(f.args);
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const run = createDeliveryRunner({
        async runCommand(root, command, signal, options) {
            const outcome = await runCommand(root, command, signal, options);
            if (command.args[1] === "deploy") controller.abort();
            return outcome;
        },
    });
    let report;
    try { report = await run(ctx); }
    catch (error) { assert.match(error.message, /cancel|abort/i); }
    if (report) assert.ok(["blocked", "failed"].includes(report.status));
    assert.deepEqual((await f.events()).map(({ phase }) => phase), ["baseline", "test", "build", "deploy"]);
});
