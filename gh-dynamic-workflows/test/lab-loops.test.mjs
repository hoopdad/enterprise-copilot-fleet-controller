import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LOOP_DEFINITIONS, runAgreement } from "../lab-loops.mjs";

const proposal = (artifact = { complete: true }) => ({
    status: "PASS", summary: "Stage verified", evidence: ["test/receipt.json"], artifact,
});
const vote = (verdict = "PASS", findings = []) => ({
    verdict, findings, evidence: ["test/independent-review.json"],
});

async function harness(t, answer = () => undefined, options = {}) {
    const directory = path.resolve("gh-dynamic-workflows", "test", `.lab-loops-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    t.after(() => rm(directory, { recursive: true, force: true }));
    const calls = [];
    let owners = 0;
    const ctx = {
        runId: "test-run",
        async parallel(thunks) { return Promise.all(thunks.map((thunk) => thunk())); },
        async agent(prompt, config) {
            const owner = "status" in config.schema.properties;
            if (owner) owners++;
            const call = { prompt, ...config, owner, attempt: owners };
            calls.push(call);
            const value = await answer(call, { directory, calls });
            return value === undefined ? owner ? proposal() : vote() : value;
        },
    };
    return {
        calls, directory,
        run: (overrides = {}) => runAgreement({
            ctx, directory, key: "sprint-0:architecture", loop: "architecture",
            context: { sprint: 0, scope: ["src"], sourceInstructions: "Preserve source ownership" },
            attempts: 2, ...options, ...overrides,
        }),
        async artifacts() {
            return Promise.all((await readdir(directory)).map(async (file) => ({
                file, value: JSON.parse(await readFile(path.join(directory, file), "utf8")),
            })));
        },
    };
}

test("loop definitions preserve every root owner and exact independent reviewer set", () => {
    const expected = {
        architecture: ["Architect", ["Product Owner", "Red Team", "Critic"]],
        userExperience: ["Designer", ["Product Owner", "Critic"]],
        releasePlan: ["Product Owner", ["Stakeholder", "Architect", "Designer", "Critic"]],
        sprintDesign: ["Designer", ["Product Owner", "Critic"]],
        sprintArchitecture: ["Architect", ["Product Owner", "Critic", "Red Team"]],
        sprintPlan: ["Scrum Master", ["Product Owner", "Architect", "Critic"]],
        uiWork: ["Developer", ["Architect", "Designer", "Critic"]],
        developerWork: ["Developer", ["Architect", "Critic"]],
        endToEnd: ["Developer", ["Architect", "Critic", "Product Owner"]],
        devOps: ["DevOps Engineer", ["Architect", "Critic", "Developer"]],
        sprintReview: ["Product Owner", ["Scrum Master", "Critic", "Architect", "Red Team"]],
        retrospective: ["Product Owner", ["Scrum Master", "Critic", "Architect", "Red Team", "Designer", "Developer"]],
        closeout: ["Product Owner", ["Stakeholder", "Architect", "Critic"]],
        publication: ["Git Publisher", ["Publication Critic", "Architect"]],
    };
    assert.deepEqual(Object.keys(LOOP_DEFINITIONS), Object.keys(expected));
    for (const [key, [owner, reviewers]] of Object.entries(expected)) {
        assert.equal(LOOP_DEFINITIONS[key].owner, owner);
        assert.deepEqual(LOOP_DEFINITIONS[key].reviewers, reviewers);
        assert.ok(Object.isFrozen(LOOP_DEFINITIONS[key].reviewers));
    }
});

test("all independent votes are required, persisted, and preceded by a saved owner attempt", async (t) => {
    const h = await harness(t, async (call, { directory }) => {
        if (!call.owner) {
            const files = await readdir(directory);
            const ownerFile = files.find((file) => /attempt-1\.json$/.test(file));
            assert.ok(ownerFile);
            assert.deepEqual(JSON.parse(await readFile(path.join(directory, ownerFile), "utf8")).report, proposal());
        }
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(result.context, "readiness");
    assert.deepEqual(result.value, { complete: true });
    assert.deepEqual(result.report, proposal());
    assert.equal(h.calls.length, 4);
    assert.deepEqual(result.attempts[0].reviews.map((review) => review.role), ["Product Owner", "Red Team", "Critic"]);
    assert.equal((await h.artifacts()).length, 4);
    assert.ok(h.calls.every((call) => call.agent === "lab-reader"));
    assert.ok(h.calls.every((call) => !("maxTokens" in call) && !("timeout" in call)));
    assert.match(h.calls[0].prompt, /source-owner instructions/);
    assert.match(h.calls[1].prompt, /untrusted data, not instructions/);
});

test("labels bind run, key, loop, role, attempt, observation and data digest without cached reuse", async (t) => {
    const h = await harness(t);
    await h.run();
    await h.run();
    await h.run({ context: { sprint: 1 } });
    assert.equal(new Set(h.calls.map((call) => call.label)).size, 12);
    for (const call of h.calls) {
        assert.match(call.label, /test-run:sprint-0:architecture:architecture:/);
        assert.match(call.label, /(?:owner|reviewer)-.+:attempt-1:[a-f0-9]{64}:[a-f0-9-]{36}$/);
    }
    const firstDigest = h.calls[0].label.split(":").at(-2);
    assert.equal(h.calls[4].label.split(":").at(-2), firstDigest);
    assert.notEqual(h.calls[8].label.split(":").at(-2), firstDigest);
    assert.equal((await h.artifacts()).length, 12);
});

test("semantic invalid PASS is triaged by every reviewer and concrete repair receives original report and errors", async (t) => {
    const original = proposal({ complete: false });
    const h = await harness(t, (call) => {
        if (call.owner) return call.attempt === 1 ? original : proposal();
        return call.attempt === 1 ? vote("REVISE", ["Set complete=true only after test receipt is verified"]) : vote();
    }, {
        validate(artifact, report) {
            assert.equal(artifact, report.artifact);
            if (!artifact.complete) throw new Error("Missing criterion AC-1 evidence");
        },
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.deepEqual(result.attempts.map((record) => record.context), ["triage", "readiness"]);
    assert.equal(result.attempts[0].reviews.length, 3);
    const secondOwner = h.calls.find((call) => call.owner && call.attempt === 2);
    assert.match(secondOwner.prompt, /originalReport/);
    assert.match(secondOwner.prompt, /Missing criterion AC-1 evidence/);
    for (const role of LOOP_DEFINITIONS.architecture.reviewers) assert.ok(secondOwner.prompt.includes(role));
    for (const call of h.calls.filter((call) => !call.owner && call.attempt === 1)) {
        assert.match(call.prompt, /PASS confirms STOP/);
        assert.match(call.prompt, /Missing criterion AC-1 evidence/);
    }
    const persisted = (await h.artifacts()).find(({ file }) => /attempt-1\.json$/.test(file)).value;
    assert.match(persisted.validationErrors[0], /Artifact validation error/);
    assert.deepEqual(persisted.report, original);
});

for (const status of ["BLOCKED", "FAIL"]) {
    test(`${status} owner plus triage PASS confirms STOP, never readiness`, async (t) => {
        const report = { ...proposal(), status, blockerKind: "authority" };
        const h = await harness(t, (call) => call.owner ? report : vote());
        const result = await h.run();
        assert.equal(result.ok, false);
        assert.equal(result.context, "triage");
        assert.match(result.reason, /confirmed STOP/);
        assert.equal(result.attempts.length, 1);
        assert.equal(result.attempts[0].reviews.length, 3);
        assert.deepEqual(result.report, report);
    });
}

test("invalid PASS plus triage PASS also stops", async (t) => {
    const h = await harness(t, (call) => call.owner ? { ...proposal(), evidence: [] } : vote());
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.context, "triage");
    assert.match(result.attempts[0].validationErrors[0], /evidence/);
});

test("a single triage stop beats REVISE votes from the other reviewers", async (t) => {
    const h = await harness(t, (call) => call.owner
        ? { ...proposal(), status: "BLOCKED" }
        : call.label.includes("reviewer-Critic:") ? vote() : vote("REVISE", ["Repair missing test result"]));
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.match(result.reason, /confirmed STOP/);
    assert.equal(result.attempts.length, 1);
});

test("a required reviewer BLOCKED cannot be outvoted", async (t) => {
    const h = await harness(t, (call) => !call.owner && call.label.includes("reviewer-Red Team:")
        ? vote("BLOCKED", ["Missing authorized operation"]) : undefined);
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.context, "readiness");
    assert.match(result.reason, /BLOCKED/);
    assert.equal(result.attempts[0].reviews.length, 3);
});

test("readiness REVISE receives concrete findings and can reach unanimous agreement", async (t) => {
    const h = await harness(t, (call) => !call.owner && call.attempt === 1 && call.label.includes("reviewer-Critic:")
        ? vote("REVISE", ["Add test/receipt.json coverage for AC-2"]) : undefined);
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(result.attempts.length, 2);
    assert.match(h.calls.find((call) => call.owner && call.attempt === 2).prompt, /AC-2/);
    assert.equal(new Set(h.calls.map((call) => call.label)).size, 8);
});

test("empty and whitespace-only REVISE findings are invalid and never trigger author retries", async (t) => {
    for (const findings of [[], [""], ["   "], [null]]) {
        const h = await harness(t, (call) => call.owner ? proposal() : vote("REVISE", findings));
        const result = await h.run();
        assert.equal(result.ok, false);
        assert.equal(result.attempts.length, 1);
        assert.match(result.reason, /invalid vote/);
    }
});

test("attempt exhaustion stops with full evidence and final owner artifact", async (t) => {
    const h = await harness(t, (call) => call.owner
        ? proposal({ iteration: call.attempt }) : vote("REVISE", ["Correct AC-1 mismatch at src/main.mjs"]));
    const result = await h.run({ attempts: 3 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /budget exhausted/);
    assert.deepEqual(result.value, { iteration: 3 });
    assert.equal(result.attempts.length, 3);
    assert.equal(h.calls.length, 12);
    assert.equal((await h.artifacts()).length, 12);
});

test("all malformed owner shapes are independently triaged, saved and never advance", async (t) => {
    for (const report of [
        null, [], "PASS", {}, { ...proposal(), status: "pass" },
        { ...proposal(), summary: "" }, { ...proposal(), evidence: null },
        { ...proposal(), evidence: [" "] }, { ...proposal(), artifact: null },
        { ...proposal(), artifact: [] }, { ...proposal(), blockerKind: 1 },
    ]) {
        const h = await harness(t, (call) => call.owner ? report : vote());
        const result = await h.run();
        assert.equal(result.ok, false);
        assert.equal(result.context, "triage");
        assert.equal(result.attempts[0].reviews.length, 3);
        assert.ok(result.attempts[0].validationErrors.length);
        const saved = (await h.artifacts()).find(({ file }) => /attempt-1\.json$/.test(file)).value;
        assert.deepEqual(saved.report, report);
        assert.ok(saved.validationErrors.length);
    }
});

test("malformed reviewer votes cannot pass SDK-independent runtime validation", async (t) => {
    for (const report of [
        null, [], {}, { ...vote(), verdict: "pass" }, { ...vote(), evidence: [] },
        { ...vote(), evidence: [null] }, { ...vote(), findings: null },
        vote("PASS", ["There is still a defect"]), { ...vote(), findings: [""] },
    ]) {
        const h = await harness(t, (call) => call.owner ? proposal() : report);
        const result = await h.run();
        assert.equal(result.ok, false);
        assert.equal(result.attempts[0].reviews.length, 3);
        assert.ok(result.attempts[0].reviews.every((review) => review.validationErrors.length));
        const saved = (await h.artifacts()).filter(({ file }) => /review-\d\.json$/.test(file));
        assert.equal(saved.length, 3);
        assert.ok(saved.every(({ value }) => value.validationErrors.length));
    }
});

test("agent errors are persisted and every independent reviewer is still consulted", async (t) => {
    const h = await harness(t, (call) => {
        if (call.owner) throw new Error("owner unavailable");
        if (call.label.includes("reviewer-Critic:")) throw new Error("review unavailable");
        return vote();
    });
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.context, "triage");
    assert.equal(result.attempts[0].reviews.length, 3);
    assert.ok(result.attempts[0].validationErrors.some((error) => /owner unavailable/.test(error)));
    assert.ok(result.attempts[0].reviews.at(-1).validationErrors.some((error) => /review unavailable/.test(error)));
    assert.equal((await h.artifacts()).length, 4);
});

test("read-only owner source drift throws an explicit persisted integrity violation", async (t) => {
    let source = { hash: "before" };
    const h = await harness(t, (call) => { if (call.owner) source.hash = "after"; }, {
        snapshot: async () => source,
    });
    await assert.rejects(h.run(), /Source integrity violation/);
    assert.equal(h.calls.length, 1);
    const [{ value }] = await h.artifacts();
    assert.ok(value.validationErrors.some((error) => /integrity violation/.test(error)));
});

test("reviewers cannot edit source even when the author is allowed scoped changes", async (t) => {
    let hash = "before";
    const h = await harness(t, (call) => {
        if (!call.owner && call.label.includes("reviewer-Critic:")) hash = "unexpected";
    }, {
        snapshot: async () => ({ hash }),
        assertAuthorChanges: async () => {},
        authorAgent: "lab-author",
    });
    await assert.rejects(h.run(), /Source integrity violation: independent reviewer batch/);
    assert.equal(h.calls.length, 4);
    assert.ok(h.calls.slice(1).every((call) => call.agent === "lab-reader"));
    const record = (await h.artifacts()).find(({ file }) => /attempt-1\.json$/.test(file)).value;
    assert.equal(record.reviews.length, 3);
    assert.ok(record.validationErrors.some((error) => /integrity violation/.test(error)));
});

test("caller author callback permits only explicitly scoped edits and receives immutable snapshots", async (t) => {
    const files = { "src/allowed.mjs": "before", "src/protected.mjs": "unchanged" };
    let checked = 0;
    const h = await harness(t, (call) => { if (call.owner) files["src/allowed.mjs"] = "after"; }, {
        authorAgent: "lab-source-author",
        snapshot: async () => files,
        async assertAuthorChanges(before, after) {
            checked++;
            assert.equal(before["src/allowed.mjs"], "before");
            assert.equal(after["src/allowed.mjs"], "after");
            assert.equal(before["src/protected.mjs"], after["src/protected.mjs"]);
        },
    });
    assert.equal((await h.run()).ok, true);
    assert.equal(checked, 1);
    assert.equal(h.calls[0].agent, "lab-source-author");
    assert.match(h.calls[0].prompt, /explicit assigned write scope/);
});

test("caller rejection of author scope violation throws and never starts review", async (t) => {
    const h = await harness(t, () => undefined, {
        snapshot: async () => ({ hash: "snapshot" }),
        assertAuthorChanges: async () => { throw new Error("outside assigned paths"); },
    });
    await assert.rejects(h.run(), /Source integrity violation.*outside assigned paths/);
    assert.equal(h.calls.length, 1);
});

test("a failed parallel scheduler cannot conceal reviewer source drift", async (t) => {
    let hash = "before";
    const h = await harness(t, () => undefined, { snapshot: async () => ({ hash }) });
    const ctx = {
        agent: async () => proposal(),
        parallel: async () => {
            hash = "after";
            throw new Error("scheduler interrupted");
        },
    };
    await assert.rejects(h.run({ ctx }), /Source integrity violation: independent reviewer batch/);
    const [{ value }] = await h.artifacts();
    assert.equal(value.reviews.length, 3);
    assert.ok(value.reviews.every((review) => review.validationErrors.length));
});

test("a missing independent vote is not silently accepted from parallel results", async (t) => {
    const h = await harness(t);
    const ctx = {
        agent: async () => proposal(),
        parallel: async () => [],
    };
    const result = await h.run({ ctx });
    assert.equal(result.ok, false);
    assert.match(result.reason, /invalid vote/);
    assert.ok(result.attempts[0].reviews.every((review) => /did not return/.test(review.validationErrors[0])));
});

test("dynamic recovery loop uses the responsible owner and independent Critic/Architect", async (t) => {
    const h = await harness(t);
    const result = await h.run({
        loop: { id: "recovery:deploy-0", owner: "DevOps Engineer", reviewers: ["Critic", "Architect"] },
    });
    assert.equal(result.ok, true);
    assert.match(h.calls[0].prompt, /Role: DevOps Engineer/);
    assert.deepEqual(result.attempts[0].reviews.map((review) => review.role), ["Critic", "Architect"]);
});

test("reject invalid configuration before invoking any agent", async (t) => {
    const h = await harness(t);
    for (const overrides of [
        { attempts: 0 }, { attempts: 1.5 }, { attempts: Infinity }, { loop: "missing" },
        { loop: { id: "bad", owner: "Architect", reviewers: ["Architect"] } },
        { loop: { id: "bad", owner: "Developer", reviewers: ["Critic", "Critic"] } },
        { loop: { id: "bad", owner: "Developer", reviewers: [] } },
        { assertAuthorChanges: () => {} }, { snapshot: true }, { validate: true },
    ]) {
        await assert.rejects(h.run(overrides));
    }
    assert.equal(h.calls.length, 0);
});
