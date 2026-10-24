import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { normalizeFindings, verifyChecks, runLoop, ownerSchema, reviewerSchema, SECURITY_ROLE } from "../lab-loops.mjs";
import { checks, skeletonChecks, owner, review, context, project, commitRequirements,
    authorityProject, correction, assessCorrections } from "./evidence.fixture.mjs";

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

test("all mandatory corrections need original requirement or approved amendment citations and falsifiable reasons", async (t) => {
    const root = await authorityProject(t);
    const finding = correction();
    const defect = correction({ basis: "demonstrated-defect", evidence: "checks.log", failingCheck: "failure" });
    const cases = [
        [finding, "blocking"],
        [{ ...finding, basis: "approved-amendment", requirement: { path: "docs/requirements/api.md", line: 2 } }, "blocking"],
        [defect, "blocking"],
        [{ ...defect, failingCheck: undefined }, "blocking"],
        [{ ...finding, requirement: { path: "docs/requirements/api.md", line: 3 } }, "observation"],
        [{ ...finding, requirement: { path: "docs/requirements/missing.md", line: 1 } }, "observation"],
        [{ ...finding, requirement: { path: "README.md", line: 1 } }, "observation"],
        [{ ...finding, requirement: { path: "docs/requirements/../../checks.log", line: 1 } }, "observation"],
        [{ ...finding, requirement: { path: "docs/requirements/api.md", line: 0 } }, "observation"],
        [{ ...finding, requirement: { path: "docs\\requirements\\api.md", line: 1 } }, "blocking"],
        [{ ...finding, requirement: { path: path.join(root, "docs/requirements/api.md"), line: 1 } }, "observation"],
        [{ ...finding, requirement: undefined }, "observation"],
        [{ ...finding, basis: undefined }, "observation"],
        [{ ...finding, basis: "architect-preference" }, "observation"],
        [{ ...finding, reason: "" }, "observation"],
        [{ ...finding, failingCheck: "failure" }, "observation"],
        [{ ...finding, failingCheck: "pass" }, "observation"],
        [{ ...defect, failingCheck: "pass" }, "observation"],
        [{ ...defect, failingCheck: "unknown" }, "observation"],
        [{ ...defect, evidence: "missing.log" }, "observation"],
        [{ ...defect, evidence: undefined }, "observation"],
        [{ ...defect, evidence: "../evidence.fixture.mjs" }, "observation"],
        [{ ...defect, evidence: "gh-dynamic-workflows/package.json" }, "observation"],
        [{ ...defect, requirement: undefined }, "observation"],
        [{ ...finding, type: "observation", blocking: true }, "observation"],
    ];
    const emitted = [...checks({ id: "failure", exitCode: 1, evidence: "checks.log" }), ...checks({ id: "pass" })];
    for (const role of ["Architect", "Product Owner", "Scrum Master", "Developer", "Designer", "DevOps Engineer", "Stakeholder", "Critic"]) {
        for (const [input, expected] of cases) {
            const [result] = await normalizeFindings([input], { role, checks: emitted, projectRoot: root });
            assert.equal(result.type, expected, `${role}: ${JSON.stringify(input)}`);
            if (expected === "observation") {
                assert.equal(result.failingCheck, undefined);
                assert.equal(result.requirement, undefined);
                assert.equal(result.correctionId, undefined);
            } else {
                assert.equal(result.correctionId, `${role}:1`);
                assert.equal(result.reason, input.reason);
            }
        }
    }
});

test("Network/Infrastructure Security and its legacy alias only block infrastructure or dependency CVEs", async (t) => {
    const root = await authorityProject(t);
    for (const role of [SECURITY_ROLE, "Red Team"]) for (const scope of [
        "infrastructure-config", "dependency-cve", "product-security", undefined,
    ]) {
        const [finding] = await normalizeFindings([correction({ scope })], { role, projectRoot: root });
        assert.equal(finding.type, ["infrastructure-config", "dependency-cve"].includes(scope) ? "blocking" : "observation");
    }
});

test("original request files outside the requirements ledger may be cited directly", async (t) => {
    const root = await project(t);
    await writeFile(path.join(root, "user-request.md"), "Original user: provide a health response.\n");
    await commitRequirements(root, ["user-request.md"]);
    const [finding] = await normalizeFindings([correction({ requirement: { path: "user-request.md", line: 1 } })],
        { role: "Architect", projectRoot: root });
    assert.equal(finding.type, "blocking");
});

test("requirement citations reject new/dirty lines and directory-symlink escapes", async (t) => {
    const root = await authorityProject(t);
    const finding = (name, line = 1) => correction({ requirement: { path: `docs/requirements/${name}`, line } });
    const normalize = async (item) => (await normalizeFindings([item], { role: "Critic", projectRoot: root }))[0];
    assert.equal((await normalize(finding("api.md"))).type, "blocking");
    await writeFile(path.join(root, "docs/requirements/api.md"), "A fabricated replacement requirement.\n");
    assert.equal((await normalize(finding("api.md"))).type, "observation");
    await writeFile(path.join(root, "docs/requirements/new.md"), "An uncommitted invented requirement.\n");
    assert.equal((await normalize(finding("new.md"))).type, "observation");
    const outside = await authorityProject(t);
    await symlink(path.join(outside, "docs/requirements"), path.join(root, "escape"),
        process.platform === "win32" ? "junction" : "dir");
    assert.equal((await normalize(correction({ requirement: { path: "escape/api.md", line: 1 } }))).type, "observation");
});

test("missing, failed, malformed, duplicate, empty or escaped check evidence cannot complete", async (t) => {
    const root = await project(t);
    await writeFile(path.join(root, "empty.log"), "");
    await symlink(path.join(root, ".."), path.join(root, "outside"), process.platform === "win32" ? "junction" : "dir");
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

test("walking skeleton needs actual emitted azd deployment and a distinct deployed probe, not wording", async (t) => {
    const root = await project(t);
    const packet = { projectRoot: root, assignment: { walkingSkeleton: true,
        doneWhen: "passes in deployed environment", handoff: "azd deployment URL" } };
    assert.match(await verifyChecks(checks({ evidence: "checks.log" }), packet), /azd up\/provision\/deploy/);
    assert.equal(await verifyChecks(skeletonChecks("checks.log"), packet), null);
    assert.match(await verifyChecks(skeletonChecks("checks.log").slice(0, 1), packet), /separate passing deployed probe/);
    assert.match(await verifyChecks(skeletonChecks("checks.log").map((check) =>
        check.id === "azd-deployment" ? { ...check, command: "echo azd up" } : check), packet), /azd/);
    for (const command of ["azd provision --no-prompt", "azd deploy --no-prompt"]) {
        assert.equal(await verifyChecks(skeletonChecks("checks.log").map((check) =>
            check.id === "azd-deployment" ? { ...check, command } : check), packet), null);
    }
});

test("unsupported votes, prose and check-adequacy objections cannot gate ANY reviewer role", async (t) => {
    const root = await project(t);
    let round = 0;
    const calls = [];
    const result = await runLoop({
        ctx: context((input) => {
            calls.push(input);
            if (input.kind === "doer") {
                round++;
                if (round > 1) {
                    assert.equal(input.feedback.reviews[0].findings[0].type, "observation");
                    assert.equal(input.feedback.reviews[0].accepted, true);
                    assert.match(input.instructions.join("\n"), /Reviewer feedback prose is audit commentary/);
                }
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
    assert.equal(result.rounds, 1);
    assert.ok(result.reviews.every((review) => review.accepted));
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
                return owner({ checks: checks({ evidence: "checks.log" }),
                    correctionAssessments: assessCorrections(input.feedback) });
            }
            return review({ findings: input.role === "Critic" && round === 1 ? [correction()] : [] });
        }), loop, key: "requirement", context: { projectRoot: root, assignment: {} },
    });
    assert.equal(result.status, "agreed");
    assert.equal(result.rounds, 2);
    assert.equal(calls.filter((call) => call.kind === "doer").length, 2);
    assert.equal(calls.filter((call) => call.kind === "reviewer").length, 6);
    assert.ok(!calls.some((call) => call.citationVerification));
    assert.deepEqual(await readFile(path.join(root, "docs/requirements/api.md"), "utf8"), "Require health check.\n");
});

test("valid requirement blockers use only original parallel reviewers and cannot be waived by another approval", async (t) => {
    const root = await project(t);
    await mkdir(path.join(root, "docs/requirements"), { recursive: true });
    await writeFile(path.join(root, "docs/requirements/api.md"), "Health endpoint must respond.\n");
    await commitRequirements(root);
    const calls = [];
    const result = await runLoop({
        ctx: context((input) => {
            calls.push(input);
            if (input.kind === "doer") return owner({ checks: checks({ evidence: "checks.log" }) });
            return review({ findings: input.role === "Critic" ? [correction()] : [] });
        }),
        loop, key: "original-reviews", context: { projectRoot: root, assignment: {} }, attempts: 1,
    });
    assert.equal(result.status, "limit-reached");
    assert.equal(result.feedback.reviews[0].findings[0].type, "blocking");
    assert.deepEqual(calls.filter((call) => call.kind === "reviewer").map((call) => call.role), loop.reviewers);
    assert.equal(calls.length, 1 + loop.reviewers.length);
    assert.ok(!calls.some((call) => call.kind === "governance" || call.citationVerification));
});

test("every reviewer role must ground mandatory corrections, regardless of check-suitability opinion", async (t) => {
    const root = await authorityProject(t);
    for (const role of ["Architect", "Product Owner", "Scrum Master", "Developer", "Designer", "DevOps Engineer", "Stakeholder", "Critic", "Red Team"]) {
        const result = await runLoop({
            ctx: context((input) => input.kind === "doer" ? owner({ checks: checks({ evidence: "checks.log" }) })
                : review({ checksValid: true, findings: [correction(role === "Red Team" ? { scope: "infrastructure-config" } : {})] })),
            loop: { ...loop, reviewers: [role] }, key: role, context: { projectRoot: root }, attempts: 1,
        });
        assert.equal(result.status, "limit-reached", role);
        assert.equal(result.feedback.reviews[0].accepted, false);
        assert.equal(result.feedback.reviews[0].findings[0].correctionId, `${role}:1`);
    }
});

test("owner judges corrections and existing reviewers verify confirmed, refuted and unresolved responses", async (t) => {
    const root = await authorityProject(t);
    for (const verdict of ["confirmed", "refuted", "unresolved"]) {
        let round = 0;
        const result = await runLoop({
            ctx: context((input, options) => {
                if (input.kind === "doer") {
                    round++;
                    if (round === 2) assert.ok(options.schema.required.includes("correctionAssessments"));
                    return owner({ checks: checks({ evidence: "checks.log" }),
                        correctionAssessments: assessCorrections(input.feedback, verdict, verdict === "unresolved" ? "" : "checks.log") });
                }
                if (round === 2) {
                    assert.equal(input.owner.correctionAssessments[0].verdict, verdict);
                    assert.match(input.instructions.join("\n"), /Independently verify correctionAssessments/);
                }
                return review({ checksValid: false, findings: round === 1 ? [correction()] : [] });
            }),
            loop: { ...loop, reviewers: ["Architect", "Product Owner"] },
            key: verdict, context: { projectRoot: root }, attempts: 2,
        });
        assert.equal(result.status, "agreed");
        assert.equal(result.rounds, 2);
        assert.deepEqual(result.correctionAssessments.map((item) => item.verdict), [verdict, verdict]);
    }
});

test("missing, duplicate, invented and unsupported owner correction assessments fail explicitly", async (t) => {
    const root = await authorityProject(t);
    for (const alter of [
        () => undefined, () => [], (items) => [...items, ...items],
        (items) => [{ ...items[0], correctionId: "Invented:1" }],
        (items) => [{ ...items[0], verdict: "agree" }],
        (items) => [{ ...items[0], reason: "" }],
        (items) => [{ ...items[0], evidence: "" }],
        (items) => [{ ...items[0], evidence: "missing.log" }],
        (items) => [{ ...items[0], evidence: "../evidence.fixture.mjs" }],
    ]) {
        let round = 0;
        await assert.rejects(runLoop({
            ctx: context((input) => input.kind === "doer" ? owner({
                checks: checks({ evidence: "checks.log" }),
                ...(++round > 1 ? { correctionAssessments: alter(assessCorrections(input.feedback)) } : {}),
            }) : review({ findings: [correction()] })),
            loop: { ...loop, reviewers: ["Architect"] }, key: "bad-assessment", context: { projectRoot: root }, attempts: 2,
        }), /[Cc]orrection assessment/);
    }
});

test("an owner refutation or unresolved response cannot waive an actual failing required check", async (t) => {
    const root = await authorityProject(t);
    let round = 0;
    const result = await runLoop({
        ctx: context((input) => input.kind === "doer" ? owner({
            checks: checks({ evidence: "checks.log", exitCode: ++round > 1 ? 1 : 0 }),
            correctionAssessments: assessCorrections(input.feedback, "refuted"),
        }) : review({ findings: round === 1 ? [correction()] : [] })),
        loop: { ...loop, reviewers: ["Architect"] }, key: "refuted-check", context: { projectRoot: root }, attempts: 2,
    });
    assert.equal(result.status, "limit-reached");
    assert.match(result.reason, /Check contract failed/);
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
