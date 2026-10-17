import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createTicketBroker, issueTicket, acquireWorkspace } from "../lab-executor.mjs";
import { git, hashBytes, resolveRoots, scriptBinding, sourceCensus, validateNativePlan, validateOrigin } from "../lab-policy.mjs";
import { artifactDirectory, digest, readArtifact, runCommand } from "../runtime.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const allowedNames = [
    "DELIVERY_TARGET", "DELIVERY_RUN_ID", "DELIVERY_SOURCE_FINGERPRINT", "DELIVERY_BUILD_FINGERPRINT",
    "AZURE_CONFIG_DIR", "DELIVERY_REGION", "DELIVERY_SUBSCRIPTION_ID", "DELIVERY_REVISION",
    "DELIVERY_WEB_ORIGIN", "DELIVERY_PROVISION_STAGE", "DELIVERY_PROVISION_STAGE_INDEX",
    "DELIVERY_PLAN_EVIDENCE", "DELIVERY_PLAN_IDENTITY", "DELIVERY_PLAN_AGGREGATE",
    "DELIVERY_TENANT_ID", "DELIVERY_OPERATION_ID", "DELIVERY_EVIDENCE_PATH", "DELIVERY_SPRINT_ID",
    "DELIVERY_EVIDENCE_DIRECTORY", "DELIVERY_PLAN_CONTEXT",
];
const command = (script = "scripts/receipt.mjs", args = []) => ({
    repository: "app", executable: process.execPath, script, args, cwd: ".", dependencies: [], timeoutMs: 15000,
});
const parse = async (file) => JSON.parse(await readFile(file, "utf8"));

async function fixture(t, script = "await import('node:fs/promises');") {
    const root = path.join(testRoot, `.lab-native-${randomUUID()}`);
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, ".azure", "isolated"), { recursive: true });
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, ".gitignore"), ".delivery-runs/\n.azure/\nevidence/\nbuild/\n");
    await writeFile(path.join(root, "spec.md"), "Native regression fixture; no remote effects.\n");
    await writeFile(path.join(root, "scripts", "receipt.mjs"), script);
    await git(root, ["init", "--quiet"]);
    await git(root, ["add", "--", ".gitignore", "spec.md", "scripts/receipt.mjs"]);
    const { roots } = await resolveRoots({
        projectRoot: root, repositories: [{ id: "app", path: ".", access: "write", scope: ["scripts"] }],
        azure: { profile: { repository: "app", path: ".azure/isolated" } },
    });
    const runId = `native-${randomUUID()}`;
    const directory = await artifactDirectory(root, runId);
    const broker = createTicketBroker();
    return { root, roots, runId, directory, broker };
}

function operator(h, extra = {}) {
    return {
        runId: h.runId,
        async agent(prompt, config) {
            assert.equal(config.agent, "lab-operator");
            assert.match(prompt, /using lab_execute_ticket/);
            assert.match(prompt, /Do not author scripts, invoke a shell, modify source/);
            assert.match(config.label, new RegExp(`^${h.runId}:`));
            const token = /Execute only ticket ([a-f0-9-]{36}) /.exec(prompt)?.[1];
            assert.ok(token, "operator receives only an opaque active ticket");
            h.token = token;
            h.invoked = await h.broker.invoke(token);
            return { invoked: true, receipt: { outcome: { ok: false }, actual: { status: "forged" } } };
        },
        ...extra,
    };
}

async function issue(h, options = {}) {
    return issueTicket({
        ctx: operator(h), broker: h.broker, workspace: { async save() {} }, directory: h.directory,
        roots: h.roots, command: command(),
        binding: { sourceFingerprint: digest(await sourceCensus(h.roots)) },
        environment: {}, role: "DevOps Engineer", kind: "native-fixture", mutation: false,
        operation: { id: "op-fixture", state: "read-only" }, ...options,
    });
}

test("real native child receives all 20 allowed overrides, including index zero and plan context, and filters secrets", async (t) => {
    const sensitive = ["LAB_TEST_TOKEN", "LAB_TEST_SECRET", "LAB_TEST_PASSWORD", "LAB_TEST_CREDENTIAL",
        "LAB_TEST_PRIVATE_KEY", "LAB_TEST_CONNECTION_STRING"];
    const h = await fixture(t, `
        import { writeFile } from "node:fs/promises";
        const names = ${JSON.stringify(allowedNames)};
        const sensitive = ${JSON.stringify(sensitive)};
        await writeFile(process.env.DELIVERY_EVIDENCE_PATH, JSON.stringify({
            values: Object.fromEntries(names.map(name => [name, process.env[name]])),
            leaked: Object.keys(process.env).filter(name => sensitive.includes(name)),
            unknown: process.env.LAB_TEST_UNKNOWN_OVERRIDE ?? null,
        }));
    `);
    const output = path.join(h.directory, "environment.json");
    const environment = Object.fromEntries(allowedNames.map((name, index) => [name, `fixture-${index}`]));
    Object.assign(environment, {
        DELIVERY_EVIDENCE_PATH: output, DELIVERY_PROVISION_STAGE_INDEX: "0", DELIVERY_EVIDENCE_DIRECTORY: h.directory,
        AZURE_CONFIG_DIR: path.join(h.root, ".azure", "isolated"),
        DELIVERY_WEB_ORIGIN: "https://fixture.example.invalid",
    });
    const originals = Object.fromEntries([...sensitive, "LAB_TEST_UNKNOWN_OVERRIDE"].map((name) => [name, process.env[name]]));
    t.after(() => {
        for (const [name, value] of Object.entries(originals)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
    sensitive.forEach((name) => { process.env[name] = "fixture-sensitive-not-a-real-secret"; });
    delete process.env.LAB_TEST_UNKNOWN_OVERRIDE;
    const result = await runCommand(h.root, {
        executable: process.execPath, args: ["scripts/receipt.mjs"], cwd: ".", timeoutMs: 15000,
    }, undefined, { environment: { ...environment, LAB_TEST_UNKNOWN_OVERRIDE: "must-not-forward", LAB_TEST_TOKEN: "must-not-forward" } });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(allowedNames.length, 20);
    const actual = await parse(output);
    assert.deepEqual(actual.values, environment);
    assert.equal(actual.values.DELIVERY_PROVISION_STAGE_INDEX, "0");
    assert.deepEqual(actual.leaked, []);
    assert.equal(actual.unknown, null);
});

test("every explicitly forwarded native environment value must be a string", async (t) => {
    const h = await fixture(t);
    const spec = { executable: process.execPath, args: ["scripts/receipt.mjs"], cwd: ".", timeoutMs: 15000 };
    for (const name of allowedNames) {
        for (const value of [0, false, null, {}, ["0"]]) {
            await assert.rejects(runCommand(h.root, spec, undefined, { environment: { [name]: value } }),
                /Invalid deployment environment/, `${name} rejects ${JSON.stringify(value)}`);
        }
    }
});

test("operator-invoked broker persists mutation intent before spawning and independently reads the child's receipt", async (t) => {
    const h = await fixture(t, `
        import path from "node:path";
        import { readFile, writeFile } from "node:fs/promises";
        const output = process.env.DELIVERY_EVIDENCE_PATH;
        const intent = JSON.parse(await readFile(output.replace(/-evidence\\.json$/, "-intent.json"), "utf8"));
        const ledger = JSON.parse(await readFile(path.resolve(".delivery-runs/lab-target-ledger.json"), "utf8"));
        const operation = ledger.operations.find(item => item.id === process.env.DELIVERY_OPERATION_ID);
        if (!operation || operation.state !== "started" || operation.attempts !== 1 ||
            operation.ticketId !== path.basename(output).replace(/-evidence\\.json$/, "") ||
            intent.operationId !== operation.id) process.exit(29);
        await writeFile(output, JSON.stringify({ status: "PASS", evidence: ["child-observed-intent"],
            data: { intent, operation, processId: process.pid } }));
    `);
    const workspace = await acquireWorkspace(h.root, h.runId);
    try {
        const operation = { id: "op-native", state: "admitted", attempts: 0 };
        workspace.ledger.operations.push(operation);
        await workspace.save();
        const receipt = await issue(h, { workspace, mutation: true, operation });
        assert.equal(receipt.outcome.ok, true);
        assert.equal(receipt.outcome.exitCode, 0);
        assert.equal(receipt.actual.status, "PASS");
        assert.notEqual(receipt.actual.data.processId, process.pid);
        assert.equal(receipt.actual.data.operation.state, "started");
        assert.equal(receipt.actual.data.intent.operationId, operation.id);
        const stored = await readArtifact(h.directory, `${receipt.ticketId}-native.json`);
        assert.deepEqual(receipt, stored);
        const bytes = await readFile(path.join(h.directory, `${receipt.ticketId}-evidence.json`));
        assert.equal(receipt.evidenceHash, hashBytes(bytes));
        const ledger = await readArtifact(workspace.directory, "lab-target-ledger.json");
        assert.equal(ledger.operations[0].state, "unknown", "zero exit does not positively reconcile a mutation");
        assert.deepEqual(ledger.operations[0].lastReceipt.outcome, receipt.outcome);
        await assert.rejects(h.broker.invoke(h.token), /Unknown or expired/);
    } finally { await workspace.release(); }
});

test("operator claims without an actual invocation cannot manufacture success and the offered token is revoked", async (t) => {
    const h = await fixture(t);
    let token;
    await assert.rejects(issue(h, {
        ctx: operator(h, {
            async agent(prompt) {
                token = /Execute only ticket ([a-f0-9-]{36}) /.exec(prompt)[1];
                return { invoked: true, outcome: { ok: true }, actual: { status: "PASS" } };
            },
        }),
    }), /No valid native receipt/);
    assert.deepEqual((await readdir(h.directory)).filter((name) => name !== "scratch"), []);
    await assert.rejects(h.broker.invoke(token), /Unknown or expired/);
});

test("source drift between ticket admission and operator invocation blocks before durable intent or child effects", async (t) => {
    const h = await fixture(t, "throw new Error('drifted source must never spawn this child');");
    await assert.rejects(issue(h, {
        ctx: operator(h, {
            async agent(prompt) {
                h.token = /Execute only ticket ([a-f0-9-]{36}) /.exec(prompt)[1];
                await writeFile(path.join(h.root, "spec.md"), "Changed after the coordinator's admission.\n");
                await h.broker.invoke(h.token);
                return { invoked: true };
            },
        }),
    }), /Accepted source changed/);
    assert.deepEqual((await readdir(h.directory)).filter((name) => name !== "scratch"), []);
    await assert.rejects(h.broker.invoke(h.token), /Unknown or expired/);
});

test("reviewed script and dependency bytes bind tickets even if a caller supplies a fresh source fingerprint", async (t) => {
    const h = await fixture(t);
    await writeFile(path.join(h.root, "scripts", "dependency.mjs"), "export const value = 1;\n");
    const spec = { ...command(), dependencies: [{ repository: "app", path: "scripts/dependency.mjs" }] };
    const binding = await scriptBinding(spec, h.roots);
    assert.equal(binding.files.length, 2);
    await writeFile(path.join(h.root, "scripts", "dependency.mjs"), "export const value = 2;\n");
    let effects = 0;
    const token = h.broker.offer({
        roots: h.roots, command: spec, commandIdentity: digest(binding),
        sourceFingerprint: digest(await sourceCensus(h.roots)),
        before() { effects++; },
    });
    await assert.rejects(h.broker.invoke(token), /Reviewed script\/dependency bytes changed/);
    assert.equal(effects, 0);
    await assert.rejects(h.broker.invoke(token), /Unknown or expired/);
});

test("a native child failing without evidence retains an honest process outcome, not the operator's PASS claim", async (t) => {
    const h = await fixture(t, "process.exit(23);");
    const receipt = await issue(h);
    assert.equal(receipt.outcome.ok, false);
    assert.equal(receipt.outcome.exitCode, 23);
    assert.equal(receipt.outcome.reason, "exit");
    assert.equal(receipt.actual, null);
    assert.equal(receipt.evidenceHash, null);
    assert.equal(receipt.sourceIntact, true);
});

test("native staged-plan and actual-origin receipts propagate saved plan identity without regenerating apply input", async (t) => {
    const h = await fixture(t, `
        import path from "node:path";
        import { createHash } from "node:crypto";
        import { mkdir, readFile, writeFile } from "node:fs/promises";
        const hash = bytes => createHash("sha256").update(bytes).digest("hex");
        const env = process.env;
        const binding = { runId: env.DELIVERY_RUN_ID, sourceFingerprint: env.DELIVERY_SOURCE_FINGERPRINT,
            buildFingerprint: env.DELIVERY_BUILD_FINGERPRINT, revision: env.DELIVERY_REVISION,
            sprintId: env.DELIVERY_SPRINT_ID,
            stageId: env.DELIVERY_PROVISION_STAGE, stageIndex: Number(env.DELIVERY_PROVISION_STAGE_INDEX) };
        let data;
        if (process.argv[2] === "plan") {
            await mkdir("evidence", { recursive: true });
            const binary = Buffer.from("local native-plan fixture bytes");
            const json = Buffer.from(JSON.stringify({ resource_changes: [{
                address: "fixture_resource.app", type: "fixture_resource", change: { actions: ["create"] }
            }] }));
            await writeFile("evidence/stage.bin", binary);
            await writeFile("evidence/stage.json", json);
            data = { binaryHash: hash(binary), jsonHash: hash(json), stageIndex: binding.stageIndex };
        } else if (process.argv[2] === "apply") {
            const binary = await readFile(env.DELIVERY_PLAN_EVIDENCE);
            data = { consumedPlanHash: hash(binary), planIdentity: env.DELIVERY_PLAN_IDENTITY,
                aggregate: env.DELIVERY_PLAN_AGGREGATE, effect: "completed" };
        } else {
            data = { webOrigin: "https://fixture.example.invalid", revision: env.DELIVERY_REVISION,
                buildFingerprint: env.DELIVERY_BUILD_FINGERPRINT };
        }
        await writeFile(env.DELIVERY_EVIDENCE_PATH, JSON.stringify({
            status: "PASS", binding, evidence: ["local-fixture-only-no-cloud"], data
        }));
    `);
    const sourceFingerprint = digest(await sourceCensus(h.roots));
    const binding = { runId: h.runId, sourceFingerprint, buildFingerprint: "fixture-build", revision: "local-fixture",
        sprintId: "sprint-one", stageId: "foundation", stageIndex: 0 };
    const environment = {
        DELIVERY_RUN_ID: h.runId, DELIVERY_SOURCE_FINGERPRINT: sourceFingerprint,
        DELIVERY_BUILD_FINGERPRINT: binding.buildFingerprint, DELIVERY_REVISION: binding.revision,
        DELIVERY_PROVISION_STAGE: binding.stageId, DELIVERY_PROVISION_STAGE_INDEX: "0", DELIVERY_SPRINT_ID: binding.sprintId,
    };
    const plan = await issue(h, { command: command(undefined, ["plan"]), binding, environment, kind: "plan-foundation" });
    assert.equal(plan.outcome.ok, true);
    assert.deepEqual(plan.actual.binding, binding);
    assert.equal(plan.actual.data.stageIndex, 0);
    const binaryPath = path.join(h.root, "evidence", "stage.bin");
    const jsonPath = path.join(h.root, "evidence", "stage.json");
    const planBytes = await readFile(binaryPath);
    assert.equal(hashBytes(planBytes), plan.actual.data.binaryHash);
    assert.equal(hashBytes(await readFile(jsonPath)), plan.actual.data.jsonHash);
    validateNativePlan(await parse(jsonPath), { shared: false });
    const planIdentity = digest(plan.actual.data);
    const aggregate = digest([planIdentity]);
    const apply = await issue(h, {
        command: command(undefined, ["apply"]), binding,
        environment: { ...environment, DELIVERY_PLAN_EVIDENCE: binaryPath, DELIVERY_PLAN_IDENTITY: planIdentity,
            DELIVERY_PLAN_AGGREGATE: aggregate }, kind: "apply-foundation",
    });
    assert.equal(apply.outcome.ok, true);
    assert.equal(apply.actual.data.consumedPlanHash, hashBytes(planBytes));
    assert.equal(apply.actual.data.planIdentity, planIdentity);
    assert.equal(apply.actual.data.aggregate, aggregate);
    assert.deepEqual(await readFile(binaryPath), planBytes);
    const verify = await issue(h, { command: command(undefined, ["verify"]), binding, environment, kind: "verify" });
    assert.equal(verify.outcome.ok, true);
    assert.equal(validateOrigin(verify.actual.data.webOrigin), "https://fixture.example.invalid");
    assert.equal(verify.actual.data.revision, binding.revision);
    assert.equal(verify.actual.data.buildFingerprint, binding.buildFingerprint);
    assert.equal(digest(await sourceCensus(h.roots)), sourceFingerprint);
});

test("native runner distinguishes pre-abort, spawn failure, timeout, and nonzero exit", async (t) => {
    const h = await fixture(t, "setInterval(() => {}, 1000);");
    const spec = { executable: process.execPath, args: ["scripts/receipt.mjs"], cwd: ".", timeoutMs: 100 };
    const aborted = await runCommand(h.root, spec, AbortSignal.abort());
    assert.equal(aborted.reason, "aborted");
    assert.equal(aborted.errorCode, "ABORT_ERR");
    const missing = await runCommand(h.root, { ...spec, executable: "lab-fixture-missing-executable" });
    assert.equal(missing.reason, "spawn");
    assert.equal(missing.errorCode, "ENOENT");
    const timeout = await runCommand(h.root, spec);
    assert.equal(timeout.ok, false);
    assert.equal(timeout.reason, "timeout");
    assert.equal(timeout.timedOut, true);
});
