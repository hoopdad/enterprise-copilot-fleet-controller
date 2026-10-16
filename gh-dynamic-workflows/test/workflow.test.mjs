import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, readdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    validateInput, validatePlan, applyChanges, safePath, runCommand,
    EXECUTION_ACK, DEPLOY_ACK, DIAGNOSTIC_ACK, redactDiagnostics,
} from "../runtime.mjs";
import { createDeliveryRunner, metadata } from "../workflow.mjs";

const spec = (name = "test") => ({ executable: process.execPath, args: ["-e", "process.exit(0)", name], cwd: ".", timeoutMs: 10000 });
const task = (id = "feature", paths = ["src/feature.mjs"], dependsOn = []) => ({ id, title: id, paths, dependsOn });
const good = { ok: true, exitCode: 0, reason: "exit" };
const bad = { ok: false, exitCode: 1, reason: "exit" };
function input(root) {
    return {
        schemaVersion: 1, projectRoot: root,
        input: { kind: "product", path: "spec.md", goal: "Implement a feature" },
        scope: ["src", "test"], acceptance: ["Feature works; existing behavior preserved"],
        attempts: { planning: 2, implementation: 2, repair: 1 },
        execution: { authorized: true, acknowledgement: EXECUTION_ACK },
        commands: { baseline: [spec("baseline")], test: [spec("test")], build: [spec("build")] },
        deployment: { mode: "build-only" },
    };
}
function deploy(args, mode = "nonproduction") {
    args.deployment = {
        mode, environment: "test", target: "existing-local-test", authorized: true,
        acknowledgement: DEPLOY_ACK, idempotent: true,
        command: spec("deploy"), verify: spec("verify"), smoke: [spec("smoke")],
    };
}
async function workspace(t) {
    const root = path.resolve("gh-dynamic-workflows", "test", `.work-${randomUUID()}`);
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "test"), { recursive: true });
    await writeFile(path.join(root, "spec.md"), "Implement feature");
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}
function harness(args, answer = () => undefined) {
    const journal = new Map();
    const agents = new Map();
    const calls = [];
    const pauses = new Set();
    const ctx = {
        args, runId: randomUUID(), signal: new AbortController().signal,
        phase() {}, log() {},
        async step(key, producer, options) {
            if (options?.volatile) return producer();
            if (!journal.has(key)) journal.set(key, await producer());
            return journal.get(key);
        },
        async parallel(thunks) { return Promise.all(thunks.map(async (thunk) => { try { return await thunk(); } catch { return null; } })); },
        async pause(key) { if (!pauses.has(key)) { pauses.add(key); throw new Error("paused"); } },
        async agent(prompt, options) {
            const cacheKey = JSON.stringify([prompt, options]);
            if (agents.has(cacheKey)) return agents.get(cacheKey);
            calls.push(options.label);
            let value = await answer(options.label, prompt);
            if (value === undefined) {
                if (options.label.includes(":plan:")) value = {
                    tasks: [task()], architecture: "Small backward-compatible feature module",
                    ux: { applicable: false, rationale: "No user interface in this feature" },
                    requirements: args.acceptance.map((criterion) => ({ criterion, approach: "Implement feature", verification: "Run regression tests" })),
                    risks: [], decisions: ["Preserve interfaces"],
                };
                else if (options.label.includes(":implement:") || options.label.includes(":repair:")) {
                    value = { changes: [{ path: "src/feature.mjs", content: "export const feature = true;\n" }] };
                } else value = {
                    verdict: "pass", findings: [],
                    ...(options.label.includes(":delivery-critic:") ? {
                        coverage: args.acceptance.map((criterion) => ({ criterion, status: "verified", paths: ["src/feature.mjs"] })),
                    } : {}),
                };
            }
            agents.set(cacheKey, value);
            return value;
        },
    };
    return { ctx, calls };
}

test("input validates authority, explicit attempts, deployment and commands beyond structural SDK schema", () => {
    const args = input(".");
    assert.equal(validateInput(args).deployment.mode, "build-only");
    for (const mutate of [
        (a) => { a.execution.authorized = false; },
        (a) => { a.execution.shareDiagnostics = true; },
        (a) => { a.attempts.planning = -1; },
        (a) => { a.attempts.repair = 0.5; },
        (a) => { a.scope = ["../outside"]; },
        (a) => { a.scope = [".env"]; },
        (a) => { a.scope = [".github/agents"]; },
        (a) => { a.scope = ["SRC."]; },
        (a) => { a.generatedPaths = ["src"]; },
        (a) => { a.commands.test = []; },
        (a) => { a.commands.test[0].timeoutMs = 0; },
        (a) => { a.commands.build[0].executable = "build.cmd"; },
        (a) => { a.input.path = "."; },
    ]) {
        const invalid = structuredClone(args); mutate(invalid);
        assert.throws(() => validateInput(invalid));
    }
    deploy(args);
    assert.equal(validateInput(args).deployment.environment, "test");
    args.deployment.environment = "production";
    assert.throws(() => validateInput(args), /nonproduction/);
    assert.equal(Object.hasOwn(metadata, "limits"), false);
});

test("dependency layers enforce complete DAG and disjoint write ownership", () => {
    const plan = { tasks: [task("one", ["src/a"]), task("two", ["src/b"]), task("three", ["test/c"], ["one", "two"])] };
    assert.deepEqual(validatePlan(plan, ["src", "test"]).map((layer) => layer.map((item) => item.id)), [["one", "two"], ["three"]]);
    for (const tasks of [
        [task("one", ["src/a"], ["missing"])],
        [task("one", ["src/a"], ["two"]), task("two", ["src/b"], ["one"])],
        [task("one", ["src/a"]), task("two", ["src/a/b"])],
        [task("one", ["src/a"]), task("two", ["SRC/A"])],
        [task("one", ["outside/a"])],
        [task("one"), task("one")],
    ]) assert.throws(() => validatePlan({ tasks }, ["src", "test"]));
});

test("proposal validation happens before any write and rejects traversal, duplicates and symlinks", async (t) => {
    const root = await workspace(t);
    await assert.rejects(applyChanges(root, { changes: [
        { path: "src/valid.mjs", content: "valid" }, { path: "../escape", content: "bad" },
    ] }, ["src"]));
    await assert.rejects(readFile(path.join(root, "src", "valid.mjs")), { code: "ENOENT" });
    await assert.rejects(applyChanges(root, { changes: [
        { path: "src/a", content: "one" }, { path: "src/a", content: "two" },
    ] }, ["src"]));
    try { await symlink(path.join(root, "test"), path.join(root, "src", "linked"), "junction"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
    await assert.rejects(safePath(root, "src/linked/file", { missing: true }), /Symlink/i);
});

test("real command runner checks real exit status and fails missing executable without leaking output", async (t) => {
    const root = await workspace(t);
    assert.equal((await runCommand(root, spec(), new AbortController().signal)).ok, true);
    assert.equal((await runCommand(root, { ...spec(), args: ["-e", "process.exit(7)"] })).exitCode, 7);
    const missing = await runCommand(root, { ...spec(), executable: "nonexistent-delivery-executable-123" });
    assert.equal(missing.ok, false);
    assert.equal(missing.errorCode, "ENOENT");
    assert.equal(missing.command.executable, "nonexistent-delivery-executable-123");
    const timeout = await runCommand(root, { ...spec(), args: ["-e", "setInterval(() => {}, 10000)"], timeoutMs: 100 });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.reason, "timeout");
    assert.equal(timeout.timedOut, true);
    const signal = AbortSignal.abort();
    assert.equal((await runCommand(root, spec(), signal)).ok, false);
});

test("diagnostic evidence is opt-in, bounded, useful and redacts common credential forms", async (t) => {
    const root = await workspace(t);
    const script = "console.error('AssertionError: expected 4, got 5; token=ghp_exampleCredential123'); process.exit(1)";
    const quiet = await runCommand(root, { ...spec(), args: ["-e", script] });
    assert.equal(Object.hasOwn(quiet, "diagnostics"), false);
    const captured = await runCommand(root, { ...spec(), args: ["-e", script] }, undefined, { shareDiagnostics: true });
    assert.match(captured.diagnostics.stderr, /expected 4, got 5/);
    assert.doesNotMatch(captured.diagnostics.stderr, /exampleCredential/);
    const redacted = redactDiagnostics(
        "known-value https://user:pass@example.com auth Bearer abcxyz password=hello " +
        "eyJhbGc.eyJzdWI.signature -----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----",
        { ACCESS_TOKEN: "known-value" },
    );
    for (const secret of ["known-value", "user:pass", "abcxyz", "hello", "eyJhbGc", "\nprivate\n"]) assert.equal(redacted.includes(secret), false);
    const bounded = await runCommand(root, { ...spec(), args: ["-e", "console.error('x'.repeat(20000)); process.exit(1)"] }, undefined, { shareDiagnostics: true });
    assert.equal(bounded.diagnostics.truncated, true);
    assert.ok(bounded.diagnostics.stderr.length <= 8192);
});

test("build-only delivery writes proposed files, real closeout and never deploys", async (t) => {
    const root = await workspace(t);
    const { ctx } = harness(input(root));
    const commands = [];
    const run = createDeliveryRunner({ runCommand: async (_root, command) => { commands.push(command.args.at(-1)); return good; } });
    const report = await run(ctx);
    assert.equal(report.status, "built");
    assert.equal(report.deployed, false);
    assert.deepEqual(commands, ["baseline", "test", "build"]);
    assert.match(await readFile(path.join(root, "src", "feature.mjs"), "utf8"), /feature = true/);
    assert.equal(JSON.parse(await readFile(path.join(root, ".delivery-runs", ctx.runId, "closeout.json"), "utf8")).status, "built");
});

test("baseline failure blocks all agents and implementation", async (t) => {
    const root = await workspace(t);
    const { ctx, calls } = harness(input(root));
    const report = await createDeliveryRunner({ runCommand: async () => bad })(ctx);
    assert.equal(report.status, "blocked");
    assert.equal(report.phase, "baseline");
    assert.equal(calls.length, 0);
});

test("null planning agent and null parallel implementation cannot produce success", async (t) => {
    const root = await workspace(t);
    const failedPlanner = harness(input(root), (label) => label.includes(":plan:") ? null : undefined);
    await assert.rejects(createDeliveryRunner({ runCommand: async () => good })(failedPlanner.ctx), /Agent failed/);
    const failedImplementation = harness(input(root), (label) => label.includes(":implement:") ? null : undefined);
    const report = await createDeliveryRunner({ runCommand: async () => good })(failedImplementation.ctx);
    assert.equal(report.status, "blocked");
    assert.equal(report.phase, "implementation");
});

test("critic revision is bounded and feedback reaches the next implementation author", async (t) => {
    const root = await workspace(t);
    let feedbackSeen = false;
    const { ctx } = harness(input(root), (label, prompt) => {
        if (label.includes(":implementation-critic:feature:1")) return { verdict: "revise", findings: ["add regression"] };
        if (label.includes(":implement:feature:2")) feedbackSeen = prompt.includes("add regression");
        if (label.includes(":implement:") || label.includes(":implementation-critic:")) {
            assert.match(prompt, /Small backward-compatible feature module/);
            assert.match(prompt, /No user interface in this feature/);
        }
    });

    assert.equal((await createDeliveryRunner({ runCommand: async () => good })(ctx)).status, "built");
    assert.equal(feedbackSeen, true);
});

test("operator-authorized sanitized failure diagnostics reach the bounded repair author", async (t) => {
    const root = await workspace(t);
    const args = input(root);
    args.execution.shareDiagnostics = true;
    args.execution.diagnosticsAcknowledgement = DIAGNOSTIC_ACK;
    let repairedFromEvidence = false;
    const { ctx } = harness(args, (label, prompt) => {
        if (label.includes(":repair:")) repairedFromEvidence = prompt.includes("expected feature true") && prompt.includes("Small backward-compatible feature module");
    });
    let tests = 0;
    const run = createDeliveryRunner({ runCommand: async (_root, command, _signal, options) => {
        assert.equal(options.shareDiagnostics, true);
        if (command.args.at(-1) === "test" && ++tests === 1) return {
            ...bad, diagnostics: { stderr: "AssertionError: expected feature true", stdout: "", truncated: false },
        };
        return good;
    } });
    assert.equal((await run(ctx)).status, "built");
    assert.equal(repairedFromEvidence, true);
});

test("test failure triggers bounded repair, then re-runs test and build", async (t) => {
    const root = await workspace(t);
    const { ctx } = harness(input(root), (label) => label.includes(":repair:") ?
        { changes: [{ path: "src/feature.mjs", content: "export const feature = 'fixed';\n" }] } : undefined);
    let tests = 0;
    const run = createDeliveryRunner({ runCommand: async (_root, command) => command.args.at(-1) === "test" && ++tests === 1 ? bad : good });
    assert.equal((await run(ctx)).status, "built");
    assert.equal(tests, 2);
    assert.match(await readFile(path.join(root, "src", "feature.mjs"), "utf8"), /fixed/);
    assert.equal((await run(ctx)).status, "built", "resume after repair skips stale task-apply fingerprints and revalidates");
});

test("zero repair budget fails rather than fabricating successful tests", async (t) => {
    const root = await workspace(t);
    const args = input(root); args.attempts.repair = 0;
    const { ctx, calls } = harness(args);
    const report = await createDeliveryRunner({ runCommand: async (_root, command) => command.args.at(-1) === "test" ? bad : good })(ctx);
    assert.equal(report.status, "failed");
    assert.equal(calls.some((label) => label.includes(":repair:")), false);
});

test("repair allowance remains consumed across resumes", async (t) => {
    const root = await workspace(t);
    const { ctx, calls } = harness(input(root), (label) => label.includes(":repair:") ?
        { changes: [{ path: "src/feature.mjs", content: "export const feature = 'repaired';\n" }] } : undefined);
    let failing = true;
    const run = createDeliveryRunner({ runCommand: async (_root, command) => command.args.at(-1) === "test" && failing ? bad : good });
    assert.equal((await run(ctx)).status, "failed");
    const repairCount = calls.filter((label) => label.includes(":repair:")).length;
    assert.equal(repairCount, 1);
    assert.equal((await run(ctx)).status, "failed");
    assert.equal(calls.filter((label) => label.includes(":repair:")).length, repairCount);
    failing = false;
    assert.equal((await run(ctx)).status, "built");
});

test("declared generated output is allowed but source mutation by a build is not", async (t) => {
    const root = await workspace(t);
    const args = input(root); args.generatedPaths = ["dist"];
    const { ctx } = harness(args);
    const run = createDeliveryRunner({ runCommand: async (_root, command) => {
        if (command.args.at(-1) === "build") {
            await mkdir(path.join(root, "dist"), { recursive: true });
            await writeFile(path.join(root, "dist", "bundle.js"), "built output");
        }
        return good;
    } });
    assert.equal((await run(ctx)).status, "built");
    const root2 = await workspace(t);
    const second = harness(input(root2));
    const unsafe = createDeliveryRunner({ runCommand: async (_root, command) => {
        if (command.args.at(-1) === "build") await writeFile(path.join(root2, "src", "feature.mjs"), "modified source");
        return good;
    } });
    assert.equal((await unsafe(second.ctx)).status, "blocked");
});

test("final critic cannot pass incomplete acceptance evidence", async (t) => {
    const root = await workspace(t);
    const { ctx } = harness(input(root), (label) => label.includes(":delivery-critic:") ?
        { verdict: "pass", findings: [], coverage: [] } : undefined);
    await assert.rejects(createDeliveryRunner({ runCommand: async () => good })(ctx), /cover every acceptance/);
});

test("pause/resume re-tests and rechecks live deployment without redeploying completed receipts", async (t) => {
    const root = await workspace(t);
    const args = input(root); deploy(args, "pause-before-deploy");
    const { ctx } = harness(args);
    const commands = [];
    const run = createDeliveryRunner({ runCommand: async (_root, command) => { commands.push(command.args.at(-1)); return good; } });
    await assert.rejects(run(ctx), /paused/);
    assert.equal(commands.includes("deploy"), false);
    assert.equal((await run(ctx)).status, "deployed");
    assert.equal((await run(ctx)).status, "deployed");
    assert.equal(commands.filter((name) => name === "deploy").length, 1);
    assert.equal(commands.filter((name) => name === "test").length, 3);
    assert.equal(commands.filter((name) => name === "verify").length, 2);
    assert.equal(commands.filter((name) => name === "smoke").length, 2);
});

test("ambiguous deployment without positive legacy verification and failed smoke never become successful on resume", async (t) => {
    const root = await workspace(t);
    const args = input(root); deploy(args);
    args.deployment.retry = { verifyAttempts: 1, delayMs: 0 };
    const { ctx } = harness(args);
    let deployments = 0;
    const run = createDeliveryRunner({ runCommand: async (_root, command) => {
        if (command.args.at(-1) === "deploy") { deployments++; return bad; }
        if (command.args.at(-1) === "verify") return bad;
        return good;
    } });
    assert.equal((await run(ctx)).status, "blocked");
    assert.match((await run(ctx)).reason, /Ambiguous/);
    assert.equal(deployments, 1);
    const root2 = await workspace(t);
    const args2 = input(root2); deploy(args2);
    args2.deployment.retry = { delayMs: 0 };
    const second = harness(args2);
    const smokeRun = createDeliveryRunner({ runCommand: async (_root, command) => command.args.at(-1) === "smoke" ? bad : good });
    assert.equal((await smokeRun(second.ctx)).status, "failed");
    assert.equal((await smokeRun(second.ctx)).status, "failed");
});

test("changed spec, changed non-owned source and identity changes block stale replay", async (t) => {
    const root = await workspace(t);
    const args = input(root);
    const { ctx } = harness(args);
    const run = createDeliveryRunner({ runCommand: async () => good });
    assert.equal((await run(ctx)).status, "built");
    await writeFile(path.join(root, "unowned.txt"), "external change");
    assert.equal((await run(ctx)).status, "blocked");
    await rm(path.join(root, "unowned.txt"));
    await writeFile(path.join(root, "spec.md"), "Changed spec");
    await assert.rejects(run(ctx), /identity\/version changed/);
});

test("installer works from the standalone package, resolves installed modules and refuses overwrites", async (t) => {
    const root = await workspace(t);
    const distribution = path.join(root, "distribution");
    const packageRoot = path.join(distribution, "gh-dynamic-workflows");
    const project = path.join(root, "project");
    await mkdir(distribution);
    await mkdir(project);
    async function copyPackage(source, destination) {
        // Test fixtures live in the package; omit this one and concurrently running tests.
        if (/^\.(?:work|nonprod)-/.test(path.basename(source))) return;
        await mkdir(destination, { recursive: true });
        for (const entry of await readdir(source, { withFileTypes: true })) {
            const from = path.join(source, entry.name);
            const to = path.join(destination, entry.name);
            if (entry.isDirectory()) await copyPackage(from, to);
            else await copyFile(from, to);
        }
    }
    await copyPackage(path.resolve("gh-dynamic-workflows"), packageRoot);
    assert.deepEqual(await readdir(distribution), ["gh-dynamic-workflows"]);
    const install = path.join(packageRoot, "install.mjs");
    const first = spawnSync(process.execPath, [install, project], { cwd: distribution, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const loader = path.join(project, ".github", "extensions", "autonomous-delivery", "extension.mjs");
    const reader = path.join(project, ".github", "agents", "delivery-reader.agent.md");
    const entry = path.join(project, "gh-dynamic-workflows", "extension.mjs");
    const workflow = path.join(project, "gh-dynamic-workflows", "workflow.mjs");
    const runtime = path.join(project, "gh-dynamic-workflows", "runtime.mjs");
    const loaderSource = await readFile(loader, "utf8");
    const loaderImport = loaderSource.match(/^import ["']([^"']+)["'];\s*$/);
    assert.ok(loaderImport, "installed loader must contain a single runtime registration import");
    assert.equal(loaderImport[1], "../../../gh-dynamic-workflows/extension.mjs");
    assert.equal(fileURLToPath(new URL(loaderImport[1], pathToFileURL(loader))), entry);
    const entrySource = await readFile(entry, "utf8");
    const readerReference = entrySource.match(/new URL\(["']([^"']+delivery-reader\.agent\.md)["'], import\.meta\.url\)/);
    assert.ok(readerReference, "runtime registration must resolve the installed reader role");
    assert.equal(fileURLToPath(new URL(readerReference[1], pathToFileURL(entry))), reader);
    const readerSource = await readFile(reader, "utf8");
    assert.match(readerSource, /^name: delivery-reader$/m);
    assert.match(readerSource, /^tools: \["read", "search"\]$/m);
    for (const module of [loader, entry, workflow, runtime]) {
        const checked = spawnSync(process.execPath, ["--check", module], { encoding: "utf8" });
        assert.equal(checked.status, 0, checked.stderr);
    }
    assert.equal(typeof (await import(pathToFileURL(workflow).href)).createDeliveryRunner, "function");
    assert.equal(typeof (await import(pathToFileURL(runtime).href)).validateInput, "function");
    const destinations = [loader, reader, entry, workflow, runtime];
    const preserved = await Promise.all(destinations.map(async (destination) => {
        const marker = destination.endsWith(".mjs") ? "\n// Existing user customization\n" : "\n<!-- Existing user customization -->\n";
        const contents = await readFile(destination, "utf8") + marker;
        await writeFile(destination, contents);
        return contents;
    }));
    const second = spawnSync(process.execPath, [install, project], { cwd: distribution, encoding: "utf8" });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /Already exists/);
    assert.deepEqual(await Promise.all(destinations.map((destination) => readFile(destination, "utf8"))), preserved);
});
