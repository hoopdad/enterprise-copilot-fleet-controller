import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { artifactDirectory, digest, saveArtifact } from "../runtime.mjs";
import { runOfflineCheck } from "../lab-preflight.mjs";
import {
    LAB_VERSION, freezeInfrastructurePolicy, hashBytes, readReference, resolveRoots, scriptBinding,
    sourceCensus, terraformPolicy, validateCanonicalGuard, validateNativePlan, validateTasks,
} from "../lab-policy.mjs";
import { cleanupOwnedScratch, createScratch, withScratch } from "../lab-scratch.mjs";
import { recheckRuntimeIdentityPin } from "../lab-workflow.mjs";

const exec = promisify(execFile);
const example = JSON.parse(await readFile(new URL("../examples/lab.json", import.meta.url), "utf8"));
async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lab-offline-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await exec("git", ["init", root]);
    for (const directory of ["src", "scripts/lab/framework", "docs", "infra/nested", "keys", ".azure/lab-profile"]) await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "/.delivery-runs/\n/.azure/\nkeys/id_ed25519\n*.tfstate\n");
    await writeFile(path.join(root, "README.md"), "Fixture owner instructions.");
    await writeFile(path.join(root, "docs/spec.md"), "Offline fixture requirements.");
    await writeFile(path.join(root, "keys/lab.pub"), "ssh-ed25519 AAAA offline-public-key");
    await writeFile(path.join(root, "keys/id_ed25519"), "PRIVATE FIXTURE: must not be consumed");
    await writeFile(path.join(root, "infra/local.tfstate"), "{}");
    await writeFile(path.join(root, "infra/nested/excluded.tf"), "# not in immediate collection");
    for (let index = 0; index < 5; index++) await writeFile(path.join(root, `infra/input-${index}.tf`), `# canonical input ${index}\n`);
    await writeFile(path.join(root, "scripts/lab/shared.mjs"), "export const prerequisite = true;\n");
    for (const name of ["lab-scratch.mjs", "lab-policy.mjs", "runtime.mjs"]) await writeFile(path.join(root, "scripts/lab/framework", name), await readFile(new URL(`../${name}`, import.meta.url)));
    await writeFile(path.join(root, "scripts/lab/check.mjs"), `
import {readFile,readdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {withScratch} from "./framework/lab-scratch.mjs";
import {prerequisite} from "./shared.mjs";
const files=["scripts/lab/check.mjs","scripts/lab/shared.mjs","scripts/lab/framework/lab-scratch.mjs","scripts/lab/framework/lab-policy.mjs","scripts/lab/framework/runtime.mjs","keys/lab.pub",
    ...(await readdir("infra")).filter(n=>n.endsWith(".tf")).sort().map(n=>"infra/"+n)];
for(const file of files) await readFile(file);
if(!prerequisite || !(await readFile("keys/lab.pub","utf8")).startsWith("ssh-ed25519 ")) throw Error("Canonical offline prerequisites failed");
await withScratch(async child=>{await writeFile(path.join(child,"negative-fixture.tf"),"# local negative fixture");});
await writeFile(process.env.DELIVERY_EVIDENCE_PATH,JSON.stringify({status:"PASS",
binding:{runId:process.env.DELIVERY_RUN_ID,sourceFingerprint:process.env.DELIVERY_SOURCE_FINGERPRINT},
evidence:["actual-local-prerequisites"],data:{offline:true,checks:{prerequisites:true,dependencyInventory:true,scratchOwnership:true},
consumedSources:files.map(path=>({repository:"app",path}))}}));
`);
    const input = structuredClone(example);
    input.projectRoot = root;
    input.specification.path = "docs/spec.md";
    input.repositories[0].sourceScope = ["src", "test", "scripts/lab", "docs", "README.md", ".gitignore", "infra/*.tf", "keys/lab.pub"];
    input.repositories[0].instructionPaths = ["README.md"];
    const command = {
        repository: "app", executable: "node", script: "scripts/lab/check.mjs", args: [], cwd: ".", timeoutMs: 30000,
        dependencies: [{ repository: "app", collection: "infra/*.tf" }, { repository: "app", path: "keys/lab.pub" },
            ...["shared.mjs", "framework/lab-scratch.mjs", "framework/lab-policy.mjs", "framework/runtime.mjs"].map((name) => ({ repository: "app", path: `scripts/lab/${name}` }))],
    };
    input.commands = { baseline: [command], test: [command], build: [command], preflight: [command] };
    return { root, input, command };
}

test("one offline integration check runs canonical helpers, actual native environment and owned scratch", async (t) => {
    const { root, input } = await fixture(t);
    const report = await runOfflineCheck({ input, runId: "offline-integration" });
    assert.equal(report.status, "PASS");
    assert.equal(report.environment.variables.length, 20);
    assert.equal(report.environment.stageIndex, "0");
    assert.deepEqual(report.scratch, { ownedCleanup: true, failureCleanup: true, unrelatedPreserved: true });
    const files = report.inventory[0].files.map((file) => file.path);
    assert.equal(files.filter((file) => file.endsWith(".tf")).length, 5);
    assert.ok(files.includes("keys/lab.pub"));
    assert.ok(!files.some((file) => /id_ed25519|tfstate|nested/.test(file)));
    assert.ok(!(await readdir(path.join(root, "scripts/lab"))).some((name) => name.includes("fixture")));
});

test("constrained collection membership detects future immediate files without granting writes", async (t) => {
    const { root, input, command } = await fixture(t);
    const { roots } = await resolveRoots(input);
    const before = await scriptBinding(command, roots);
    await writeFile(path.join(root, "infra/new.tf"), "# new consumed source");
    const after = await scriptBinding(command, roots);
    assert.notEqual(digest(before), digest(after));
    assert.ok(Object.hasOwn((await sourceCensus(roots)).app, "infra/new.tf"));
    assert.ok(!Object.hasOwn((await sourceCensus(roots)).app, "infra/nested/excluded.tf"));
    assert.throws(() => validateTasks({ tasks: [{
        id: "not-authorized", kind: "developer", repository: "app", paths: ["infra/new.tf"], dependsOn: [],
        requirementIds: [input.acceptance[0].id],
    }] }, input, { requirementIds: [input.acceptance[0].id] }), /outside authorized scope/);
    for (const collection of ["infra/**/*.tf", "infra/*.json", "../*.tf"]) await assert.rejects(
        scriptBinding({ ...command, dependencies: [{ repository: "app", collection }] }, roots), /collection|Unsafe/);
});

test("offline actual-consumption inventory catches an omitted canonical Terraform input", async (t) => {
    const { input, command } = await fixture(t);
    command.dependencies = [...command.dependencies.slice(1),
        ...[0, 1, 2, 3].map((index) => ({ repository: "app", path: `infra/input-${index}.tf` }))];
    await assert.rejects(runOfflineCheck({ input }), /consumed dependency inventory/);
});

test("standalone offline CLI runs without SDK registration or agent dispatch", async (t) => {
    const { root, input } = await fixture(t);
    const directory = await artifactDirectory(root, "cli-input");
    const file = path.join(directory, "input.json");
    await writeFile(file, JSON.stringify(input));
    const script = fileURLToPath(new URL("../lab-preflight.mjs", import.meta.url));
    const { stdout } = await exec(process.execPath, [script, file], { timeout: 60000 });
    assert.equal(JSON.parse(stdout).status, "PASS");
    await assert.rejects(exec(process.execPath, [script, file, "--unknown"]), (error) => error.code === 1 && /Usage:/.test(error.stderr));
});

test("invalid scratch fails rather than falling back; framework cleanup preserves unrelated children", async (t) => {
    const { root } = await fixture(t);
    const directory = await artifactDirectory(root, "scratch-test"), scratch = await createScratch(directory);
    const unrelated = path.join(scratch, "helper-00000000-0000-0000-0000-000000000000");
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, "preserve.txt"), "unrelated");
    await assert.rejects(withScratch(() => assert.fail("must not run"), path.join(root, "scripts")), /ENOENT|ownership|scratch/);
    await assert.rejects(withScratch(async (child) => {
        await writeFile(path.join(child, "fixture"), "owned");
        throw new Error("negative-test");
    }, scratch), /negative-test/);
    const crashed = path.join(root, "scripts/lab/crashed-helper.mjs");
    await writeFile(crashed, `
import {withScratch} from "./framework/lab-scratch.mjs";
import {writeFile} from "node:fs/promises";
import path from "node:path";
await withScratch(async child=>{await writeFile(path.join(child,"fixture"),"owned");process.exit(9);});
`);
    await assert.rejects(exec(process.execPath, [crashed], { env: { ...process.env, DELIVERY_EVIDENCE_DIRECTORY: scratch } }), (error) => error.code === 9);
    assert.equal((await readdir(scratch)).filter((name) => name.startsWith("helper-")).length, 2);
    await cleanupOwnedScratch(scratch);
    assert.equal(await readFile(path.join(unrelated, "preserve.txt"), "utf8"), "unrelated");
    assert.equal((await readdir(scratch)).filter((name) => name.startsWith("helper-")).length, 1);
    await writeFile(path.join(root, ".gitignore"), "/.azure/\n");
    await assert.rejects(createScratch(await artifactDirectory(root, "unignored")), /must be Git-ignored/);
});

test("offline resume validates retained AzAPI plans against finalized frozen metadata without effects", async (t) => {
    const { root, input } = await fixture(t);
    input.infrastructureProfile = { repository: "app", path: "docs/infrastructure.json" };
    await writeFile(path.join(root, input.infrastructureProfile.path), JSON.stringify({ policy: { permittedArmTypes: ["Microsoft.Network/virtualNetworks"] }, metadata: { status: "finalized" } }));
    const args = { ...input, terraformPolicy: terraformPolicy(input) }, { roots } = await resolveRoots(args);
    const policy = await freezeInfrastructurePolicy(args, roots, []);
    const directory = await artifactDirectory(root, "retained-run");
    const owner = { stateOwner: "fixture", shared: false, subscriptionId: args.azure.subscriptionId, tenantId: args.azure.tenantId, region: args.azure.region };
    const binding = { runId: "retained-run", sourceFingerprint: digest(await sourceCensus(roots)), stageId: "foundation", stageIndex: 0 };
    const native = { resource_changes: [{ address: "azapi_resource.network", type: "azapi_resource",
        change: { actions: ["create"], after: { type: "Microsoft.Network/virtualNetworks@2024-05-01", parent_id: "/subscriptions/fixture/resourceGroups/lab", body: { properties: {} } } } }] };
    validateNativePlan(native, owner, [], { canonical: true });
    const hashes = { binary: hashBytes("saved binary"), json: hashBytes(JSON.stringify(native)) };
    const addresses = ["fixture:azapi_resource.network"];
    const checks = Object.fromEntries(["resourceSemantics", "parentIds", "remoteIds", "permittedProperties", "dependencyClosure", "cumulativeScope", "terraformPolicy", "acceptedMetadata"]
        .map((name) => [name, { pass: true, evidence: [`fixture-native-${name}`] }]));
    const guard = { version: 2, status: "PASS", binaryHash: hashes.binary, jsonHash: hashes.json,
        stateOwner: owner.stateOwner, subscriptionId: owner.subscriptionId, tenantId: owner.tenantId,
        evidence: ["fixture-exact-native-guard"], sourceFingerprint: binding.sourceFingerprint, binding,
        policyIdentity: digest(policy), checks, scope: { addresses, count: 1 } };
    validateCanonicalGuard(guard, hashes, owner, binding, policy, addresses);
    assert.throws(() => validateCanonicalGuard({ ...guard, scope: { addresses: [], count: 0 } }, hashes, owner, binding, policy, addresses), /cumulative scope/);
    hashes.guard = hashBytes(JSON.stringify(guard));
    const archives = {}, retained = {};
    for (const [name, bytes] of Object.entries({ binary: "saved binary", json: JSON.stringify(native), guard: JSON.stringify(guard) })) {
        archives[name] = `retained-${hashes[name]}.bin`;
        retained[archives[name]] = hashes[name];
        await writeFile(path.join(directory, archives[name]), bytes);
    }
    const plan = { repository: "app", ownership: owner, hashes, archives, binding, policy, addresses };
    await saveArtifact(directory, "lab-state.json", {
        identity: digest({ version: LAB_VERSION, args, spec: await readReference(roots, input.specification), contracts: [], infrastructureCeiling: policy.rules,
            roots: [...roots.values()].map(({ id, absolute }) => ({ id, absolute })) }),
        roots: [...roots.values()].map(({ id, identity }) => ({ id, identity })), accepted: await sourceCensus(roots), retained,
        completedSprints: ["one"], sprints: { one: { admissions: [{ plans: [plan] }] } },
    });

    const result = await runOfflineCheck({ input, resumeRunId: "retained-run" });
    assert.equal(result.resume.status, "retained-inputs-valid");
    assert.equal(result.resume.plans, 1);
    assert.match(result.resume.effects, /Not observed offline/);
    assert.equal(policy.metadata.status, "finalized");
    const changed = { ...guard, policyIdentity: digest({ ...policy, metadata: { status: "reserved" } }) };
    assert.throws(() => validateCanonicalGuard(changed, hashes, owner, binding, policy, addresses), /accepted-policy/);
});

test("retained runtime pins compare binding values, not script JSON key order", async (t) => {
    const { root, input } = await fixture(t);
    const directory = await artifactDirectory(root, "pin-run");
    const receipt = "native-11111111-2222-3333-4444-555555555555";
    const identity = { principalId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", resourceId: "runtime",
        subscriptionId: input.azure.subscriptionId, tenantId: input.azure.tenantId, evidence: ["native-fixture"] };
    const binding = { runId: "pin-run", sourceFingerprint: "source", buildFingerprint: "build", revision: "revision" };
    const actual = { status: "PASS", binding: {
        revision: binding.revision, sourceFingerprint: binding.sourceFingerprint, runId: binding.runId, buildFingerprint: binding.buildFingerprint,
    }, evidence: ["native-fixture"], data: { effect: "completed", observations: ["native-fixture"], runtimeIdentity: identity } };
    await saveArtifact(directory, `${receipt}-evidence.json`, actual);
    const evidencePath = path.join(directory, `${receipt}-evidence.json`), evidenceHash = hashBytes(await readFile(evidencePath));
    await saveArtifact(directory, `${receipt}-native.json`, { ticketId: receipt, evidenceHash, sourceIntact: true, outcome: { ok: true, exitCode: 0 }, actual });
    const pin = { identity, binding, receipt, path: evidencePath, evidenceHash };
    await recheckRuntimeIdentityPin(pin, directory, input, null);
    await assert.rejects(recheckRuntimeIdentityPin({ ...pin, binding: { ...binding, revision: "wrong" } }, directory, input, null), /original successful native/);
    await writeFile(evidencePath, `${JSON.stringify(actual)}\nchanged`);
    await assert.rejects(recheckRuntimeIdentityPin(pin, directory, input, null), /receipt changed/);
});
