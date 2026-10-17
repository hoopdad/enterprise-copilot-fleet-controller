import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { git, noLinks } from "./lab-policy.mjs";

async function requireIgnored(root, directory) {
    try { await git(root, ["check-ignore", "--no-index", "--quiet", "--", path.relative(root, directory)]); }
    catch (error) {
        if (error.code !== 1) throw error;
        throw new Error("Lab evidence/scratch must be Git-ignored; explicitly ignore /.delivery-runs/ before running");
    }
}

export async function createScratch(runDirectory, owner = `offline-${randomUUID()}`) {
    const root = path.dirname(path.dirname(runDirectory)), runId = path.basename(runDirectory);
    if (path.basename(path.dirname(runDirectory)) !== ".delivery-runs" ||
        !/^[a-zA-Z0-9_-]+$/.test(runId) || !/^(?:native|offline)-[a-f0-9-]{36}$/.test(owner)) throw new Error("Invalid framework scratch identity");
    await noLinks(runDirectory);
    if (await realpath(root) !== root) throw new Error("Scratch root is not canonical");
    const directory = path.join(runDirectory, "scratch", owner);
    await requireIgnored(root, directory);
    await noLinks(directory);
    await mkdir(path.dirname(directory), { recursive: true });
    await mkdir(directory);
    await writeFile(path.join(directory, "ownership.json"), JSON.stringify({ version: 1, root, runId, owner }), { flag: "wx", mode: 0o600 });
    return directory;
}

export async function validateScratch(directory) {
    if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("DELIVERY_EVIDENCE_DIRECTORY must be an absolute framework-owned scratch directory");
    await noLinks(directory);
    const marker = path.join(directory, "ownership.json");
    await noLinks(marker);
    const owner = JSON.parse(await readFile(marker, "utf8"));
    if (owner.version !== 1 || typeof owner.root !== "string" || !path.isAbsolute(owner.root) ||
        !/^[a-zA-Z0-9_-]+$/.test(owner.runId) || !/^(?:native|offline)-[a-f0-9-]{36}$/.test(owner.owner) ||
        path.join(owner.root, ".delivery-runs", owner.runId, "scratch", owner.owner) !== directory ||
        await realpath(owner.root) !== owner.root) throw new Error("Invalid supplied scratch ownership");
    await requireIgnored(owner.root, directory);
    return directory;
}

export async function withScratch(callback, directory = process.env.DELIVERY_EVIDENCE_DIRECTORY) {
    await validateScratch(directory);
    const child = path.join(directory, `helper-${randomUUID()}`);
    await mkdir(child);
    await writeFile(path.join(child, "scratch-child.json"), JSON.stringify({ parent: directory, child: path.basename(child) }), { flag: "wx", mode: 0o600 });
    try { return await callback(child); }
    finally {
        await noLinks(child);
        await rm(child, { recursive: true, force: true });
    }

}

export async function cleanupOwnedScratch(directory) {
    await validateScratch(directory);
    for (const name of await readdir(directory)) {
        if (!/^helper-[a-f0-9-]{36}$/.test(name)) continue;
        const child = path.join(directory, name), marker = path.join(child, "scratch-child.json");
        await noLinks(child);
        await noLinks(marker);
        let ownership;
        try { ownership = JSON.parse(await readFile(marker, "utf8")); }
        catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") continue; throw error; }
        if (ownership.parent !== directory || ownership.child !== name) throw new Error("Invalid owned scratch child");
        await rm(child, { recursive: true, force: true });
    }
}
