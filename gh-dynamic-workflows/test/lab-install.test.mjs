import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const checkoutRoot = path.dirname(packageRoot);
const files = [
    ["runtime.mjs", "gh-dynamic-workflows/runtime.mjs"],
    ["workflow.mjs", "gh-dynamic-workflows/workflow.mjs"],
    ["extension.mjs", "gh-dynamic-workflows/extension.mjs"],
    ["lab-policy.mjs", "gh-dynamic-workflows/lab-policy.mjs"],
    ["lab-executor.mjs", "gh-dynamic-workflows/lab-executor.mjs"],
    ["lab-loops.mjs", "gh-dynamic-workflows/lab-loops.mjs"],
    ["lab-workflow.mjs", "gh-dynamic-workflows/lab-workflow.mjs"],
    ["lab-scratch.mjs", "gh-dynamic-workflows/lab-scratch.mjs"],
    ["lab-preflight.mjs", "gh-dynamic-workflows/lab-preflight.mjs"],
    ["LAB-CONTRACT.md", "gh-dynamic-workflows/LAB-CONTRACT.md"],
    ["LAB-DESIGN.md", "gh-dynamic-workflows/LAB-DESIGN.md"],
    ["templates/extension.mjs", ".github/extensions/autonomous-delivery/extension.mjs"],
    ["templates/delivery-reader.agent.md", ".github/agents/delivery-reader.agent.md"],
    ["templates/lab-reader.agent.md", ".github/agents/lab-reader.agent.md"],
    ["templates/lab-author.agent.md", ".github/agents/lab-author.agent.md"],
    ["templates/lab-operator.agent.md", ".github/agents/lab-operator.agent.md"],
];
const profiles = {
    "lab-reader": ["read", "search"],
    "lab-author": ["read", "search", "edit"],
    "lab-operator": ["read", "search", "lab_execute_ticket"],
};

async function fixture(t) {
    // Targets are siblings of the checkout, never the installer source or an OS temp directory.
    const root = path.join(path.dirname(checkoutRoot), `.lab-install-check-${randomUUID()}`);
    await mkdir(root);
    t.after(() => rm(root, { recursive: true, force: true }));
    const distribution = path.join(root, "distribution", "gh-dynamic-workflows");
    await mkdir(distribution, { recursive: true });
    for (const from of ["install.mjs", ...files.map(([source]) => source)]) {
        const destination = path.join(distribution, from);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(packageRoot, from), destination);
    }
    const target = path.join(root, "target");
    await mkdir(target);
    return { root, distribution, target };
}
function install(distribution, target) {
    return spawnSync(process.execPath, [path.join(distribution, "install.mjs"), target], {
        cwd: path.dirname(distribution), encoding: "utf8", timeout: 30000, windowsHide: true,
    });
}
async function snapshot(root, prefix = "") {
    const result = {};
    for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
        const name = path.join(prefix, entry.name);
        if (entry.isDirectory()) Object.assign(result, await snapshot(root, name));
        else result[name] = await readFile(path.join(root, name), "base64");
    }
    return result;
}
async function directoryLink(t, destination, victim) {
    try {
        await symlink(victim, destination, process.platform === "win32" ? "junction" : "dir");
        return true;
    } catch (error) {
        if (!["EPERM", "EACCES", "ENOSYS"].includes(error.code)) throw error;
        t.skip(`Directory links unavailable: ${error.code}`);
        return false;
    }
}

test("lab installer is standalone, copies all original/companion files and preserves owner configuration", async (t) => {
    const { distribution, target } = await fixture(t);
    await mkdir(path.join(target, ".github"), { recursive: true });
    const instructions = "Owner policy: fleet dispatch until explicitly opted into lab delivery.\n";
    await writeFile(path.join(target, ".github", "copilot-instructions.md"), instructions);
    await writeFile(path.join(target, ".github", "mcp.json"), '{"owner":"unchanged"}\n');
    const result = install(distribution, target);
    assert.equal(result.status, 0, result.stderr);
    for (const [from, to] of files) {
        assert.deepEqual(await readFile(path.join(target, to)), await readFile(path.join(distribution, from)), to);
    }
    assert.equal(await readFile(path.join(target, ".github", "copilot-instructions.md"), "utf8"), instructions);
    assert.equal(await readFile(path.join(target, ".github", "mcp.json"), "utf8"), '{"owner":"unchanged"}\n');
    for (const [name, tools] of Object.entries(profiles)) {
        const text = await readFile(path.join(target, ".github", "agents", `${name}.agent.md`), "utf8");
        assert.match(text, new RegExp(`^name: ${name}$`, "m"));
        assert.deepEqual(JSON.parse(text.match(/^tools: (.+)$/m)?.[1]), tools);
    }
    const installed = path.join(target, "gh-dynamic-workflows");
    const policy = await import(pathToFileURL(path.join(installed, "lab-policy.mjs")));
    const workflow = await import(pathToFileURL(path.join(installed, "lab-workflow.mjs")));
    const executor = await import(pathToFileURL(path.join(installed, "lab-executor.mjs")));
    const loops = await import(pathToFileURL(path.join(installed, "lab-loops.mjs")));
    assert.equal(typeof policy.validateLabInput, "function");
    assert.equal(workflow.labMetadata.name, "lab-delivery");
    assert.equal(typeof executor.executionTool, "function");
    assert.ok(loops.LOOP_DEFINITIONS.architecture);
    const scratch = await import(pathToFileURL(path.join(installed, "lab-scratch.mjs")));
    assert.equal(typeof scratch.withScratch, "function");
    const preflight = await import(pathToFileURL(path.join(installed, "lab-preflight.mjs")));
    assert.equal(typeof preflight.runOfflineCheck, "function");
    const preflightSyntax = spawnSync(process.execPath, ["--check", path.join(installed, "lab-preflight.mjs")], {
        encoding: "utf8", timeout: 30000, windowsHide: true,
    });
    assert.equal(preflightSyntax.status, 0, preflightSyntax.stderr);
    const example = JSON.parse(await readFile(path.join(packageRoot, "examples", "lab.json"), "utf8"));
    assert.equal(policy.validateLabInput(example), example);
    assert.equal(example.target.deploy, false);
    assert.deepEqual(policy.terraformPolicy(example), { requirement: "any", preference: "avm" });
    for (const grant of ["provision", "providerRegistration", "publish", "repositoryCreation", "modelTests"]) {
        assert.equal(example.authorization[grant], false);
    }
});

test("repeat installation refuses without changing any installed or owner bytes", async (t) => {
    const { distribution, target } = await fixture(t);
    assert.equal(install(distribution, target).status, 0);
    for (const [, destination] of files) {
        const file = path.join(target, destination);
        await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("\nowner-reviewed local customization\n")]));
    }
    const before = await snapshot(target);
    const result = install(distribution, target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Already exists/);
    assert.deepEqual(await snapshot(target), before);
});

test("every existing destination is refused before any original or companion file is copied", async (t) => {
    const { root, distribution } = await fixture(t);
    for (const [index, [, destination]] of files.entries()) {
        await t.test(destination, async () => {
            const target = path.join(root, `conflict-${index}`);
            const file = path.join(target, destination);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, "owner content must survive\n");
            const before = await snapshot(target);
            const result = install(distribution, target);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Already exists/);
            assert.deepEqual(await snapshot(target), before);
        });
    }
});

test("every linked destination is refused before copying and cannot write into the link target", async (t) => {
    const { root, distribution } = await fixture(t);
    for (const [index, [, destination]] of files.entries()) {
        await t.test(destination, async (subtest) => {
            const target = path.join(root, `linked-file-${index}`);
            const link = path.join(target, destination);
            const victim = path.join(root, `victim-file-${index}`);
            await mkdir(victim);
            await writeFile(path.join(victim, "sentinel"), "untouched\n");
            await mkdir(path.dirname(link), { recursive: true });
            if (!await directoryLink(subtest, link, victim)) return;
            const result = install(distribution, target);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Refusing symlink destination/);
            assert.deepEqual(await snapshot(victim), { sentinel: Buffer.from("untouched\n").toString("base64") });
            for (const [, other] of files) {
                if (other === destination) continue;
                await assert.rejects(readFile(path.join(target, other)), { code: "ENOENT" });
            }
        });
    }
});

test("linked root and shared destination directories are refused before any writes", async (t) => {
    const { root, distribution } = await fixture(t);
    const ancestors = [".", "gh-dynamic-workflows", ".github", ".github/agents",
        ".github/extensions", ".github/extensions/autonomous-delivery"];
    for (const [index, destination] of ancestors.entries()) {
        await t.test(destination, async (subtest) => {
            const target = path.join(root, `linked-directory-${index}`);
            const link = path.join(target, destination);
            const victim = path.join(root, `victim-directory-${index}`);
            await mkdir(victim);
            await writeFile(path.join(victim, "sentinel"), "untouched\n");
            await mkdir(path.dirname(link), { recursive: true });
            if (!await directoryLink(subtest, link, victim)) return;
            const result = install(distribution, target);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Refusing symlink destination/);
            assert.deepEqual(await snapshot(victim), { sentinel: Buffer.from("untouched\n").toString("base64") });
        });
    }
});

test("a linked ancestor above the target cannot be hidden by realpath", async (t) => {
    const { root, distribution } = await fixture(t);
    const real = path.join(root, "physical-parent");
    const link = path.join(root, "linked-parent");
    await mkdir(path.join(real, "nested"), { recursive: true });
    if (!await directoryLink(t, link, real)) return;
    const result = install(distribution, path.join(link, "nested"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing symlink destination/);
    assert.deepEqual(await readdir(path.join(real, "nested")), []);
});
