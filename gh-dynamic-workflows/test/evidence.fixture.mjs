import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const fixtureBase = fileURLToPath(new URL(".", import.meta.url));
export const fixtureRoot = fileURLToPath(new URL("../..", import.meta.url));
export const checks = (overrides = {}) => [{
    id: "contract", kind: "schema", command: "node --test test/*.test.mjs",
    requirement: "Validate the assigned completeWhen contract", environment: "deployed", exitCode: 0,
    evidence: "gh-dynamic-workflows/package.json", ...overrides,
}];
export const skeletonChecks = (evidence = "gh-dynamic-workflows/package.json") => [
    ...checks({ id: "azd-deployment", kind: "test", command: "azd up --no-prompt", evidence }),
    ...checks({ id: "deployed-probe", kind: "deployed-probe", command: "curl --fail https://deployed.example/health", evidence }),
];
export const owner = (overrides = {}) => ({
    status: "complete", summary: "Synthetic test response, not real delivery evidence.", artifact: {},
    checks: checks(), progress: [], ...overrides,
});
export const review = (overrides = {}) => ({
    checksValid: true, findings: [], feedback: "Synthetic evidence inspected.", verifiedProgress: [], ...overrides,
});
export const correction = (overrides = {}) => ({
    type: "blocking", summary: "Required health response is absent.", action: "Implement the required response.",
    basis: "original-requirement", requirement: { path: "docs/requirements/api.md", line: 1 },
    reason: "The original user requires a health response, but the assigned endpoint has no response path.",
    ...overrides,
});
export const assessCorrections = (feedback, verdict = "confirmed", evidence = "checks.log") =>
    (feedback?.reviews ?? []).flatMap((review) => review.findings.filter((finding) => finding.type === "blocking")
        .map((finding) => ({ correctionId: finding.correctionId, verdict,
            reason: verdict === "confirmed" ? "The cited failure was reproduced and corrected."
                : verdict === "refuted" ? "The source and check demonstrate the required response already exists."
                    : "The available evidence does not establish whether the claim is true.",
            evidence })));
export const task = (id, kind = "developer", dependsOn = []) => ({
    id, title: id, kind, owner: kind === "designer" ? "Designer" : kind === "devops" ? "DevOps Engineer" : "Developer",
    dependsOn, doneWhen: "Assigned deployed checks pass.", exclusions: [], handoff: "Deployed check results.",
});
export const skeleton = () => ({ ...task("skeleton", "devops"), walkingSkeleton: true,
    doneWhen: "Deployed checks pass; azd handoff is available." });
export async function project(t) {
    const root = await mkdtemp(path.join(fixtureBase, ".evidence-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "checks.log"), "Fixture-only command output, exit code 0.\n");
    return root;
}
export async function commitRequirements(root, files = ["docs/requirements"]) {
    const execute = promisify(execFile);
    const git = (args) => execute("git", ["-C", root, ...args], {
        env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
    });
    await git(["init", "--quiet"]);
    await git(["add", "--", ...files]);
    await git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic requirement fixture"]);
}
export async function authorityProject(t) {
    const root = await project(t);
    await mkdir(path.join(root, "docs", "requirements"), { recursive: true });
    await writeFile(path.join(root, "docs", "requirements", "api.md"),
        "Original user request: the health endpoint must respond.\nUser explicitly approves adding a readiness response.\n");
    await commitRequirements(root);
    return root;
}
export function context(agent) {
    return {
        agent: async (prompt, options) => agent(JSON.parse(prompt), options),
        step: async (_, fn) => fn(), parallel: (thunks) => Promise.all(thunks.map((fn) => fn())), log() {},
    };
}
