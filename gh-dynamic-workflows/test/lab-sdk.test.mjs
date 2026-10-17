import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
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

test("actual installed SDK accepts both workflow registrations", {
    skip: !process.env.LAB_SDK_EXTENSION,
}, async () => {
    const { defineWorkflow } = await import(pathToFileURL(process.env.LAB_SDK_EXTENSION).href);
    for (const meta of [metadata, labMetadata]) {
        const handle = defineWorkflow({ meta, run: async () => ({ status: "not-executed" }) });
        assert.equal(handle.meta.name, meta.name);
    }
});

test("actual isolated CLI loads installed workflows and ticket tool without executing delivery", {
    skip: process.env.LAB_SDK_PROBE !== "1",
    timeout: 120000,
}, async (t) => {
    const root = path.resolve("gh-dynamic-workflows", "test", `.sdk-${randomUUID()}`);
    await mkdir(root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const install = spawnSync(process.execPath, [path.resolve("gh-dynamic-workflows", "install.mjs"), root], { encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr);
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
    assert.match(logs, /"name":"lab_execute_ticket"/);
    assert.doesNotMatch(logs, /Required project .*profile is missing|Workflow argsSchema is invalid/);
});
