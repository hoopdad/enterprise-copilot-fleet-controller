import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { normalizeFindings, verifyChecks, runLoop, ownerSchema, reviewerSchema } from "../lab-loops.mjs";
import { checks, owner, review, context, project, commitRequirements } from "./evidence.fixture.mjs";

const loop = { id: "AssignedWorkDeveloperLoop", name: "Work", owner: "Developer", reviewers: ["Critic", "Red Team", "Architect"] };
test("response contracts require executable checks and structured check suitability, not completion votes", () => {
    assert.ok(ownerSchema.required.includes("checks"));
    assert.ok(reviewerSchema.required.includes("checksValid"));
    assert.ok(reviewerSchema.required.includes("findings"));
    assert.equal(reviewerSchema.properties.agree, undefined);
    assert.equal(reviewerSchema.properties.taskComplete, undefined);
    assert.deepEqual(ownerSchema.properties.checks.items.required,
        ["id", "kind", "command", "requirement", "environment", "exitCode", "evidence"]);
});

test("Critic blockers need a real nonempty requirement line or an emitted failing check; everything else is observation", async (t) => {
    const root = await project(t);
    await mkdir(path.join(root, "docs/requirements"), { recursive: true });
    await writeFile(path.join(root, "docs/requirements/api.md"), "Health endpoint must respond.\n\n");
    await commitRequirements(root);
    const finding = { type: "blocking", summary: "Health endpoint absent.", action: "Implement the endpoint." };
    const cases = [
        [{ ...finding, requirement: { path: "docs/requirements/api.md", line: 1 } }, "blocking"],
        [{ ...finding, requirement: { path: "docs/requirements/api.md", line: 2 } }, "observation"],
        [{ ...finding, requirement: { path: "docs/requirements/missing.md", line: 1 } }, "observation"],
        [{ ...finding, requirement: { path: "README.md", line: 1 } }, "observation"],
        [{ ...finding, requirement: { path: "docs/requirements/../../checks.log", line: 1 } }, "observation"],
        [{ ...finding, requirement: { path: "docs/requirements/api.md", line: 0 } }, "observation"],
        [{ ...finding, failingCheck: "failure" }, "blocking"],
        [{ ...finding, failingCheck: "pass" }, "observation"],
        [{ ...finding, failingCheck: "unknown" }, "observation"],
        [{ ...finding, requirement: { path: "docs/requirements/api.md", line: 1 }, failingCheck: "failure" }, "observation"],
        [finding, "observation"],
        [{ ...finding, type: "observation", blocking: true }, "observation"],
    ];
    const emitted = [...checks({ id: "failure", exitCode: 1 }), ...checks({ id: "pass" })];
    for (const [input, expected] of cases) {
        const [result] = await normalizeFindings([input], { role: "Critic", checks: emitted, projectRoot: root });
        assert.equal(result.type, expected, JSON.stringify(input));
        if (expected === "observation") {
            assert.equal(result.failingCheck, undefined);
            assert.equal(result.requirement, undefined);
        }
    }
});

test("Red Team only blocks infrastructure configuration and application dependency CVE findings", async (t) => {
    const root = await project(t);
    for (const scope of ["infrastructure-config", "dependency-cve", "product-security", undefined]) {
        const [finding] = await normalizeFindings([{
            type: "blocking", summary: "A check failed.", action: "Fix the failure.", failingCheck: "bad", scope,
        }], { role: "Red Team", projectRoot: root, checks: checks({ id: "bad", exitCode: 2 }) });
        assert.equal(finding.type, ["infrastructure-config", "dependency-cve"].includes(scope) ? "blocking" : "observation");
    }
});

test("missing, failed, malformed, duplicate, empty or escaped check evidence cannot complete", async (t) => {
    const root = await project(t);
    await writeFile(path.join(root, "empty.log"), "");
    await symlink(path.join(root, ".."), path.join(root, "outside"));
    const valid = checks({ evidence: "checks.log" });
    assert.equal(await verifyChecks(valid, { projectRoot: root, assignment: {} }), null);
    for (const invalid of [
        [], undefined, checks({ exitCode: 1 }), checks({ exitCode: "0" }), checks({ command: "" }),
        checks({ kind: "vote" }), checks({ environment: "cloud" }), [...valid, ...valid],
        checks({ evidence: "missing.log" }), checks({ evidence: "empty.log" }),
        checks({ evidence: "../evidence.fixture.mjs" }), checks({ evidence: "outside/evidence.fixture.mjs" }),
        checks({ evidence: path.join(root, "checks.log") }),
        checks({ evidence: "checks.log", environment: "local", kind: "deployed-probe" }),
    ]) assert.equal(typeof await verifyChecks(invalid, { projectRoot: root }), "string", JSON.stringify(invalid));
    assert.match(await verifyChecks(checks({ evidence: "checks.log", environment: "local" }),
        { projectRoot: root, assignment: {} }), /deployed/);
    assert.equal(await verifyChecks(checks({ evidence: "checks.log", environment: "local" }), { projectRoot: root }), null);
});

test("unsupported critic/red-team votes and prose cannot gate; other reviewers assess check adequacy", async (t) => {
    const root = await project(t);
    let round = 0;
    const calls = [];
    const result = await runLoop({
        ctx: context((input) => {
            calls.push(input);
            if (input.kind === "doer") {
                round++;
                if (round > 1) assert.equal(input.feedback.reviews[0].findings[0].type, "observation");
                return owner({ checks: checks({ evidence: "checks.log" }) });
            }
            return review({
                agree: false, taskComplete: false, checksValid: input.role === "Architect" ? round > 1 : false,
                feedback: "Uncited mandatory redesign! No votes may complete this!",
                findings: [{ type: "blocking", summary: "Unsupported demand", action: "Redesign" }],
            });
        }), loop, key: "votes", context: { projectRoot: root, assignment: {} }, attempts: 3,
    });
    assert.equal(result.status, "agreed");
    assert.equal(result.rounds, 2);
    assert.ok(calls.every((call) => ["doer", "reviewer"].includes(call.kind)));
    assert.ok(!JSON.stringify(result).includes("disposition"));
    assert.ok(!JSON.stringify(result).includes("governanceHistory"));
    assert.ok(calls.every((call) => !Object.hasOwn(call, "priorDispositions")));
});

test("valid requirement-backed findings force rework and retain evidence without a triage chain", async (t) => {
    const root = await project(t);
    await mkdir(path.join(root, "docs/requirements"), { recursive: true });
    await writeFile(path.join(root, "docs/requirements/api.md"), "Require health check.\n");
    await commitRequirements(root);
    let round = 0;
    const calls = [];
    const result = await runLoop({
        ctx: context((input) => {
            calls.push(input);
            if (input.kind === "doer") {
                round++;
                if (round === 2) {
                    assert.equal(input.feedback.reviews[0].findings[0].requirement.line, 1);
                    assert.equal(input.feedback.governance, undefined);
                }
                return owner({ checks: checks({ evidence: "checks.log" }) });
            }
            return review({ findings: input.role === "Critic" && round === 1 ? [{
                type: "blocking", summary: "Health missing.", action: "Implement.",
                requirement: { path: "docs/requirements/api.md", line: 1 },
            }] : [] });
        }), loop, key: "requirement", context: { projectRoot: root, assignment: {} },
    });
    assert.equal(result.status, "agreed");
    assert.equal(result.rounds, 2);
    assert.equal(calls.filter((call) => call.kind === "doer").length, 2);
    assert.equal(calls.filter((call) => call.kind === "reviewer").length, 6);
    assert.deepEqual(await readFile(path.join(root, "docs/requirements/api.md"), "utf8"), "Require health check.\n");
});

test("checks are never executed by runtime and human limitations never fabricate completion", async (t) => {
    const root = await project(t);
    const result = await runLoop({
        ctx: context((input) => input.kind === "doer" ? owner({
            status: "needs-input", checks: [], limitation: "Deployment authorization denied.",
            nextAction: "Authorize the required deployment.",
        }) : review({ checksValid: false })),
        loop, key: "permission", context: { projectRoot: root, assignment: {} },
    });
    assert.equal(result.status, "needs-input");
    assert.deepEqual(result.checks, []);
    assert.equal(result.nextAction, "Authorize the required deployment.");
    assert.equal(result.limitation, "Deployment authorization denied.");
});
