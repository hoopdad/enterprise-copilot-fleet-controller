import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { artifactDirectory, digest, readArtifact, redactDiagnostics, runCommand, saveArtifact } from "./runtime.mjs";
import {
    LAB_VERSION, evidence, freezeInfrastructurePolicy, hashBytes, nativeCommand, noLinks, readReference, resolveRoots,
    scriptBinding, sourceCensus, terraformPolicy, validateLabInput,
    runtimeAccessPolicy,
} from "./lab-policy.mjs";
import { acquireWorkspace } from "./lab-executor.mjs";
import { cleanupOwnedScratch, createScratch, withScratch } from "./lab-scratch.mjs";
import { recheckPlans, recheckRuntimeIdentityPin } from "./lab-workflow.mjs";

async function nativeBoundary(root, scratch, runId, sourceFingerprint) {
    return withScratch(async (child) => {
        const output = path.join(child, "environment.json"), script = path.join(child, "environment.mjs");
        const environment = {
            DELIVERY_TARGET: "offline-boundary", DELIVERY_RUN_ID: runId,
            DELIVERY_SOURCE_FINGERPRINT: sourceFingerprint, DELIVERY_BUILD_FINGERPRINT: "offline-build",
            AZURE_CONFIG_DIR: path.join(child, "unused-profile"), DELIVERY_REGION: "offline-region",
            DELIVERY_SUBSCRIPTION_ID: "offline-subscription", DELIVERY_REVISION: "offline-revision",
            DELIVERY_WEB_ORIGIN: "https://offline.invalid", DELIVERY_PROVISION_STAGE: "offline-stage",
            DELIVERY_PROVISION_STAGE_INDEX: "0", DELIVERY_PLAN_EVIDENCE: path.join(child, "saved-plan.bin"),
            DELIVERY_PLAN_IDENTITY: "offline-plan", DELIVERY_PLAN_AGGREGATE: "offline-aggregate",
            DELIVERY_TENANT_ID: "offline-tenant", DELIVERY_OPERATION_ID: "offline-operation",
            DELIVERY_EVIDENCE_PATH: output, DELIVERY_SPRINT_ID: "offline-sprint",
            DELIVERY_EVIDENCE_DIRECTORY: scratch, DELIVERY_PLAN_CONTEXT: path.join(child, "policy.json"),
        };
        await writeFile(script,
            `import {writeFile} from "node:fs/promises";\n` +
            `const names=${JSON.stringify(Object.keys(environment))};\n` +
            `await writeFile(process.env.DELIVERY_EVIDENCE_PATH,JSON.stringify({values:Object.fromEntries(names.map(n=>[n,process.env[n]])),credentialPresent:Object.keys(process.env).some(n=>/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE.?KEY|CONNECTION.?STRING/i.test(n))}));\n`,
            { flag: "wx", mode: 0o600 });
        const outcome = await runCommand(root, { executable: process.execPath, args: [script], cwd: ".", timeoutMs: 30000 }, undefined,
            { environment: { ...environment, DELIVERY_PRIVATE_KEY: "must-not-be-forwarded" } });
        if (!outcome.ok) throw new Error("Offline native environment probe failed");
        const actual = JSON.parse(await readFile(output, "utf8"));
        if (actual.credentialPresent || Object.entries(environment).some(([name, value]) => actual.values[name] !== value)) throw new Error("Native environment propagation or credential filtering failed");
        return { variables: Object.keys(environment), stageIndex: actual.values.DELIVERY_PROVISION_STAGE_INDEX };
    }, scratch);
}

async function scratchBoundary(scratch) {
    const sentinel = path.join(scratch, `unrelated-${randomUUID()}.txt`);
    let failedChild;
    await writeFile(sentinel, "preserve", { flag: "wx" });
    try {
        await withScratch(async (child) => { await writeFile(path.join(child, "fixture.txt"), "owned"); }, scratch);
        try {
            await withScratch(async (child) => {
                failedChild = child;
                await writeFile(path.join(child, "fixture.txt"), "owned");
                throw new Error("Expected offline scratch failure");
            }, scratch);
            throw new Error("Scratch failure probe unexpectedly returned");
        } catch (error) { if (error.message !== "Expected offline scratch failure") throw error; }
        try { await lstat(failedChild); throw new Error("Failed helper scratch was not cleaned"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (await readFile(sentinel, "utf8") !== "preserve") throw new Error("Unrelated scratch file changed");
        return { ownedCleanup: true, failureCleanup: true, unrelatedPreserved: true };
    } finally { await rm(sentinel, { force: true }); }
}

function commandsIn(value, result = []) {
    if (Array.isArray(value)) { for (const child of value) commandsIn(child, result); }
    else if (value && typeof value === "object") {
        if (value.executable && value.script) result.push(value);
        else for (const child of Object.values(value)) commandsIn(child, result);
    }
    return result;
}

async function checkResume(runId, projectRoot, roots, args, census, ledger) {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid resume run ID");
    const directory = path.join(projectRoot, ".delivery-runs", runId);
    await noLinks(directory);
    const state = await readArtifact(directory, "lab-state.json");
    if (!state) throw new Error("No retained workflow state for offline resume check");
    const contracts = [];
    for (const reference of args.ownerContracts ?? []) contracts.push({ ...reference, content: await readReference(roots, reference) });
    const identity = digest({
        version: LAB_VERSION, args, spec: await readReference(roots, args.specification), contracts,
        infrastructureCeiling: args.infrastructureProfile ? (await freezeInfrastructurePolicy(args, roots, contracts)).rules : null,
        roots: [...roots.values()].map(({ id, absolute }) => ({ id, absolute })),
    });
    if (state.identity !== identity || (state.accepted && digest(state.accepted) !== digest(census))) throw new Error("Resume input or accepted source identity changed");
    for (const previous of state.roots) if (previous.identity && digest(previous.identity) !== digest(roots.get(previous.id)?.identity)) throw new Error("Resume physical root identity changed");
    for (const [name, hash] of Object.entries(state.retained ?? {})) {
        if (!/^retained-[a-f0-9]{64}\.bin$/.test(name) || name !== `retained-${hash}.bin`) throw new Error("Invalid retained snapshot identity");
        const file = path.join(directory, name);
        await noLinks(file);
        if (hashBytes(await readFile(file)) !== hash) throw new Error("Retained build/plan snapshot changed");
    }
    let plans = 0;
    for (const [sprintId, sprint] of Object.entries(state.sprints)) {
        if (sprint.runtimeIdentity) await recheckRuntimeIdentityPin(sprint.runtimeIdentity, directory, args,
            runtimeAccessPolicy(args, sprint.infrastructurePolicy?.rules));
        const admitted = (sprint.admissions ?? []).flatMap((item) => item.plans);
        await recheckPlans(admitted, roots, { archiveDirectory: directory });
        if (!state.completedSprints.includes(sprintId)) await recheckPlans(admitted, roots);
        plans += admitted.length;
    }
    return {
        state, report: {
            status: "retained-inputs-valid", plans,
            pendingOperations: ledger.operations.filter((item) => item.runId === runId &&
                ["admitted", "started", "unknown"].includes(item.state)).map(({ id, state: status }) => ({ id, state: status })),
            effects: "Not observed offline; the workflow must positively reconcile original effects before progressing",
        },
    };
}

export async function runOfflineCheck({ input, runId = `offline-${randomUUID()}`, resumeRunId } = {}) {
    const validated = validateLabInput(input), args = { ...validated, terraformPolicy: terraformPolicy(validated) };
    if (!args.commands.preflight?.length) throw new Error("Standalone offline check requires explicit reviewed commands.preflight helpers");
    const { projectRoot, roots } = await resolveRoots(args);
    const directory = await artifactDirectory(projectRoot, runId), workspace = await acquireWorkspace(projectRoot, runId);
    let scratch;
    try {
        scratch = await createScratch(directory);
        const census = await sourceCensus(roots), sourceFingerprint = digest(census);
        const resumed = resumeRunId ? await checkResume(resumeRunId, projectRoot, roots, args, census, workspace.ledger) : null;
        const allCommands = commandsIn([args.commands, resumed?.state.bootstrapScripts,
            Object.values(resumed?.state.sprints ?? {}).map((sprint) => sprint.artifacts)]);
        const inventory = [];
        for (const command of allCommands) inventory.push(await scriptBinding(command, roots));
        const environment = await nativeBoundary(projectRoot, scratch, runId, sourceFingerprint);
        const ownership = await scratchBoundary(scratch);
        for (const [index, command] of args.commands.preflight.entries()) {
            const binding = await scriptBinding(command, roots);
            const evidencePath = path.join(directory, `prerequisite-${index}.json`);
            const inventoryPath = path.join(directory, `inventory-${index}.json`);
            await saveArtifact(directory, `inventory-${index}.json`, binding);
            const outcome = await runCommand(roots.get(command.repository).absolute, nativeCommand(command), undefined, {
                environment: {
                    ...Object.fromEntries(environment.variables.map((name) => [name, ""])),
                    DELIVERY_TARGET: args.target.id, DELIVERY_RUN_ID: runId, DELIVERY_SOURCE_FINGERPRINT: sourceFingerprint,
                    DELIVERY_REGION: args.azure.region, DELIVERY_SUBSCRIPTION_ID: args.azure.subscriptionId,
                    DELIVERY_TENANT_ID: args.azure.tenantId, DELIVERY_EVIDENCE_PATH: evidencePath,
                    DELIVERY_EVIDENCE_DIRECTORY: scratch, DELIVERY_PLAN_CONTEXT: inventoryPath,
                    DELIVERY_OPERATION_ID: `offline-prerequisite-${index}`,
                    AZURE_CONFIG_DIR: path.join(roots.get(args.azure.profile.repository).absolute, ...args.azure.profile.path.split("/")),
                },
            });
            const receipt = await readArtifact(directory, `prerequisite-${index}.json`);
            if (!outcome.ok || receipt?.status !== "PASS" || receipt.binding?.runId !== runId ||
                receipt.binding?.sourceFingerprint !== sourceFingerprint || !evidence(receipt.evidence) ||
                receipt.data?.offline !== true || ["prerequisites", "dependencyInventory", "scratchOwnership"].some((name) => receipt.data?.checks?.[name] !== true)) {
                throw new Error(`Canonical offline prerequisite helper ${index} failed or omitted actual evidence`);
            }
            const keys = (files) => files.map(({ repository, path: file }) => `${repository}:${file}`).sort();
            if (!Array.isArray(receipt.data.consumedSources) ||
                digest(keys(receipt.data.consumedSources)) !== digest(keys(binding.files))) throw new Error("Actual consumed dependency inventory differs from declared monitored files");
            if (digest(await scriptBinding(command, roots)) !== digest(binding) || digest(await sourceCensus(roots)) !== sourceFingerprint) throw new Error("Offline helper changed monitored source/dependency membership");
        }
        const report = { status: "PASS", kind: "offline-integration", runId, inventory, environment, scratch: ownership, resume: resumed?.report ?? null,
            liveDeployment: "Not exercised; offline integration does not certify Azure or model execution" };
        await saveArtifact(directory, "offline-check.json", report);
        return report;
    } catch (error) {
        await saveArtifact(directory, "offline-check.json", { status: "FAIL", kind: "offline-integration", reason: redactDiagnostics(error.message) });
        throw error;
    } finally {
        try { if (scratch) await cleanupOwnedScratch(scratch); }
        finally { await workspace.release(); }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [file, flag, resumeRunId, ...extra] = process.argv.slice(2);
        if (!file || extra.length || (flag !== undefined && (flag !== "--resume" || !resumeRunId))) throw new Error("Usage: node lab-preflight.mjs INPUT.json [--resume RUN-ID]");
        const result = await runOfflineCheck({ input: JSON.parse(await readFile(path.resolve(file), "utf8")), resumeRunId });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${redactDiagnostics(error.message)}\n`);
        process.exitCode = 1;
    }
}
