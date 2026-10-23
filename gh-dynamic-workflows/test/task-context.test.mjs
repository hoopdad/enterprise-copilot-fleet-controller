import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { archiveContext, contextInstructions, historyLocation } from "../task-context.mjs";
import { taskContext } from "../loop-workflow.mjs";
import { fixtureBase } from "./evidence.fixture.mjs";

test("task instructions separate authorized local commands from denied external probes without broadening access", () => {
    const instructions = contextInstructions.join("\n");
    assert.match(instructions, /ordinary Git\/test\/build commands inside projectRoot/);
    assert.match(instructions, /do not routinely scan parent directories/);
    assert.match(instructions, /separately attempt the authorized repository-local operation before declaring needs-input/);
    assert.match(instructions, /Never retry the denied external access through another tool/);
    assert.match(instructions, /genuinely required denied operation/);
    assert.match(instructions, /CLI path permissions and project resource\/data boundaries remain binding/);
});

async function fixture(t) {
    const root = await mkdtemp(path.join(fixtureBase, ".task-handoff-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return { projectRoot: root, history: historyLocation(root, "offline-run"),
        request: { authorization: { provision: false, modelTests: false } }, specification: "Original acceptance." };
}

function governance(key = "domain") {
    return { origin: { key, assignment: { id: key, doneWhen: "Original bounded contract." } },
        instructions: [{ id: "actual-defect", disposition: "required", action: "Fix required output.",
            acceptance: "Original output exists.", taskBoundary: "Domain only." }],
        nonBlocking: [{ id: "optional", disposition: "decline", rationale: "Outside original task.",
            acceptance: "", taskBoundary: "Domain only." }] };
}

function outcome(key, rounds) {
    const current = governance(key);
    return { key, status: "agreed", loopId: "AssignedWorkDeveloperLoop", rounds,
        summary: "Bounded handoff accepted; liveReady remains false.",
        artifact: { DeveloperWork: { path: `contracts/${key}.md`, commit: "abc123",
            liveReady: false, adapterBinding: null, limitations: ["Wire and independent quality remain unproved."] } },
        checks: [{ id: "contract", exitCode: 0, evidence: "checks.log" }],
        reviews: [{ role: "Architect", checksValid: true, findings: [],
            feedback: "CURRENT-REVIEW-" + "x".repeat(1000) }],
        governanceHistory: Array.from({ length: rounds }, () => ({
            owner: { summary: "RAW-OLD-REPORT-" + "x".repeat(2000) },
            reviews: ["RAW-OLD-REVIEW"], governance: current,
        })),
        feedback: { owner: { summary: "Current evidence." }, reviews: [{ feedback: "Current finding." }],
            governance: current, governanceHistory: Array.from({ length: rounds }, () => ({ huge: "RAW-NESTED-" + "x".repeat(2000) })) },
    };
}

test("additional historical rounds do not expand the integration task packet; exact originals remain readable", async (t) => {
    const common = await fixture(t);
    const make = (rounds) => [outcome("domain", rounds), outcome("support", rounds), outcome("unrelated-binding", rounds)];
    const small = make(2), large = make(200);
    const extra = { assignment: { id: "integration", doneWhen: "Join originals.", exclusions: ["No live proof."] },
        dependencies: large.slice(0, 2) };
    const before = structuredClone(large);
    const packet = await taskContext(common, {}, large, extra);
    const comparison = await taskContext(common, {}, small, { ...extra, dependencies: small.slice(0, 2) });
    assert.ok(JSON.stringify(packet).length < 10000);
    assert.ok(JSON.stringify(packet).length <= JSON.stringify(comparison).length + 30);
    assert.doesNotMatch(JSON.stringify(packet), /RAW-|CURRENT-REVIEW-/);
    assert.equal(packet.dependencies.length, 2);
    assert.equal(packet.dependencies[0].artifact.DeveloperWork.liveReady, false);
    assert.equal(packet.dependencies[0].artifact.DeveloperWork.adapterBinding, null);
    assert.equal(packet.dependencies[0].reviews[0].checksValid, true);
    assert.equal(packet.dependencies[0].checks[0].id, "contract");
    assert.deepEqual(packet.request, common.request);
    assert.equal(packet.priorDispositions, undefined);
    assert.doesNotMatch(JSON.stringify(packet), /disposition|governanceHistory/);
    assert.deepEqual(large, before);
    const original = JSON.parse(await readFile(path.join(common.projectRoot, packet.dependencies[0].audit.path), "utf8"));
    assert.deepEqual(original, before[0]);
    assert.deepEqual(JSON.parse(await readFile(path.join(common.projectRoot, packet.outcomes[2].audit.path), "utf8")), before[2]);
    assert.equal(packet.outcomes[2].artifact, undefined);
});

test("scoped replanning preserves current criteria and historical audit without importing dispositions", async (t) => {
    const common = await fixture(t);
    const original = governance("original");
    const oldReference = JSON.stringify(["original", "optional"]);
    const revised = governance("revised");
    revised.nonBlocking = [{ ...revised.nonBlocking[0], id: "updated-optional", supersedes: [oldReference] }];
    const prior = { ...outcome("revised", 20), governance: revised };
    const rawScope = { assignment: { id: "binding", doneWhen: "Actual production binding.", exclusions: ["No fake authority."] },
        request: { ...outcome("replan", 100), status: "needs-replan" },
        dependencies: [outcome("prerequisite", 50)], inherited: {
            assignment: { id: "outer", doneWhen: "Preserve original acceptance." },
            request: { feedback: { governance: original, governanceHistory: [{ raw: "RAW-OUTER" }] } },
        } };
    const packet = await taskContext(common, {}, [prior], { scopeRevision: rawScope });
    assert.equal(packet.priorDispositions, undefined);
    assert.equal(packet.scopeRevision.assignment.doneWhen, rawScope.assignment.doneWhen);
    assert.equal(packet.scopeRevision.inherited.assignment.id, "outer");
    assert.equal(packet.scopeRevision.request.feedback, undefined);
    assert.doesNotMatch(JSON.stringify(packet), /RAW-|CURRENT-REVIEW-/);
    assert.deepEqual(JSON.parse(await readFile(path.join(common.projectRoot, packet.scopeRevision.request.audit.path), "utf8")), rawScope.request);
    assert.doesNotMatch(JSON.stringify(packet), /disposition|governanceHistory/);
});

test("document references retain source and commit; audits are additive, idempotent and never overwrite history", async (t) => {
    const common = await fixture(t);
    const doc = { path: "architecture.md", commit: "abc123", liveReady: false, detail: "Large original detail." };
    const audit = await archiveContext(common.history, "original", doc);
    const packet = await taskContext(common, { Architecture: doc }, [], {}, new Map(), new Map([["Architecture", audit]]));
    assert.equal(packet.documents.Architecture.path, doc.path);
    assert.equal(packet.documents.Architecture.commit, doc.commit);
    assert.equal(packet.documents.Architecture.detail, undefined);
    assert.deepEqual(JSON.parse(await readFile(path.join(common.projectRoot, audit.path), "utf8")), doc);
    const repeat = await archiveContext(common.history, "original", doc);
    assert.deepEqual(repeat, audit);
    const changed = await archiveContext(common.history, "original", { ...doc, liveReady: true });
    assert.notEqual(changed.path, audit.path);
    assert.equal((await readdir(path.join(common.projectRoot, common.history.directory))).length, 2);
    assert.equal(JSON.parse(await readFile(path.join(common.projectRoot, audit.path), "utf8")).liveReady, false);
    assert.throws(() => historyLocation(common.projectRoot, "../old-run"), /single run identifier/);
});
