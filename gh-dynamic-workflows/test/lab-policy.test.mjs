import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
    cumulativeAddresses, readReference, scriptBinding, terraformPolicy,
    validateLabInput, validateNativePlan, validateReleasePlan, validateTasks,
    runtimeAccessPolicy, validateProvisionPhases, validateRuntimeIdentity,
} from "../lab-policy.mjs";

const example = JSON.parse(await readFile(new URL("../examples/lab.json", import.meta.url), "utf8"));
function createInput() {
    const input = structuredClone(example);
    input.repositories[0].access = "create";
    input.repositories[0].scope = ["."];
    input.authorization.repositoryCreation = true;
    input.azure.profile.path = "private/profile";
    return input;
}

test("broad new-repository authority cannot assign bootstrap work over a credential profile", () => {
    const input = createInput();
    assert.equal(validateLabInput(input), input);
    for (const file of ["private", "private/profile", "private/profile/token.json"]) {
        const changed = structuredClone(input);
        changed.bootstrapPaths[0].paths = [file];
        assert.throws(() => validateLabInput(changed), /credential profile/);
    }
});

test("broad new-repository authority excludes credentials and private execution outputs from tasks", () => {
    const input = createInput();
    const sprint = { requirementIds: [input.acceptance[0].id] };
    const task = {
        id: "implement", repository: "app", kind: "developer", paths: ["src"],
        dependsOn: [], requirementIds: sprint.requirementIds,
    };
    assert.equal(validateTasks({ tasks: [task] }, input, sprint).length, 1);
    for (const file of ["private", "private/profile", "private/profile/token.json", ".azure", ".env", "state.tfstate"]) {
        assert.throws(() => validateTasks({ tasks: [{ ...task, paths: [file] }] }, input, sprint), /credentials|private execution|Protected path/);
    }
});

test("private command entries and cross-root dependencies are rejected before any filesystem reads", async () => {
    const command = structuredClone(example.commands.test[0]);
    const roots = new Map([
        ["app", { ...example.repositories[0], privatePaths: ["private/profile"] }],
        ["context", { id: "context", access: "read", privatePaths: ["private/context-profile"] }],
    ]);
    await assert.rejects(scriptBinding({ ...command, script: "private/profile/run.mjs" }, roots), /Credential profile/);
    await assert.rejects(scriptBinding({
        ...command, dependencies: [{ repository: "context", path: "private/context-profile/token.json" }],
    }, roots), /Credential profile/);
});

test("source references reject unknown roots and credential contents explicitly", async () => {
    await assert.rejects(readReference(new Map(), { repository: "missing", path: "docs/spec.md" }), /Unknown reference root/);
    const roots = new Map([["app", { privatePaths: ["private/profile"] }]]);
    await assert.rejects(readReference(roots, { repository: "app", path: "private/profile/token.json" }), /not readable source/);
});

test("Terraform preferences cannot silently become architecture/release requirements", () => {
    const args = createInput();
    assert.deepEqual(terraformPolicy(args), { requirement: "any", preference: "avm" });
    const plan = { terraformPolicy: terraformPolicy(args), sprints: [{
        id: "one", goal: "Implement authorized criterion", requirementIds: [args.acceptance[0].id],
    }] };
    validateReleasePlan(plan, args);
    assert.throws(() => validateReleasePlan({ ...plan, terraformPolicy: { requirement: "avm", preference: "avm" } }, args), /Terraform requirement/);
    args.terraformPolicy = { requirement: "avm", preference: "none" };
    assert.deepEqual(terraformPolicy(args), args.terraformPolicy);
    assert.throws(() => validateReleasePlan(plan, args), /Terraform requirement/);
});

test("canonical semantic admission supports AzureRM/AzAPI equivalence and cross-region read inputs", () => {
    const owner = { shared: true, stateOwner: "network", subscriptionId: "sub", tenantId: "tenant", region: "region-a" };
    const contract = { ...owner, addressPrefixes: ["module.network."], resourceTypes: ["Microsoft.Network/virtualNetworks"], actions: ["create", "update"] };
    for (const type of ["azurerm_virtual_network", "azapi_resource"]) {
        const plan = { resource_changes: [{ address: `module.network.${type}.vnet`, type,
            change: { actions: ["create"], after: { location: "region-a" } } },
        { address: "data.remote", type: "azapi_resource", change: { actions: ["read"], after: { location: "region-b" } } },
        { address: "data.unchanged", type: "azurerm_resource_group", change: { actions: ["no-op"], after: { location: "region-b" } } }] };
        validateNativePlan(plan, owner, [contract], { canonical: true });
        const changed = structuredClone(plan);
        changed.resource_changes[0].change.after.location = "region-b";
        assert.throws(() => validateNativePlan(changed, owner, [contract], { canonical: true }), /location/);
        changed.resource_changes[0].change.actions = ["delete", "create"];
        assert.throws(() => validateNativePlan(changed, owner, [contract], { canonical: true }), /Destructive/);
    }
});

test("cumulative scope retains unique mutation addresses across stages without counting reads", () => {
    const prior = [{ plans: [{
        ownership: { stateOwner: "network" },
        summary: [{ address: "vnet.a", actions: ["create"] }, { address: "vnet.lookup", actions: ["read"] }],
    }] }];
    const current = { resource_changes: [
        { address: "vnet.a", change: { actions: ["update"] } },
        { address: "subnet.b", change: { actions: ["create"] } },
        { address: "vnet.noop", change: { actions: ["no-op"] } },
    ] };
    assert.deepEqual(cumulativeAddresses(prior, current, "network"), ["network:subnet.b", "network:vnet.a"]);
});

test("identity-dependent Terraform phases require opt-in and monotonic pre/post declaration", () => {
    const args = createInput();
    validateProvisionPhases([{ id: "one" }, { id: "two" }], args);
    assert.throws(() => validateProvisionPhases([{ phase: "after-deploy" }], args), /explicit/);
    args.target.deploy = true;
    args.deploymentOrder = "identity-before-post-provision";
    validateProvisionPhases([{ phase: "before-deploy" }, { phase: "after-deploy" }], args);
    assert.throws(() => validateProvisionPhases([{ phase: "after-deploy" }, { phase: "before-deploy" }], args), /must precede/);
    assert.throws(() => validateProvisionPhases([{ phase: "during-deploy" }], args), /Unknown/);
});

test("runtime model-access authority is independent, exact-resource scoped and disabled by default", () => {
    const args = createInput();
    const policy = {
        deploymentResourceId: "exact-hosted-agent",
        assignments: [{
            scope: "/subscriptions/sub/resourceGroups/lab/providers/Microsoft.CognitiveServices/accounts/model",
            roleDefinitionId: "/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/11111111-2222-3333-4444-555555555555",
        }],
    };
    assert.equal(runtimeAccessPolicy(args, { runtimeIdentityModelAccess: policy }), null);
    args.authorization.runtimeIdentityModelAccess = true;
    assert.throws(() => validateLabInput(args), /Runtime model access/);
    args.target.deploy = true;
    args.authorization.provision = true;
    args.deploymentOrder = "identity-before-post-provision";
    args.infrastructureProfile = { repository: "app", path: "docs/policy.json" };
    args.azure.subscriptionId = "sub";
    validateLabInput(args);
    assert.equal(runtimeAccessPolicy(args, { runtimeIdentityModelAccess: policy }), policy);
    for (const scope of ["/subscriptions/sub", "/subscriptions/sub/resourceGroups/lab",
        "/subscriptions/other/resourceGroups/lab/providers/Microsoft.CognitiveServices/accounts/model"]) {
        assert.throws(() => runtimeAccessPolicy(args, { runtimeIdentityModelAccess: { ...policy, assignments: [{ ...policy.assignments[0], scope }] } }), /exact resource scopes/);
    }
});

test("native AzureRM/AzAPI model role grants bind the actual runtime principal, exact scope and role", () => {
    const owner = { shared: false, stateOwner: "model-access", region: "region" };
    const identity = { principalId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
    const assignment = {
        scope: "/subscriptions/sub/resourceGroups/lab/providers/Microsoft.CognitiveServices/accounts/model",
        roleDefinitionId: "/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/11111111-2222-3333-4444-555555555555",
    };
    const access = { phase: "after-deploy", policy: { assignments: [assignment] }, identity };
    for (const type of ["azurerm_role_assignment", "azapi_resource"]) {
        const after = type === "azurerm_role_assignment" ?
            { scope: assignment.scope, principal_id: identity.principalId, role_definition_id: assignment.roleDefinitionId, principal_type: "ServicePrincipal" } :
            { type: "Microsoft.Authorization/roleAssignments@2022-04-01", parent_id: assignment.scope,
                body: { properties: { principalId: identity.principalId, roleDefinitionId: assignment.roleDefinitionId, principalType: "ServicePrincipal" } } };
        const plan = { resource_changes: [{ address: `${type}.model`, type, change: { actions: ["create"], after } }] };
        validateNativePlan(plan, owner, [], { canonical: true, runtimeAccess: access });
        assert.throws(() => validateNativePlan(plan, owner, [], { canonical: true }), /separately authorized/);
        assert.throws(() => validateNativePlan(plan, owner, [], { canonical: true, runtimeAccess: { ...access, phase: "before-deploy" } }), /post-deployment/);
        assert.throws(() => validateNativePlan(plan, owner, [], { canonical: true, runtimeAccess: { ...access, identity: { principalId: "other" } } }), /observed runtime principal/);
        const updated = structuredClone(plan);
        updated.resource_changes[0].change.actions = ["update"];
        assert.throws(() => validateNativePlan(updated, owner, [], { canonical: true, runtimeAccess: access }), /updates are prohibited/);
        const conditional = structuredClone(plan);
        if (type === "azurerm_role_assignment") conditional.resource_changes[0].change.after.condition = "arbitrary";
        else conditional.resource_changes[0].change.after.body.properties.condition = "arbitrary";
        assert.throws(() => validateNativePlan(conditional, owner, [], { canonical: true, runtimeAccess: access }), /Conditional/);
    }
});

test("runtime observations normalize identity representation but never accept guessed principals or target drift", () => {
    const args = createInput();
    const identity = { principalId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", resourceId: "agent",
        subscriptionId: args.azure.subscriptionId, tenantId: args.azure.tenantId, evidence: ["native-observation"] };
    const normalized = validateRuntimeIdentity(identity, args, { deploymentResourceId: "agent" });
    assert.equal(normalized.principalId, identity.principalId.toLowerCase());
    assert.throws(() => validateRuntimeIdentity({ ...identity, principalId: "guessed" }, args), /Actual runtime identity/);
    assert.throws(() => validateRuntimeIdentity(identity, args, { deploymentResourceId: "other-agent" }), /Actual runtime identity/);
});
