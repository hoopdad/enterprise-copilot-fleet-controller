import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./fixture.mjs";
import { installStudio } from "../install.mjs";

test("installs studio independently without modifying an existing workflow", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const workflow = path.join(f.project, "gh-dynamic-workflows", "workflow.mjs");
    const before = await readFile(workflow);
    await installStudio(f.project);
    assert.match(await readFile(path.join(f.project, ".github", "extensions", "workflow-studio", "extension.mjs"), "utf8"), /studio\/extension.mjs/);
    assert.deepEqual(await readFile(workflow), before);
    assert.ok((await readdir(path.join(f.project, "gh-dynamic-workflows", "studio"))).includes("package-lock.json"));
    await assert.rejects(installStudio(f.project), /Already exists/);
});

test("preflights all destinations before writing or replacing any file", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const destination = path.join(f.project, ".github", "extensions", "workflow-studio");
    await mkdir(destination);
    await writeFile(path.join(destination, "extension.mjs"), "user content");
    await assert.rejects(installStudio(f.project), /Already exists/);
    assert.equal(await readFile(path.join(destination, "extension.mjs"), "utf8"), "user content");
    await assert.rejects(readFile(path.join(f.project, "gh-dynamic-workflows", "studio", "server.mjs")), { code: "ENOENT" });
    await assert.rejects(installStudio(undefined), /explicit/);
});
