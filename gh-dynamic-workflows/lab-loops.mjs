import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contextInstructions } from "./task-context.mjs";
import { workCardSchema, taskCardsSchema, validateWorkCard, validateTaskCards, workCardInstructions, architectureCardInstructions, planningCardInstructions } from "./work-cards.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && !!value.trim();
const executeFile = promisify(execFile);
export const checkSchema = {
    type: "object", additionalProperties: false,
    required: ["id", "kind", "command", "requirement", "environment", "exitCode", "evidence"],
    properties: {
        id: { type: "string", minLength: 1 },
        kind: { type: "string", enum: ["test", "schema", "deployed-probe"] },
        command: { type: "string", minLength: 1 }, requirement: { type: "string", minLength: 1 },
        environment: { type: "string", enum: ["local", "deployed"] },
        exitCode: { type: "integer" }, evidence: { type: "string", minLength: 1 },
    },
};
const findingFields = {
    summary: { type: "string", minLength: 1 }, action: { type: "string", minLength: 1 },
    scope: { type: "string", enum: ["infrastructure-config", "dependency-cve"] },
};
export const findingSchema = { oneOf: [
    { type: "object", additionalProperties: false, required: ["type", "summary", "action"],
        properties: { type: { const: "observation" }, ...findingFields } },
    { type: "object", additionalProperties: false, required: ["type", "summary", "action"],
        properties: { type: { const: "blocking" }, ...findingFields,
            requirement: { type: "object", additionalProperties: false, required: ["path", "line"],
                properties: { path: { type: "string", pattern: "^docs/requirements/.+" }, line: { type: "integer", minimum: 1 } } },
            failingCheck: { type: "string", minLength: 1 } },
        oneOf: [{ type: "object", required: ["requirement"], not: { type: "object", required: ["failingCheck"] } },
            { type: "object", required: ["failingCheck"], not: { type: "object", required: ["requirement"] } }] },
] };
export const ownerSchema = {
    type: "object", required: ["status", "summary", "artifact", "workCard", "checks"],
    properties: {
        status: { type: "string", enum: ["complete", "rework", "needs-replan", "needs-input"] },
        summary: { type: "string" }, artifact: { type: "object" }, nextAction: { type: "string" },
        limitation: { type: "string" }, workCard: workCardSchema, taskCards: taskCardsSchema,
        checks: { type: "array", items: checkSchema },
        progress: { type: "array", items: { type: "object", required: ["id", "evidence"],
            properties: { id: { type: "string", minLength: 1 }, evidence: { type: "string", minLength: 1 } } } },
    },
};
export const reviewerSchema = {
    type: "object", required: ["checksValid", "findings", "feedback", "workCard"],
    properties: {
        checksValid: { type: "boolean" }, findings: { type: "array", items: findingSchema },
        feedback: { type: "string" }, workCard: workCardSchema,
        verifiedProgress: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    },
};

// Resolve only repository-local evidence; neither evidence nor citations may escape through symlinks.
async function sourceFile(root, relative) {
    if (!root || !text(relative) || path.isAbsolute(relative)) throw new Error("Expected a repository-relative evidence path");
    const base = await realpath(root);
    const file = await realpath(path.resolve(base, relative));
    if (!file.startsWith(base + path.sep)) throw new Error("Evidence must stay inside projectRoot");
    return readFile(file, "utf8");
}

async function requirementLine(root, requirement) {
    const base = await realpath(root);
    const file = await realpath(path.resolve(base, requirement.path));
    if (!file.startsWith(path.join(base, "docs", "requirements") + path.sep)) return false;
    const lines = (await sourceFile(base, requirement.path)).split(/\r?\n/);
    const current = lines[requirement.line - 1];
    if (!current?.trim()) return false;
    // Fixed read-only Git operations verify authority; emitted check commands never run here.
    const git = async (args) => (await executeFile("git", ["--no-pager", "-C", base, ...args],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })).stdout;
    const prefix = (await git(["rev-parse", "--show-prefix"])).replace(/[\r\n]+$/, "");
    const committed = await git(["show", `HEAD:${prefix}${requirement.path}`]);
    return committed.split(/\r?\n/)[requirement.line - 1] === current;
}

export async function verifyChecks(checks, context = {}) {
    if (!Array.isArray(checks) || !checks.length) return "Completion requires nonempty executable checks.";
    const ids = new Set();
    for (const check of checks) {
        if (!object(check) || !["id", "command", "requirement", "evidence"].every((field) => text(check[field])) ||
            !["test", "schema", "deployed-probe"].includes(check.kind) ||
            !["local", "deployed"].includes(check.environment) || !Number.isInteger(check.exitCode) ||
            ids.has(check.id) || (check.kind === "deployed-probe" && check.environment !== "deployed")) {
            return "Checks need unique ids and all structured execution/evidence fields.";
        }
        ids.add(check.id);
        if (check.exitCode !== 0) return `Check ${check.id} failed with exit code ${check.exitCode}.`;
        try {
            if (!(await sourceFile(context.projectRoot, check.evidence)).trim()) throw new Error("Empty evidence");
        } catch {
            return `Check ${check.id} needs an inspectable nonempty repository-relative evidence file.`;
        }
    }
    if ((context.assignment || context.continuousVerification) && !checks.some((check) => check.environment === "deployed")) {
        return "Every assignment and continuous verification requires a passing deployed-environment check.";
    }
    return null;
}

export async function normalizeFindings(findings, { role, checks = [], projectRoot } = {}) {
    return Promise.all((Array.isArray(findings) ? findings : []).map(async (finding) => {
        const normalized = {
            type: "observation", summary: text(finding?.summary) ? finding.summary : "Unsupported finding",
            action: text(finding?.action) ? finding.action : "No blocking action established.",
            ...(["infrastructure-config", "dependency-cve"].includes(finding?.scope) ? { scope: finding.scope } : {}),
        };
        if (!object(finding) || finding.type !== "blocking" || !text(finding.summary) || !text(finding.action) ||
            (role === "Red Team" && !["infrastructure-config", "dependency-cve"].includes(finding.scope))) return normalized;
        const requirement = finding.requirement;
        const hasRequirement = requirement !== undefined, hasCheck = finding.failingCheck !== undefined;
        if (hasRequirement === hasCheck) return normalized;
        if (hasCheck && checks.some((check) => text(check.id) && check.id === finding.failingCheck &&
            Number.isInteger(check.exitCode) && check.exitCode !== 0)) {
            return { ...normalized, type: "blocking", failingCheck: finding.failingCheck };
        }
        if (object(requirement) && /^docs\/requirements\/.+/.test(requirement.path) &&
            !requirement.path.split("/").includes("..") && Number.isInteger(requirement.line) && requirement.line > 0) {
            try {
                if (await requirementLine(projectRoot, requirement)) {
                    return { ...normalized, type: "blocking", requirement };
                }
            } catch { /* Missing or inaccessible citations are observations, not authority. */ }
        }
        return normalized;
    }));
}

const ownerInstructions = [
    ...contextInstructions, ...workCardInstructions,
    "Carry out this loop's work using ordinary permission-bound repository tools. Execute checks through those tools; this runtime never executes supplied command strings or broadens permissions.",
    "The scope ledger is repository docs/requirements and tests, within the assigned doneWhen and exclusions. completeWhen must be verified by executable checks each round, not reviewer completion votes.",
    "Return checks:[{id,kind:test|schema|deployed-probe,command,requirement,environment:local|deployed,exitCode,evidence}]. Record actual commands and exit codes; evidence is a repository-relative nonempty log/result file reviewers can inspect against actual source and commits. Never fabricate successful checks. All assignments require a passing deployed-environment check.",
    "For genuinely non-executable work, report limitation explaining exactly why no suitable executable check exists and return needs-input or rework with nextAction. Empty checks never complete a loop; schema checks can validate planning artifacts but must actually run.",
    "Return complete only when your own status and nonempty passing checks satisfy this loop's completeWhen. Reviewer pending responses are not owner rework. Return rework for correctable failures, needs-input for missing human authority, or needs-replan for a material scoped contract/architecture change.",
    "Use artifact keys matching YAML outputs. ReleasePlan contains sprints with unique ids. SprintPlan contains tasks with id,title,kind (ui/developer/designer/devops),owner,dependsOn,doneWhen,exclusions,handoff.",
    "Deployment comes first: the first sprint starts with walkingSkeleton:true,kind:devops,owner:DevOps Engineer,dependsOn:[],doneWhen requiring a deployed pass and azd handoff. Every other first-sprint task transitively depends on it. Include exclusiveResources for shared deployment/configuration state.",
    "EndToEndTestLoop and DevOpsWorkLoop run after every accepted assignment, before its dependents. Failing E2E or deployment is not successful completion, even when accurately reported.",
    "Read normalized feedback directly; observations are optional and never imply scope expansion. Fix evidence-backed blockers or failing/unsuitable checks. No Scrum triage, Architect advice, Product Owner decision or disposition ledger runs between rounds.",
    "Before ending every turn that changes files, including rework or needs-input, commit your own intended changes before reviewers inspect them. Never commit secrets, generated junk or another person's work. Report branch and commit IDs; if committing fails, report the problem, not complete.",
    "Inspect Git status first and preserve concurrent changes. Stage explicit owned paths and use path-scoped git commit --only in shared checkouts. Do not switch branches underneath active agents, discard work, force-push or remove Git locks. Keep task commits available for integration.",
    "Use request.git.featureBranch when supplied. Include observed model/usage/elapsed metadata in commit messages only when actually available; never invent counters.",
    "At SprintReview, SprintRetro and ReleaseCloseout reconcile intended work onto the feature branch or retain abandoned commits on a named branch with concrete abandonment reasons recorded in a feature-branch commit.",
];
const reviewInstructions = [
    ...contextInstructions, ...workCardInstructions,
    "Independently inspect actual source, command logs/result files and Git commits, not just owner summaries. Confirm checks actually exercise completeWhen, requirements and doneWhen on the claimed environment. Return checksValid:boolean for check suitability and evidence credibility, not a completion vote.",
    "Return findings as a discriminated union: {type:observation,summary,action} OR {type:blocking,summary,action,requirement:{path:docs/requirements/...,line:positive integer}} OR {type:blocking,summary,action,failingCheck:id}. Cite exactly one source. Requirement lines must resolve inside projectRoot/docs/requirements and match the committed HEAD line; dirty/new fabricated lines cannot block. FailingCheck must name an emitted check with nonzero exitCode. Unsupported claims become observations.",
    "Critic and Red Team can block ONLY with a valid structured finding citing a requirement line or failing check. Raw agree:false, taskComplete:false, prose and checksValid:false without a supported blocker cannot gate these roles. Other reviewers assess check adequacy using checksValid, not substitute completion votes.",
    "Critic: is everything required present and everything present required? Missing work or untraceable additions need a real requirement line or failing check to block; otherwise record an observation. Requirements and tests are the scope ledger.",
    "Red Team: findings are limited to infrastructure-config or dependency-cve; include scope with one of those values. Review infrastructure configurations and application library CVEs only, not general product security or invented governance controls.",
    "Observations never block and there is no zero-findings requirement. Pending parallel reviewer responses are not unmet owner criteria. Preserve human authorization boundaries.",
    "Keep review read-only. Inspect actual Git commits for changed files and require credible logs; do not fabricate missing evidence or waive deployed assignment checks. No dispositions or governance triage.",
];

export async function runLoop({ ctx, loop, key, context, attempts, maxNoProgressRounds, agents = {}, decode, dispatch,
    scheduleAgent = (_, work) => work(), priority = 0 }) {
    if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 1)) throw new Error("An explicitly supplied loop attempt limit must be a positive integer");
    if (maxNoProgressRounds !== undefined && (!Number.isSafeInteger(maxNoProgressRounds) || maxNoProgressRounds < 1)) throw new Error("An explicitly supplied maxNoProgressRounds must be a positive integer");
    const guardLimit = maxNoProgressRounds ?? 3;
    const doerSchema = { ...ownerSchema, required: [...ownerSchema.required, "progress",
        ...(loop.id === "SprintPlanLoop" ? ["taskCards"] : [])] };
    const reviewSchema = { ...reviewerSchema, required: [...reviewerSchema.required, "verifiedProgress"] };
    return ctx.step(key, async () => {
        let feedback = null, noProgressRounds = 0;
        const credited = [], evidence = new Set();
        const progressState = () => ({ noProgressRounds, limit: guardLimit, credited: [...credited] });
        for (let attempt = 1; attempts === undefined || attempt <= attempts; attempt++) {
            ctx.signal?.throwIfAborted();
            ctx.log(`${loop.name}: ${loop.owner}, round ${attempt}`);
            const owner = await scheduleAgent("doer", () => ctx.agent(JSON.stringify({
                kind: "doer", role: loop.owner, loop, context, feedback, progressState: progressState(),
                instructions: [...ownerInstructions,
                    ...(["ArchitectureLoop", "SprintArchitectureLoop"].includes(loop.id) ? architectureCardInstructions : []),
                    ...(loop.id === "SprintPlanLoop" ? planningCardInstructions : []),
                    "Report progress:[{id,evidence}] only for substantive NEW advances; repeated evidence, prose churn and activity alone are not progress.",
                    ...(dispatch ? ["Plan completion requires dispatch-ready assignments, not completed implementation. Use rough estimatedMinutes critical paths and bounded contract handoffs. Match exclusiveResources for mutable contention, not merely file overlap."] : []),
                    ...(context.scopeRevision ? ["Resolve only the affected scoped amendment with existing Architect/Scrum Master loops. Preserve unrelated accepted work and requirements; use a separate replacement graph with internal dependency IDs."] : []),
                ],
            }), { agent: agents.owner ?? agents.doer ?? "workflow-owner", label: `${key}:doer:${attempt}`, schema: doerSchema }), priority);
            if (!object(owner) || !["complete", "rework", "needs-replan", "needs-input"].includes(owner.status) ||
                typeof owner.summary !== "string" || !object(owner.artifact)) throw new Error(`Invalid do-er response in ${loop.id}; no completion was recorded`);
            validateWorkCard(owner.workCard, `${loop.id} owner`);
            if (!Array.isArray(owner.checks)) throw new Error(`Invalid do-er checks in ${loop.id}; no completion was recorded`);
            if (!Array.isArray(owner.progress) || owner.progress.some((item) => !object(item) || !text(item.id) || !text(item.evidence)) ||
                new Set(owner.progress.map((item) => item.id)).size !== owner.progress.length) throw new Error(`Invalid do-er progress in ${loop.id}; no progress was credited`);
            let transportIssue = await verifyChecks(owner.checks, context);
            if (owner.status === "complete" && !transportIssue && decode) {
                try {
                    await decode(owner.artifact);
                    if (loop.id === "SprintPlanLoop") validateTaskCards(owner.taskCards, owner.artifact.SprintPlan?.tasks, loop.id);
                } catch (error) { transportIssue = error.message; }
            }
            const dispatched = owner.status === "complete" && !transportIssue && dispatch ? await dispatch(owner.artifact, attempt) : undefined;
            let reviews;
            try {
                reviews = await ctx.parallel(loop.reviewers.map((role) => async () => {
                    const review = await scheduleAgent("reviewer", () => ctx.agent(JSON.stringify({
                        kind: "reviewer", role, loop, context, owner, transportIssue, dispatch: dispatched?.context, feedback,
                        progressState: progressState(), instructions: [...reviewInstructions,
                            "Return verifiedProgress:[id,...] only for independently inspected NEW advances in owner.progress. Compare prior credited evidence; repeated tests alone do not count."],
                    }), { agent: agents.reviewer ?? "workflow-reviewer", label: `${key}:reviewer:${role}:${attempt}`,
                        schema: role === "Red Team" ? { ...reviewSchema, properties: { ...reviewSchema.properties,
                            findings: { type: "array", items: { oneOf: findingSchema.oneOf.map((branch) => ({
                                ...branch, required: [...branch.required, "scope"],
                            })) } },
                        } } : reviewSchema }), priority);
                    if (!object(review) || typeof review.checksValid !== "boolean" || typeof review.feedback !== "string" ||
                        !Array.isArray(review.findings)) throw new Error(`Invalid ${role} reviewer response in ${loop.id}`);
                    validateWorkCard(review.workCard, `${loop.id} ${role} reviewer`);
                    if (!Array.isArray(review.verifiedProgress) || review.verifiedProgress.some((id) => !owner.progress.some((item) => item.id === id)) ||
                        new Set(review.verifiedProgress).size !== review.verifiedProgress.length) throw new Error(`Invalid ${role} reviewer progress in ${loop.id}; no progress was credited`);
                    const findings = await normalizeFindings(review.findings, { role, checks: owner.checks, projectRoot: context.projectRoot });
                    const accepted = !findings.some((finding) => finding.type === "blocking") &&
                        (["Critic", "Red Team"].includes(role) || review.checksValid);
                    return { role, checksValid: review.checksValid, feedback: review.feedback, findings,
                        verifiedProgress: review.verifiedProgress, ...(review.workCard ? { workCard: review.workCard } : {}), accepted };
                }));
                if (reviews.some((review) => !review)) throw new Error(`Reviewer execution failed in ${loop.id}`);
            } catch (error) { await dispatched?.settle(); throw error; }
            const accepted = reviews.every((review) => review.accepted);
            const result = { artifact: owner.artifact, summary: owner.summary, checks: owner.checks, reviews, rounds: attempt,
                ...(owner.workCard ? { workCard: owner.workCard } : {}),
                ...(text(owner.limitation) ? { limitation: owner.limitation } : {}) };
            if (owner.status === "needs-input") {
                await dispatched?.settle();
                return { ...result, status: "needs-input", nextAction: owner.nextAction ?? "Supply the exact missing authority or input." };
            }
            if (owner.status === "complete" && !transportIssue && accepted) {
                return { ...result, status: "agreed", ...(dispatched ? { dispatch: dispatched.context } : {}) };
            }
            const dispatchedWork = await dispatched?.settle();
            feedback = { owner, reviews, transportIssue, ...(dispatchedWork ? { dispatchedWork } : {}) };
            if (owner.status === "needs-replan" && !["ArchitectureLoop", "UserExperienceLoop", "ReleasePlanLoop",
                "SprintDesignLoop", "SprintArchitectureLoop", "SprintPlanLoop"].includes(loop.id)) {
                return { ...result, status: "needs-replan", feedback,
                    nextAction: owner.nextAction ?? "Revise only the affected assignment through existing architecture/planning loops." };
            }
            const advances = owner.progress.filter((item) => !credited.some((prior) => prior.id === item.id) &&
                !evidence.has(item.evidence.trim().replace(/\s+/g, " ").toLowerCase()) &&
                reviews.every((review) => review.verifiedProgress.includes(item.id)));
            for (const item of advances) {
                credited.push({ ...item, round: attempt });
                evidence.add(item.evidence.trim().replace(/\s+/g, " ").toLowerCase());
            }
            noProgressRounds = advances.length ? 0 : noProgressRounds + 1;
            if (noProgressRounds >= guardLimit) return { ...result, status: "blocked", stopCause: "no-progress",
                reason: transportIssue ?? "No new advance verified by every original reviewer.",
                nextAction: "Inspect unresolved checks and findings and change approach.", progress: progressState(), feedback };
        }
        return { status: "limit-reached", rounds: attempts, limit: attempts,
            summary: `${loop.id} stopped at the explicitly supplied ${attempts}-round limit.`,
            reason: feedback.transportIssue ?? `The do-er reported ${feedback.owner.status}: ${feedback.owner.summary}`,
            nextAction: "Continue from existing work and unresolved checks/findings in a new run.", feedback };
    });
}
