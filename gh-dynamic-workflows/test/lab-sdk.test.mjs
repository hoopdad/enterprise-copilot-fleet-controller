import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { labMetadata } from "../lab-workflow.mjs";
import { metadata } from "../workflow.mjs";

test("every declared schema object has an explicit type and no guessed SDK limits", () => {
    function check(schema) {
        assert.ok(schema && typeof schema === "object");
        if (schema.properties || schema.required) assert.equal(schema.type, "object");
        for (const nested of Object.values(schema.properties ?? {})) check(nested);
        if (schema.items) check(schema.items);
        for (const key of ["oneOf", "anyOf", "allOf"]) for (const nested of schema[key] ?? []) check(nested);
    }
    check(labMetadata.argsSchema);
    assert.equal(Object.hasOwn(labMetadata, "limits"), false);
});

test("actual CLI JSONL envelope and result-file shapes match the concise reporter without agents or delivery", {
    skip: process.env.LAB_SDK_PROBE !== "1",
    timeout: 120000,
}, async (t) => {
    const { parseEnvelope, describeOutcome } = await import("../run.mjs");
    const base = fileURLToPath(new URL("..", import.meta.url));
    const root = path.join(base, "test", `.sdk-${randomUUID()}`);
    const extension = path.join(root, ".github", "extensions", "reporting-fixture");
    await mkdir(extension, { recursive: true });
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(extension, "extension.mjs"), `
import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { createLoopRunner } from ${JSON.stringify(pathToFileURL(path.join(base, "loop-workflow.mjs")).href)};
import { labMetadata } from ${JSON.stringify(pathToFileURL(path.join(base, "lab-workflow.mjs")).href)};
await joinSession({ workflows: [defineWorkflow({
    meta: { ...labMetadata, name: "reporting-fixture", argsSchema: { type: "object" } },
    run: async (ctx) => {
        if (!ctx.args.nested) return { status: "needs-input", summary: "Fixture only; no delivery executed." };
        const tasks = [
            { id: "a", title: "Fixture a", kind: "developer", owner: "Developer", dependsOn: [] },
            { id: "b", title: "Fixture b", kind: "ui", owner: "Developer", dependsOn: ["a"] },
        ];
        return createLoopRunner()({
            args: { projectRoot: ${JSON.stringify(root)} }, runId: ctx.runId, signal: ctx.signal,
            step: (...args) => ctx.step(...args), parallel: (...args) => ctx.parallel(...args),
            phase: (...args) => ctx.phase(...args), log: (...args) => ctx.log(...args),
            agent: async (prompt) => {
                const input = JSON.parse(prompt);
                if (input.kind === "reviewer") {
                    if (input.loop.id === "SprintPlanLoop" && input.dispatch?.status !== "dispatched")
                        throw new Error("Planning review preceded actual original-loop dispatch");
                    return { agree: true, feedback: "Fixture review only" };
                }
                const artifact = input.loop.id === "ReleasePlanLoop" ? { ReleasePlan: { sprints: [{ id: "fixture" }] } }
                    : input.loop.id === "SprintPlanLoop" ? { SprintPlan: { tasks } } : {};
                return { status: "complete", summary: "Fixture only; no tools or actual agents", artifact };
            },
        });
    },
})] });
`);
    assert.equal(spawnSync("git", ["-C", root, "init", "--quiet"]).status, 0);
    const resultFile = path.join(root, "result.json");
    const probe = spawnSync("copilot", [
        "-C", root, "--experimental", "--disable-builtin-mcps", "--no-auto-update", "--no-custom-instructions",
        "workflow", "run", "reporting-fixture", "--args", "{}", "--silent", "--output-format", "json", "--result-file", resultFile,
    ], {
        encoding: "utf8", timeout: 100000,
        env: { ...process.env, COPILOT_HOME: path.join(root, "isolated-home"), GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: "true" },
    });
    assert.equal(probe.status, 0, probe.stderr + probe.stdout);
    const result = JSON.parse(await readFile(resultFile, "utf8"));
    const envelope = parseEnvelope(probe.stdout);
    assert.equal(result.status, "needs-input");
    assert.equal(envelope.status, "completed", JSON.stringify(envelope));
    assert.equal(describeOutcome(envelope, result).exitCode, 2);
    const nested = spawnSync("copilot", [
        "-C", root, "--experimental", "--disable-builtin-mcps", "--no-auto-update", "--no-custom-instructions",
        "workflow", "run", "reporting-fixture", "--args", '{"nested":true}', "--silent", "--output-format", "json", "--result-file", resultFile,
    ], {
        encoding: "utf8", timeout: 100000,
        env: { ...process.env, COPILOT_HOME: path.join(root, "isolated-home"), GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: "true" },
    });
    assert.equal(nested.status, 0, nested.stderr + nested.stdout);
    const nestedResult = JSON.parse(await readFile(resultFile, "utf8"));
    assert.equal(nestedResult.status, "completed", JSON.stringify(nestedResult));
    assert.equal(nestedResult.outcomes.find((outcome) => outcome.loopId === "SprintPlanLoop").dispatch.status, "dispatched");
    assert.equal(nestedResult.outcomes.filter((outcome) => outcome.key.includes("/task/")).length, 2);
});

test("actual installed SDK accepts both workflow registrations", {
    skip: !process.env.LAB_SDK_EXTENSION,
}, async () => {
    const { defineWorkflow } = await import(pathToFileURL(process.env.LAB_SDK_EXTENSION).href);
    for (const meta of [metadata, labMetadata]) {
        const handle = defineWorkflow({ meta, run: async () => ({ status: "not-executed" }) });
        assert.equal(handle.meta.name, meta.name);
    }
});

test("actual isolated CLI loads only YAML workflows without executing delivery", {
    skip: process.env.LAB_SDK_PROBE !== "1",
    timeout: 120000,
}, async (t) => {
    const base = fileURLToPath(new URL("..", import.meta.url));
    const root = path.join(base, "test", `.sdk-${randomUUID()}`);
    await mkdir(root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const install = spawnSync(process.execPath, [path.join(base, "install.mjs"), root], { encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr);
    const dependencies = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
        ["--prefix", path.join(root, "gh-dynamic-workflows"), "ci", "--offline", "--no-audit", "--no-fund"],
        { encoding: "utf8", shell: process.platform === "win32" });
    assert.equal(dependencies.status, 0, dependencies.stderr);
    const init = spawnSync("git", ["-C", root, "init", "--quiet"], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const logRoot = path.join(root, "logs");
    const probe = spawnSync("copilot", [
        "-C", root, "--experimental", "--disable-builtin-mcps", "--no-auto-update",
        "--no-custom-instructions", "--log-level", "debug", "--log-dir", logRoot,
        "workflow", "run", "__lab_registration_probe_only__", "--args", "{}", "--silent", "--output-format", "json",
    ], {
        encoding: "utf8", timeout: 100000,
        env: { ...process.env, COPILOT_HOME: path.join(root, "isolated-home"), GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: "true" },
    });
    assert.equal(probe.status, 2, probe.stderr);
    assert.match(probe.stderr + probe.stdout, /__lab_registration_probe_only__.*not found/);
    const files = await readdir(logRoot);
    const logs = (await Promise.all(files.filter((name) => name.endsWith(".log")).map((name) => readFile(path.join(logRoot, name), "utf8")))).join("\n");
    assert.match(logs, /Workflow extension setup completed: failures=0, nonRunning=0/);
    assert.match(logs, /"name":"autonomous-delivery"/);
    assert.match(logs, /"name":"lab-delivery"/);
    assert.doesNotMatch(logs, /"name":"lab_execute_ticket"|"name":"lab-delivery-resume"/);
    assert.doesNotMatch(logs, /Required project .*profile is missing|Workflow argsSchema is invalid/);
});
