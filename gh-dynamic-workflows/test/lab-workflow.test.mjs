import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import {
    LAB_ACK, assertScopedChanges, git, hashBytes, resolveRoots, runtimeAccessPolicy, scriptBinding, sourceCensus,
    validateCapacityObservation, validateCoverage, validateLabInput, validateNativePlan, validateOrigin, validateRuntimeIdentity, validateTasks,
} from "../lab-policy.mjs";
import { acquireWorkspace, createTicketBroker, issueTicket } from "../lab-executor.mjs";
import { createLabRunner } from "../lab-workflow.mjs";
import { LOOP_DEFINITIONS } from "../lab-loops.mjs";
import { artifactDirectory, digest, readArtifact } from "../runtime.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const reference = (file) => ({ repository: "app", path: file });
const command = (mode = "baseline") => ({
    repository: "app", executable: process.execPath, script: "scripts/local.mjs",
    args: [mode], cwd: ".", dependencies: [], timeoutMs: 15000,
});
function input(projectRoot = testRoot) {
    return {
        schemaVersion: 1, profile: "azure-lab", projectRoot,
        terraformPolicy: { requirement: "any", preference: "avm" },
        repositories: [{ id: "app", path: ".", access: "write", scope: ["src", "scripts", "docs"] }],
        specification: reference("spec.md"),
        acceptance: [{ id: "ac-main", criterion: "The local fixture implements the exact requested value.", level: "local" }],
        authorization: {
            acknowledgement: LAB_ACK, localExecution: true, directSdkDispatch: true,
            provision: false, providerRegistration: false, publish: false, repositoryCreation: false, modelTests: false,
        },
        target: { id: "fixture", environment: "test", deploy: false, requirePublication: false },
        azure: { subscriptionId: "fixture-subscription", tenantId: "fixture-tenant", region: "fixture-region",
            profile: reference(".azure/isolated"), providers: [], models: [] },
        commands: { baseline: [command()], test: [command("test")], build: [command("build")] },
        attempts: { planning: 1, implementation: 1, repair: 0, recovery: 1 }, maxSprints: 1,
        bootstrapPaths: [{ repository: "app", paths: ["scripts"] }],
        documentationPaths: [{ repository: "app", paths: ["docs/README.md", "docs/RELEASE-NOTES.md"] }],
    };
}
const clone = (value) => structuredClone(value);
const coverage = () => [{ id: "ac-main", status: "verified", evidence: ["native-local-test-and-build-receipts"] }];
const proposal = (artifact) => ({ status: "PASS", summary: "Local fixture stage inspected", evidence: ["fixture-source-and-native-receipts"], artifact });
const vote = () => ({ verdict: "PASS", findings: [], evidence: ["independent-fixture-inspection"] });

const localScript = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const binding = { runId: process.env.DELIVERY_RUN_ID, sourceFingerprint: process.env.DELIVERY_SOURCE_FINGERPRINT };
for (const [key, name] of Object.entries({
    buildFingerprint: "DELIVERY_BUILD_FINGERPRINT", revision: "DELIVERY_REVISION", sprintId: "DELIVERY_SPRINT_ID",
    stageId: "DELIVERY_PROVISION_STAGE", planEvidence: "DELIVERY_PLAN_EVIDENCE", planIdentity: "DELIVERY_PLAN_IDENTITY",
    planAggregate: "DELIVERY_PLAN_AGGREGATE", planContext: "DELIVERY_PLAN_CONTEXT", webOrigin: "DELIVERY_WEB_ORIGIN",
})) if (process.env[name]) binding[key] = process.env[name];
if (process.env.DELIVERY_PROVISION_STAGE_INDEX) binding.stageIndex = Number(process.env.DELIVERY_PROVISION_STAGE_INDEX);
const mode = process.argv[2];
let data = {};
if (mode === "identity") data = { subscriptionId: process.env.DELIVERY_SUBSCRIPTION_ID,
    tenantId: process.env.DELIVERY_TENANT_ID, region: process.env.DELIVERY_REGION, enabled: true };
else if (mode === "topology") data = { designEvidence: ["fixture-spec.md"], designQuestions: [] };
else if (mode === "test") {
    assert.equal(await readFile("src/feature.txt", "utf8"), "implemented fixture value\\n");
    assert.equal(await readFile("src/existing.txt", "utf8"), "initially dirty owner bytes\\n");
} else if (mode === "build") {
    let bytes = await readFile("src/feature.txt");
    try { bytes = Buffer.concat([bytes, await readFile("src/correction.txt")]); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir("build", { recursive: true });
    const file = "build/" + binding.sourceFingerprint + ".bin";
    await writeFile(file, bytes);
    data = { artifacts: [{ repository: "app", path: file, sha256: hash(bytes) }] };
} else assert.equal(mode, "baseline");
await writeFile(process.env.DELIVERY_EVIDENCE_PATH, JSON.stringify({
    status: "PASS", binding, evidence: ["actual local Node fixture " + mode], data
}));
`;

async function fixture(t) {
    const base = path.join(testRoot, `.lab-workflow-${randomUUID()}`);
    const root = path.join(base, "app");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "scripts"));
    await mkdir(path.join(root, "docs"));
    await mkdir(path.join(root, ".azure", "isolated"), { recursive: true });
    t.after(() => rm(base, { recursive: true, force: true }));
    await writeFile(path.join(root, ".gitignore"), ".delivery-runs/\n.azure/\nbuild/\nignored/\n");
    await writeFile(path.join(root, "spec.md"), "Implement exactly one local fixture value; no cloud or publication.\n");
    await writeFile(path.join(root, "AGENTS.md"), "Preserve unrelated files and the originally dirty file.\n");
    await writeFile(path.join(root, "src", "existing.txt"), "tracked owner bytes\n");
    await writeFile(path.join(root, "docs", "README.md"), "Original fixture README.\n");
    await writeFile(path.join(root, "scripts", "local.mjs"), localScript);
    await git(root, ["init", "--quiet"]);
    await git(root, ["add", "--", ".gitignore", "spec.md", "AGENTS.md", "src", "docs", "scripts"]);
    await writeFile(path.join(root, "src", "existing.txt"), "initially dirty owner bytes\n");
    const args = input(root);
    const { roots } = await resolveRoots(args);
    return { base, root, roots, args, runId: `workflow-${randomUUID()}` };
}

test("lab intake requires acknowledgement and every independent grant, without broadening another capability", () => {
    const original = input();
    assert.equal(validateLabInput(original), original);
    for (const name of ["provision", "providerRegistration", "publish", "repositoryCreation", "modelTests"]) {
        for (const value of [undefined, "true", 1, null]) {
            const args = clone(original);
            args.authorization[name] = value;
            assert.throws(() => validateLabInput(args), /Explicit authorization/);
        }
        if (name !== "publish") {
            const args = clone(original);
            args.authorization[name] = true;
            validateLabInput(args);
            for (const other of ["provision", "providerRegistration", "publish", "repositoryCreation", "modelTests"]) {
                if (other !== name) assert.equal(args.authorization[other], false);
            }
        }
    }
    for (const name of ["localExecution", "directSdkDispatch"]) {
        const args = clone(original);
        args.authorization[name] = false;
        assert.throws(() => validateLabInput(args), /Explicit Azure lab/);
    }
    assert.throws(() => validateLabInput({ ...original, authorization: { ...original.authorization, acknowledgement: "yes" } }),
        /Explicit Azure lab/);
    assert.throws(() => validateLabInput({ ...original, target: { ...original.target, environment: "production" } }),
        /nonproduction/);
    const registration = clone(original);
    registration.authorization.provision = true;
    registration.azure.providers = ["Microsoft.Storage"];
    assert.throws(() => validateLabInput(registration), /Provider registration lacks authority/);
    const paid = clone(original);
    paid.target.deploy = true;
    paid.acceptance[0].level = "model";
    assert.throws(() => validateLabInput(paid), /Paid model acceptance lacks authority/);
});

test("public and private publication need exact target authority; neither visibility implies repository creation", () => {
    for (const visibility of ["public", "private"]) {
        const args = input();
        args.publication = { repository: "app", github: "fixture-owner/fixture-repo", visibility,
            branch: "fixture", tagRequired: false, create: false };
        assert.throws(() => validateLabInput(args), /Exact publication/);
        args.authorization.publish = true;
        validateLabInput(args);
        assert.equal(args.authorization.repositoryCreation, false);
        args.publication.create = true;
        assert.throws(() => validateLabInput(args), /GitHub repository creation lacks authority/);
        args.authorization.repositoryCreation = true;
        validateLabInput(args);
        for (const field of ["github", "visibility", "branch", "create", "tagRequired"]) {
            const missing = clone(args);
            delete missing.publication[field];
            assert.throws(() => validateLabInput(missing), /Exact publication/);
        }
    }
    const args = input();
    args.authorization.publish = true;
    assert.throws(() => validateLabInput(args), /Publication grant requires exact target/);
    args.authorization.publish = false;
    args.target.requirePublication = true;
    assert.throws(() => validateLabInput(args), /requires publication authority/);
    args.target.requirePublication = false;
    args.repositories.push({ id: "new-root", path: "../new-root", access: "create", scope: ["."] });
    assert.throws(() => validateLabInput(args), /Repository creation is not authorized/);
});

test("dependency-scoped monitoring includes all writes, specification, instructions, script entries and dependencies", () => {
    const args = input();
    args.repositories[0].sourceScope = ["src", "scripts", "docs", "spec.md", "AGENTS.md"];
    args.repositories[0].instructionPaths = ["AGENTS.md"];
    args.commands.test[0].dependencies = [reference("src/existing.txt")];
    validateLabInput(args);
    for (const [removed, expected] of [
        ["src", /Every write scope must be monitored/],
        ["spec.md", /Specification must be monitored/],
        ["AGENTS.md", /Owner instructions must remain monitored/],
    ]) {
        const changed = clone(args);
        changed.repositories[0].sourceScope = changed.repositories[0].sourceScope.filter((scope) => scope !== removed);
        assert.throws(() => validateLabInput(changed), expected);
    }
    const noInstructions = clone(args);
    delete noInstructions.repositories[0].instructionPaths;
    assert.throws(() => validateLabInput(noInstructions), /explicit owner instruction/);
    const entry = clone(args);
    entry.commands.test[0].script = "unmonitored/entry.mjs";
    assert.throws(() => validateLabInput(entry), /Command entry must be monitored/);
    const dependency = clone(args);
    dependency.commands.test[0].dependencies = [reference("unmonitored/dependency.mjs")];
    assert.throws(() => validateLabInput(dependency), /Command dependency must be monitored/);
});

test("bootstrap and documentation assignments require explicit writable scopes and exact Markdown closeout paths", () => {
    for (const name of ["bootstrapPaths", "documentationPaths"]) {
        for (const value of [undefined, [], [{ repository: "unknown", paths: ["docs/README.md"] }],
            [{ repository: "app", paths: ["outside/README.md"] }]]) {
            const args = input();
            args[name] = value;
            assert.throws(() => validateLabInput(args));
        }
    }
    const broad = input();
    broad.documentationPaths[0].paths = ["docs"];
    assert.throws(() => validateLabInput(broad), /exact Markdown files/);
    const readOnly = input();
    readOnly.repositories[0].access = "read";
    assert.throws(() => validateLabInput(readOnly), /Invalid bootstrapPaths assignment/);
});

test("real Git census includes dirty and nonignored untracked bytes, excludes ignored evidence, and enforces declared scopes", async (t) => {
    const h = await fixture(t);
    const initial = await sourceCensus(h.roots);
    assert.equal(initial.app["src/existing.txt"], hashBytes("initially dirty owner bytes\n"));
    await writeFile(path.join(h.root, "src", "untracked.txt"), "untracked but monitored\n");
    await mkdir(path.join(h.root, "ignored"));
    await writeFile(path.join(h.root, "ignored", "noise.txt"), "ignored by Git\n");
    await writeFile(path.join(h.root, ".env"), "fixture excluded credential material\n");
    const after = await sourceCensus(h.roots);
    assert.equal(after.app["src/untracked.txt"], hashBytes("untracked but monitored\n"));
    assert.ok(!("ignored/noise.txt" in after.app));
    assert.ok(!(".env" in after.app));
    assertScopedChanges(initial, after, h.roots, [{ repository: "app", paths: ["src"] }]);
    assert.throws(() => assertScopedChanges(initial, after, h.roots, [{ repository: "app", paths: ["docs"] }]), /Out-of-scope/);
    h.roots.get("app").access = "read";
    assert.throws(() => assertScopedChanges(initial, after, h.roots), /Out-of-scope/);
    h.roots.get("app").access = "write";
    h.roots.get("app").sourceScope = ["src", "scripts", "spec.md", "AGENTS.md", "docs"];
    const partial = await sourceCensus(h.roots);
    await writeFile(path.join(h.root, "unrelated.txt"), "outside explicitly monitored closure\n");
    assert.deepEqual(await sourceCensus(h.roots), partial);
    await writeFile(path.join(h.root, "ignored", "dependency.mjs"), "export default 1;\n");
    await assert.rejects(scriptBinding({ ...command(), dependencies: [reference("ignored/dependency.mjs")] }, h.roots),
        /Command dependency must be monitored/);
    delete h.roots.get("app").sourceScope;
    await assert.rejects(scriptBinding({ ...command(), dependencies: [reference("ignored/dependency.mjs")] }, h.roots),
        /ignored or unmonitored/);
});

test("real roots reject aliases, nested roots and directory junctions, while explicit sibling Git roots resolve", async (t) => {
    const h = await fixture(t);
    const sibling = path.join(h.base, "sibling");
    await mkdir(sibling);
    await git(sibling, ["init", "--quiet"]);
    const args = clone(h.args);
    args.repositories.push({ id: "sibling", path: "../sibling", access: "read" });
    const resolved = await resolveRoots(args);
    assert.equal(resolved.roots.size, 2);
    assert.equal(resolved.roots.get("sibling").absolute.toLowerCase(), sibling.toLowerCase());
    const duplicate = clone(h.args);
    duplicate.repositories.push({ id: "alias", path: ".", access: "read" });
    await assert.rejects(resolveRoots(duplicate), /disjoint/);
    const nested = clone(h.args);
    nested.repositories.push({ id: "nested", path: "new-root", access: "create", scope: ["."] });
    await assert.rejects(resolveRoots(nested), /disjoint/);
    const linked = path.join(h.base, "linked");
    await symlink(sibling, linked, process.platform === "win32" ? "junction" : "dir");
    const linkArgs = clone(h.args);
    linkArgs.repositories.push({ id: "linked", path: "../linked", access: "read" });
    await assert.rejects(resolveRoots(linkArgs), /Linked path/);
    await symlink(path.join(h.root, "scripts"), path.join(h.root, "linked-scripts"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(scriptBinding({ ...command(), script: "linked-scripts/local.mjs" }, h.roots), /[Ll]ink|[Ss]ymlink/);
});

test("task DAG admits parallel disjoint layers and rejects cycles, missing prerequisites, overlaps and uncovered criteria", () => {
    const args = input();
    const sprint = { id: "sprint-one", requirementIds: ["ac-main"] };
    const task = (id, paths, dependsOn = []) => ({ id, kind: "developer", repository: "app", paths, dependsOn,
        requirementIds: ["ac-main"] });
    const plan = { tasks: [task("one", ["src/one"]), task("two", ["src/two"]), task("three", ["src/three"], ["one", "two"])] };
    assert.deepEqual(validateTasks(plan, args, sprint).map((layer) => layer.map((item) => item.id)), [["one", "two"], ["three"]]);
    for (const dependency of ["missing", "one", "three"]) {
        const invalid = clone(plan);
        invalid.tasks[0].dependsOn = [dependency];
        assert.throws(() => validateTasks(invalid, args, sprint), /cycle or missing dependency/);
    }
    for (const paths of [["src"], ["src/one/nested"], ["docs/../src"]]) {
        const invalid = clone(plan);
        invalid.tasks[1].paths = paths;
        assert.throws(() => validateTasks(invalid, args, sprint));
    }
    const unknownRequirement = clone(plan);
    unknownRequirement.tasks[0].requirementIds = ["ac-unapproved"];
    assert.throws(() => validateTasks(unknownRequirement, args, sprint), /invalid sprint task/);
    assert.throws(() => validateTasks(plan, args, { ...sprint, requirementIds: ["ac-main", "ac-unassigned"] }), /Unassigned sprint requirement/);
    const readOnly = clone(args);
    readOnly.repositories[0].access = "read";
    assert.throws(() => validateTasks(plan, readOnly, sprint), /invalid sprint task/);
});

test("native plan policy refuses destroy, replacement, move, import, drift, deferred and unknown changes", () => {
    const item = { address: "fixture_resource.app", type: "fixture_resource", change: { actions: ["create"] } };
    const plan = { resource_changes: [item] };
    const owner = { stateOwner: "fixture-state", subscriptionId: "fixture-sub", tenantId: "fixture-tenant", shared: false };
    validateNativePlan(plan, owner);
    for (const actions of [["delete"], ["delete", "create"], ["create", "delete"], ["unknown"], []]) {
        assert.throws(() => validateNativePlan({ resource_changes: [{ ...item, change: { actions } }] }, owner), /plan action/);
    }
    for (const extra of [{ previous_address: "fixture_resource.old" }, { change: { actions: ["create"], importing: { id: "external" } } }]) {
        assert.throws(() => validateNativePlan({ resource_changes: [{ ...item, ...extra }] }, owner), /plan action/);
    }
    for (const extra of [{ errored: true }, { deferred_changes: [{}] }, { resource_drift: [{}] }]) {
        assert.throws(() => validateNativePlan({ ...plan, ...extra }, owner), /Incomplete\/deferred/);
    }
    const shared = { ...owner, shared: true };
    assert.throws(() => validateNativePlan(plan, shared), /lacks owner authority/);
    const contract = { ...owner, addressPrefixes: ["fixture_resource."], resourceTypes: ["fixture_resource"], actions: ["create"] };
    validateNativePlan(plan, shared, [contract]);
    assert.throws(() => validateNativePlan(plan, shared, [{ ...contract, tenantId: "different" }]), /owner-approved contract/);
    assert.throws(() => validateNativePlan({ resource_changes: [{ ...item, change: { actions: ["update"] } }] }, shared, [contract]),
        /owner-approved contract/);
});

test("actual origin policy rejects credentials, paths, loopback aliases and non-HTTPS authorities", () => {
    assert.equal(validateOrigin("https://fixture.example.invalid"), "https://fixture.example.invalid");
    for (const origin of [
        "http://fixture.example.invalid", "https://fixture.example.invalid/path", "https://fixture.example.invalid/",
        "https://user:password@fixture.example.invalid", "https://localhost", "https://LOCALHOST.",
        "https://service.localhost", "https://127.0.0.1", "https://127.1", "https://2130706433",
        "https://0x7f000001", "https://0.0.0.0", "https://[::1]", "https://[0:0:0:0:0:0:0:1]",
        "https://[::]", "https://[::ffff:127.0.0.1]", "https://fixture.example.invalid?query=1",
        "https://fixture.example.invalid#fragment",
    ]) assert.throws(() => validateOrigin(origin), undefined, origin);
});

test("runtime model access denies ungranted IAM and binds native or AzAPI creates to one observed principal and exact scope/role", () => {
    const args = input();
    args.azure.subscriptionId = "11111111-1111-4111-8111-111111111111";
    args.azure.tenantId = "22222222-2222-4222-8222-222222222222";
    args.target.deploy = true;
    args.authorization.provision = true;
    args.authorization.runtimeIdentityModelAccess = true;
    args.deploymentOrder = "identity-before-post-provision";
    args.infrastructureProfile = reference("src/infrastructure-profile.json");
    const base = `/subscriptions/${args.azure.subscriptionId}`;
    const scope = `${base}/resourceGroups/lab-fixture/providers/Microsoft.CognitiveServices/accounts/fixture-model`;
    const role = `${base}/providers/Microsoft.Authorization/roleDefinitions/33333333-3333-4333-8333-333333333333`;
    const declared = { deploymentResourceId: `${base}/resourceGroups/lab-fixture/providers/Microsoft.App/containerApps/fixture-app`,
        assignments: [{ scope, roleDefinitionId: role }] };
    const policy = runtimeAccessPolicy(args, { runtimeIdentityModelAccess: declared });
    const identity = { principalId: "44444444-4444-4444-8444-444444444444", resourceId: declared.deploymentResourceId,
        subscriptionId: args.azure.subscriptionId, tenantId: args.azure.tenantId, evidence: ["actual-native-identity-receipt"] };
    validateLabInput(args);
    assert.deepEqual(validateRuntimeIdentity(identity, args, policy), identity);
    const owner = { shared: false, region: args.azure.region };
    const access = { phase: "after-deploy", identity, policy };
    const after = { scope, role_definition_id: role, principal_id: identity.principalId, principal_type: "ServicePrincipal" };
    const item = { address: "azurerm_role_assignment.model", type: "azurerm_role_assignment", change: { actions: ["create"], after } };
    const plan = (resource = item) => ({ resource_changes: [resource] });
    validateNativePlan(plan(), owner, [], { runtimeAccess: access });
    assert.throws(() => validateNativePlan(plan(), owner), /separately authorized post-deployment/);
    assert.throws(() => validateNativePlan(plan(), owner, [], { runtimeAccess: { ...access, phase: "before-deploy" } }),
        /separately authorized post-deployment/);
    for (const grant of [undefined, false]) {
        const ungranted = clone(args);
        ungranted.authorization.runtimeIdentityModelAccess = grant;
        assert.equal(runtimeAccessPolicy(ungranted, { runtimeIdentityModelAccess: declared }), null);
    }
    const noOptIn = clone(args);
    delete noOptIn.deploymentOrder;
    assert.throws(() => validateLabInput(noOptIn), /separate authority, opt-in ordering/);
    for (const override of [
        { principal_id: "55555555-5555-4555-8555-555555555555" }, { scope: `${base}/resourceGroups/lab-fixture` },
        { role_definition_id: `${base}/providers/Microsoft.Authorization/roleDefinitions/66666666-6666-4666-8666-666666666666` },
        { principal_type: "User" }, { condition: "@Resource[anything]" }, { condition_version: "2.0" },
        { delegated_managed_identity_resource_id: declared.deploymentResourceId }, { role_definition_name: "Owner" },
        { custom_grant: true },
    ]) assert.throws(() => validateNativePlan(plan({ ...item, change: { ...item.change, after: { ...after, ...override } } }),
        owner, [], { runtimeAccess: access }));
    for (const actions of [["update"], ["delete", "create"]]) {
        assert.throws(() => validateNativePlan(plan({ ...item, change: { ...item.change, actions } }), owner, [], { runtimeAccess: access }));
    }
    const properties = { principalId: identity.principalId, principalType: "ServicePrincipal", roleDefinitionId: role };
    const azapi = { address: "azapi_resource.model_access", type: "azapi_resource",
        change: { actions: ["create"], after: { type: "Microsoft.Authorization/roleAssignments@2022-04-01", parent_id: scope,
            body: { properties } } } };
    validateNativePlan(plan(azapi), owner, [], { canonical: true, runtimeAccess: access });
    for (const extra of [{ condition: "unsupported" }, { delegatedManagedIdentityResourceId: declared.deploymentResourceId },
        { principalId: "55555555-5555-4555-8555-555555555555" }]) {
        assert.throws(() => validateNativePlan(plan({ ...azapi, change: { ...azapi.change, after: { ...azapi.change.after,
            body: { properties: { ...properties, ...extra } } } } }), owner, [], { canonical: true, runtimeAccess: access }));
    }
    assert.throws(() => validateRuntimeIdentity({ ...identity, resourceId: `${declared.deploymentResourceId}-other` }, args, policy),
        /exact deployed target/);
    assert.throws(() => runtimeAccessPolicy(args, { runtimeIdentityModelAccess: { ...declared, assignments: [{
        scope: scope.replace(args.azure.subscriptionId, "unauthorized-subscription"), roleDefinitionId: role,
    }] } }), /authorized subscription/);
});

test("coverage requires one positive evidence-bearing result for each exact criterion", () => {
    const acceptance = input().acceptance;
    validateCoverage({ coverage: coverage() }, acceptance);
    for (const items of [
        [], [...coverage(), ...coverage()], [{ ...coverage()[0], id: "ac-unapproved" }],
        [{ ...coverage()[0], status: "blocked" }], [{ ...coverage()[0], evidence: [] }],
        [{ ...coverage()[0], evidence: [""] }],
    ]) assert.throws(() => validateCoverage({ coverage: items }, acceptance));
});

test("numeric capacity combines available and allocated only with exact started revision/plan proof", () => {
    const model = { name: "fixture-model", version: "fixture-version", sku: "fixture-sku", unit: "fixture-units", requiredCapacity: 10 };
    const observation = { ...model, supported: true, availableCapacity: 10 };
    validateCapacityObservation({ models: [observation] }, [model]);
    const allocated = { ...observation, availableCapacity: 4, allocatedCapacity: 6,
        allocationRevision: "fixture-revision", planIdentity: "fixture-plan", allocationEvidence: ["actual-local-allocation-receipt"] };
    const started = [{ state: "started", binding: { revision: allocated.allocationRevision, planIdentity: allocated.planIdentity } }];
    validateCapacityObservation({ models: [allocated] }, [model], started);
    for (const operations of [[], [{ ...started[0], binding: { ...started[0].binding, revision: "stale-revision" } }],
        [{ ...started[0], binding: { ...started[0].binding, planIdentity: "different-plan" } }]]) {
        assert.throws(() => validateCapacityObservation({ models: [allocated] }, [model], operations), /exact same-run started-plan proof/);
    }
    for (const overrides of [
        { availableCapacity: null }, { availableCapacity: NaN }, { availableCapacity: "10" }, { availableCapacity: -1 },
        { supported: false }, { version: "substituted-version" }, { sku: "substituted-sku" }, { unit: "different-unit" },
    ]) assert.throws(() => validateCapacityObservation({ models: [{ ...observation, ...overrides }] }, [model]), /Unknown\/unsupported\/substituted/);
    assert.throws(() => validateCapacityObservation({ models: [{ ...allocated, allocationEvidence: [] }] }, [model], started),
        /exact same-run started-plan proof/);
    assert.throws(() => validateCapacityObservation({ models: [{ ...allocated, allocatedCapacity: -1 }] }, [model], started),
        /Unknown allocated/);
    assert.throws(() => validateCapacityObservation({ models: [{ ...allocated, allocatedCapacity: 5 }] }, [model], started),
        /Insufficient exact model capacity/);
    assert.throws(() => validateCapacityObservation({ models: [] }, [model]), /Missing numeric model capacity/);
});

function workflowContext(h, options = {}) {
    const calls = [];
    const phases = [];
    const broker = createTicketBroker();
    const ctx = {
        args: h.args, runId: h.runId, phase: (value) => phases.push(value),
        async parallel(thunks) { return Promise.all(thunks.map((thunk) => thunk())); },
        async agent(prompt, config) {
            const call = { prompt, ...config };
            calls.push(call);
            if (config.agent === "lab-operator") {
                const token = /Execute only ticket ([a-f0-9-]{36}) /.exec(prompt)?.[1];
                assert.ok(token);
                if (options.beforeOperator) await options.beforeOperator(call);
                call.nativeReceipt = await broker.invoke(token);
                return { invoked: true, status: "operator summaries are not native evidence" };
            }
            const loop = /Loop: ([A-Za-z0-9-]+)\./.exec(prompt)?.[1];
            assert.ok(loop, "dispatch uses the real runAgreement loop label");
            const data = JSON.parse(prompt.slice(prompt.indexOf("Stage data: ") + "Stage data: ".length));
            call.loop = loop;
            call.data = data;
            const owner = "status" in config.schema.properties;
            call.owner = owner;
            assert.match(config.label, /:attempt-1:[a-f0-9]{64}:[a-f0-9-]{36}$/);
            if (!owner) {
                assert.equal(config.agent, "lab-reader");
                assert.deepEqual(data.validationErrors, [], `owner artifact for ${loop} is semantically valid`);
                assert.match(prompt, /READINESS:/);
                if (["userExperience", "sprintDesign", "uiWork"].includes(loop)) {
                    assert.equal(data.report.artifact.applicable, false);
                    assert.match(data.report.artifact.rationale, /non-UI/);
                }
                return vote();
            }
            if (options.owner) {
                const overridden = await options.owner(call, data.context);
                if (overridden !== undefined) return overridden;
            }
            let artifact;
            const document = { document: `${loop}: substantive local fixture design and evidence.` };
            if (loop === "bootstrap-scripts") {
                assert.equal(config.agent, "lab-author");
                artifact = { identity: { command: command("identity") }, topology: { command: command("topology") } };
            } else if (loop.startsWith("bootstrap-") || loop.startsWith("resume-")) artifact = data.context.data;
            else if (loop === "releasePlan") artifact = { terraformPolicy: data.context.args.terraformPolicy,
                sprints: [{ id: "sprint-one", goal: "Deliver one local fixture.", requirementIds: ["ac-main"] }] };
            else if (loop === "sprintPlan") artifact = { tasks: [
                { id: "feature", repository: "app", kind: "developer", paths: ["src/feature.txt"], dependsOn: [], requirementIds: ["ac-main"] },
                { id: "ui-na", repository: "app", kind: "ui", paths: ["src/ui"], dependsOn: [], requirementIds: ["ac-main"] },
            ] };
            else if (loop === "developerWork") {
                assert.equal(config.agent, "lab-author");
                await writeFile(path.join(h.root, "src", "feature.txt"), "implemented fixture value\n");
                artifact = { ...document, changedPaths: ["src/feature.txt"] };
            } else if (["userExperience", "sprintDesign", "uiWork"].includes(loop)) {
                artifact = { ...document, applicable: false, rationale: "Explicit non-UI fixture; no screens or browser interactions." };
            } else if (loop === "devOps") artifact = { provisionStages: [], smoke: [] };
            else if (loop === "endToEnd") artifact = { coverage: coverage() };
            else if (loop === "sprintReview") artifact = { coverage: coverage(), backlog: [
                { id: "future-goal", requirementIds: ["ac-future"], description: "New goal requires a separate authorization.", blocking: false },
            ] };
            else if (loop === "retrospective") artifact = { ...document, improvements: ["Retain actual local evidence for the next sprint."] };
            else if (loop === "closeout") {
                assert.equal(config.agent, "lab-author");
                await writeFile(path.join(h.root, "docs", "README.md"), "Fixture built locally; not deployed or published.\n");
                await writeFile(path.join(h.root, "docs", "RELEASE-NOTES.md"), "ac-main verified by native local tests.\n");
                artifact = { ...document, coverage: coverage(), readme: reference("docs/README.md"),
                    releaseNotes: reference("docs/RELEASE-NOTES.md") };
            } else {
                assert.ok(["architecture", "sprintArchitecture"].includes(loop), `unexpected loop ${loop}`);
                artifact = { ...document, ...(loop === "architecture" ? { terraformPolicy: data.context.args.terraformPolicy } : {}) };
            }
            return proposal(artifact);
        },
    };
    return { ctx, calls, phases, broker, run: () => createLabRunner({ broker, observePublication: options.observePublication })(ctx) };
}

test("one full built delivery exercises all 13 independently reviewed loops, native local checks and scoped author/docs changes", async (t) => {
    const h = await fixture(t);
    const before = await sourceCensus(h.roots);
    const stagedBefore = await git(h.root, ["diff", "--cached", "--binary"]);
    const harness = workflowContext(h);
    const result = await harness.run();
    assert.equal(result.status, "built", JSON.stringify(result));
    assert.equal(result.stage, "closeout");
    assert.deepEqual(result.completedSprints, ["sprint-one"]);
    assert.deepEqual(result.coverage, coverage());
    assert.equal(result.delivery.status, "built");
    assert.equal(result.delivery.webOrigin, null);
    assert.equal(result.backlog[0].deferred, true);
    assert.match(result.documentationPublication, /local/);
    const after = await sourceCensus(h.roots);
    const changed = Object.keys(after.app).filter((file) => before.app[file] !== after.app[file]).sort();
    assert.deepEqual(changed, ["docs/README.md", "docs/RELEASE-NOTES.md", "src/feature.txt"]);
    for (const [file, hash] of Object.entries(before.app)) {
        if (file !== "docs/README.md") assert.equal(after.app[file], hash, `original ${file} is unchanged`);
    }
    assert.equal(await readFile(path.join(h.root, "src", "existing.txt"), "utf8"), "initially dirty owner bytes\n");
    assert.equal(await git(h.root, ["diff", "--cached", "--binary"]), stagedBefore, "workflow never stages unrelated dirty work");
    assert.equal(result.closeoutSourceFingerprint, digest(after));
    assert.notEqual(result.delivery.sourceFingerprint, result.closeoutSourceFingerprint, "docs are distinguished from the frozen build");
    for (const [loop, definition] of Object.entries(LOOP_DEFINITIONS)) {
        if (loop === "publication") continue;
        const owners = harness.calls.filter((call) => call.loop === loop && call.owner);
        assert.equal(owners.length, 1, `exactly one ${loop} owner proposal`);
        assert.match(owners[0].prompt, new RegExp(`Role: ${definition.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
        const reviewers = harness.calls.filter((call) => call.loop === loop && !call.owner);
        assert.deepEqual(reviewers.map((call) => /Independent reviewer role: ([^.]+)\./.exec(call.prompt)[1]), definition.reviewers);
    }
    const operators = harness.calls.filter((call) => call.agent === "lab-operator");
    assert.equal(operators.length, 6, "identity, topology, baseline, test, build and post-doc test actually execute");
    for (const call of operators) {
        assert.equal(call.nativeReceipt.outcome.ok, true);
        assert.equal(call.nativeReceipt.actual.status, "PASS");
        assert.equal(call.nativeReceipt.sourceIntact, true);
    }
    const directory = await artifactDirectory(h.root, h.runId);
    const state = await readArtifact(directory, "lab-state.json");
    const build = state.sprints["sprint-one"].build;
    assert.equal(build.artifacts[0].sha256, hashBytes(await readFile(path.join(h.root, ...build.artifacts[0].path.split("/")))));
    const buildSnapshot = `retained-${build.artifacts[0].sha256}.bin`;
    assert.equal(state.retained[buildSnapshot], build.artifacts[0].sha256);
    assert.equal(hashBytes(await readFile(path.join(directory, buildSnapshot))), build.artifacts[0].sha256);
    const files = await readdir(directory);
    const agreements = await Promise.all(files.filter((name) => /-attempt-1\.json$/.test(name))
        .map((name) => readArtifact(directory, name)));
    assert.equal(agreements.length, 16, "13 release loops and three bootstrap agreements persist");
    assert.ok(agreements.every((record) => record.context === "readiness" && record.reviews.every((review) => review.report.verdict === "PASS")));
    assert.equal(new Set(harness.calls.map((call) => call.label)).size, harness.calls.length);
    assert.ok(harness.phases.includes("Release Closeout"));
    assert.deepEqual(await readArtifact(path.join(h.root, ".delivery-runs"), "lab-target-ledger.json"), null);
    assert.equal(await readArtifact(path.join(h.root, ".delivery-runs"), "lab-active.json"), null);
});

test("blocking in-scope backlog revises the reviewed release plan and carries retro context into a real second sprint", async (t) => {
    const h = await fixture(t);
    h.args.maxSprints = 2;
    const carried = [];
    const improvement = "Check the second sprint correction against retained first sprint evidence.";
    const harness = workflowContext(h, {
        async owner(call, context) {
            if (call.loop === "releasePlan" && context.corrections) {
                assert.deepEqual(context.completedSprints, ["sprint-one"]);
                assert.deepEqual(context.corrections.map((item) => item.id), ["fix-local"]);
                assert.deepEqual(context.improvements, [improvement]);
                return proposal({ terraformPolicy: context.args.terraformPolicy, sprints: [
                    ...clone(context.priorRelease.sprints),
                    { id: "sprint-two", goal: "Correct the original authorized requirement.", requirementIds: ["ac-main"], backlogIds: ["fix-local"] },
                ] });
            }
            if (call.loop === "sprintReview") {
                if (context.sprint.id === "sprint-one") return proposal({
                    coverage: [{ ...coverage()[0], status: "blocked", evidence: ["observed-local-fixture-correction-needed"] }],
                    backlog: [
                        { id: "fix-local", requirementIds: ["ac-main"], description: "Add an in-scope correction.", blocking: true },
                        { id: "future-goal", requirementIds: ["ac-future"], description: "Outside the original authorized goal.", blocking: true },
                    ], resolvedBacklogIds: [],
                });
                assert.equal(await readFile(path.join(h.root, "src", "correction.txt"), "utf8"), "verified second sprint correction\n");
                return proposal({ coverage: coverage(), backlog: [], resolvedBacklogIds: ["fix-local"] });
            }
            if (call.loop === "retrospective") return proposal({
                document: "Observed correction planning and evidence handoff.", improvements: [improvement],
            });
            if (context.sprint?.id === "sprint-two") {
                assert.deepEqual(context.previousSprints, ["sprint-one"]);
                assert.deepEqual(context.improvements, [improvement]);
                assert.equal(context.backlog.find((item) => item.id === "fix-local").status, "open");
                assert.equal(context.backlog.find((item) => item.id === "future-goal").deferred, true);
                assert.equal(context.previousDelivery.status, "built");
                carried.push(call.loop);
                if (call.loop === "sprintPlan") return proposal({ tasks: [{
                    id: "correction", repository: "app", kind: "developer", paths: ["src/correction.txt"],
                    dependsOn: [], requirementIds: ["ac-main"],
                }] });
                if (call.loop === "developerWork") {
                    await writeFile(path.join(h.root, "src", "correction.txt"), "verified second sprint correction\n");
                    return proposal({ document: "Implemented only the reviewed in-scope correction.", changedPaths: ["src/correction.txt"] });
                }
            }
        },
    });
    const result = await harness.run();
    assert.equal(result.status, "built", JSON.stringify(result));
    assert.deepEqual(result.completedSprints, ["sprint-one", "sprint-two"]);
    assert.equal(result.backlog.find((item) => item.id === "fix-local").status, "resolved");
    assert.equal(result.backlog.find((item) => item.id === "future-goal").deferred, true);
    for (const loop of ["sprintDesign", "sprintArchitecture", "sprintPlan", "developerWork", "devOps", "endToEnd"]) {
        assert.ok(carried.includes(loop), `${loop} consumes the actual prior sprint's backlog and retro`);
    }
    const directory = await artifactDirectory(h.root, h.runId);
    const state = await readArtifact(directory, "lab-state.json");
    assert.equal(state.releasePlanRevisions.length, 1);
    assert.deepEqual(state.releasePlanRevisions[0].sprints[0],
        harness.calls.find((call) => call.loop === "releasePlan" && !call.owner).data.report.artifact.sprints[0]);
    assert.deepEqual(state.releasePlanRevisions[0].sprints[1].backlogIds, ["fix-local"]);
    const builds = Object.values(state.sprints).map((sprint) => sprint.build);
    assert.notEqual(builds[0].sourceFingerprint, builds[1].sourceFingerprint);
    assert.notEqual(builds[0].buildFingerprint, builds[1].buildFingerprint);
    for (const build of builds) {
        const artifact = build.artifacts[0];
        assert.equal(hashBytes(await readFile(path.join(h.root, ...artifact.path.split("/")))), artifact.sha256,
            "each sprint retains its own immutable build artifact");
        const snapshot = `retained-${artifact.sha256}.bin`;
        assert.equal(state.retained[snapshot], artifact.sha256);
        assert.equal(hashBytes(await readFile(path.join(directory, snapshot))), artifact.sha256,
            "the first sprint snapshot survives later authoring and builds");
    }
    assert.equal(harness.calls.filter((call) => call.agent === "lab-operator").length, 8);
    assert.equal(harness.calls.filter((call) => call.loop === "releasePlan" && call.owner).length, 2);
    assert.equal(await readArtifact(path.join(h.root, ".delivery-runs"), "lab-active.json"), null);
});

const cloudFixtureScript = `
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
const env = process.env;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => hash(JSON.stringify(value));
const parse = async file => JSON.parse(await readFile(file, "utf8"));
const output = env.DELIVERY_EVIDENCE_PATH;
const directory = path.dirname(output);
const relative = file => path.relative(process.cwd(), file).replaceAll("\\\\", "/");
const stage = process.argv[3];
const mode = process.argv[2];
const identityFirst = process.argv[4] === "identity-first";
const profile = identityFirst ? await parse("src/infrastructure-profile.json") : null;
const principalId = "44444444-4444-4444-8444-444444444444";
const binding = { runId: env.DELIVERY_RUN_ID, sourceFingerprint: env.DELIVERY_SOURCE_FINGERPRINT };
for (const [key, name] of Object.entries({
    buildFingerprint: "DELIVERY_BUILD_FINGERPRINT", revision: "DELIVERY_REVISION",
    sprintId: "DELIVERY_SPRINT_ID", planAggregate: "DELIVERY_PLAN_AGGREGATE",
    stageId: "DELIVERY_PROVISION_STAGE", planIdentity: "DELIVERY_PLAN_IDENTITY",
    planEvidence: "DELIVERY_PLAN_EVIDENCE", planContext: "DELIVERY_PLAN_CONTEXT", webOrigin: "DELIVERY_WEB_ORIGIN",
})) if (env[name]) binding[key] = env[name];
if (env.DELIVERY_PROVISION_STAGE_INDEX !== "") binding.stageIndex = Number(env.DELIVERY_PROVISION_STAGE_INDEX);
const ownership = { stateOwner: "fixture-only-state", shared: false, subscriptionId: env.DELIVERY_SUBSCRIPTION_ID,
    tenantId: env.DELIVERY_TENANT_ID, region: env.DELIVERY_REGION };
const ledger = await parse(".delivery-runs/lab-target-ledger.json").catch(error => {
    if (error.code !== "ENOENT") throw error;
    return { operations: [] };
});
const marker = name => path.join(directory, "fixture-effect-" + name + ".json");
let data;
if (mode === "plan") {
    const policyContext = await parse(env.DELIVERY_PLAN_CONTEXT);
    assert.equal(policyContext.policyIdentity, digest(policyContext.policy));
    assert.deepEqual(policyContext.policy.terraform, { requirement: "any", preference: "avm" });
    assert.equal(policyContext.policy.metadata.registryState, "finalized");
    assert.equal(binding.planAggregate, digest(policyContext.priorAdmissions));
    assert.equal(binding.stageId, stage);
    assert.equal(binding.stageIndex, stage === "foundation" ? 0 : 1);
    if (stage === "foundation") assert.equal(binding.planAggregate, digest([]));
    else {
        const previous = ledger.operations.find(item => item.kind === "provision-sprint-one-foundation");
        assert.equal(previous.state, "completed", "second plan waits for positive reconciliation of the first stage");
        assert.equal(previous.reconciliation.effect, "completed");
    }
    const access = identityFirst && stage === "model-access";
    if (access) {
        const deployed = ledger.operations.find(item => item.kind === "deploy-sprint-one");
        assert.equal(deployed.state, "completed", "identity is positively observed before planning its access");
        const pin = policyContext.runtimeIdentity;
        assert.equal(pin.operationId, deployed.id);
        assert.equal(pin.identity.principalId, principalId);
        assert.equal(pin.identity.resourceId, profile.policy.runtimeIdentityModelAccess.deploymentResourceId);
        assert.equal(hash(await readFile(pin.path)), pin.evidenceHash, "post plan consumes the pinned native identity receipt");
    }
    const binary = Buffer.from("local saved native plan fixture " + stage);
    const resource = access ? {
        address: "azurerm_role_assignment.model", type: "azurerm_role_assignment",
        change: { actions: ["create"], after: {
            principal_id: policyContext.runtimeIdentity.identity.principalId, principal_type: "ServicePrincipal",
            scope: profile.policy.runtimeIdentityModelAccess.assignments[0].scope,
            role_definition_id: profile.policy.runtimeIdentityModelAccess.assignments[0].roleDefinitionId,
        } },
    } : { address: "fixture_resource." + stage, type: "fixture_resource", change: { actions: ["create"] } };
    const json = Buffer.from(JSON.stringify({ resource_changes: [resource] }));
    const addresses = new Set();
    for (const admission of policyContext.priorAdmissions) for (const plan of admission.plans) {
        for (const resource of plan.summary) if (resource.actions.some(action => ["create", "update"].includes(action))) {
            addresses.add(plan.ownership.stateOwner + ":" + resource.address);
        }
    }
    addresses.add(ownership.stateOwner + ":" + resource.address);
    const sortedAddresses = [...addresses].sort();
    const plansDirectory = path.resolve(".azure", "lab-delivery", env.DELIVERY_RUN_ID);
    await mkdir(plansDirectory, { recursive: true });
    const binaryPath = path.join(plansDirectory, stage + ".bin");
    const jsonPath = path.join(plansDirectory, stage + ".json");
    const guardPath = path.join(plansDirectory, stage + "-guard.json");
    await writeFile(binaryPath, binary);
    await writeFile(jsonPath, json);
    const guard = { version: 2, status: "PASS", policyIdentity: policyContext.policyIdentity,
        checks: Object.fromEntries(["resourceSemantics", "parentIds", "remoteIds", "permittedProperties",
            "dependencyClosure", "cumulativeScope", "terraformPolicy", "acceptedMetadata"].map(name =>
                [name, { pass: true, evidence: ["local-fixture-check-" + name] }])),
        scope: { addresses: sortedAddresses, count: sortedAddresses.length },
        binaryHash: hash(binary), jsonHash: hash(json),
        ...ownership, sourceFingerprint: binding.sourceFingerprint, binding, evidence: ["local fixture binary/json correspondence"] };
    if (access) {
        guard.runtimeIdentityHash = policyContext.runtimeIdentity.evidenceHash;
        guard.checks.runtimeIdentityModelAccess = { pass: true, evidence: ["local exact principal/scope/role observation"] };
    }
    await writeFile(guardPath, JSON.stringify(guard));
    data = { plans: [{ repository: "app", binary: relative(binaryPath), json: relative(jsonPath),
        guard: relative(guardPath), ownership }] };
} else if (mode === "apply" || mode === "mutate") {
    const intent = await parse(output.replace(/-evidence\\.json$/, "-intent.json"));
    const operation = ledger.operations.find(item => item.id === env.DELIVERY_OPERATION_ID);
    assert.equal(operation.state, "started", "native intent is durable before this child begins");
    assert.equal(intent.operationId, operation.id);
    assert.deepEqual(intent.binding, binding);
    if (mode === "apply") {
        const state = await parse(path.join(directory, "lab-state.json"));
        const admission = state.sprints[binding.sprintId].admissions[binding.stageIndex];
        assert.equal(admission.planIdentity, binding.planIdentity, "independently reviewed plan is admitted before apply");
        assert.equal(hash(await readFile(binding.planEvidence)), admission.plans[0].hashes.binary);
        assert.equal(binding.planEvidence, admission.plans[0].binary);
    } else if (stage === "deploy") {
        assert.equal(ledger.operations.filter(item => item.kind.startsWith("provision-") && item.state === "completed").length,
            identityFirst ? 1 : 2);
    } else {
        assert.equal(stage, "smoke");
        assert.equal(binding.webOrigin, "https://fixture.example.invalid");
        const state = await parse(path.join(directory, "lab-state.json"));
        const pin = state.sprints[binding.sprintId].originPin;
        assert.equal(hash(await readFile(pin.path)), pin.evidenceHash, "smoke sees the actual pinned origin receipt");
        assert.equal(pin.origin, binding.webOrigin);
    }
    await writeFile(marker(stage), JSON.stringify({ binding, operationId: operation.id }));
    data = { observedLocalEffect: stage };
} else if (mode === "reconcile") {
    const actual = await parse(marker(stage)).catch(error => {
        if (error.code !== "ENOENT" || !identityFirst || stage !== "model-access") throw error;
        return null;
    });
    if (!actual) data = { effect: "absent", safeToRetry: true, observations: ["local missing role-assignment marker"] };
    else {
    if (identityFirst && stage === "deploy") {
        assert.equal(actual.binding.sourceFingerprint, binding.sourceFingerprint);
        assert.equal(actual.binding.buildFingerprint, binding.buildFingerprint);
        assert.equal(actual.binding.revision, binding.revision);
    } else assert.deepEqual(actual.binding, binding);
    assert.equal(actual.operationId, env.DELIVERY_OPERATION_ID, "reconciliation keeps the original mutation identity");
    const original = ledger.operations.find(item => item.id === actual.operationId);
    assert.ok(["unknown", "completed", "absent"].includes(original.state), "observer only reconciles a retained native operation");
    data = { effect: "completed", observations: [relative(marker(stage))] };
    if (stage === "smoke") Object.assign(data, { acceptancePassed: true, coverage: [{
        id: "ac-live", status: "verified", evidence: [relative(marker(stage))]
    }] });
    if (identityFirst && stage === "deploy") {
        const changed = await parse(".azure/runtime-identity-override.json").catch(error => {
            if (error.code !== "ENOENT") throw error;
            return null;
        });
        data.runtimeIdentity = { principalId: changed?.principalId ?? principalId,
            resourceId: profile.policy.runtimeIdentityModelAccess.deploymentResourceId,
            subscriptionId: env.DELIVERY_SUBSCRIPTION_ID, tenantId: env.DELIVERY_TENANT_ID,
            evidence: ["actual local deployment marker " + actual.operationId] };
    }
    }
} else {
    assert.equal(mode, "verify");
    if (identityFirst) {
        const failure = await parse(".azure/fail-verify.json").catch(error => {
            if (error.code !== "ENOENT") throw error;
            return null;
        });
        if (failure?.enabled) {
            await appendFile(path.join(directory, "cloud-events.jsonl"), JSON.stringify({
                mode, stage, binding, operationId: env.DELIVERY_OPERATION_ID, failed: true
            }) + "\\n");
            await writeFile(output, JSON.stringify({ status: "FAIL", binding,
                evidence: ["actual local native verify failure"], data: { failure: "fixture-exit-31" } }));
            process.exit(31);
        }
    }
    const deployed = await parse(marker("deploy"));
    if (identityFirst) {
        assert.equal(deployed.binding.sourceFingerprint, binding.sourceFingerprint);
        assert.equal(deployed.binding.buildFingerprint, binding.buildFingerprint);
        assert.equal(deployed.binding.revision, binding.revision);
        assert.equal(ledger.operations.filter(item => item.kind.startsWith("provision-") && item.state === "completed").length, 2);
    } else assert.deepEqual(deployed.binding, binding);
    assert.equal(ledger.operations.find(item => item.id === deployed.operationId).state, "completed");
    data = { webOrigin: "https://fixture.example.invalid", revision: binding.revision, buildFingerprint: binding.buildFingerprint };
}
await appendFile(path.join(directory, "cloud-events.jsonl"), JSON.stringify({
    mode, stage, binding, operationId: env.DELIVERY_OPERATION_ID
}) + "\\n");
await writeFile(output, JSON.stringify({ status: "PASS", binding, evidence: ["local fake-cloud fixture; no network"], data }));
`;

for (const resume of [false, true]) {
test(resume ? "native staged resume preserves finalized policy and reconciles an admitted stage without replan or reapply"
    : "full native fake-cloud delivery plans, admits, applies and reconciles two ordered stages before pinned-origin smoke", async (t) => {
    const h = await fixture(t);
    h.args.target.deploy = true;
    h.args.authorization.provision = true;
    h.args.attempts.recovery = resume ? 2 : 1;
    h.args.infrastructureProfile = reference("src/infrastructure-profile.json");
    const infrastructureRules = { stateOwner: "fixture-only-state", maxResources: 2,
        armTypes: ["Fixture.Local/resources"], subscriptionId: h.args.azure.subscriptionId,
        tenantId: h.args.azure.tenantId, region: h.args.azure.region };
    const finalizedRegistry = { registryState: "finalized", resourceNames: ["foundation", "service"] };
    const registryPath = path.join(h.root, "src", "infrastructure-profile.json");
    await writeFile(registryPath, JSON.stringify({ policy: infrastructureRules,
        metadata: { ...finalizedRegistry, registryState: resume ? "reserved" : "finalized" } }));
    h.args.acceptance.push({ id: "ac-live", criterion: "The fake-cloud fixture exposes the admitted local revision.", level: "live" });
    await writeFile(path.join(h.root, "scripts", "cloud-fixture.mjs"), cloudFixtureScript);
    const native = (mode, stage) => ({ ...command(), script: "scripts/cloud-fixture.mjs", args: [mode, stage] });
    const operation = (stage, mode = "mutate") => ({ command: native(mode, stage), reconcile: native("reconcile", stage) });
    let liveCoverage;
    const allCoverage = () => [...coverage(), liveCoverage];
    const options = {
        async beforeOperator(call) {
            if (resume && /:plan-sprint-one-service:/.test(call.label)) throw new Error("Fixture interrupted after reconciled first stage");
        },
        async owner(call, context) {
            if (call.loop === "releasePlan") return proposal({ terraformPolicy: context.args.terraformPolicy, sprints: [{
                id: "sprint-one", goal: "Exercise local fake-cloud execution only.", requirementIds: ["ac-main", "ac-live"],
            }] });
            if (call.loop === "sprintPlan") return proposal({ tasks: [{
                id: "feature", repository: "app", kind: "developer",
                paths: ["src/feature.txt", ...(resume ? ["src/infrastructure-profile.json"] : [])],
                dependsOn: [], requirementIds: ["ac-main", "ac-live"],
            }] });
            if (resume && call.loop === "developerWork") {
                const originalProfile = JSON.parse(await readFile(registryPath, "utf8"));
                assert.deepEqual(originalProfile.policy, infrastructureRules);
                assert.equal(originalProfile.metadata.registryState, "reserved");
                await writeFile(path.join(h.root, "src", "feature.txt"), "implemented fixture value\n");
                await writeFile(registryPath, JSON.stringify({ ...originalProfile, metadata: finalizedRegistry }));
                return proposal({ document: "Finalized the reserved registry during the authorized source implementation.",
                    changedPaths: ["src/feature.txt", "src/infrastructure-profile.json"] });
            }
            if (call.loop === "infrastructure-policy") {
                assert.deepEqual(context.policy.rules, infrastructureRules);
                assert.deepEqual(context.policy.metadata, finalizedRegistry);
                return proposal({ policyIdentity: digest(context.policy) });
            }
            if (call.loop === "devOps") return proposal({
                provisionStages: ["foundation", "service"].map((id) => ({ id, plan: native("plan", id), ...operation(id, "apply") })),
                deploy: operation("deploy"), verify: native("verify", "deploy"), smoke: [operation("smoke")],
            });
            if (call.loop.startsWith("exact-plan-")) {
                for (const plan of context.plans) {
                    assert.deepEqual(plan.summary, [{
                        address: `fixture_resource.${context.stage.id}`, type: "fixture_resource", actions: ["create"],
                    }]);
                    assert.ok(!("resource_changes" in plan), "review receives a sanitized resource summary, not raw native JSON");
                    assert.equal(hashBytes(await readFile(path.join(h.root, ...plan.binary.split("/")))), plan.hashes.binary);
                    const guard = JSON.parse(await readFile(path.join(h.root, ...plan.guard.split("/")), "utf8"));
                    assert.equal(guard.binaryHash, plan.hashes.binary);
                    assert.equal(guard.jsonHash, plan.hashes.json);
                    assert.equal(guard.version, 2);
                }
                return proposal({ planIdentity: digest(context.plans) });
            }
            if (call.loop.startsWith("recovery-")) return proposal({ command: context.command });
            if (call.loop === "sprintReview") {
                assert.equal(context.delivery.webOrigin, "https://fixture.example.invalid");
                assert.equal(context.nativeCoverage.length, 1);
                const native = context.nativeCoverage[0];
                assert.equal(native.id, "ac-live");
                assert.equal(native.status, "verified");
                assert.match(native.receipt, /^native-[a-f0-9-]{36}$/);
                liveCoverage = { id: native.id, status: native.status, evidence: [...native.evidence, native.receipt] };
                return proposal({ coverage: allCoverage(), backlog: [], resolvedBacklogIds: [] });
            }
            if (call.loop === "closeout") {
                await writeFile(path.join(h.root, "docs", "README.md"), "Fake-cloud fixture only; no external deployment occurred.\n");
                await writeFile(path.join(h.root, "docs", "RELEASE-NOTES.md"), "Two ordered local fake-cloud stages and actual native receipts verified.\n");
                return proposal({ document: "Local fake-cloud runner regression.", coverage: allCoverage(),
                    readme: reference("docs/README.md"), releaseNotes: reference("docs/RELEASE-NOTES.md") });
            }
        },
    };
    const harness = workflowContext(h, options);
    let resumed;
    if (resume) {
        await assert.rejects(harness.run(), /Fixture interrupted after reconciled first stage/);
        const directory = await artifactDirectory(h.root, h.runId);
        const interrupted = await readArtifact(directory, "lab-state.json");
        assert.equal(interrupted.sprints["sprint-one"].admissions.length, 1);
        assert.deepEqual(interrupted.sprints["sprint-one"].infrastructurePolicy.rules, infrastructureRules);
        assert.deepEqual(interrupted.sprints["sprint-one"].infrastructurePolicy.metadata, finalizedRegistry);
        assert.notEqual(interrupted.original.app["src/infrastructure-profile.json"],
            interrupted.sprints["sprint-one"].infrastructurePolicy.profile.sha256,
            "the accepted frozen policy uses finalized source, not the intake reservation");
        const retained = interrupted.sprints["sprint-one"].admissions[0];
        resumed = workflowContext(h, { ...options, beforeOperator: undefined });
        const result = await resumed.run();
        const completed = await readArtifact(directory, "lab-state.json");
        assert.deepEqual(completed.sprints["sprint-one"].admissions[0], retained, "resume reuses the exact prior admission");
        resumed.result = result;
    }
    const result = resumed ? resumed.result : await harness.run();
    assert.equal(result.status, "deployed", JSON.stringify(result));
    assert.equal(result.delivery.webOrigin, "https://fixture.example.invalid");
    assert.deepEqual(result.coverage, allCoverage());
    const directory = await artifactDirectory(h.root, h.runId);
    const events = (await readFile(path.join(directory, "cloud-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map(({ mode, stage }) => `${mode}:${stage}`), [
        "plan:foundation", "apply:foundation", "reconcile:foundation",
        ...(resume ? ["reconcile:foundation"] : []),
        "plan:service", "apply:service", "reconcile:service",
        "mutate:deploy", "reconcile:deploy", "verify:deploy", "mutate:smoke", "reconcile:smoke",
    ]);
    const state = await readArtifact(directory, "lab-state.json");
    assert.deepEqual(state.sprints["sprint-one"].infrastructurePolicy.rules, infrastructureRules);
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { policy: infrastructureRules, metadata: finalizedRegistry },
        "implementation finalizes metadata without enlarging immutable owner approvals");
    const admissions = state.sprints["sprint-one"].admissions;
    assert.equal(admissions.length, 2);
    for (const [index, admission] of admissions.entries()) {
        const plan = events.find((event) => event.mode === "plan" && event.stage === admission.stageId);
        const apply = events.find((event) => event.mode === "apply" && event.stage === admission.stageId);
        assert.equal(plan.binding.stageIndex, index);
        assert.equal(plan.binding.planAggregate, digest(admissions.slice(0, index)));
        const policyContext = JSON.parse(await readFile(plan.binding.planContext, "utf8"));
        assert.equal(policyContext.policyIdentity, digest(state.sprints["sprint-one"].infrastructurePolicy));
        assert.deepEqual(policyContext.priorAdmissions, admissions.slice(0, index));
        assert.equal(apply.binding.planIdentity, admission.planIdentity);
        assert.equal(apply.binding.planEvidence, admission.plans[0].binary);
        for (const plan of admission.plans) {
            for (const name of ["binary", "json", "guard"]) {
                const snapshot = `retained-${plan.hashes[name]}.bin`;
                assert.equal(plan.archives[name], snapshot);
                assert.equal(state.retained[snapshot], plan.hashes[name]);
                assert.equal(hashBytes(await readFile(path.join(directory, snapshot))), plan.hashes[name],
                    "admitted native bytes retain a hash-keyed private snapshot");
            }
        }
    }
    assert.equal(result.delivery.planAggregate, digest(admissions));
    const ledger = await readArtifact(path.join(h.root, ".delivery-runs"), "lab-target-ledger.json");
    assert.deepEqual(ledger.operations.map((entry) => entry.kind), [
        "provision-sprint-one-foundation", "provision-sprint-one-service", "deploy-sprint-one", "smoke-sprint-one-0",
    ]);
    assert.ok(ledger.operations.every((entry) => entry.state === "completed" && entry.attempts === 1 &&
        entry.recoveryAttempts === (resume && entry.kind === "provision-sprint-one-foundation" ? 2 : 1) &&
        entry.reconciliation.effect === "completed"));
    const calls = [...harness.calls, ...(resumed?.calls ?? [])];
    const nativeCalls = calls.filter((call) => call.agent === "lab-operator" && call.nativeReceipt);
    assert.equal(nativeCalls.length, resume ? 29 : 25, "resume adds identity observations and reconciliation, never a duplicate apply");
    assert.ok(nativeCalls.every((call) => call.nativeReceipt.outcome.ok && call.nativeReceipt.sourceIntact));
    const origin = state.sprints["sprint-one"].originPin;
    assert.equal(origin.evidenceHash, hashBytes(await readFile(origin.path)));
    assert.equal(await readArtifact(path.join(h.root, ".delivery-runs"), "lab-active.json"), null);
});
}

const publicationFixtureScript = `
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
const exec = promisify(execFile);
const git = async args => (await exec("git", args, {
    encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" }
})).stdout.trim();
const env = process.env;
const output = env.DELIVERY_EVIDENCE_PATH;
const directory = path.dirname(output);
const parse = async file => JSON.parse(await readFile(file, "utf8"));
const mode = process.argv[2];
const baseline = process.argv[3];
const binding = { runId: env.DELIVERY_RUN_ID, sourceFingerprint: env.DELIVERY_SOURCE_FINGERPRINT,
    buildFingerprint: env.DELIVERY_BUILD_FINGERPRINT, sprintId: env.DELIVERY_SPRINT_ID };
const marker = path.join(directory, mode.includes("prepare") ? "publication-prepare.json" : "publication-push.json");
let data;
if (mode === "prepare" || mode === "push") {
    const ledger = await parse(".delivery-runs/lab-target-ledger.json");
    const operation = ledger.operations.find(item => item.id === env.DELIVERY_OPERATION_ID);
    assert.equal(operation.state, "started");
    const intent = await parse(output.replace(/-evidence\\.json$/, "-intent.json"));
    assert.equal(intent.operationId, operation.id);
    if (mode === "prepare") {
        await git(["add", "--", "src/feature.txt", ...(process.argv[4] === "include-owner-dirty" ? ["src/existing.txt"] : [])]);
        await git(["commit", "--no-gpg-sign", "--quiet", "-m", "Prepare local publication fixture"]);
    } else {
        assert.equal(ledger.operations.find(item => item.kind.startsWith("publish-prepare-")).state, "completed");
        assert.equal(await git(["diff", "--name-only", baseline, "HEAD"]), "src/feature.txt",
            "task-only prepared diff is inspected before this local push");
        assert.equal((await git(["ls-remote", "origin", "refs/heads/fixture"])).split(/\\s+/)[0], baseline);
        await git(["push", "--quiet", "origin", "HEAD:refs/heads/fixture"]);
    }
    await writeFile(marker, JSON.stringify({ revision: await git(["rev-parse", "HEAD"]), operationId: operation.id }));
    data = { actualLocalGitEffect: mode };
} else {
    const effect = await parse(marker);
    assert.equal(effect.operationId, env.DELIVERY_OPERATION_ID);
    assert.equal(effect.revision, await git(["rev-parse", "HEAD"]));
    if (mode === "reconcile-push") {
        assert.equal((await git(["ls-remote", "origin", "refs/heads/fixture"])).split(/\\s+/)[0], effect.revision);
    } else assert.equal(mode, "reconcile-prepare");
    data = { effect: "completed", observations: [marker] };
}
await writeFile(output, JSON.stringify({ status: "PASS", binding, evidence: ["actual local Git fixture only"], data }));
`;

async function runtimeAccessFixture(t) {
    const h = await fixture(t);
    h.args.azure.subscriptionId = "11111111-1111-4111-8111-111111111111";
    h.args.azure.tenantId = "22222222-2222-4222-8222-222222222222";
    h.args.target.deploy = true;
    h.args.authorization.provision = true;
    h.args.authorization.runtimeIdentityModelAccess = true;
    h.args.deploymentOrder = "identity-before-post-provision";
    h.args.attempts.recovery = 4;
    h.args.infrastructureProfile = reference("src/infrastructure-profile.json");
    h.args.acceptance.push({ id: "ac-live", criterion: "Observe the fixture identity's exact authorized model access.", level: "live" });
    const group = `/subscriptions/${h.args.azure.subscriptionId}/resourceGroups/lab-fixture`;
    const rules = {
        stateOwner: "fixture-only-state", maxResources: 2,
        armTypes: ["Fixture.Local/resources", "Microsoft.Authorization/roleAssignments"],
        subscriptionId: h.args.azure.subscriptionId, tenantId: h.args.azure.tenantId, region: h.args.azure.region,
        runtimeIdentityModelAccess: {
            deploymentResourceId: `${group}/providers/Microsoft.App/containerApps/fixture-app`,
            assignments: [{
                scope: `${group}/providers/Microsoft.CognitiveServices/accounts/fixture-model`,
                roleDefinitionId: `/subscriptions/${h.args.azure.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/33333333-3333-4333-8333-333333333333`,
            }],
        },
    };
    const profile = { policy: rules, metadata: { registryState: "finalized", resourceNames: ["foundation", "model-access"] } };
    await writeFile(path.join(h.root, "src", "infrastructure-profile.json"), JSON.stringify(profile));
    await writeFile(path.join(h.root, "scripts", "cloud-fixture.mjs"), cloudFixtureScript);
    const native = (mode, stage) => ({ ...command(), script: "scripts/cloud-fixture.mjs", args: [mode, stage, "identity-first"] });
    const operation = (stage, mode = "mutate") => ({ command: native(mode, stage), reconcile: native("reconcile", stage) });
    let liveCoverage;
    const allCoverage = () => [...coverage(), liveCoverage];
    return {
        ...h, rules,
        harness(beforeOperator) {
            return workflowContext(h, {
                beforeOperator,
                async owner(call, context) {
                    if (call.loop === "releasePlan") return proposal({ terraformPolicy: context.args.terraformPolicy, sprints: [{
                        id: "sprint-one", goal: "Observe fixture identity before admitting its narrowly authorized model grant.",
                        requirementIds: ["ac-main", "ac-live"],
                    }] });
                    if (call.loop === "sprintPlan") return proposal({ tasks: [{
                        id: "feature", repository: "app", kind: "developer", paths: ["src/feature.txt"],
                        dependsOn: [], requirementIds: ["ac-main", "ac-live"],
                    }] });
                    if (call.loop === "devOps") return proposal({
                        provisionStages: [
                            { id: "foundation", phase: "before-deploy", plan: native("plan", "foundation"), ...operation("foundation", "apply") },
                            { id: "model-access", phase: "after-deploy", plan: native("plan", "model-access"), ...operation("model-access", "apply") },
                        ],
                        deploy: operation("deploy"), verify: native("verify", "deploy"), smoke: [operation("smoke")],
                    });
                    if (call.loop === "infrastructure-policy") {
                        assert.deepEqual(context.policy.rules, rules);
                        return proposal({ policyIdentity: digest(context.policy) });
                    }
                    if (call.loop.startsWith("exact-plan-")) return proposal({ planIdentity: digest(context.plans) });
                    if (call.loop.startsWith("recovery-")) return proposal({ command: context.command });
                    if (call.loop === "sprintReview") {
                        const actual = context.nativeCoverage.find((item) => item.id === "ac-live");
                        assert.equal(actual.status, "verified");
                        liveCoverage = { id: actual.id, status: actual.status, evidence: [...actual.evidence, actual.receipt] };
                        return proposal({ coverage: allCoverage(), backlog: [], resolvedBacklogIds: [] });
                    }
                    if (call.loop === "closeout") {
                        await writeFile(path.join(h.root, "docs", "README.md"), "Local identity-first regression only; no cloud effects.\n");
                        await writeFile(path.join(h.root, "docs", "RELEASE-NOTES.md"), "Exact fixture identity/scope/role validated with native receipts.\n");
                        return proposal({ document: "Local identity-first delivery verified.", coverage: allCoverage(),
                            readme: reference("docs/README.md"), releaseNotes: reference("docs/RELEASE-NOTES.md") });
                    }
                },
            });
        },
    };
}

for (const scenario of ["complete", "resume", "successful-refresh", "principal-changed"]) {
    const title = {
        complete: "opt-in native order is foundation, observed deploy identity, post-deploy model access, then verification",
        resume: "identity-first resume retains the identity and post plan without redeploy, replan or reapply",
        "successful-refresh": "successful native verify refreshes do not consume the persisted failure allowance on resume",
        "principal-changed": "changed native principal on resume blocks post-deploy access retry without redeployment",
    }[scenario];
    test(title, async (t) => {
        const h = await runtimeAccessFixture(t);
        const before = await sourceCensus(h.roots);
        const interrupt = scenario === "resume" ? /:verify-sprint-one:/ :
            scenario === "successful-refresh" ? /:identity-before-reconcile-smoke-sprint-one-0:/ :
            scenario === "principal-changed" ? /:provision-sprint-one-model-access:/ : null;
        const first = h.harness(interrupt ? async (call) => {
            if (interrupt.test(call.label)) throw new Error("Fixture identity-first interruption");
        } : undefined);
        const directory = await artifactDirectory(h.root, h.runId);
        let priorAdmission;
        let verifyKey;
        let result;
        if (interrupt) {
            let interruption, earlyResult;
            try { earlyResult = await first.run(); } catch (error) { interruption = error; }
            assert.ok(interruption, `Expected the explicit fixture interruption, got ${JSON.stringify(earlyResult)}`);
            assert.match(interruption.message, /Fixture identity-first interruption/);
            assert.equal(interruption.labNativeStarted, false, "interruption occurs before the broker's native before-boundary");
            const interrupted = await readArtifact(directory, "lab-state.json");
            assert.equal(interrupted.sprints["sprint-one"].admissions.length, 2);
            priorAdmission = interrupted.sprints["sprint-one"].admissions[1];
            const savedGuard = JSON.parse(await readFile(path.join(h.root, ...priorAdmission.plans[0].guard.split("/")), "utf8"));
            assert.match(savedGuard.runtimeIdentityHash, /^[a-f0-9]{64}$/);
            if (scenario === "resume" || scenario === "successful-refresh") {
                assert.equal(h.args.attempts.implementation, 1, "the regression does not raise the retry budget");
                const audits = Object.entries(interrupted.checkAttempts);
                assert.equal(audits.length, 1);
                [verifyKey] = audits[0];
                assert.equal(interrupted.checkAttempts[verifyKey], 1, "dispatch remains visible in the durable audit");
                assert.equal(interrupted.checkFailures[verifyKey], 0, "success or proven pre-invocation interruption leaves no failure debit");
                const verification = first.calls.find((call) => /:verify-sprint-one:/.test(call.label));
                assert.ok(verification);
                if (scenario === "resume") assert.equal(verification.nativeReceipt, undefined);
                else {
                    assert.equal(verification.nativeReceipt.outcome.ok, true);
                    assert.equal(verification.nativeReceipt.actual.status, "PASS");
                }
            }
            if (scenario === "principal-changed") {
                await writeFile(path.join(h.root, ".azure", "runtime-identity-override.json"),
                    JSON.stringify({ principalId: "55555555-5555-4555-8555-555555555555" }));
            }
            result = await h.harness().run();
        } else result = await first.run();
        assert.equal(result.status, scenario === "principal-changed" ? "blocked" : "deployed", JSON.stringify(result));
        const events = (await readFile(path.join(directory, "cloud-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
        const effects = events.filter((item) => ["apply", "mutate"].includes(item.mode));
        assert.deepEqual(effects.map(({ mode, stage }) => `${mode}:${stage}`), [
            "apply:foundation", "mutate:deploy",
            ...(scenario === "principal-changed" ? [] : ["apply:model-access", "mutate:smoke"]),
        ], "a resume never replays completed mutations");
        const state = await readArtifact(directory, "lab-state.json");
        if (verifyKey) {
            assert.equal(state.checkAttempts[verifyKey], 2, "resume records the second dispatch without erasing history");
            assert.equal(state.checkFailures[verifyKey], 0, "the resumed success releases only its reserved debit");
            assert.equal(events.filter((item) => item.mode === "verify").length, scenario === "successful-refresh" ? 2 : 1);
        }
        const admissions = state.sprints["sprint-one"].admissions;
        assert.deepEqual(admissions.map((item) => item.stageIndex), [0, 1]);
        if (priorAdmission) assert.deepEqual(admissions[1], priorAdmission, "exact admitted post-plan bytes and access context survive resume");
        const postPlans = events.filter((item) => item.mode === "plan" && item.stage === "model-access");
        assert.equal(postPlans.length, 1);
        const pin = JSON.parse(await readFile(postPlans[0].binding.planContext, "utf8")).runtimeIdentity;
        assert.equal(pin.identity.principalId, "44444444-4444-4444-8444-444444444444");
        assert.equal(pin.identity.resourceId, h.rules.runtimeIdentityModelAccess.deploymentResourceId);
        assert.equal(hashBytes(await readFile(pin.path)), pin.evidenceHash);
        const postGuard = JSON.parse(await readFile(path.join(h.root, ...admissions[1].plans[0].guard.split("/")), "utf8"));
        assert.equal(postGuard.runtimeIdentityHash, pin.evidenceHash);
        assert.equal(postGuard.checks.runtimeIdentityModelAccess.pass, true);
        const ledger = await readArtifact(path.join(h.root, ".delivery-runs"), "lab-target-ledger.json");
        const deployment = ledger.operations.find((item) => item.kind === "deploy-sprint-one");
        assert.equal(deployment.attempts, 1);
        const postOperation = ledger.operations.find((item) => item.kind === "provision-sprint-one-model-access");
        if (scenario === "principal-changed") {
            assert.equal(result.status, "blocked", JSON.stringify(result));
            assert.match(result.reason, /identity|principal/i);
            assert.equal(postOperation.attempts, 0, "identity drift blocks before any role assignment attempt");
            assert.equal(events.some((item) => item.mode === "verify"), false);
        } else {
            assert.equal(result.status, "deployed", JSON.stringify(result));
            assert.equal(postOperation.attempts, 1);
            const sequence = events.map(({ mode, stage }) => `${mode}:${stage}`);
            assert.ok(sequence.indexOf("reconcile:deploy") < sequence.indexOf("plan:model-access"));
            assert.ok(sequence.indexOf("reconcile:model-access") < sequence.indexOf("verify:deploy"));
            assert.equal(events.filter((item) => item.mode === "plan").length, 2, "saved plans are never regenerated on resume");
        }
        const after = await sourceCensus(h.roots);
        for (const [file, hash] of Object.entries(before.app)) {
            if (file !== "docs/README.md") assert.equal(after.app[file], hash, `operational execution preserves ${file}`);
        }
        assert.equal(await readArtifact(path.join(h.root, ".delivery-runs"), "lab-active.json"), null);
    });
}

test("an actual failed native verify remains spent across resume with the original one-attempt budget", async (t) => {
    const h = await runtimeAccessFixture(t);
    assert.equal(h.args.attempts.implementation, 1);
    const failurePath = path.join(h.root, ".azure", "fail-verify.json");
    await writeFile(failurePath, JSON.stringify({ enabled: true }));
    const first = h.harness();
    const initial = await first.run();
    assert.equal(initial.status, "blocked", JSON.stringify(initial));
    assert.equal(initial.kind, "verify-sprint-one");
    assert.match(initial.reason, /persisted retry budget/);
    const verification = first.calls.find((call) => /:verify-sprint-one:/.test(call.label));
    assert.equal(verification.nativeReceipt.outcome.ok, false);
    assert.equal(verification.nativeReceipt.outcome.exitCode, 31);
    assert.equal(verification.nativeReceipt.actual.status, "FAIL");
    const directory = await artifactDirectory(h.root, h.runId);
    const interrupted = await readArtifact(directory, "lab-state.json");
    const audits = Object.entries(interrupted.checkAttempts);
    assert.equal(audits.length, 1);
    const [key, attempts] = audits[0];
    assert.equal(attempts, 1);
    assert.equal(interrupted.checkFailures[key], 1, "actual native failure keeps its debit");
    const source = await sourceCensus(h.roots);
    await writeFile(failurePath, JSON.stringify({ enabled: false }));
    assert.deepEqual(await sourceCensus(h.roots), source, "changing only the external fixture observation does not change frozen source");
    const resumed = h.harness();
    const result = await resumed.run();
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.equal(result.kind, "verify-sprint-one");
    assert.match(result.reason, /persisted retry budget/);
    assert.ok(!resumed.calls.some((call) => /:verify-sprint-one:/.test(call.label)),
        "resume cannot dispatch a second native verify after the actual failure exhausted authority");
    const completed = await readArtifact(directory, "lab-state.json");
    assert.equal(completed.checkAttempts[key], 1);
    assert.equal(completed.checkFailures[key], 1);
    const events = (await readFile(path.join(directory, "cloud-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((item) => item.mode === "verify").length, 1);
    assert.equal(events.find((item) => item.mode === "verify").failed, true);
    assert.equal(events.some((item) => item.stage === "smoke"), false);
    assert.equal(await readArtifact(path.join(h.root, ".delivery-runs"), "lab-active.json"), null);
});

for (const includeDirty of [false, true]) {
    test(includeDirty ? "publication rejects unauthorized initially dirty bytes before the local bare remote advances"
        : "full native publication prepares, independently inspects and pushes only task changes to a local bare remote", async (t) => {
        const h = await fixture(t);
        await writeFile(path.join(h.root, "scripts", "publish-fixture.mjs"), publicationFixtureScript);
        for (const [name, value] of [
            ["user.name", "Local Lab Fixture"], ["user.email", "fixture@example.invalid"], ["commit.gpgsign", "false"],
            ["core.hooksPath", path.join(h.root, ".azure", "no-hooks")], ["protocol.allow", "never"], ["protocol.file.allow", "always"],
        ]) await git(h.root, ["config", "--local", name, value]);
        await git(h.root, ["add", "--", "scripts/publish-fixture.mjs"]);
        await git(h.root, ["commit", "--no-gpg-sign", "--quiet", "-m", "Initial local fixture"]);
        await git(h.root, ["branch", "--move", "fixture"]);
        const baseline = (await git(h.root, ["rev-parse", "HEAD"])).trim();
        const bare = path.join(h.base, "local-only.git");
        await git(h.base, ["init", "--bare", "--quiet", bare]);
        const github = "test/lab-fixture";
        const authorizedUrl = `https://github.com/${github}`;
        const bareUrl = pathToFileURL(bare).href;
        await git(h.root, ["config", "--local", `url.${bareUrl}.insteadOf`, authorizedUrl]);
        await git(h.root, ["remote", "add", "origin", authorizedUrl]);
        assert.equal((await git(h.root, ["config", "--get", "remote.origin.url"])).trim(), authorizedUrl);
        assert.equal((await git(h.root, ["remote", "get-url", "origin"])).trim(), bareUrl, "Git resolves only to this test's local fixture");
        await git(h.root, ["push", "--quiet", "origin", "HEAD:refs/heads/fixture"]);
        h.args.authorization.publish = true;
        h.args.publication = { repository: "app", github, visibility: "private", branch: "fixture", tagRequired: false, create: false };
        let observations = 0;
        const native = (mode) => ({
            ...command(), script: "scripts/publish-fixture.mjs",
            args: [mode, baseline, includeDirty ? "include-owner-dirty" : "task-only"],
        });
        const harness = workflowContext(h, {
            observePublication: async (target) => {
                observations++;
                assert.equal(target, github);
                return { nameWithOwner: github, isPrivate: true };
            },
            async owner(call, context) {
                if (call.loop === "publication") return proposal({
                    prepare: { command: native("prepare"), reconcile: native("reconcile-prepare") },
                    command: native("push"), reconcile: native("reconcile-push"),
                });
                if (call.loop.startsWith("recovery-publish")) return proposal({ command: context.command });
            },
        });
        const result = await harness.run();
        const remoteHead = (await git(h.base, ["--git-dir", bare, "rev-parse", "refs/heads/fixture"])).trim();
        const ledger = await readArtifact(path.join(h.root, ".delivery-runs"), "lab-target-ledger.json");
        if (includeDirty) {
            assert.equal(result.status, "blocked", JSON.stringify(result));
            assert.match(result.reason, /initially dirty bytes without exact input authority/);
            assert.equal(remoteHead, baseline, "rejection happens before any remote ref change");
            assert.equal(observations, 0);
            assert.deepEqual(ledger.operations.map((item) => item.kind), ["publish-prepare-sprint-one"]);
            assert.ok(!harness.calls.some((call) => call.agent === "lab-operator" && /:publish-sprint-one:/.test(call.label)));
        } else {
            assert.equal(result.status, "built", JSON.stringify(result));
            assert.equal(observations, 1);
            assert.notEqual(remoteHead, baseline);
            assert.equal(result.delivery.revision, remoteHead);
            assert.equal((await git(h.base, ["--git-dir", bare, "diff", "--name-only", baseline, remoteHead])).trim(), "src/feature.txt");
            assert.deepEqual(ledger.operations.map((item) => item.kind), ["publish-prepare-sprint-one", "publish-sprint-one"]);
            const publication = harness.calls.filter((call) => call.loop === "publication");
            assert.equal(publication[0].agent, "lab-author");
            assert.deepEqual(publication.slice(1).map((call) => /Independent reviewer role: ([^.]+)\./.exec(call.prompt)[1]),
                ["Publication Critic", "Architect"]);
        }
        assert.ok(ledger.operations.every((item) => item.state === "completed" && item.attempts === 1));
        assert.equal(await readFile(path.join(h.root, "src", "existing.txt"), "utf8"), "initially dirty owner bytes\n");
        assert.equal(await readArtifact(path.join(h.root, ".delivery-runs"), "lab-active.json"), null);
    });
}

test("accepted source drift on resume blocks before fresh authoring or native execution", async (t) => {
    const h = await fixture(t);
    const initial = workflowContext(h);
    const built = await initial.run();
    assert.equal(built.status, "built", JSON.stringify(built));
    await writeFile(path.join(h.root, "src", "feature.txt"), "drifted after accepted closeout\n");
    const resumed = workflowContext(h);
    const result = await resumed.run();
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /Accepted source drift/);
    assert.deepEqual(resumed.calls, []);
});

test("unresolved interrupted mutation fences persist across leases and block a new run before all agent calls", async (t) => {
    const h = await fixture(t);
    const workspace = await acquireWorkspace(h.root, h.runId);
    const directory = await artifactDirectory(h.root, h.runId);
    const operation = { id: "op-interrupted", runId: h.runId, target: h.args.target.id,
        kind: "deploy-sprint-one", state: "admitted", attempts: 0 };
    try {
        const script = `
            import { writeFile } from "node:fs/promises";
            await writeFile(process.env.DELIVERY_EVIDENCE_PATH, JSON.stringify({
                status: "PASS", evidence: ["local-only-operation-fixture"], data: { effect: "unknown" }
            }));
        `;
        await writeFile(path.join(h.root, "scripts", "interrupted.mjs"), script);
        const broker = createTicketBroker();
        workspace.ledger.operations.push(operation);
        await workspace.save();
        await issueTicket({
            ctx: {
                runId: h.runId,
                async agent(prompt, config) {
                    assert.equal(config.agent, "lab-operator");
                    await broker.invoke(/Execute only ticket ([a-f0-9-]{36}) /.exec(prompt)[1]);
                    throw new Error("Fixture operator disconnected after actual child exit");
                },
            },
            broker, workspace, directory, roots: h.roots,
            command: { ...command(), script: "scripts/interrupted.mjs", args: [] },
            binding: { sourceFingerprint: digest(await sourceCensus(h.roots)) }, environment: {},
            role: "DevOps Engineer", kind: operation.kind, mutation: true, operation,
        }).then(() => assert.fail("operator interruption must surface"), (error) => {
            assert.match(error.message, /operator disconnected/);
        });
        assert.equal(operation.state, "unknown");
        const ledger = await readArtifact(workspace.directory, "lab-target-ledger.json");
        assert.equal(ledger.operations[0].state, "unknown");
        assert.equal(ledger.operations[0].attempts, 1);
        await assert.rejects(acquireWorkspace(h.root, "parallel-run"), /Another lab run or stale lease/);
    } finally { await workspace.release(); }
    const retained = await readArtifact(path.join(h.root, ".delivery-runs"), "lab-target-ledger.json");
    const next = workflowContext({ ...h, runId: `new-${randomUUID()}` });
    const result = await next.run();
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /Another run retains unresolved target effects/);
    assert.equal(result.ownerRunId, h.runId);
    assert.equal(result.operationId, operation.id);
    assert.deepEqual(next.calls, []);
    assert.deepEqual(await readArtifact(path.join(h.root, ".delivery-runs"), "lab-target-ledger.json"), retained);
    assert.equal(await readArtifact(path.join(h.root, ".delivery-runs"), "lab-active.json"), null);
});
