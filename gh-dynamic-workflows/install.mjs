import { copyFile, mkdir, lstat, realpath, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const source = path.dirname(fileURLToPath(import.meta.url));
const requested = path.resolve(process.argv[2] ?? ".");
const replaceRetiredEngine = process.argv[3] === "--replace-retired-engine";
if (process.argv.length > 4 && !replaceRetiredEngine) throw new Error("Unknown installation option");
let ancestor = requested;
while (true) {
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error(`Refusing symlink destination: ${ancestor}`);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
}
const target = await realpath(requested);
const files = [
    ["install.mjs", "gh-dynamic-workflows/install.mjs"],
    ["package.json", "gh-dynamic-workflows/package.json"],
    ["package-lock.json", "gh-dynamic-workflows/package-lock.json"],
    [".gitignore", "gh-dynamic-workflows/.gitignore"],
    ["loops.yml", "gh-dynamic-workflows/loops.yml"],
    ["loop-source.mjs", "gh-dynamic-workflows/loop-source.mjs"],
    ["loop-workflow.mjs", "gh-dynamic-workflows/loop-workflow.mjs"],
    ["scheduling.mjs", "gh-dynamic-workflows/scheduling.mjs"],
    ["run.mjs", "gh-dynamic-workflows/run.mjs"],
    ["workflow.mjs", "gh-dynamic-workflows/workflow.mjs"],
    ["extension.mjs", "gh-dynamic-workflows/extension.mjs"],
    ["lab-loops.mjs", "gh-dynamic-workflows/lab-loops.mjs"],
    ["work-cards.mjs", "gh-dynamic-workflows/work-cards.mjs"],
    ["task-context.mjs", "gh-dynamic-workflows/task-context.mjs"],
    ["lab-workflow.mjs", "gh-dynamic-workflows/lab-workflow.mjs"],
    ["LAB-CONTRACT.md", "gh-dynamic-workflows/LAB-CONTRACT.md"],
    ["LAB-DESIGN.md", "gh-dynamic-workflows/LAB-DESIGN.md"],
    ["README.md", "gh-dynamic-workflows/README.md"],
    ["WORK-CARD-DEFINITIONS.md", "gh-dynamic-workflows/WORK-CARD-DEFINITIONS.md"],
    ["DELIVERY-PRINCIPLES.md", "gh-dynamic-workflows/DELIVERY-PRINCIPLES.md"],
    ["QUICKSTART.md", "gh-dynamic-workflows/QUICKSTART.md"],
    ["RESEARCH.md", "gh-dynamic-workflows/RESEARCH.md"],
    ...["extension.mjs", "workflow-owner.agent.md", "workflow-reviewer.agent.md"].map((file) =>
        [`templates/${file}`, `gh-dynamic-workflows/templates/${file}`]),
    ...["install.test.mjs", "lab-loops.test.mjs", "lab-workflow.test.mjs", "lab-sdk.test.mjs", "run.test.mjs", "scheduling.test.mjs",
        "scope-governance.test.mjs", "evidence.fixture.mjs", "task-context.test.mjs", "work-cards.test.mjs"].map((file) =>
        [`test/${file}`, `gh-dynamic-workflows/test/${file}`]),
    ["templates/extension.mjs", ".github/extensions/autonomous-delivery/extension.mjs"],
    ["templates/workflow-owner.agent.md", ".github/agents/workflow-owner.agent.md"],
    ["templates/workflow-reviewer.agent.md", ".github/agents/workflow-reviewer.agent.md"],
];
const retired = [
    "gh-dynamic-workflows/scope-governance.mjs",
    "gh-dynamic-workflows/test/scope-governance.fixture.mjs",
    "gh-dynamic-workflows/continuation.mjs",
    "gh-dynamic-workflows/test/continuation.test.mjs",
    ...["runtime.mjs", "lab-policy.mjs", "lab-executor.mjs", "lab-scratch.mjs", "lab-preflight.mjs",
        "lab-discovery.mjs", "agent-profiles.mjs"].map((file) => `gh-dynamic-workflows/${file}`),
    ...["delivery-reader", "lab-author", "lab-reader", "lab-operator"].flatMap((name) =>
        [`.github/agents/${name}.agent.md`, `gh-dynamic-workflows/templates/${name}.agent.md`]),
    ...["lab-install", "lab-native", "lab-offline", "lab-policy", "nonproduction", "workflow",
        "lab-discovery", "lab-preflight"].map((name) => `gh-dynamic-workflows/test/${name}.test.mjs`),
];
// Installation replacement is explicit; no historical run/state directory is touched.
if (replaceRetiredEngine) {
    for (const file of retired) {
        try {
            const stat = await lstat(path.join(target, file));
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Retired source is not a regular file: ${file}`);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
}
for (const [, destination] of files) {
    let current = target;
    for (const part of destination.split("/")) {
        current = path.join(current, part);
        try {
            const stat = await lstat(current);
            if (stat.isSymbolicLink()) throw new Error(`Refusing symlink destination: ${current}`);
            if (current === path.join(target, destination) && (!replaceRetiredEngine || !stat.isFile())) {
                throw new Error(`Already exists: ${current}`);
            }
        } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
}
for (const [from, to] of files) {
    const destination = path.join(target, to);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.resolve(source, from), destination, replaceRetiredEngine ? 0 : 1);
}
if (replaceRetiredEngine) {
    for (const file of retired) {
        try { await unlink(path.join(target, file)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    }
}
process.stdout.write(`Installed YAML delivery loops in ${target}.\nRun npm --prefix "${path.join(target, "gh-dynamic-workflows")}" ci, then reload extensions in Copilot CLI.\n`);
