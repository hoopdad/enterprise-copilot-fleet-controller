import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contextInstructions } from "./task-context.mjs";
import { workCardSchema, taskCardsSchema, validateWorkCard, validateTaskCards, workCardInstructions, architectureCardInstructions, planningCardInstructions } from "./work-cards.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && !!value.trim();
const executeFile = promisify(execFile);
export const CORRECTION_CONTRACT = "requirement-grounded-v1";
export const SECURITY_ROLE = "Network/Infrastructure Security";
const securityRole = (role) => [SECURITY_ROLE, "Red Team"].includes(role);
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
const citationSchema = {
    type: "object", additionalProperties: false, required: ["path", "line"],
    properties: { path: { type: "string", minLength: 1 }, line: { type: "integer", minimum: 1 } },
};
export const findingSchema = { oneOf: [
    { type: "object", additionalProperties: false, required: ["type", "summary", "action"],
        properties: { type: { const: "observation" }, ...findingFields } },
    ...["original-requirement", "approved-amendment", "demonstrated-defect"].map((basis) => ({
        type: "object", additionalProperties: false,
        required: ["type", "summary", "action", "basis", "requirement", "reason",
            ...(basis === "demonstrated-defect" ? ["evidence"] : [])],
        properties: { type: { const: "blocking" }, ...findingFields,
            basis: { const: basis }, requirement: citationSchema, reason: { type: "string", minLength: 1 },
            ...(basis === "demonstrated-defect" ? {
                evidence: { type: "string", minLength: 1 }, failingCheck: { type: "string", minLength: 1 },
            } : {}) },
    })),
] };
const correctionAssessmentSchema = {
    type: "object", additionalProperties: false,
    required: ["correctionId", "verdict", "reason", "evidence"],
    properties: {
        correctionId: { type: "string", minLength: 1 },
        verdict: { type: "string", enum: ["confirmed", "refuted", "unresolved"] },
        reason: { type: "string", minLength: 1 }, evidence: { type: "string" },
    },
};
export const ownerSchema = {
    type: "object", required: ["status", "summary", "artifact", "workCard", "checks"],
    properties: {
        status: { type: "string", enum: ["complete", "rework", "needs-replan", "needs-input"] },
        summary: { type: "string" }, artifact: { type: "object" }, nextAction: { type: "string" },
        limitation: { type: "string" }, workCard: workCardSchema, taskCards: taskCardsSchema,
        checks: { type: "array", items: checkSchema },
        correctionAssessments: { type: "array", items: correctionAssessmentSchema },
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
    if (!object(requirement) || !text(requirement.path) || path.isAbsolute(requirement.path) ||
        requirement.path.split(/[\\/]/).includes("..") ||
        !Number.isSafeInteger(requirement.line) || requirement.line < 1) return false;
    const base = await realpath(root);
    const lines = (await sourceFile(base, requirement.path)).split(/\r?\n/);
    const current = lines[requirement.line - 1];
    if (!current?.trim()) return false;
    // Git verifies citation integrity, not user authorship or semantic entailment.
    const git = async (args) => (await executeFile("git", ["--no-pager", "-C", base, ...args],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })).stdout;
    const prefix = (await git(["rev-parse", "--show-prefix"])).replace(/[\r\n]+$/, "");
    const committed = await git(["show", `HEAD:${prefix}${requirement.path.replaceAll("\\", "/")}`]);
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
    if ((context.assignment || context.continuousVerification || context.requireDeployedCheck) &&
        !checks.some((check) => check.environment === "deployed")) {
        return "Every assignment, deployment verification and deployed acceptance loop requires a passing deployed-environment check.";
    }
    if (context.assignment?.walkingSkeleton === true) {
        const deployment = checks.find((check) =>
            /(?:^|&&\s*|;\s*)azd\s+(?:up|provision|deploy)(?=\s|$)/.test(check.command.trim()));
        if (!deployment || !checks.some((check) => check.id !== deployment.id &&
            check.kind === "deployed-probe" && check.environment === "deployed")) {
            return "Walking skeleton completion requires emitted azd up/provision/deploy execution evidence plus a separate passing deployed probe.";
        }
    }
    return null;
}

export async function normalizeFindings(findings, { role, checks = [], projectRoot } = {}) {
    return Promise.all((Array.isArray(findings) ? findings : []).map(async (finding, index) => {
        const normalized = {
            type: "observation", summary: text(finding?.summary) ? finding.summary : "Unsupported finding",
            action: text(finding?.action) ? finding.action : "No blocking action established.",
            ...(["infrastructure-config", "dependency-cve"].includes(finding?.scope) ? { scope: finding.scope } : {}),
        };
        if (!object(finding) || finding.type !== "blocking" || !text(finding.summary) || !text(finding.action) ||
            (securityRole(role) && !["infrastructure-config", "dependency-cve"].includes(finding.scope))) return normalized;
        if (!["original-requirement", "approved-amendment", "demonstrated-defect"].includes(finding.basis) ||
            !text(finding.reason)) return normalized;
        const defect = finding.basis === "demonstrated-defect";
        if (!defect && (finding.failingCheck !== undefined || finding.evidence !== undefined)) return normalized;
        if (finding.failingCheck !== undefined && !checks.some((check) =>
            text(check.id) && check.id === finding.failingCheck &&
            Number.isInteger(check.exitCode) && check.exitCode !== 0 && check.evidence === finding.evidence)) return normalized;
        try {
            if (!(await requirementLine(projectRoot, finding.requirement))) return normalized;
            if (defect && (!text(finding.evidence) || !(await sourceFile(projectRoot, finding.evidence)).trim())) return normalized;
        } catch { return normalized; /* Missing or inaccessible evidence never establishes authority. */ }
        return { ...normalized, type: "blocking", correctionId: `${role}:${index + 1}`,
            basis: finding.basis, requirement: finding.requirement, reason: finding.reason,
            ...(defect ? { evidence: finding.evidence } : {}),
            ...(finding.failingCheck !== undefined ? { failingCheck: finding.failingCheck } : {}) };
    }));
}

async function verifyCorrectionAssessments(assessments, feedback, root) {
    const corrections = (feedback?.reviews ?? []).flatMap((review) =>
        review.findings.filter((finding) => finding.type === "blocking"));
    if (assessments === undefined && !corrections.length) return;
    if (!Array.isArray(assessments) || assessments.length !== corrections.length ||
        new Set(assessments.map((item) => item?.correctionId)).size !== assessments.length) {
        throw new Error("Correction assessments must address every previous supported correction exactly once");
    }
    for (const item of assessments) {
        if (!object(item) || !corrections.some((finding) => finding.correctionId === item.correctionId) ||
            !["confirmed", "refuted", "unresolved"].includes(item.verdict) || !text(item.reason) ||
            typeof item.evidence !== "string" || (item.verdict !== "unresolved" && !text(item.evidence))) {
            throw new Error("Invalid correction assessment; give a confirmed/refuted/unresolved verdict, reason and inspectable evidence");
        }
        if (item.evidence) {
            try {
                if (!(await sourceFile(root, item.evidence)).trim()) throw new Error("Empty evidence");
            } catch { throw new Error(`Correction assessment ${item.correctionId} needs readable repository-local evidence`); }
        }
    }
}

const ownerInstructions = [
    ...contextInstructions, ...workCardInstructions,
    "Carry out this loop's work using ordinary permission-bound repository tools. Execute checks through those tools; this runtime never executes supplied command strings or broadens permissions.",
    "The scope ledger is repository docs/requirements and tests, within the assigned doneWhen and exclusions. completeWhen must be verified by executable checks each round, not reviewer completion votes.",
    "An accepted scope change requires actual project/user authority, an edit to docs/requirements and a corresponding regression test in the same committed change. Report that commit for independent Git inspection. Declined proposals never land in implementation, requirements or tests; reviewer observations do not authorize scope expansion. Do not create a disposition replacement ledger.",
    "Return checks:[{id,kind:test|schema|deployed-probe,command,requirement,environment:local|deployed,exitCode,evidence}]. Record actual commands and exit codes; evidence is a repository-relative nonempty log/result file reviewers can inspect against actual source and commits. Never fabricate successful checks. All accepted assignments require passing deployed verification. For deploymentManaged construction, emit real local checks and an exact committed revision or immutable build artifact; the runner invokes existing DevOps-then-E2E loops on that candidate before your original reviewers and acceptance. A construction report alone is not an accepted handoff.",
    "Runtime evidence-file validation establishes inspectability, not that a process actually ran or succeeded. Execute checks using your ordinary permission-bound tools and retain actual command output; independent reviewers verify execution and meaning from logs, source and Git commits. Never present a file-path check as execution attestation.",
    "For genuinely non-executable work, report limitation explaining exactly why no suitable executable check exists and return needs-input or rework with nextAction. Empty checks never complete a loop; schema checks can validate planning artifacts but must actually run.",
    "Return complete only when your own status and nonempty passing checks satisfy this loop's completeWhen. Reviewer pending responses are not owner rework. Return rework for correctable failures, needs-input for missing human authority, or needs-replan for a material scoped contract/architecture change.",
    "Use artifact keys matching YAML outputs. ReleasePlan contains sprints with unique ids. SprintPlan contains tasks with id,title,kind (ui/developer/designer/devops),owner,dependsOn,doneWhen,exclusions,handoff.",
    "Deployment comes first: the first sprint starts with walkingSkeleton:true,kind:devops,owner:DevOps Engineer,dependsOn:[],doneWhen requiring a deployed pass, and an explicit deployment handoff. The skeleton owner must emit actual azd up/provision/deploy command evidence plus a separate successful deployed-probe check; merely mentioning azd in doneWhen/handoff is not deployment. Every other first-sprint task transitively depends on it. Include exclusiveResources for shared deployment/configuration state.",
    "DevOpsWorkLoop then EndToEndTestLoop verify each candidate before assignment acceptance and dependency release. Failing E2E or deployment is not successful completion, even when accurately reported.",
    "When context.deploymentManaged is true, build and check source locally but do not mutate the shared deployed environment. Only the DevOps loop holds the environment mutation lock. Continuous verification must deploy the exact context.candidate revision/build artifact, never an unrelated mutable working tree; if that cannot be established, return rework or needs-input rather than claiming deployed success. E2E verifies the same deployment while the lock is held.",
    "A localized blocker does not authorize new scope or stop independent approved work. Replan only a material contract/dependency change through existing roles; do not create continuation amendments, disposition ledgers or mandatory work-exhaustion reviews. Sprint order alone is not a dependency; explicit sprint.dependsOn requires full acceptance of the named sprints. Keep genuine shared prerequisites and every deployed acceptance criterion.",
    "Read normalized feedback directly; observations are optional and never imply scope expansion. Fix supported requirement failures and actual failing/missing execution checks. No Scrum triage, Architect advice, Product Owner decision or disposition ledger runs between rounds.",
    "Every mandatory correction from any role, including Architect, Product Owner and Scrum Master, must cite an original user requirement, an explicitly approved amendment, or a demonstrated defect preventing that requirement, and explain exactly why the current work fails it. A committed agent-written requirement or failing invented test alone is not user authority. Reviewer feedback prose and checksValid:false alone are optional commentary, not mandatory work. Preserve actual execution/permission failures; optional suggestions never authorize scope, new tests or replanning.",
    "On retry assess each previous supported correction in correctionAssessments:[{correctionId,verdict:confirmed|refuted|unresolved,reason,evidence}]. Use its supplied correctionId exactly once. Confirm or refute with repository-relative source/log evidence; unresolved may use empty evidence but must explain the uncertainty. Do not call uncertainty proof, waive a failing required check, or claim completion while a confirmed failure remains. The original reviewers verify your reasoning in their next existing review; no new judge or approval stage is added.",
    "Before ending every turn that changes files, including rework or needs-input, commit your own intended changes before reviewers inspect them. Never commit secrets, generated junk or another person's work. Report branch and commit IDs; if committing fails, report the problem, not complete.",
    "Inspect Git status first and preserve concurrent changes. Stage explicit owned paths and use path-scoped git commit --only in shared checkouts. Do not switch branches underneath active agents, discard work, force-push or remove Git locks. Keep task commits available for integration.",
    "Use request.git.featureBranch when supplied. Include observed model/usage/elapsed metadata in commit messages only when actually available; never invent counters.",
    "At SprintReview, SprintRetro and ReleaseCloseout reconcile intended work onto the feature branch or retain abandoned commits on a named branch with concrete abandonment reasons recorded in a feature-branch commit.",
];
const reviewInstructions = [
    ...contextInstructions, ...workCardInstructions,
    "Independently inspect actual source, command logs/result files and Git commits, not just owner summaries. Confirm checks actually exercise completeWhen, requirements and doneWhen on the claimed environment. Return checksValid:boolean for check suitability and evidence credibility, not a completion vote.",
    "For an accepted scope change, inspect actual authority and the Git commit: docs/requirements edits and the corresponding regression test must be in the same committed change. Declined proposals must never land. Assess the regression check's suitability; do not substitute a disposition ledger or treat observations as authorization.",
    "A nonempty evidence file does not prove execution. Verify the actual owner-tool command output, exit code and claimed environment against source/commits; do not accept fabricated logs or claim cryptographic execution verification from this runtime.",
    "Return {type:observation,summary,action} for optional suggestions. Every blocking finding from EVERY role requires {type:blocking,summary,action,basis:original-requirement|approved-amendment|demonstrated-defect,requirement:{path,line},reason}. Cite the original user requirement or explicit approval directly in an existing repository-local source, with a positive committed HEAD line. reason states a falsifiable claim of how the work fails that requirement, not a preference. demonstrated-defect additionally requires evidence: a nonempty repository-relative source/log file showing the defect prevents the cited requirement; optional failingCheck must name an emitted failed check whose evidence matches. A failing check alone is not authority.",
    "All roles, including Architect, Product Owner, Scrum Master, Critic and Red Team, can block ONLY with a supported structured correction. Raw agree:false, taskComplete:false, prose and checksValid:false alone cannot gate any role. Keep checksValid as diagnostic assessment; when checks omit a required behavior or are not credible, cite the actual requirement and explain the specific failure in a blocking finding. Unsupported or unresolved opinion stays optional.",
    "Independently verify correctionAssessments in this same review. Architect checks technical reasoning; Product Owner checks requirement entailment where already assigned. Do not summon absent roles or add an arbitration stage. Withdraw refuted claims; uphold only a currently demonstrated requirement failure with citation, reason and evidence. An owner's assertion or unresolved verdict is not a waiver of actual failing required checks.",
    "Critic: is everything required present and everything present required? Missing work or untraceable additions need the same original-requirement/approved-amendment/defect grounding as every other role; otherwise record an observation. Requirements and tests are the scope ledger.",
    "Network/Infrastructure Security (legacy role: Red Team): findings are limited to infrastructure-config or dependency-cve; include scope with one of those values. Review affected network exposure, routing, private connectivity, identity/access configuration and relevant application-library CVEs only, not broad adversarial campaigns, general product security or invented governance controls. When this scope is unchanged or inapplicable, return no findings; do not expand the task to justify a review.",
    "Observations never block and there is no zero-findings requirement. Pending parallel reviewer responses are not unmet owner criteria. Preserve human authorization boundaries.",
    "A requirement citation is not semantic proof or proof of user authorship: inspect the original request/explicit approval and verify the cited line applies to this assignment and entails the correction. Committing an agent's interpretation does not authorize it. Unrelated headings, descriptive prose, speculative defects and invented interpretations are observations.",
    "Keep review read-only. Inspect actual Git commits for changed files and require credible logs; do not fabricate missing evidence or waive deployed assignment checks. No dispositions or governance triage.",
];

export async function runLoop({ ctx, loop, key, context, attempts, maxNoProgressRounds, agents = {}, decode, dispatch, verify,
    scheduleAgent = (_, work) => work(), priority = 0 }) {
    if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 1)) throw new Error("An explicitly supplied loop attempt limit must be a positive integer");
    if (maxNoProgressRounds !== undefined && (!Number.isSafeInteger(maxNoProgressRounds) || maxNoProgressRounds < 1)) throw new Error("An explicitly supplied maxNoProgressRounds must be a positive integer");
    const guarded = maxNoProgressRounds !== undefined;
    const doerSchema = { ...ownerSchema, required: [...ownerSchema.required, ...(guarded ? ["progress"] : []),
        ...(loop.id === "SprintPlanLoop" ? ["taskCards"] : [])] };
    const reviewSchema = { ...reviewerSchema, required: [...reviewerSchema.required, ...(guarded ? ["verifiedProgress"] : [])] };
    return ctx.step(key, async () => {
        let feedback = null, noProgressRounds = 0;
        const credited = [], evidence = new Set();
        const progressState = () => ({ noProgressRounds, limit: maxNoProgressRounds, credited: [...credited] });
        for (let attempt = 1; attempts === undefined || attempt <= attempts; attempt++) {
            ctx.signal?.throwIfAborted();
            ctx.log(`${loop.name}: ${loop.owner}, round ${attempt}`);
            const pendingCorrections = feedback?.reviews.some((review) => review.findings.some((finding) => finding.type === "blocking"));
            const owner = await scheduleAgent("doer", () => ctx.agent(JSON.stringify({
                kind: "doer", role: loop.owner, loop, context, feedback,
                ...(guarded ? { progressState: progressState() } : {}),
                instructions: [...ownerInstructions,
                    ...(["ArchitectureLoop", "SprintArchitectureLoop"].includes(loop.id) ? architectureCardInstructions : []),
                    ...(loop.id === "SprintPlanLoop" ? planningCardInstructions : []),
                    ...(guarded ? ["Report progress:[{id,evidence}] only for substantive NEW advances; repeated evidence, prose churn and activity alone are not progress."] : []),
                    ...(dispatch ? ["Plan completion requires dispatch-ready assignments, not completed implementation. Use rough estimatedMinutes critical paths and bounded contract handoffs. Match exclusiveResources for mutable contention, not merely file overlap."] : []),
                    ...(context.scopeRevision ? ["Resolve only the affected scoped amendment with existing Architect/Scrum Master loops. Preserve unrelated accepted work and requirements; use a separate replacement graph with internal dependency IDs."] : []),
                ],
            }), { agent: agents.owner ?? agents.doer ?? "workflow-owner", label: `${key}:doer:${attempt}`,
                schema: pendingCorrections ? { ...doerSchema, required: [...doerSchema.required, "correctionAssessments"] } : doerSchema }), priority);
            if (!object(owner) || !["complete", "rework", "needs-replan", "needs-input"].includes(owner.status) ||
                typeof owner.summary !== "string" || !object(owner.artifact)) throw new Error(`Invalid do-er response in ${loop.id}; no completion was recorded`);
            validateWorkCard(owner.workCard, `${loop.id} owner`);
            if (!Array.isArray(owner.checks)) throw new Error(`Invalid do-er checks in ${loop.id}; no completion was recorded`);
            await verifyCorrectionAssessments(owner.correctionAssessments, feedback, context.projectRoot);
            if (guarded && (!Array.isArray(owner.progress) || owner.progress.some((item) =>
                !object(item) || !text(item.id) || item.id !== item.id.trim() || !text(item.evidence)) ||
                new Set(owner.progress.map((item) => item.id)).size !== owner.progress.length)) throw new Error(`Invalid do-er progress in ${loop.id}; no progress was credited`);
            let transportIssue = await verifyChecks(owner.checks, { ...context,
                ...(verify && context.deploymentManaged ? { assignment: undefined } : {}),
                requireDeployedCheck: context.requireDeployedCheck ||
                    ["EndToEndTestLoop", "DevOpsWorkLoop", "SprintReviewLoop"].includes(loop.id) });
            if (owner.status === "complete" && !transportIssue && decode) {
                try {
                    await decode(owner.artifact);
                    if (loop.id === "SprintPlanLoop") validateTaskCards(owner.taskCards, owner.artifact.SprintPlan?.tasks, loop.id);
                } catch (error) { transportIssue = error.message; }
            }
            if (owner.status === "complete" && !transportIssue && verify) {
                const verified = await verify(owner, attempt);
                if (verified.status !== "agreed") return verified;
                owner.verification = verified.verification;
                owner.checks = [...owner.checks, ...verified.verification.flatMap((outcome, index) =>
                    outcome.checks.map((check) => ({ ...check, id: `verification/${index}/${check.id}` })))];
                transportIssue = await verifyChecks(owner.checks, context);
            }
            const dispatched = owner.status === "complete" && !transportIssue && dispatch ? await dispatch(owner.artifact, attempt) : undefined;
            let reviews;
            try {
                reviews = await ctx.parallel(loop.reviewers.map((role) => async () => {
                    const review = await scheduleAgent("reviewer", () => ctx.agent(JSON.stringify({
                        kind: "reviewer", role, loop, context, owner, transportIssue, dispatch: dispatched?.context, feedback,
                        ...(guarded ? { progressState: progressState() } : {}),
                        instructions: [...reviewInstructions, ...(guarded ? [
                            "Return verifiedProgress:[id,...] only for independently inspected NEW advances in owner.progress. Compare prior credited evidence; repeated tests alone do not count.",
                        ] : [])],
                    }), { agent: agents.reviewer ?? "workflow-reviewer", label: `${key}:reviewer:${role}:${attempt}`,
                        schema: securityRole(role) ? { ...reviewSchema, properties: { ...reviewSchema.properties,
                            findings: { type: "array", items: { oneOf: findingSchema.oneOf.map((branch) => ({
                                ...branch, required: [...branch.required, "scope"],
                            })) } },
                        } } : reviewSchema }), priority);
                    if (!object(review) || typeof review.checksValid !== "boolean" || typeof review.feedback !== "string" ||
                        !Array.isArray(review.findings)) throw new Error(`Invalid ${role} reviewer response in ${loop.id}`);
                    validateWorkCard(review.workCard, `${loop.id} ${role} reviewer`);
                    if (guarded && (!Array.isArray(review.verifiedProgress) || review.verifiedProgress.some((id) => !owner.progress.some((item) => item.id === id)) ||
                        new Set(review.verifiedProgress).size !== review.verifiedProgress.length)) throw new Error(`Invalid ${role} reviewer progress in ${loop.id}; no progress was credited`);
                    const findings = await normalizeFindings(review.findings, { role, checks: owner.checks, projectRoot: context.projectRoot });
                    const accepted = !findings.some((finding) => finding.type === "blocking");
                    return { role, checksValid: review.checksValid, feedback: review.feedback, findings,
                        ...(guarded ? { verifiedProgress: review.verifiedProgress } : {}),
                        ...(review.workCard ? { workCard: review.workCard } : {}), accepted };
                }));
                if (reviews.some((review) => !review)) throw new Error(`Reviewer execution failed in ${loop.id}`);
            } catch (error) { await dispatched?.settle(); throw error; }
            const accepted = reviews.every((review) => review.accepted);
            const result = { artifact: owner.artifact, summary: owner.summary, checks: owner.checks, reviews, rounds: attempt,
                ...(owner.verification ? { verification: owner.verification } : {}),
                ...(owner.correctionAssessments ? { correctionAssessments: owner.correctionAssessments } : {}),
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
            if (guarded) {
                const advances = owner.progress.filter((item) => !credited.some((prior) => prior.id === item.id) &&
                    !evidence.has(item.evidence.trim().replace(/\s+/g, " ").toLowerCase()) &&
                    reviews.filter((review) => review.role !== "Critic" && !securityRole(review.role))
                        .every((review) => review.verifiedProgress.includes(item.id)));
                for (const item of advances) {
                    credited.push({ ...item, round: attempt });
                    evidence.add(item.evidence.trim().replace(/\s+/g, " ").toLowerCase());
                }
                noProgressRounds = advances.length ? 0 : noProgressRounds + 1;
                if (noProgressRounds >= maxNoProgressRounds) return { ...result, status: "blocked", stopCause: "no-progress",
                    reason: transportIssue ?? "No new advance verified by every original check-adequacy reviewer.",
                    nextAction: "Inspect unresolved checks and findings and change approach.", progress: progressState(), feedback };
            }
        }
        return { status: "limit-reached", rounds: attempts, limit: attempts,
            summary: `${loop.id} stopped at the explicitly supplied ${attempts}-round limit.`,
            reason: feedback.transportIssue ?? `The do-er reported ${feedback.owner.status}: ${feedback.owner.summary}`,
            nextAction: "Continue from existing work and unresolved checks/findings in a new run.", feedback };
    });
}
