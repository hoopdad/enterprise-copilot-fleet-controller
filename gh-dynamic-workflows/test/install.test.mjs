import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("fresh installations contain only ordinary YAML loop runtime and do-er/reviewer profiles; existing files are not overwritten", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yaml-loop-install-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const installer = fileURLToPath(new URL("../install.mjs", import.meta.url));
    const installed = spawnSync(process.execPath, [installer, root], { encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    const files = await readdir(path.join(root, "gh-dynamic-workflows"));
    assert.ok(files.includes("loops.yml") && files.includes("package-lock.json"));
    assert.ok(!files.some((file) => /executor|policy|preflight|scratch|runtime/.test(file)));
    assert.deepEqual((await readdir(path.join(root, ".github", "agents"))).sort(),
        ["workflow-doer.agent.md", "workflow-reviewer.agent.md"]);
    const before = await readFile(path.join(root, "gh-dynamic-workflows", "loops.yml"), "utf8");
    const repeated = spawnSync(process.execPath, [installer, root], { encoding: "utf8" });
    assert.notEqual(repeated.status, 0);
    assert.equal(await readFile(path.join(root, "gh-dynamic-workflows", "loops.yml"), "utf8"), before);
});
