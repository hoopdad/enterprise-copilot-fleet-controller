import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
    digest, readArtifact, saveArtifact, runCommand, redactDiagnostics,
} from "./runtime.mjs";
import {
    git, hashBytes, nativeCommand, noLinks, revalidateRoots, scriptBinding, sourceCensus,
} from "./lab-policy.mjs";
import { cleanupOwnedScratch, createScratch, validateScratch } from "./lab-scratch.mjs";

export async function acquireWorkspace(projectRoot, runId) {
    const directory = path.join(projectRoot, ".delivery-runs");
    await noLinks(directory);
    await mkdir(directory, { recursive: true });
    const lease = path.join(directory, "lab-active.json");
    await noLinks(lease);
    try {
        await writeFile(lease, JSON.stringify({ runId, processId: process.pid, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (error.code === "EEXIST") throw new Error("Another lab run or stale lease exists; inspect lab-active.json before explicit owner cleanup");
        throw error;
    }
    let ledger;
    try { ledger = await readArtifact(directory, "lab-target-ledger.json") ?? { version: 1, operations: [] }; }
    catch (error) { await rm(lease); throw error; }
    if (ledger.version !== 1 || !Array.isArray(ledger.operations) || ledger.operations.some((operation) =>
        !operation || typeof operation.id !== "string" || typeof operation.runId !== "string" ||
        !["admitted", "started", "unknown", "absent", "completed"].includes(operation.state) ||
        ["attempts", "recoveryAttempts"].some((name) => operation[name] !== undefined &&
            (!Number.isSafeInteger(operation[name]) || operation[name] < 0)))) {
        await rm(lease);
        throw new Error("Malformed lab target ledger");
    }
    return {
        directory, ledger,
        async save() { await saveArtifact(directory, "lab-target-ledger.json", ledger); },
        async release() { await rm(lease); },
    };
}

// Tickets are active only in the owning extension process; agents never supply commands.
export function createTicketBroker({ execute = runCommand } = {}) {
    const tickets = new Map();
    const executing = new Set();
    const broker = {
        offer(ticket) {
            const token = randomUUID();
            tickets.set(token, ticket);
            return token;
        },
        revoke(token) { tickets.delete(token); },
        async invoke(token) {
            if (typeof token !== "string" || !tickets.has(token)) throw new Error("Unknown or expired lab execution ticket");
            const ticket = tickets.get(token);
            const workspaceKey = ticket.workspaceKey ?? ticket.directory ?? "initialization";
            if (executing.has(workspaceKey)) throw new Error("Another lab operation is active in this workspace");
            tickets.delete(token);
            executing.add(workspaceKey);
            try {
                if (ticket.initialize) return await ticket.initialize();
                await revalidateRoots(ticket.roots);
                if (ticket.verify) await ticket.verify();
                if (ticket.scratchDirectory) await validateScratch(ticket.scratchDirectory);
                if (ticket.sourceFingerprint !== digest(await sourceCensus(ticket.roots))) throw new Error("Accepted source changed before native execution");
                if (digest(await scriptBinding(ticket.command, ticket.roots)) !== ticket.commandIdentity) throw new Error("Reviewed script/dependency bytes changed");
                await ticket.before();
                const spec = nativeCommand(ticket.command);
                const outcome = await execute(ticket.roots.get(ticket.command.repository).absolute, spec, ticket.signal, {
                    shareDiagnostics: ticket.shareDiagnostics, environment: ticket.environment,
                });
                let actual = null, evidenceHash = null;
                try {
                    await noLinks(ticket.evidencePath);
                    const bytes = await readFile(ticket.evidencePath);
                    actual = JSON.parse(bytes.toString("utf8"));
                    evidenceHash = hashBytes(bytes);
                } catch (error) {
                    if (error.code !== "ENOENT") {
                        await ticket.after({ outcome, evidenceError: "Invalid or unreadable native evidence" });
                        throw error;
                    }
                }
                const sourceIntact = ticket.sourceFingerprint === digest(await sourceCensus(ticket.roots));
                const receipt = {
                    ticketId: ticket.id, commandIdentity: ticket.commandIdentity,
                    sourceFingerprint: ticket.sourceFingerprint, outcome, evidenceHash, actual,
                    sourceIntact, recordedAt: new Date().toISOString(),
                };
                await saveArtifact(ticket.directory, `${ticket.id}-native.json`, receipt);
                await ticket.after(receipt);
                if (ticket.scratchDirectory) await validateScratch(ticket.scratchDirectory);
                if (ticket.verify) await ticket.verify();
                return receipt;
            } finally { executing.delete(workspaceKey); }
        },
    };
    return broker;
}
export function executionTool(broker) {
    return {
        name: "lab_execute_ticket",
        description: "Execute exactly one coordinator-admitted lab script ticket. No arbitrary commands; native intent is persisted before spawning.",
        parameters: { type: "object", required: ["ticket"], properties: { ticket: { type: "string" } }, additionalProperties: false },
        handler: async (args) => {
            try {
                const receipt = await broker.invoke(args?.ticket);
                return {
                    resultType: receipt.outcome?.ok && receipt.sourceIntact ? "success" : "failure",
                    textResultForLlm: JSON.stringify({
                        ticketId: receipt.ticketId, outcome: receipt.outcome,
                        sourceIntact: receipt.sourceIntact, evidenceHash: receipt.evidenceHash,
                    }),
                };
            } catch (error) {
                return { resultType: "failure", textResultForLlm: redactDiagnostics(error.message) };
            }
        },
    };
}

export async function issueTicket({ ctx, broker, workspace, directory, roots, command, binding, environment, role, kind, mutation, operation, shareDiagnostics, verify }) {
    const commandIdentity = digest(await scriptBinding(command, roots));
    const ticketId = `native-${randomUUID()}`;
    const evidencePath = path.join(directory, `${ticketId}-evidence.json`);
    const scratchDirectory = await createScratch(directory, ticketId);
    await noLinks(evidencePath);
    if (await readArtifact(directory, `${ticketId}-native.json`)) throw new Error("Native receipt identity reused");
    let nativeStarted = false;
    const ticket = broker.offer({
        id: ticketId, roots, command, commandIdentity, sourceFingerprint: binding.sourceFingerprint,
        directory, evidencePath, scratchDirectory, signal: ctx.signal, shareDiagnostics, verify,
        environment: { ...environment, DELIVERY_EVIDENCE_PATH: evidencePath, DELIVERY_OPERATION_ID: operation.id, DELIVERY_EVIDENCE_DIRECTORY: scratchDirectory },
        async before() {
            nativeStarted = true;
            if (mutation) {
                operation.state = "started";
                operation.attempts = (operation.attempts ?? 0) + 1;
                operation.ticketId = ticketId;
                operation.commandIdentity = commandIdentity;
                await workspace.save();
            }
            await saveArtifact(directory, `${ticketId}-intent.json`, { kind, operationId: operation.id, commandIdentity, binding });
        },
        async after(receipt) {
            if (mutation) {
                operation.lastReceipt = { ticketId, outcome: receipt.outcome, sourceIntact: receipt.sourceIntact ?? false };
                if (receipt.ticketId) {
                    operation.primaryEvidence = { ticketId: receipt.ticketId, evidenceHash: receipt.evidenceHash };
                    operation.productResult = receipt.outcome?.ok === true && receipt.actual?.status === "PASS" ? "PASS" :
                        receipt.actual?.status === "FAIL" ? "FAIL" : "unknown";
                }
                // A zero exit is not positive reconciliation of a remote side effect.
                operation.state = "unknown";
                await workspace.save();
            }
        },
    });
    let answer;
    try {
        answer = await ctx.agent(
            `Role: ${role}. Execute only ticket ${ticket} using lab_execute_ticket. ` +
            `This is the ${kind} stage of an explicitly authorized nonproduction lab run. ` +
            "Do not author scripts, invoke a shell, modify source, change authority, or delegate. " +
            "The tool journals intent before spawning. Report whether invocation returned; the coordinator reads native receipts itself.",
            {
                agent: "lab-operator", label: `${ctx.runId}:${role}:${kind}:${ticketId}`,
                schema: { type: "object", required: ["invoked"], properties: { invoked: { type: "boolean" } } },
            },
        );
    } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error("Lab operator failed", { cause: error }), { labNativeStarted: nativeStarted });
    } finally {
        broker.revoke(ticket);
        await cleanupOwnedScratch(scratchDirectory);
    }
    const receipt = await readArtifact(directory, `${ticketId}-native.json`);
    if (!answer || !receipt || receipt.ticketId !== ticketId || receipt.commandIdentity !== commandIdentity ||
        receipt.sourceFingerprint !== binding.sourceFingerprint || !receipt.sourceIntact) {
        throw Object.assign(new Error(`No valid native receipt for delegated ${kind}; inspect retained intent before retry`), { labBlocked: true, labNativeStarted: nativeStarted });
    }
    if (verify) await verify();
    await validateScratch(scratchDirectory);
    return receipt;
}

export async function initializeRoots({ ctx, broker, roots, workspace }) {
    for (const repo of roots.values()) {
        if (repo.gitReady) continue;
        if (repo.access !== "create") throw new Error("Root initialization lacks explicit creation authority");
        const operation = {
            id: `root-${repo.id}`, runId: ctx.runId, target: repo.absolute,
            kind: "local-repository-creation", state: "admitted",
        };
        workspace.ledger.operations.push(operation);
        await workspace.save();
        const token = broker.offer({
            workspaceKey: workspace.directory,
            async initialize() {
                await noLinks(repo.absolute);
                operation.state = "started";
                await workspace.save();
                await mkdir(repo.absolute, { recursive: true });
                const initial = await lstat(repo.absolute);
                operation.rootIdentity = { dev: initial.dev, ino: initial.ino };
                await workspace.save();
                await git(repo.absolute, ["init"]);
                const stat = await lstat(repo.absolute);
                repo.identity = { dev: stat.dev, ino: stat.ino };
                repo.gitReady = true;
                operation.state = "completed";
                operation.rootIdentity = repo.identity;
                await workspace.save();
                return { ticketId: operation.id, outcome: { ok: true, exitCode: 0 }, sourceIntact: true };
            },
        });
        try {
            await ctx.agent(`Role: Git Publisher. Invoke lab_execute_ticket exactly once with ticket ${token} to initialize the explicitly creatable local repository ${repo.id}. No GitHub creation or publication.`, {
                agent: "lab-operator", label: `${ctx.runId}:root:${repo.id}:${randomUUID()}`,
                schema: { type: "object", required: ["invoked"], properties: { invoked: { type: "boolean" } } },
            });
        } finally { broker.revoke(token); }
        if (operation.state !== "completed") throw new Error("Local repository creation needs owner reconciliation");
    }
}
