import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("fresh installations contain the ordinary YAML runtime and owner/reviewer profiles; existing files are not overwritten", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yaml-loop-install-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const installer = fileURLToPath(new URL("../install.mjs", import.meta.url));
    const installed = spawnSync(process.execPath, [installer, root], { encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    const files = await readdir(path.join(root, "gh-dynamic-workflows"));
    assert.ok(files.includes("loops.yml") && files.includes("package-lock.json"));
    assert.ok(files.includes("scheduling.mjs"));
    assert.ok((await readdir(path.join(root, "gh-dynamic-workflows", "test"))).includes("scheduling.test.mjs"));
    const reviewer = await readFile(path.join(root, ".github", "agents", "workflow-reviewer.agent.md"), "utf8");
    assert.match(reviewer, /"execute"/);
    assert.match(reviewer, /read-only Git inspection/);
    assert.match(reviewer, /read-only evidence verification/);
    assert.match(reviewer, /explicitly supplied artifact files/);
    assert.match(reviewer, /cryptographic byte hashes and parsing structured data/);
    assert.match(reviewer, /Do not execute application, test, build, release or reconciliation scripts/);
    assert.match(reviewer, /abandonment reason in a feature-branch commit message/);
    assert.ok(!files.some((file) => /executor|policy|preflight|scratch|runtime/.test(file)));
    assert.deepEqual((await readdir(path.join(root, ".github", "agents"))).sort(),
        ["workflow-owner.agent.md", "workflow-reviewer.agent.md"]);
    assert.match(await readFile(path.join(root, ".github", "agents", "workflow-owner.agent.md"), "utf8"), /name: workflow-owner/);
    assert.ok(files.includes("scope-governance.mjs"));
    assert.ok(files.includes("task-context.mjs"));
    assert.ok(files.includes("work-cards.mjs") && files.includes("WORK-CARD-DEFINITIONS.md"));
    assert.ok(files.includes("continuation.mjs") && files.includes("DELIVERY-PRINCIPLES.md"));
    assert.ok((await readdir(path.join(root, "gh-dynamic-workflows", "test"))).includes("continuation.test.mjs"));
    assert.ok((await readdir(path.join(root, "gh-dynamic-workflows", "test"))).includes("work-cards.test.mjs"));
    assert.ok((await readdir(path.join(root, "gh-dynamic-workflows", "test"))).includes("task-context.test.mjs"));
    for (const file of ["loop-workflow.mjs", "lab-loops.mjs", "continuation.mjs",
        "test/lab-workflow.test.mjs", "test/continuation.test.mjs", "README.md", "LAB-CONTRACT.md"]) {
        assert.equal(await readFile(path.join(root, "gh-dynamic-workflows", file), "utf8"),
            await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
    }
    const before = await readFile(path.join(root, "gh-dynamic-workflows", "loops.yml"), "utf8");
    const repeated = spawnSync(process.execPath, [installer, root], { encoding: "utf8" });
    assert.notEqual(repeated.status, 0);
    assert.equal(await readFile(path.join(root, "gh-dynamic-workflows", "loops.yml"), "utf8"), before);
});

test("explicit upgrade installs the owner default, retains legacy overrides and never touches historical state", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yaml-loop-upgrade-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const installer = fileURLToPath(new URL("../install.mjs", import.meta.url));
    assert.equal(spawnSync(process.execPath, [installer, root], { encoding: "utf8" }).status, 0);
    const legacy = path.join(root, ".github", "agents", "workflow-doer.agent.md");
    await writeFile(legacy, "Legacy custom override; retain for agents.doer.");
    await rm(path.join(root, ".github", "agents", "workflow-owner.agent.md"));
    await writeFile(path.join(root, "gh-dynamic-workflows", "lab-loops.mjs"), "Old runtime");
    const history = path.join(root, "gh-dynamic-workflows", ".delivery-runs");
    await mkdir(history);
    await writeFile(path.join(history, "history.json"), '{"untouched":true}');
    const upgraded = spawnSync(process.execPath, [installer, root, "--replace-retired-engine"], { encoding: "utf8" });
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.match(await readFile(path.join(root, ".github", "agents", "workflow-owner.agent.md"), "utf8"), /name: workflow-owner/);
    assert.match(await readFile(path.join(root, "gh-dynamic-workflows", "lab-loops.mjs"), "utf8"), /agents.owner \?\? agents.doer \?\? "workflow-owner"/);
    assert.equal(await readFile(legacy, "utf8"), "Legacy custom override; retain for agents.doer.");
    assert.equal(await readFile(path.join(history, "history.json"), "utf8"), '{"untouched":true}');
    const reviewer = await readFile(path.join(root, ".github", "agents", "workflow-reviewer.agent.md"), "utf8");
    assert.match(reviewer, /read-only evidence verification/);
    assert.match(reviewer, /explicitly supplied artifact files/);
    assert.ok((await readdir(path.join(root, "gh-dynamic-workflows", "test"))).includes("scope-governance.fixture.mjs"));
});
