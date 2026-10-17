import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { DIAGNOSTIC_ACK, digest, owns, relativePath, safePath } from "./runtime.mjs";

const exec = promisify(execFile);
export const LAB_VERSION = "azure-lab-v1";
export const LAB_ACK = "I authorize the explicitly selected nonproduction lab capabilities";
export const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const text = (value) => typeof value === "string" && value.trim().length > 0;
export const evidence = (value) => Array.isArray(value) && value.length > 0 && value.every(text);
export const hashBytes = (value) => createHash("sha256").update(value).digest("hex");
const capabilities = ["provision", "providerRegistration", "publish", "repositoryCreation", "modelTests"];
const secret = (file) => /(^|\/)(\.env(?:\.|$)|credentials?(?:\.|\/|$)|secrets?(?:\.|\/|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.(?!pub$))|node_modules(?:\/|$)|.*\.(?:pem|key|tfstate)(?:\.|$))/i.test(file);
export const id = (value) => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const covered = (scopes, file) => scopes?.some((scope) => scope === "." || owns(scope, file));
function collectionDirectory(value) {
    if (typeof value !== "string" || !value.endsWith("/*.tf") || /[*?[\]{}]/.test(value.slice(0, -5))) throw new Error("Only immediate-directory /*.tf dependency collections are supported");
    return relativePath(value.slice(0, -5));
}
function monitored(repo, file) {
    return !repo.sourceScope || repo.sourceScope.some((scope) => scope.includes("*") ?
        path.posix.dirname(file) === collectionDirectory(scope) && file.endsWith(".tf") : owns(scope, file));
}
export function terraformPolicy(args) {
    const policy = args.terraformPolicy ?? { requirement: "any", preference: "avm" };
    if (!object(policy) || !["any", "avm"].includes(policy.requirement) || !["none", "avm"].includes(policy.preference)) throw new Error("Explicit Terraform requirement/preference must be any|avm and none|avm");
    return { requirement: policy.requirement, preference: policy.preference };
}

export async function git(root, args) {
    const { stdout } = await exec("git", ["-C", root, ...args], {
        encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
}
export async function noLinks(absolute) {
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try {
            if ((await lstat(current)).isSymbolicLink()) throw new Error(`Linked path: ${current}`);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
}
export function validateLabInput(value) {
    if (!object(value) || value.schemaVersion !== 1 || value.profile !== "azure-lab" ||
        !text(value.projectRoot) || !Array.isArray(value.repositories) || !value.repositories.length ||
        !object(value.authorization) || value.authorization.acknowledgement !== LAB_ACK ||
        value.authorization.localExecution !== true || value.authorization.directSdkDispatch !== true) {
        throw new Error("Explicit Azure lab profile, roots, local execution and direct SDK authority required");
    }
    for (const name of capabilities) {
        if (typeof value.authorization[name] !== "boolean") throw new Error(`Explicit authorization.${name} required`);
    }
    if (value.execution?.shareDiagnostics !== undefined && typeof value.execution.shareDiagnostics !== "boolean") throw new Error("shareDiagnostics must be boolean");
    if (value.execution?.shareDiagnostics === true && value.execution.diagnosticsAcknowledgement !== DIAGNOSTIC_ACK) throw new Error("Sharing redacted diagnostics requires explicit acknowledgement");
    if (!id(value.target?.id) || !["dev", "test", "staging", "nonproduction"].includes(value.target.environment) ||
        typeof value.target.deploy !== "boolean" || typeof value.target.requirePublication !== "boolean") {
        throw new Error("An explicit nonproduction target and deployment/publication policy are required");
    }
    if (value.deploymentOrder !== undefined && !["provision-first", "identity-before-post-provision"].includes(value.deploymentOrder)) throw new Error("Unsupported deploymentOrder");
    if (value.deploymentOrder === "identity-before-post-provision" && !value.target.deploy) throw new Error("Identity-dependent provisioning requires deployment");
    if (value.authorization.runtimeIdentityModelAccess !== undefined && typeof value.authorization.runtimeIdentityModelAccess !== "boolean") throw new Error("runtimeIdentityModelAccess must be an explicit boolean");
    if (value.authorization.runtimeIdentityModelAccess === true && (!value.authorization.provision ||
        !value.target.deploy || value.deploymentOrder !== "identity-before-post-provision" || !value.infrastructureProfile)) throw new Error("Runtime model access requires separate authority, opt-in ordering, provisioning and an exact infrastructure profile");
    if (value.target.requirePublication && !value.authorization.publish) throw new Error("Target requires publication authority");
    const ids = new Set();
    for (const repo of value.repositories) {
        if (!object(repo) || !id(repo.id) || ids.has(repo.id) || !text(repo.path) ||
            !["read", "write", "create"].includes(repo.access)) throw new Error("Invalid repository declaration");
        ids.add(repo.id);
        if (repo.access === "create" && !value.authorization.repositoryCreation) throw new Error("Repository creation is not authorized");
        if (repo.access !== "read" && (!Array.isArray(repo.scope) || !repo.scope.length)) throw new Error("Writable repository needs exact scopes");
        for (const scope of repo.scope ?? []) {
            if (scope !== "." || repo.access !== "create") relativePath(scope);
            if (secret(scope) || /[*?[\]{}]/.test(scope)) throw new Error("Secret or wildcard write scope");
        }
        if (repo.sourceScope !== undefined) {
            if (repo.access !== "write" || !evidence(repo.sourceScope)) throw new Error("Only shared writable roots support sourceScope");
            repo.sourceScope.forEach((scope) => scope.includes("*") ? collectionDirectory(scope) : relativePath(scope));
            if (repo.scope.some((scope) => !monitored(repo, scope))) throw new Error("Every write scope must be monitored");
            if (!evidence(repo.instructionPaths)) throw new Error("Partial monitoring requires explicit owner instruction paths");
            for (const file of repo.instructionPaths) {
                relativePath(file);
                if (!monitored(repo, file)) throw new Error("Owner instructions must remain monitored");
            }
        }
    }
    validateReference(value.specification, ids);
    const specRepo = value.repositories.find((repo) => repo.id === value.specification.repository);
    if (!monitored(specRepo, value.specification.path)) throw new Error("Specification must be monitored");
    terraformPolicy(value);
    if (value.infrastructureProfile !== undefined) {
        validateReference(value.infrastructureProfile, ids);
        if (!monitored(value.repositories.find((repo) => repo.id === value.infrastructureProfile.repository), value.infrastructureProfile.path)) throw new Error("Infrastructure profile must be monitored");
    }
    if (!Array.isArray(value.acceptance) || !value.acceptance.length) throw new Error("Explicit acceptance required");
    const criteria = new Set();
    for (const criterion of value.acceptance) {
        if (!id(criterion.id) || criteria.has(criterion.id) || !text(criterion.criterion) ||
            !["local", "live", "browser", "model"].includes(criterion.level)) throw new Error("Invalid acceptance criterion");
        if (criterion.level !== "local" && !value.target.deploy) throw new Error("Live acceptance requires deployment");
        if (criterion.level === "model" && !value.authorization.modelTests) throw new Error("Paid model acceptance lacks authority");
        criteria.add(criterion.id);
    }
    for (const name of ["planning", "implementation", "repair", "recovery"]) {
        if (!Number.isSafeInteger(value.attempts?.[name]) || value.attempts[name] < (name === "repair" ? 0 : 1)) {
            throw new Error(`Explicit integer attempts.${name} required`);
        }
    }
    if (!Number.isSafeInteger(value.maxSprints) || value.maxSprints < 1) throw new Error("Explicit maxSprints required");
    for (const name of ["baseline", "test", "build"]) {
        if (!Array.isArray(value.commands?.[name]) || !value.commands[name].length) throw new Error(`commands.${name} required`);
        value.commands[name].forEach((command) => validateScript(command, value.repositories));
    }
    if (value.commands.preflight !== undefined) {
        if (!Array.isArray(value.commands.preflight) || !value.commands.preflight.length) throw new Error("preflight must name actual offline prerequisite helpers");
        value.commands.preflight.forEach((command) => validateScript(command, value.repositories));
    }
    for (const name of ["bootstrapPaths", "documentationPaths"]) {
        if (!Array.isArray(value[name]) || !value[name].length) throw new Error(`Explicit ${name} assignments required`);
        for (const assignment of value[name]) {
            const owner = value.repositories.find((repo) => repo.id === assignment.repository);
            if (!owner || owner.access === "read" || !evidence(assignment.paths)) throw new Error(`Invalid ${name} assignment`);
            for (const file of assignment.paths) {
                relativePath(file);
                if (!covered(owner.scope, file)) throw new Error(`${name} outside write authority`);
                if (value.azure?.profile?.repository === owner.id &&
                    (owns(file, value.azure.profile.path) || owns(value.azure.profile.path, file))) throw new Error("Author assignments cannot include the credential profile");
                if (name === "documentationPaths" && !/\.md$/i.test(file)) throw new Error("Closeout requires exact Markdown files, not broad source directories");
            }
        }
    }
    if (!object(value.azure) || !text(value.azure.subscriptionId) || !text(value.azure.tenantId) ||
        !text(value.azure.region)) throw new Error("Explicit Azure subscription/tenant/region required");
    validateReference(value.azure.profile, ids);
    const profileRepo = value.repositories.find((repo) => repo.id === value.azure.profile.repository);
    if (profileRepo.scope?.some((scope) => scope !== "." &&
        (owns(scope, value.azure.profile.path) || owns(value.azure.profile.path, scope)))) throw new Error("Azure credential profile cannot overlap write scope");
    if (!Array.isArray(value.azure.providers) || new Set(value.azure.providers).size !== value.azure.providers.length ||
        value.azure.providers.some((name) => !/^Microsoft\.[A-Za-z0-9]+$/.test(name))) throw new Error("Exact Azure provider ceiling required");
    if (value.azure.providers.length && !value.authorization.providerRegistration) throw new Error("Provider registration lacks authority");
    for (const model of value.azure.models ?? []) {
        if (![model.name, model.version, model.sku, model.unit].every(text) ||
            !Number.isSafeInteger(model.requiredCapacity) || model.requiredCapacity < 1) throw new Error("Exact numeric model sizing required");
    }
    if (value.publication !== undefined) {
        const publication = value.publication;
        if (!value.authorization.publish || !ids.has(publication.repository) ||
            !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(publication.github) ||
            !["private", "public"].includes(publication.visibility) ||
            !text(publication.branch) || typeof publication.tagRequired !== "boolean" ||
            typeof publication.create !== "boolean") throw new Error("Exact publication target/branch/visibility required");
        if (value.repositories.find((repo) => repo.id === publication.repository).access === "read") throw new Error("Publication cannot mutate a read-only repository");
        if (publication.create && !value.authorization.repositoryCreation) throw new Error("GitHub repository creation lacks authority");
        if (publication.includeInitialDirtyPaths !== undefined) {
            if (!Array.isArray(publication.includeInitialDirtyPaths)) throw new Error("Exact initially dirty publication paths required");
            const repo = value.repositories.find((item) => item.id === publication.repository);
            for (const file of publication.includeInitialDirtyPaths) {
                relativePath(file);
                if (!covered(repo.scope, file)) throw new Error("Initially dirty publication grant exceeds write scope");
            }
        }
    } else if (value.authorization.publish) throw new Error("Publication grant requires exact target");
    for (const contract of value.ownerContracts ?? []) {
        validateReference(contract, ids);
        if (!evidence(contract.sourcePaths) || !evidence(contract.addressPrefixes) || !evidence(contract.resourceTypes) || !text(contract.stateOwner) ||
            !text(contract.subscriptionId) || !text(contract.tenantId) ||
            !Array.isArray(contract.actions) || contract.actions.some((action) => !["create", "update"].includes(action)) ||
            !contract.actions.length) throw new Error("Exact additive/update owner contract required; destructive changes excluded");
        contract.sourcePaths.forEach(relativePath);
        const owner = value.repositories.find((repo) => repo.id === contract.repository);
        if (!monitored(owner, contract.path)) throw new Error("Owner contract must remain monitored");
        if (contract.sourcePaths.some((file) => !covered(owner.scope, file))) throw new Error("Owner contract source exceeds write scope");
    }
    return value;
}
export function validateReference(reference, ids) {
    if (!object(reference) || !ids.has(reference.repository)) throw new Error("Unknown repository reference");
    relativePath(reference.path);
}
export function validateScript(value, repositories) {
    const repo = repositories.find((item) => item.id === value?.repository);
    if (!repo || !object(value) || !text(value.executable) ||
        !["node", "node.exe", "pwsh", "pwsh.exe", "python", "python.exe", "python3"].includes(path.basename(value.executable).toLowerCase()) ||
        !Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string" || /[\x00-\x1f]/.test(arg)) ||
        !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || !text(value.cwd)) throw new Error("Reviewed native script command required");
    relativePath(value.script);
    if (secret(value.script) || owns(".azure", value.script)) throw new Error("Command entry cannot be hidden in secret/evidence paths");
    if (repo.privatePaths?.some((owner) => owns(owner, value.script))) throw new Error("Credential profile cannot contain executable source");
    if (value.cwd !== ".") relativePath(value.cwd);
    if (!Array.isArray(value.dependencies)) throw new Error("Declare script dependency closure explicitly");
    if (!monitored(repo, value.script)) throw new Error("Command entry must be monitored");
    for (const dependency of value.dependencies) {
        const owner = repositories.find((item) => item.id === dependency.repository);
        if (!owner || Boolean(dependency.path) === Boolean(dependency.collection)) throw new Error("Dependency requires exactly one file path or constrained collection");
        const file = dependency.collection ? collectionDirectory(dependency.collection) : relativePath(dependency.path);
        if (secret(file) || owns(".azure", file)) throw new Error("Command dependencies cannot be hidden in secret/evidence paths");
        if (owner.privatePaths?.some((item) => owns(item, file) || (dependency.collection && owns(file, item)))) throw new Error("Credential profile is not a script dependency");
        if (dependency.collection) {
            if (owner.sourceScope && !owner.sourceScope.some((scope) => scope === dependency.collection || (!scope.includes("*") && owns(scope, file)))) throw new Error("Dependency collection must remain monitored, including future additions");
        } else if (!monitored(owner, file)) throw new Error("Command dependency must be monitored");
    }
    return value;
}
export async function resolveRoots(args) {
    const projectRoot = path.resolve(args.projectRoot);
    await noLinks(projectRoot);
    const canonical = await realpath(projectRoot);
    const roots = new Map();
    for (const repo of args.repositories) {
        const absolute = path.resolve(canonical, repo.path);
        await noLinks(absolute);
        let identity = null, gitReady = false;
        try {
            const stat = await lstat(absolute);
            if (!stat.isDirectory()) throw new Error("Repository is not a directory");
            if (repo.access !== "create" || (await readdir(absolute)).length) {
                const top = (await git(absolute, ["rev-parse", "--show-toplevel"])).trim();
                if ((await realpath(top)).toLowerCase() !== (await realpath(absolute)).toLowerCase()) throw new Error("Not an exact Git root");
                gitReady = true;
            }
            identity = { dev: stat.dev, ino: stat.ino };
        } catch (error) { if (error.code !== "ENOENT" || repo.access !== "create") throw error; }
        roots.set(repo.id, {
            ...repo, absolute, identity, gitReady,
            privatePaths: repo.id === args.azure.profile.repository ? [args.azure.profile.path] : [],
        });
    }
    const all = [...roots.values()];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const a = all[i].absolute.toLowerCase(), b = all[j].absolute.toLowerCase();
        if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) throw new Error("Repository roots must be disjoint");
    }
    if (!all.some((repo) => repo.absolute.toLowerCase() === canonical.toLowerCase())) throw new Error("projectRoot must be a declared Git root");
    return { projectRoot: canonical, roots };
}
export async function revalidateRoots(roots) {
    for (const repo of roots.values()) {
        await noLinks(repo.absolute);
        try {
            const stat = await lstat(repo.absolute);
            if (repo.identity && (stat.dev !== repo.identity.dev || stat.ino !== repo.identity.ino)) throw new Error(`Root identity changed: ${repo.id}`);
            if (repo.gitReady) {
                const top = (await git(repo.absolute, ["rev-parse", "--show-toplevel"])).trim();
                if ((await realpath(top)).toLowerCase() !== repo.absolute.toLowerCase()) throw new Error("Git root changed");
            }
        } catch (error) { if (error.code !== "ENOENT" || repo.identity) throw error; }
    }
}
export async function sourceCensus(roots) {
    await revalidateRoots(roots);
    const result = {};
    for (const repo of roots.values()) {
        const files = {};
        result[repo.id] = files;
        if (!repo.gitReady) {
            if (await exists(repo.absolute) && (await readdir(repo.absolute)).length) throw new Error("Uninitialized root contains unadmitted files");
            continue;
        }
        const names = (await git(repo.absolute, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
        for (const name of [...new Set(names)].sort()) {
            if (owns(".delivery-runs", name) || secret(name) || /^\.azure\//i.test(name) ||
                repo.privatePaths?.some((owner) => owns(owner, name))) continue;
            if (!monitored(repo, name)) continue;
            const absolute = path.join(repo.absolute, ...name.split("/"));
            await noLinks(absolute);
            try {
                if (!(await lstat(absolute)).isFile()) throw new Error("Non-file Git source");
                files[name] = hashBytes(await readFile(absolute));
            } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
    }
    return result;
}
async function exists(file) {
    try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
export function assertScopedChanges(before, after, roots, assignments) {
    for (const repo of roots.values()) {
        for (const file of new Set([...Object.keys(before[repo.id] ?? {}), ...Object.keys(after[repo.id] ?? {})])) {
            if (before[repo.id]?.[file] === after[repo.id]?.[file]) continue;
            const scopes = assignments ? assignments.filter((item) => item.repository === repo.id).flatMap((item) => item.paths) : repo.scope;
            if (repo.access === "read" || !covered(scopes, file)) throw new Error(`Out-of-scope change: ${repo.id}:${file}; attribution unknown`);
        }
    }
}
export async function readReference(roots, reference) {
    const repo = roots.get(reference.repository);
    if (!repo) throw new Error("Unknown reference root");
    if (repo.privatePaths?.some((owner) => owns(owner, reference.path))) throw new Error("Credential profile is not readable source");
    return readFile(await safePath(repo.absolute, reference.path), "utf8");
}
export async function scriptBinding(spec, roots) {
    validateScript(spec, [...roots.values()]);
    const files = [], collections = [], references = [{ repository: spec.repository, path: spec.script }];
    for (const dependency of spec.dependencies) {
        if (!dependency.collection) { references.push(dependency); continue; }
        const repo = roots.get(dependency.repository), directory = collectionDirectory(dependency.collection);
        const absolute = await safePath(repo.absolute, directory);
        await noLinks(absolute);
        const members = (await readdir(absolute)).filter((name) => name.endsWith(".tf")).sort().map((name) => `${directory}/${name}`);
        if (!members.length) throw new Error("Dependency collection is empty");
        collections.push({ ...dependency, members });
        references.push(...members.map((file) => ({ repository: dependency.repository, path: file })));
    }
    for (const reference of references) {
        const repo = roots.get(reference.repository);
        if (secret(reference.path) || repo.privatePaths?.some((owner) => owns(owner, reference.path))) throw new Error("Private file in dependency collection");
        const absolute = await safePath(repo.absolute, reference.path);
        const stat = await lstat(absolute);
        if (!stat.isFile()) throw new Error("Script dependencies must be explicit files");
        const ignored = await git(repo.absolute, ["ls-files", "--cached", "--others", "--exclude-standard", "--", reference.path]);
        if (!ignored.split(/\r?\n/).includes(reference.path)) throw new Error("Command dependency is ignored or unmonitored");
        files.push({ ...reference, sha256: hashBytes(await readFile(absolute)) });
    }
    return { spec, files, collections };
}
export function nativeCommand(spec) {
    const engine = path.basename(spec.executable).toLowerCase();
    const script = path.relative(spec.cwd, spec.script).replaceAll("\\", "/");
    const args = engine.startsWith("pwsh") ? ["-NoProfile", "-NonInteractive", "-File", script] :
        engine.startsWith("python") ? ["-I", script] : [script];
    return { executable: spec.executable, args: [...args, ...spec.args], cwd: spec.cwd, timeoutMs: spec.timeoutMs };
}
export function validateReleasePlan(plan, args) {
    if (digest(plan.terraformPolicy) !== digest(terraformPolicy(args))) throw new Error("Release requirements changed the configured Terraform requirement/preference");
    if (!Array.isArray(plan.sprints) || !plan.sprints.length || plan.sprints.length > args.maxSprints) throw new Error("Finite release sprints required");
    const seen = new Set(), coverage = new Set();
    for (const sprint of plan.sprints) {
        if (!id(sprint.id) || seen.has(sprint.id) || !text(sprint.goal) || !evidence(sprint.requirementIds)) throw new Error("Invalid sprint");
        seen.add(sprint.id);
        for (const requirement of sprint.requirementIds) {
            if (!args.acceptance.some((item) => item.id === requirement)) throw new Error("Sprint expanded authorized requirements");
            coverage.add(requirement);
        }
    }
    if (coverage.size !== args.acceptance.length) throw new Error("Release plan omits acceptance criteria");
}
export function validateTasks(plan, args, sprint) {
    if (!Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error("Sprint assignments required");
    const ids = new Set(), assignments = [];
    for (const task of plan.tasks) {
        const repo = args.repositories.find((item) => item.id === task.repository);
        if (!id(task.id) || ids.has(task.id) || !repo || repo.access === "read" ||
            !["ui", "developer", "designer", "devops"].includes(task.kind) ||
            !evidence(task.paths) || !Array.isArray(task.dependsOn) || !evidence(task.requirementIds) ||
            task.requirementIds.some((item) => !sprint.requirementIds.includes(item))) throw new Error("Unassigned/invalid sprint task");
        ids.add(task.id);
        for (const file of task.paths) {
            relativePath(file);
            if (secret(file) || owns(".azure", file) || (args.azure.profile.repository === task.repository &&
                (owns(file, args.azure.profile.path) || owns(args.azure.profile.path, file)))) throw new Error("Task cannot write credentials or private execution evidence");
            if (!covered(repo.scope, file)) throw new Error("Task outside authorized scope");
            for (const prior of assignments) if (prior.repository === task.repository && (owns(prior.path, file) || owns(file, prior.path))) throw new Error("Task write scopes overlap");
            assignments.push({ repository: task.repository, path: file });
        }
    }
    const layers = [], done = new Set();
    while (done.size < plan.tasks.length) {
        const ready = plan.tasks.filter((task) => !done.has(task.id) && task.dependsOn.every((dependency) => done.has(dependency)));
        if (!ready.length) throw new Error("Task dependency cycle or missing dependency");
        layers.push(ready);
        ready.forEach((task) => done.add(task.id));
    }
    for (const requirement of sprint.requirementIds) if (!plan.tasks.some((task) => task.requirementIds.includes(requirement))) throw new Error("Unassigned sprint requirement");
    return layers;
}
export function validateNativePlan(plan, ownership, contracts = [], { canonical = false, runtimeAccess = null } = {}) {
    if (!object(plan) || !Array.isArray(plan.resource_changes) || plan.errored === true ||
        plan.deferred_changes?.length || plan.resource_drift?.length) throw new Error("Incomplete/deferred native plan");
    for (const item of plan.resource_changes) {
        const actions = item.change?.actions;
        if (!Array.isArray(actions) || !["create", "read", "no-op", "update"].includes(actions.join(",")) ||
            item.change.importing || item.previous_address) throw new Error("Destructive/replacement/import/move/unknown plan action");
        if (actions.every((action) => ["read", "no-op"].includes(action))) continue;
        validateRuntimeRoleAssignment(item, runtimeAccess);
        if (!text(item.address) || !text(item.type)) throw new Error("Missing native resource identity");
        const contract = contracts.find((entry) => entry.addressPrefixes.some((prefix) => item.address.startsWith(prefix)));
        if (ownership.shared && !contract) throw new Error("Shared-state resource lacks owner authority");
        if (contract && (contract.stateOwner !== ownership.stateOwner || contract.subscriptionId !== ownership.subscriptionId ||
            contract.tenantId !== ownership.tenantId || actions.some((action) => !contract.actions.includes(action)))) throw new Error("Plan exceeds owner-approved contract");
        if (!canonical && contract && !contract.resourceTypes?.includes(item.type)) throw new Error("Plan resource type exceeds owner-approved contract");
        for (const region of [item.change.before?.location, item.change.after?.location].filter(text)) {
            if (region.toLowerCase().replaceAll(" ", "") !== ownership.region.toLowerCase().replaceAll(" ", "")) throw new Error("Native resource location differs from admitted owner region");
        }
    }
}
export async function freezeInfrastructurePolicy(args, roots, contracts) {
    if (!args.infrastructureProfile) throw new Error("Provisioning requires an adopter-owned infrastructureProfile and reviewed canonical semantic guard");
    const content = await readReference(roots, args.infrastructureProfile), profile = JSON.parse(content);
    if (!object(profile) || !object(profile.policy) || !object(profile.metadata)) throw new Error("Infrastructure profile requires immutable policy and separately finalizable metadata objects");
    return {
        terraform: terraformPolicy(args),
        profile: { ...args.infrastructureProfile, sha256: hashBytes(content) },
        rules: profile.policy, metadata: profile.metadata, ownerContracts: contracts,
    };
}
export function cumulativeAddresses(priorAdmissions, current, stateOwner) {
    const addresses = new Set();
    for (const admission of priorAdmissions) for (const plan of admission.plans) {
        for (const item of plan.summary) if (item.actions.some((action) => ["create", "update"].includes(action))) addresses.add(`${plan.ownership.stateOwner}:${item.address}`);
    }
    for (const item of current.resource_changes) if (item.change.actions.some((action) => ["create", "update"].includes(action))) addresses.add(`${stateOwner}:${item.address}`);
    return [...addresses].sort();
}
export function validateCanonicalGuard(guard, hashes, owner, binding, policy, addresses, runtimeIdentity = null, runtimeAccess = null) {
    if (!object(guard) || guard.version !== 2 || guard.status !== "PASS" ||
        guard.binaryHash !== hashes.binary || guard.jsonHash !== hashes.json ||
        guard.stateOwner !== owner.stateOwner || guard.subscriptionId !== owner.subscriptionId ||
        guard.tenantId !== owner.tenantId || !evidence(guard.evidence) ||
        guard.sourceFingerprint !== binding.sourceFingerprint ||
        guard.policyIdentity !== digest(policy)) throw new Error("Canonical saved-plan/accepted-policy guard failed");
    if (!object(guard.binding) || Object.entries(binding).some(([name, value]) => guard.binding[name] !== value)) throw new Error("Native plan guard is not bound to this exact sprint/build/revision/stage");
    for (const name of ["resourceSemantics", "parentIds", "remoteIds", "permittedProperties", "dependencyClosure", "cumulativeScope", "terraformPolicy", "acceptedMetadata"]) {
        if (guard.checks?.[name]?.pass !== true || !evidence(guard.checks[name].evidence)) throw new Error(`Canonical semantic guard omitted ${name} evidence`);
    }
    if (!Array.isArray(guard.scope?.addresses) || digest(guard.scope.addresses) !== digest(addresses) ||
        guard.scope.count !== addresses.length) throw new Error("Canonical cumulative scope omits or changes actual prior/current mutation addresses");
    if (runtimeIdentity && guard.runtimeIdentityHash !== runtimeIdentity.evidenceHash) throw new Error("Canonical guard is not bound to the deployment-observed runtime identity");
    if (runtimeAccess && (guard.checks?.runtimeIdentityModelAccess?.pass !== true ||
        !evidence(guard.checks.runtimeIdentityModelAccess.evidence))) throw new Error("Canonical guard omitted exact runtime model-access evidence");
}
export function validateProvisionPhases(stages, args) {
    let after = false;
    for (const stage of stages) {
        const phase = stage.phase ?? "before-deploy";
        if (!["before-deploy", "after-deploy"].includes(phase)) throw new Error("Unknown provisioning phase");
        if (phase === "after-deploy") {
            if (args.deploymentOrder !== "identity-before-post-provision" || !args.target.deploy) throw new Error("Post-deployment Terraform requires explicit identity-before-post-provision ordering");
            after = true;
        } else if (after) throw new Error("All before-deploy Terraform stages must precede after-deploy stages");
    }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sameArmId = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export function runtimeAccessPolicy(args, rules) {
    if (args.authorization.runtimeIdentityModelAccess !== true) return null;
    const policy = rules?.runtimeIdentityModelAccess;
    if (!object(policy) || !text(policy.deploymentResourceId) || /[\x00-\x1f]/.test(policy.deploymentResourceId) ||
        !Array.isArray(policy.assignments) || !policy.assignments.length) throw new Error("Exact deployment target and model role assignments required");
    const seen = new Set();
    for (const assignment of policy.assignments) {
        const parts = typeof assignment.scope === "string" ? assignment.scope.split("/") : [];
        const role = typeof assignment.roleDefinitionId === "string" ?
            assignment.roleDefinitionId.match(/^(?:\/subscriptions\/([^/]+))?\/providers\/Microsoft\.Authorization\/roleDefinitions\/([^/]+)$/i) : null;
        if (parts[0] !== "" || parts[1]?.toLowerCase() !== "subscriptions" ||
            !sameArmId(parts[2], args.azure.subscriptionId) || parts[3]?.toLowerCase() !== "resourcegroups" ||
            parts[5]?.toLowerCase() !== "providers" || parts.length < 9 || parts.length % 2 !== 1 ||
            parts.slice(1).some((part) => !part || /[\\?#%\s]/.test(part) || [".", ".."].includes(part)) ||
            !role || !uuid.test(role[2]) || (role[1] && !sameArmId(role[1], args.azure.subscriptionId))) throw new Error("Model access must name exact resource scopes and role-definition IDs in the authorized subscription");
        const key = `${assignment.scope}:${assignment.roleDefinitionId}`.toLowerCase();
        if (seen.has(key)) throw new Error("Duplicate runtime model-access assignment");
        seen.add(key);
    }
    return policy;
}
export function validateRuntimeIdentity(value, args, accessPolicy = null) {
    if (!object(value) || !uuid.test(value.principalId) || !text(value.resourceId) ||
        value.subscriptionId !== args.azure.subscriptionId || value.tenantId !== args.azure.tenantId ||
        !evidence(value.evidence) || (accessPolicy && value.resourceId !== accessPolicy.deploymentResourceId)) throw new Error("Actual runtime identity must match the exact deployed target, subscription and tenant");
    return {
        principalId: value.principalId.toLowerCase(), resourceId: value.resourceId,
        subscriptionId: value.subscriptionId, tenantId: value.tenantId, evidence: [...value.evidence],
    };
}
function validateRuntimeRoleAssignment(item, access) {
    const after = item.change.after;
    const armType = typeof after?.type === "string" ? after.type.split("@")[0].toLowerCase() : "";
    const azureRm = item.type === "azurerm_role_assignment";
    const azApi = item.type?.startsWith("azapi_") && armType === "microsoft.authorization/roleassignments";
    if (!azureRm && !azApi) return;
    if (!access || access.phase !== "after-deploy" || item.change.actions.join(",") !== "create") throw new Error("Role assignments require separately authorized post-deployment runtime model access; updates are prohibited");
    let scope, principal, role, principalType;
    if (azureRm) {
        const permitted = new Set(["scope", "principal_id", "principal_type", "role_definition_id", "id", "name", "description", "skip_service_principal_aad_check",
            "role_definition_name", "condition", "condition_version", "delegated_managed_identity_resource_id"]);
        if (!object(after) || Object.keys(after).some((name) => !permitted.has(name)) ||
            ["role_definition_name", "condition", "condition_version", "delegated_managed_identity_resource_id"].some((name) => after[name] !== undefined && after[name] !== null && after[name] !== "")) throw new Error("Conditional, delegated or unspecified role assignment properties are prohibited");
        ({ scope, principal_id: principal, role_definition_id: role, principal_type: principalType } = after);
    } else {
        const body = typeof after.body === "string" ? JSON.parse(after.body) : after.body;
        const properties = body?.properties;
        if (!object(body) || Object.keys(body).some((name) => name !== "properties") ||
            !object(properties) || Object.keys(properties).some((name) => !["principalId", "principalType", "roleDefinitionId", "description"].includes(name))) throw new Error("Conditional, delegated or unspecified AzAPI role assignment properties are prohibited");
        scope = after.parent_id;
        ({ principalId: principal, roleDefinitionId: role, principalType } = properties);
    }
    if (principalType !== "ServicePrincipal" || !sameArmId(principal, access.identity.principalId) ||
        !access.policy.assignments.some((assignment) => sameArmId(scope, assignment.scope) && sameArmId(role, assignment.roleDefinitionId))) throw new Error("Role assignment exceeds the observed runtime principal or exact approved model scope/role");
}
export function validateOrigin(value) {
    if (!text(value) || !/^https:\/\/[^/?#@\s]+$/.test(value)) throw new Error("Actual HTTPS authority-only origin required");
    const parsed = new URL(value), host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (parsed.username || parsed.password || host === "localhost" || host.endsWith(".localhost") ||
        /^127\./.test(host) || ["0.0.0.0", "[::]", "[::1]"].includes(host) || host.startsWith("[::ffff:")) throw new Error("Origin cannot contain loopback or credentials");
    return value;
}
export function validateCoverage(artifact, acceptance, { allowBlocked = false } = {}) {
    if (!Array.isArray(artifact.coverage) || artifact.coverage.length !== acceptance.length) throw new Error("Exact criterion coverage required");
    const seen = new Set();
    for (const item of artifact.coverage) {
        if (!acceptance.some((criterion) => criterion.id === item.id) || seen.has(item.id) ||
            !(allowBlocked ? ["verified", "blocked"] : ["verified"]).includes(item.status) ||
            !evidence(item.evidence)) throw new Error("Missing/blocked/duplicate acceptance evidence");
        seen.add(item.id);
    }
}
export function validateCapacityObservation(artifact, models, started = []) {
    if (!Array.isArray(artifact?.models) || artifact.models.length !== models.length) throw new Error("Missing numeric model capacity");
    for (const model of models) {
        const observation = artifact.models.find((item) => item.name === model.name);
        if (!observation || ["name", "version", "sku", "unit", "requiredCapacity"].some((name) => observation[name] !== model[name]) ||
            !Number.isFinite(observation.availableCapacity) || observation.availableCapacity < 0 || observation.supported !== true) throw new Error("Unknown/unsupported/substituted model capacity");
        const allocated = observation.allocatedCapacity ?? 0;
        if (!Number.isFinite(allocated) || allocated < 0) throw new Error("Unknown allocated model capacity");
        if (allocated && (!evidence(observation.allocationEvidence) || !started.some((operation) =>
            operation.binding.revision === observation.allocationRevision && operation.binding.planIdentity === observation.planIdentity))) throw new Error("Allocated capacity lacks exact same-run started-plan proof");
        if (observation.availableCapacity + allocated < model.requiredCapacity) throw new Error("Insufficient exact model capacity");
    }
}
