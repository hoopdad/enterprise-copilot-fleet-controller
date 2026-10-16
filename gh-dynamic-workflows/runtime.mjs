import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const VERSION = "delivery-v2";
export const EXECUTION_ACK = "I reviewed these commands and authorize local execution";
export const DEPLOY_ACK = "I authorize this nonproduction deployment";
export const DIAGNOSTIC_ACK = "I authorize redacted diagnostics to be shared with workflow agents";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function relativePath(value) {
    if (!text(value) || value.includes("\\") || value.includes(":") || value.startsWith("/") ||
        value.split("/").some((part) => !part || part === "." || part === ".." ||
            /[. ]$|^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)) ||
        /[\x00-\x1f]/.test(value)) throw new Error(`Unsafe repository-relative path: ${value}`);
    if (value.split("/").some((part) => [".git", ".delivery-runs", "node_modules"].includes(part.toLowerCase())) ||
        /^\.github\/(agents|extensions)(\/|$)/i.test(value) ||
        /(^|\/)\.env($|\.)|(^|\/)(credentials|secrets?)(\.|\/|$)/i.test(value)) {
        throw new Error(`Protected path: ${value}`);
    }
    return value;
}
export const owns = (owner, file) => file.toLowerCase() === owner.toLowerCase() || file.toLowerCase().startsWith(`${owner.toLowerCase()}/`);
export function command(value) {
    if (!object(value) || !text(value.executable) || !Array.isArray(value.args) ||
        value.args.some((arg) => typeof arg !== "string" || /[\x00-\x1f]/.test(arg)) ||
        !text(value.cwd) || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0) {
        throw new Error("Commands require executable, string args, relative cwd and positive timeoutMs");
    }
    if (value.cwd !== ".") relativePath(value.cwd);
    if (/[\x00-\x1f]/.test(value.executable) || /\.(cmd|bat)$/i.test(value.executable)) {
        throw new Error("Use a native executable (not a batch file), without control characters");
    }
    return value;
}
export function validateInput(args) {
    if (!object(args) || args.schemaVersion !== 1 || !text(args.projectRoot) ||
        !object(args.input) || !["architecture", "product", "brownfield"].includes(args.input.kind) ||
        !text(args.input.goal)) throw new Error("Invalid schemaVersion, projectRoot or input");
    if (args.input.path !== ".") relativePath(args.input.path);
    if (args.input.path === "." && args.input.kind !== "brownfield") throw new Error("Specs must name a file");
    if (!Array.isArray(args.scope) || !args.scope.length) throw new Error("A nonempty write scope is required");
    args.scope.forEach(relativePath);
    if (args.generatedPaths !== undefined && !Array.isArray(args.generatedPaths)) throw new Error("generatedPaths must be an array");
    for (const generated of args.generatedPaths ?? []) {
        relativePath(generated);
        if (args.scope.some((scope) => owns(scope, generated) || owns(generated, scope)) ||
            generated === args.input.path || owns(generated, args.input.path) ||
            owns(".github", generated)) throw new Error("Generated outputs must not overlap source, input or .github");
    }
    if (!Array.isArray(args.acceptance) || !args.acceptance.length || args.acceptance.some((a) => !text(a))) {
        throw new Error("Explicit acceptance criteria are required");
    }
    if (new Set(args.acceptance).size !== args.acceptance.length) throw new Error("Acceptance criteria must be unique");
    for (const name of ["planning", "implementation", "repair"]) {
        const count = args.attempts?.[name];
        if (!Number.isSafeInteger(count) || count < (name === "repair" ? 0 : 1)) {
            throw new Error(`Explicit integer attempts.${name} is required`);
        }
    }
    if (args.execution?.authorized !== true || args.execution.acknowledgement !== EXECUTION_ACK) {
        throw new Error("Reviewed local command execution must be explicitly authorized");
    }
    if (args.execution.shareDiagnostics !== undefined && typeof args.execution.shareDiagnostics !== "boolean") {
        throw new Error("execution.shareDiagnostics must be boolean");
    }
    if (args.execution.shareDiagnostics === true && args.execution.diagnosticsAcknowledgement !== DIAGNOSTIC_ACK) {
        throw new Error("Sharing redacted command diagnostics requires explicit authorization");
    }
    for (const name of ["baseline", "test", "build"]) {
        if (!Array.isArray(args.commands?.[name]) || !args.commands[name].length) {
            throw new Error(`A nonempty commands.${name} list is required`);
        }
        args.commands[name].forEach(command);
    }
    if (!object(args.deployment)) throw new Error("Explicit deployment configuration or mode build-only is required");
    const deployment = { ...args.deployment, mode: args.deployment.mode ?? "nonproduction" };
    if (!["build-only", "pause-before-deploy", "nonproduction"].includes(deployment.mode)) {
        throw new Error("Unknown deployment mode");
    }
    if (deployment.mode !== "build-only") {
        if (!["dev", "development", "test", "staging"].includes(deployment.environment) ||
            !text(deployment.target) || deployment.authorized !== true ||
            /[\x00-\x1f]/.test(deployment.target) ||
            (deployment.idempotent !== undefined && deployment.idempotent !== true)) {
            throw new Error("Deployment requires explicit nonproduction target and authorization; commands must be idempotent");
        }
        deployment.acceptance ??= [];
        if (!Array.isArray(deployment.acceptance) || deployment.acceptance.some((value) => !text(value)) ||
            new Set(deployment.acceptance).size !== deployment.acceptance.length ||
            deployment.acceptance.some((value) => args.acceptance.includes(value))) {
            throw new Error("deployment.acceptance must contain unique live criteria separate from local acceptance");
        }
        deployment.allowedExecutables ??= ["node"];
        if (!Array.isArray(deployment.allowedExecutables) || !deployment.allowedExecutables.length ||
            deployment.allowedExecutables.some((value) => !text(value) ||
                !/^[a-zA-Z0-9_-]+(?:\.exe)?$/.test(value) ||
                /^(?:cmd|powershell|pwsh|bash|sh|zsh|fish|wscript|cscript)(?:\.exe)?$/i.test(value))) {
            throw new Error("deployment.allowedExecutables must name native executables, not shells or paths");
        }
        if (deployment.retry !== undefined && !object(deployment.retry)) throw new Error("deployment.retry must be an object");
        deployment.retry = { deployAttempts: 3, verifyAttempts: 3, smokeAttempts: 3, delayMs: 1000, ...deployment.retry };
        for (const name of ["deployAttempts", "verifyAttempts", "smokeAttempts", "delayMs"]) {
            const value = deployment.retry[name];
            if (!Number.isSafeInteger(value) || value < (name === "delayMs" ? 0 : 1) ||
                value > (name === "delayMs" ? 60000 : 10)) throw new Error(`Invalid deployment.retry.${name}`);
        }
        for (const name of ["command", "verify", "reconcile"]) {
            if (deployment[name] !== undefined) command(deployment[name]);
        }
        if (deployment.smoke !== undefined) {
            if (!Array.isArray(deployment.smoke) || !deployment.smoke.length) throw new Error("Smoke commands must be nonempty");
            deployment.smoke.forEach(command);
        }
        const explicit = Boolean(deployment.command && deployment.verify && deployment.smoke?.length);
        if (!explicit) {
            deployment.adapterPaths ??= ["scripts/delivery"];
            if (!Array.isArray(deployment.adapterPaths) || !deployment.adapterPaths.length) throw new Error("Adapter write paths are required");
            for (const file of deployment.adapterPaths) {
                relativePath(file);
                if (!args.scope.some((scope) => owns(scope, file))) throw new Error("Adapter paths must be inside authorized scope");
            }
        }
    }
    return { ...args, deployment };
}
export function validateAdapter(adapter, deployment) {
    if (!object(adapter) || !Array.isArray(adapter.changes) || !adapter.changes.length) throw new Error("Adapter requires complete UTF-8 file changes");
    const seen = new Set();
    for (const file of adapter.changes) {
        if (!object(file) || typeof file.content !== "string") throw new Error("Invalid adapter file");
        relativePath(file.path);
        if (!deployment.adapterPaths.some((scope) => owns(scope, file.path)) || seen.has(file.path.toLowerCase())) {
            throw new Error("Adapter file is duplicate or outside authorized adapter paths");
        }
        seen.add(file.path.toLowerCase());
    }
    const list = [adapter.command, adapter.verify, adapter.reconcile];
    if (!Array.isArray(adapter.smoke) || !adapter.smoke.length) throw new Error("Adapter smoke commands are required");
    list.push(...adapter.smoke);
    for (const spec of list) {
        command(spec);
        if (!deployment.allowedExecutables.includes(spec.executable)) throw new Error("Adapter executable is not allowed");
    }
    return adapter;
}
export async function safePath(root, relative, { missing = false } = {}) {
    if (relative !== ".") relativePath(relative);
    const resolvedRoot = await realpath(root);
    const parts = relative === "." ? [] : relative.split("/");
    let current = resolvedRoot;
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        try {
            const stat = await lstat(current);
            if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in workflow paths");
        } catch (error) {
            if (error.code !== "ENOENT" || !missing) throw error;
        }
    }
    return current;
}
export async function fingerprint(root, scopes, excluded = []) {
    const entries = [];
    async function visit(relative) {
        if (excluded.some((owner) => owns(owner, relative))) return;
        // Read-only fingerprints include agent/extension configuration, which is protected from writes.
        const absolute = /^\.github\/(agents|extensions)(\/|$)/i.test(relative) ?
            path.join(await realpath(root), ...relative.split("/")) :
            await safePath(root, relative, { missing: true });
        let stat;
        try { stat = await lstat(absolute); } catch (error) {
            if (error.code === "ENOENT") { entries.push([relative, null]); return; }
            throw error;
        }
        if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in workflow paths");
        if (stat.isDirectory()) {
            const children = (await readdir(absolute)).sort();
            for (const name of children) {
                if ([".git", ".delivery-runs", "node_modules", "__pycache__"].includes(name.toLowerCase()) ||
                    /^\.env($|\.)|^(credentials|secrets?)(\.|$)/i.test(name)) continue;
                await visit(relative === "." ? name : `${relative}/${name}`);
            }
        } else if (stat.isFile()) {
            entries.push([relative, createHash("sha256").update(await readFile(absolute)).digest("hex")]);
        } else throw new Error("Only regular files and directories are supported");
    }
    for (const scope of [...new Set(scopes)].sort()) await visit(scope);
    return digest(entries);
}
export function validatePlan(plan, scopes, acceptance = []) {
    if (!object(plan) || !Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error("Planner returned no tasks");
    if (acceptance.length) {
        if (!text(plan.architecture) || !object(plan.ux) || typeof plan.ux.applicable !== "boolean" ||
            !text(plan.ux.rationale) || !Array.isArray(plan.risks) || plan.risks.some((risk) => !text(risk)) ||
            !Array.isArray(plan.decisions) || plan.decisions.some((decision) => !text(decision)) ||
            !Array.isArray(plan.requirements) || plan.requirements.length !== acceptance.length) {
            throw new Error("Plan requires architecture, explicit UX applicability, risks, decisions and requirement coverage");
        }
        const criteria = new Set();
        for (const requirement of plan.requirements) {
            if (!object(requirement) || !acceptance.includes(requirement.criterion) ||
                criteria.has(requirement.criterion) || !text(requirement.approach) || !text(requirement.verification)) {
                throw new Error("Plan must cover each exact acceptance criterion once with an approach and verification");
            }
            criteria.add(requirement.criterion);
        }
    }
    const ids = new Set();
    for (const task of plan.tasks) {
        if (!object(task) || !/^[a-z][a-z0-9-]*$/.test(task.id) || ids.has(task.id) ||
            !text(task.title) || !Array.isArray(task.dependsOn) || !Array.isArray(task.paths) ||
            !task.paths.length) throw new Error("Malformed or duplicate task");
        ids.add(task.id);
        for (const file of task.paths) {
            relativePath(file);
            if (!scopes.some((scope) => owns(scope, file))) throw new Error("Task outside authorized scope");
        }
    }
    const all = plan.tasks.flatMap((task) => task.paths.map((file) => ({ id: task.id, file })));
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        if (owns(all[i].file, all[j].file) || owns(all[j].file, all[i].file)) {
            throw new Error("Write ownership must be disjoint, including across dependent tasks");
        }
    }
    const done = new Set();
    const layers = [];
    while (done.size < ids.size) {
        const ready = plan.tasks.filter((task) => !done.has(task.id) &&
            task.dependsOn.every((id) => ids.has(id) && done.has(id)));
        if (!ready.length) throw new Error("Dependency cycle, missing dependency or self dependency");
        layers.push(ready);
        ready.forEach((task) => done.add(task.id));
    }
    return layers;
}
export async function applyChanges(root, proposal, scopes) {
    if (!object(proposal) || !Array.isArray(proposal.changes) || !proposal.changes.length) {
        throw new Error("Missing implementation proposal");
    }
    const seen = new Set();
    const files = [];
    for (const change of proposal.changes) {
        if (!object(change) || typeof change.content !== "string") throw new Error("Invalid proposed file");
        relativePath(change.path);
        if (seen.has(change.path.toLowerCase()) || !scopes.some((scope) => owns(scope, change.path))) {
            throw new Error("Duplicate or unowned proposed file");
        }
        seen.add(change.path.toLowerCase());
        files.push({ ...change, absolute: await safePath(root, change.path, { missing: true }) });
    }
    for (const file of files) {
        await mkdir(path.dirname(file.absolute), { recursive: true });
        await writeFile(file.absolute, file.content, "utf8");
    }
    return files.map((file) => file.path);
}
export function redactDiagnostics(value, environment = process.env) {
    let clean = value;
    for (const [name, secret] of Object.entries(environment)) {
        if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE.?KEY|CONNECTION.?STRING/i.test(name) &&
            typeof secret === "string" && secret.length >= 4) clean = clean.split(secret).join("[REDACTED]");
    }
    return clean
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]")
        .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[REDACTED]@")
        .replace(/(\b(?:password|passwd|secret|token|api[-_]?key|accountkey|sharedaccesskey|sig|authorization|connectionstring)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[REDACTED]")
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}
export async function runCommand(root, spec, signal, { shareDiagnostics = false, environment = {} } = {}) {
    command(spec);
    const summary = { executable: spec.executable, cwd: spec.cwd, argumentsCount: spec.args.length };
    if (signal?.aborted) return { ok: false, exitCode: null, reason: "aborted", errorCode: "ABORT_ERR", command: summary };
    const cwd = await safePath(root, spec.cwd);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE.?KEY|CONNECTION.?STRING/i.test(key)));
    for (const name of ["DELIVERY_TARGET", "DELIVERY_RUN_ID", "DELIVERY_SOURCE_FINGERPRINT", "DELIVERY_BUILD_FINGERPRINT"]) {
        if (environment[name] !== undefined) {
            if (typeof environment[name] !== "string") throw new Error("Invalid deployment environment");
            env[name] = environment[name];
        }
    }
    return await new Promise((resolve) => {
        let settled = false;
        let timer;
        let timedOut = false;
        let stdout = "";
        let stderr = "";
        const finish = (result) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve({
                    ...result, command: summary, timedOut,
                    ...(shareDiagnostics ? { diagnostics: {
                        stdout: redactDiagnostics(stdout), stderr: redactDiagnostics(stderr),
                        truncated: stdout.length >= 8192 || stderr.length >= 8192,
                    } } : {}),
                });
            }
        };
        let child;
        try {
            child = spawn(spec.executable, spec.args, {
                cwd, env, shell: false, stdio: shareDiagnostics ? ["ignore", "pipe", "pipe"] : "ignore", signal,
            });
        } catch (error) {
            finish({ ok: false, exitCode: null, reason: "spawn", errorCode: error.code ?? "SPAWN_ERROR" }); return;
        }
        if (shareDiagnostics) {
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (data) => { stdout = (stdout + data).slice(0, 8192); });
            child.stderr.on("data", (data) => { stderr = (stderr + data).slice(0, 8192); });
        }
        timer = setTimeout(() => { timedOut = true; child.kill(); }, spec.timeoutMs);
        timer.unref();
        child.once("error", (error) => finish({
            ok: false, exitCode: null, reason: error.code === "ABORT_ERR" ? "aborted" : "spawn",
            errorCode: error.code ?? "SPAWN_ERROR",
        }));
        child.once("close", (code, killedSignal) => finish({
            ok: code === 0 && !killedSignal && !timedOut, exitCode: code,
            reason: timedOut ? "timeout" : killedSignal ? "signal" : "exit", signal: killedSignal,
        }));
    });
}
export async function artifactDirectory(root, runId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Unsafe run ID");
    const parent = path.join(await realpath(root), ".delivery-runs");
    try { if ((await lstat(parent)).isSymbolicLink()) throw new Error("Artifact symlink"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(parent, { recursive: true });
    const directory = path.join(parent, runId);
    try { if ((await lstat(directory)).isSymbolicLink()) throw new Error("Artifact symlink"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(directory, { recursive: true });
    return directory;
}
export async function readArtifact(directory, name) {
    const file = path.join(directory, name);
    try {
        if ((await lstat(file)).isSymbolicLink()) throw new Error("Artifact symlink");
        return JSON.parse(await readFile(file, "utf8"));
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export async function saveArtifact(directory, name, value, { exclusive = false } = {}) {
    const file = path.join(directory, name);
    try { if ((await lstat(file)).isSymbolicLink()) throw new Error("Artifact symlink"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (exclusive) return writeFile(file, content, { mode: 0o600, flag: "wx" });
    const staged = path.join(directory, `.${name}.${randomUUID()}.next`);
    try {
        await writeFile(staged, content, { mode: 0o600, flag: "wx" });
        await rename(staged, file);
    } finally {
        await rm(staged, { force: true });
    }
}
