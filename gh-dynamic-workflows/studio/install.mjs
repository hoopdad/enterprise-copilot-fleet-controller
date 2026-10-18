import { copyFile, mkdir, lstat, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const source = path.dirname(fileURLToPath(import.meta.url));
const files = [
    "extension.mjs", "server.mjs", "source.mjs", "store.mjs", "usage.mjs", "observed.mjs", "index.html", "app.mjs", "style.css",
    "package.json", "package-lock.json", ".gitignore", "README.md",
];

export async function installStudio(requestedRoot) {
    if (typeof requestedRoot !== "string" || !requestedRoot.trim()) throw new Error("An explicit target project root is required");
    const requested = path.resolve(requestedRoot);
    for (let current = requested;; current = path.dirname(current)) {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing linked destination: ${current}`);
        if (path.dirname(current) === current) break;
    }
    const root = await realpath(requested);
    const loader = path.join(".github", "extensions", "workflow-studio", "extension.mjs");
    const copies = files.map((file) => [file, path.join("gh-dynamic-workflows", "studio", file)]);
    for (const relative of [...copies.map(([, destination]) => destination), loader]) {
        let current = root;
        for (const component of relative.split(path.sep)) {
            current = path.join(current, component);
            try {
                const stat = await lstat(current);
                if (stat.isSymbolicLink()) throw new Error(`Refusing linked destination: ${current}`);
                if (current === path.join(root, relative)) throw new Error(`Already exists: ${current}`);
                if (!stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
            } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
    }
    // Verify the complete source set before creating any destination files.
    for (const [file] of copies) {
        if (!(await lstat(path.join(source, file))).isFile()) throw new Error(`Missing studio source: ${file}`);
    }
    for (const [file, destination] of copies) {
        const target = path.join(root, destination);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(source, file), target, 1);
    }
    await mkdir(path.dirname(path.join(root, loader)), { recursive: true });
    await writeFile(path.join(root, loader), 'import "../../../gh-dynamic-workflows/studio/extension.mjs";\n', { flag: "wx" });
    return root;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = await installStudio(process.argv[2]);
    process.stdout.write(`Installed Workflow Studio in ${root} without changing delivery registrations.\n` +
        "Run npm --prefix .\\gh-dynamic-workflows\\studio ci --omit=dev, then reload Copilot extensions.\n");
}
