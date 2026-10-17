import { copyFile, mkdir, lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const source = path.dirname(fileURLToPath(import.meta.url));
const requested = path.resolve(process.argv[2] ?? ".");
let ancestor = requested;
while (true) {
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error(`Refusing symlink destination: ${ancestor}`);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
}
const target = await realpath(requested);
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
// Preflight every destination before copying; never overwrite a user's extension or agent.
for (const [, destination] of files) {
    let current = target;
    for (const part of destination.split("/")) {
        current = path.join(current, part);
        try {
            const stat = await lstat(current);
            if (stat.isSymbolicLink()) throw new Error(`Refusing symlink destination: ${current}`);
            if (current === path.join(target, destination)) throw new Error(`Already exists: ${current}`);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
}
for (const [from, to] of files) {
    const destination = path.join(target, to);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.resolve(source, from), destination, 1);
}
process.stdout.write(`Installed autonomous-delivery in ${target}. Reload extensions in Copilot CLI.\n`);
