import { copyFile, mkdir, lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const source = path.dirname(fileURLToPath(import.meta.url));
const target = await realpath(path.resolve(process.argv[2] ?? "."));
const files = [
    ["runtime.mjs", "gh-dynamic-workflows/runtime.mjs"],
    ["workflow.mjs", "gh-dynamic-workflows/workflow.mjs"],
    ["extension.mjs", "gh-dynamic-workflows/extension.mjs"],
    ["templates/extension.mjs", ".github/extensions/autonomous-delivery/extension.mjs"],
    ["templates/delivery-reader.agent.md", ".github/agents/delivery-reader.agent.md"],
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
