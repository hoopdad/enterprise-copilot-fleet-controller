const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const ownerSchema = {
    type: "object", required: ["status", "summary", "artifact"],
    properties: {
        status: { type: "string", enum: ["complete", "rework", "needs-replan", "needs-input"] },
        summary: { type: "string" }, artifact: { type: "object" },
        nextAction: { type: "string" },
        progress: { type: "array", items: {
            type: "object", required: ["id", "evidence"],
            properties: { id: { type: "string", minLength: 1 }, evidence: { type: "string", minLength: 1 } },
        } },
    },
};
export const reviewerSchema = {
    type: "object", required: ["agree", "feedback"],
    properties: {
        agree: { type: "boolean" }, feedback: { type: "string" },
        taskComplete: { type: "boolean" },
        unmetCriteria: { type: "array", items: { type: "string" } },
        verifiedProgress: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    },
};

export async function runLoop({ ctx, loop, key, context, attempts, maxNoProgressRounds, agents = {}, decode, dispatch,
    scheduleAgent = (_, work) => work(), priority = 0 }) {
    if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 1)) {
        throw new Error("An explicitly supplied loop attempt limit must be a positive integer");
    }
    if (maxNoProgressRounds !== undefined && (!Number.isSafeInteger(maxNoProgressRounds) || maxNoProgressRounds < 1)) {
        throw new Error("An explicitly supplied maxNoProgressRounds must be a positive integer");
    }
    const guarded = maxNoProgressRounds !== undefined;
    const doerSchema = guarded ? { ...ownerSchema, required: [...ownerSchema.required, "progress"] } : ownerSchema;
    const reviewSchema = { ...reviewerSchema, required: [...reviewerSchema.required,
        ...(guarded ? ["verifiedProgress"] : []), ...(context.assignment ? ["taskComplete", "unmetCriteria"] : [])] };
    return ctx.step(key, async () => {
        let feedback = null;
        let noProgressRounds = 0;
        const creditedProgress = new Map();
        const creditedEvidence = new Set();
        const evidenceKey = (item) => item.evidence.trim().replace(/\s+/g, " ").toLowerCase();
        const progressState = () => ({ noProgressRounds, limit: maxNoProgressRounds, credited: [...creditedProgress.values()] });
        for (let attempt = 1; attempts === undefined || attempt <= attempts; attempt++) {
            ctx.signal?.throwIfAborted();
            ctx.log(`${loop.name}: ${loop.owner}, round ${attempt}`);
            const owner = await scheduleAgent("doer", () => ctx.agent(JSON.stringify({
                kind: "doer", role: loop.owner, loop, context, feedback,
                ...(guarded ? { progressState: progressState() } : {}),
                instructions: [
                    "Carry out this loop's work, not just a proposal. Use ordinary repository tools as needed, including commands and deployment when authorized.",
                    "Follow actual project instructions and the supplied user authority. This workflow does not expand permissions.",
                    "Research and resolve technical issues within your work loop; do not invent prerequisite approval stages.",
                    "Return complete only when you consider this loop's completeWhen condition satisfied. Return rework for work you can continue, or needs-input for a decision or authority only the user can supply.",
                    "Judge completion against the assigned task's doneWhen, exclusions and handoff, not the whole product ambition or all sprint-level criteria it contributes to. Bounded research can complete with actionable negative or unresolved findings when that satisfies its scope; task completion never asserts a working or live-ready capability.",
                    "Use rework only for a concrete unmet assigned criterion and a next action that can close it, not merely because further useful investigation is possible. Return needs-replan when a finding materially changes architecture, contracts, feasibility or task scope; identify the decision and affected deliverable in summary. This is internal Architect/Scrum Master coordination, not human needs-input.",
                    "Use artifact keys matching the YAML outputs. ReleasePlan contains sprints with unique ids; SprintPlan contains assigned tasks with id, title, kind (ui/developer/designer/devops), owner and dependsOn.",
                    "Report actual failures and uncertainty. Accurate FAIL with feedback can satisfy the EndToEndTestLoop's agreement condition; do not turn it into a fabricated PASS.",
                    "Before ending every turn that changes files, including rework or needs-input, commit your own intended changes before reviewers inspect them. Include documentation, tests and partial work worth retaining; never commit secrets or ignored build outputs. Report the branch and commit IDs in your summary/artifact. If committing fails, report the actual problem; do not claim complete.",
                    "When actually available, include model name, input tokens, cached/cache-read tokens, output tokens and elapsed time in the Git commit message. Use observed values with units/scope; omit unavailable values, never invent zeroes or infer exact counters from estimates. If final usage becomes available only afterward, an ordinary follow-up metadata commit can reference the original code commit; do not amend reviewed history just to add usage.",
                    "Use request.git.featureBranch when supplied, otherwise the project's intended feature branch. Establish that branch before parallel writing begins; do not switch a checkout underneath active agents. If working on a separate task branch, keep its commits available for integration and never delete unmerged work.",
                    "Inspect Git status first and preserve other agents' and the user's changes. Stage and commit explicit owned paths only; in a shared checkout use path-scoped git commit --only rather than committing the whole index. Do not switch a shared checkout's branch during concurrent work, force-push, discard work or remove another process's Git lock. Retry ordinary transient index contention rather than losing changes.",
                    "For needs-input, state the exact missing decision or authority in summary and an actionable nextAction. Do not request new approval for already-authorized ordinary work.",
                    ...(guarded ? [
                        "Return progress: [{id,evidence}] for concrete advances made this round toward completeWhen; return [] if none. Use stable milestone/check/feedback IDs and exact inspectable file, test, or outcome evidence.",
                        "Previously existing work, changed prose, file churn, repeated tests/results, new labels for the same advance, and activity alone are not new progress. Do not reclaim anything in progressState.credited under another ID. Independent reviewers must verify advances against prior evidence.",
                        "Productive rounds have no total cap unless attempts was explicitly supplied. Consecutive rounds without new progress verified by every original reviewer stop at progressState.limit.",
                    ] : []),
                    ...(dispatch ? [
                        "For SprintPlanLoop, return complete with assigned SprintPlan.tasks when your plan is ready to dispatch. The orchestrator then dispatches dependency-ready original work loops before your planning reviewers inspect the plan and actual dispatch.",
                        "Do not start substitute agents yourself or report needs-input merely because dispatch is owned by the orchestrator. Planning agreement requires assignment and dispatch, not completion of implementation.",
                        "Use critical-path analysis with rough estimatedMinutes:{implementation,review,integration}; do not spend excessive time predicting durations. Distinguish needing an agreed interface or fixture from needing the full implementation. dependsOn must name the smallest useful accepted handoff, not a whole subsystem by habit.",
                        "Split broad foundations into useful contract/fixture handoffs, substantial independent implementation tasks and explicit integration/refactoring tasks using existing task kinds. Document what tasks produce/consume and their acceptance criteria. Favor large amounts of parallel work with a small amount of integration refactoring; contracts are working agreements, not frozen monuments.",
                        "File overlap is an integration risk, not automatically a technical dependency. Coordinate genuinely conflicting shared edits, branch operations, test databases, ports and other mutable resources using matching exclusiveResources names. These resources are held for the assignment including reviews; split tasks at useful boundaries to avoid unnecessarily serializing whole subsystems. No worktree isolation is supplied by this runner.",
                        "As Scrum Master, identify the authorized feature branch (request.git.featureBranch when supplied), establish ownership of shared files and Git reconciliation, and include integration work to get every task's commits onto that feature branch. Never silently commit, stash or discard pre-existing user work. Do not require implementation to finish merely to approve this dispatch-ready plan.",
                        "Give every task a concise doneWhen string, exclusions array and handoff string. Separate what this task must satisfy from sprint/product acceptance it merely contributes to. Research tasks must state whether actionable unresolved/unsupported findings complete the assignment, and leave live implementation/verification in their actual owning tasks.",
                    ] : []),
                    ...(context.scopeRevision ? [
                        "This is a scoped amendment using the existing Architect and Scrum Master roles, not a full architecture restart or new approval stage. Resolve only the reported scope/contract issue; preserve user requirements, authority and unrelated running/accepted work.",
                        "Architect: return the affected SprintArchitecture disposition. Scrum Master: return SprintPlan.tasks as a self-contained replacement graph for this one assignment, with explicit doneWhen/exclusions/handoffs. Its already accepted prerequisites are in scopeRevision.dependencies; do not reference unrelated in-flight task IDs. Keep new dependency edges inside this replacement graph. Preserve the outer plan on disk too: use a separate scoped amendment file if saving this replacement graph. Do not change the outer graph or require later DevOps before implementation; defer live work to its original stage.",
                    ] : []),
                    ...(["SprintReviewLoop", "SprintRetroLoop", "ReleaseCloseoutLoop"].includes(loop.id) ? [
                        "Reconcile all sprint/release work in Git before reporting complete: every intended file change must be committed and every task commit merged into the authorized feature branch, or explicitly abandoned. Resolve ordinary integration/refactoring here; do not invent a new acceptance stage.",
                        "For abandoned work, retain its code commits on a named branch and record the task, retained branch/commit IDs and concrete abandonment reason in a commit message on the feature branch (an empty documentation commit is acceptable). Do not delete the retained branch. A chat note or uncommitted explanation is not sufficient. Report actual merged/abandoned dispositions for the Scrum Master reviewer.",
                    ] : []),
                ],
            }), { agent: agents.doer ?? "workflow-doer", label: `${key}:doer:${attempt}`, schema: doerSchema }), priority);
            if (!object(owner) || !["complete", "rework", "needs-replan", "needs-input"].includes(owner.status) ||
                typeof owner.summary !== "string" || !object(owner.artifact)) {
                throw new Error(`Invalid do-er response in ${loop.id}; no completion was recorded`);
            }
            if (guarded && (!Array.isArray(owner.progress) || owner.progress.some((item) =>
                !object(item) || typeof item.id !== "string" || !item.id.trim() || item.id !== item.id.trim() ||
                typeof item.evidence !== "string" || !item.evidence.trim()) ||
                new Set(owner.progress.map((item) => item.id)).size !== owner.progress.length)) {
                throw new Error(`Invalid do-er progress in ${loop.id}; no progress was credited`);
            }
            let transportIssue = null;
            if (owner.status === "complete" && decode) {
                try { await decode(owner.artifact); }
                catch (error) { transportIssue = error.message; }
            }
            const dispatched = owner.status === "complete" && !transportIssue && dispatch
                ? await dispatch(owner.artifact, attempt) : undefined;
            let reviews;
            try { reviews = await ctx.parallel(loop.reviewers.map((role) => async () => {
                const review = await scheduleAgent("reviewer", () => ctx.agent(JSON.stringify({
                    kind: "reviewer", role, loop, context, owner, transportIssue, dispatch: dispatched?.context,
                    ...(guarded ? { progressState: progressState(), feedback } : {}),
                    instructions: [
                        "Independently review the actual work and the YAML completeWhen condition. Read the relevant files, not just the do-er's summary.",
                        "Return agree:true when you agree with the reported outcome. Feedback may include observations even when you agree; there is no zero-findings requirement.",
                        "Separately judge report accuracy and assignment completion. For assigned work return taskComplete:boolean and unmetCriteria:[specific assigned criteria still unmet]. Agreement with an accurate incomplete report is not task acceptance. Do not demand full product/live readiness from a bounded contract or research handoff.",
                        "If continued rework is justified, identify a specific unmet doneWhen criterion and a closing next action. If the assigned deliverable is already satisfied, ask the owner to report complete rather than endorsing indefinite investigation. Material scope changes should be reported as needs-replan for existing Architect/Scrum Master coordination, not invented human permission.",
                        "Disagree with concrete feedback when more work is needed. Judge risk and evidence in context using the project's instructions, not an invented global policy.",
                        "A role named Stakeholder is a reviewer role, not a substitute for an actual required human authorization.",
                        "For any changed files, inspect the do-er's actual Git commits as well as the code. Uncommitted intended changes or an unsuccessful commit need concrete rework feedback, not a new proof protocol. Do not demand a commit for a turn that changed no files; never ask to commit secrets, generated junk or another person's work.",
                        ...(guarded ? [
                            "Return verifiedProgress: [id,...] containing only owner.progress IDs whose underlying evidence you independently inspected and verified as a substantive NEW advance this round toward completeWhen. Return [] if none, even if the summary claims progress.",
                            "Compare with progressState.credited and prior feedback. Never credit pre-existing work, repeated evidence, relabeled milestones, cosmetic edits, regression-free test reruns alone, or activity without improvement. A newly resolved finding, newly passing relevant failing test, or newly completed verifiable plan milestone can count.",
                            "Progress is separate from agreement: you can verify an advance while disagreeing that the loop is complete. Do not agree merely to avoid the stagnation stop.",
                        ] : []),
                        ...(dispatch ? [
                            "SprintPlan completion requires assigned todos and dispatched independent work, not finished implementation. Judge the orchestrator's actual dispatch context; do not require the Scrum Master to invent a second dispatcher or an additional approval stage.",
                            "Challenge unnecessary dependency chains: does a consumer need an agreed interface/fixture or the whole implementation? Check rough critical-path estimates, useful foundation handoffs, substantial parallel tasks and explicit integration work. Prefer economical refactoring over serializing all work for perfect contracts. File overlap alone is not a dependency; genuine mutable contention should be declared in exclusiveResources.",
                            "Check that the Scrum Master identified the feature branch and assigned Git integration/reconciliation responsibility. Plan review does not wait for all future code to exist or be merged.",
                            "Check each task's doneWhen, exclusions and handoff. Sprint-level acceptance references describe contribution unless explicitly assigned in full. Do not silently turn a bounded research task into a live implementation or deployment obligation.",
                        ] : []),
                        ...(context.scopeRevision ? [
                            "Review only this scoped architectural/plan amendment. Preserve the original requirements and outer task handoff; allow useful internal handoffs and honest capability limitations. Do not restart unrelated work or introduce another gate.",
                        ] : []),
                        ...(role === "Scrum Master" ? [
                            "You are accountable for Git reconciliation in this existing review role. Inspect all sprint task commits and their disposition: merged into the authorized feature branch, or retained on a branch with the task, commit IDs and abandonment reason recorded in a feature-branch commit message. Missing or uncommitted code requires the current do-er to reconcile it; remain read-only yourself. Do not accept chat-only abandonment or discard unmerged code.",
                        ] : []),
                        ...(loop.id === "ReleaseCloseoutLoop" ? [
                            "Check final Git reconciliation across the release: intended changes committed, task commits merged into the feature branch or retained with an abandonment-reason commit. This is part of the existing closeout review, not a separate gate.",
                        ] : []),
                    ],
                }), { agent: agents.reviewer ?? "workflow-reviewer", label: `${key}:reviewer:${role}:${attempt}`, schema: reviewSchema }), priority);
                if (!object(review) || typeof review.agree !== "boolean" || typeof review.feedback !== "string") {
                    throw new Error(`Invalid ${role} reviewer response in ${loop.id}`);
                }
                if (context.assignment && (typeof review.taskComplete !== "boolean" ||
                    !Array.isArray(review.unmetCriteria) || review.unmetCriteria.some((item) => typeof item !== "string"))) {
                    throw new Error(`Invalid ${role} assignment completion assessment in ${loop.id}`);
                }
                if (guarded && (!Array.isArray(review.verifiedProgress) ||
                    review.verifiedProgress.some((id) => typeof id !== "string" || !owner.progress.some((item) => item.id === id)) ||
                    new Set(review.verifiedProgress).size !== review.verifiedProgress.length)) {
                    throw new Error(`Invalid ${role} reviewer progress in ${loop.id}; no progress was credited`);
                }
                return { role, ...review };
            })); } catch (error) {
                await dispatched?.settle();
                throw error;
            }
            if (reviews.some((review) => review === null)) {
                await dispatched?.settle();
                throw new Error(`Reviewer execution failed in ${loop.id}`);
            }
            const agreed = reviews.every((review) => review.agree);
            if (agreed && owner.status === "complete" && !transportIssue &&
                (!context.assignment || reviews.every((review) => review.taskComplete))) {
                return {
                    status: "agreed", artifact: owner.artifact, summary: owner.summary, reviews, rounds: attempt,
                    ...(dispatched ? { dispatch: dispatched.context } : {}),
                };
            }
            if (agreed && owner.status === "needs-replan") {
                return { status: "needs-replan", artifact: owner.artifact, summary: owner.summary, reviews, rounds: attempt };
            }
            if (agreed && owner.status === "needs-input") {
                return {
                    status: "needs-input", artifact: owner.artifact, summary: owner.summary, reviews, rounds: attempt,
                    nextAction: owner.nextAction ?? "Resolve the reported missing decision or authority, then start a new run against the existing project work.",
                };
            }
            // Join dispatched work before revising its plan, so old and revised assignments cannot race.
            const dispatchedWork = await dispatched?.settle();
            feedback = { owner, reviews, transportIssue, ...(dispatchedWork ? { dispatchedWork } : {}) };
            if (guarded) {
                const advances = owner.progress.filter((item) => !creditedProgress.has(item.id) && !creditedEvidence.has(evidenceKey(item)) &&
                    reviews.every((review) => review.verifiedProgress.includes(item.id)));
                for (const item of advances) {
                    creditedProgress.set(item.id, { ...item, round: attempt });
                    creditedEvidence.add(evidenceKey(item));
                }
                noProgressRounds = advances.length ? 0 : noProgressRounds + 1;
                ctx.log(`${loop.name}: ${advances.length} verified new advances; ${noProgressRounds}/${maxNoProgressRounds} consecutive no-progress rounds`);
                if (noProgressRounds >= maxNoProgressRounds) {
                    return {
                        status: "blocked", rounds: attempt, stopCause: "no-progress",
                        summary: `${loop.id} stopped after ${noProgressRounds} consecutive rounds without reviewer-verified new progress.`,
                        reason: transportIssue ?? `No new advance was verified by every original reviewer. ${owner.summary}`,
                        nextAction: "Inspect the unresolved feedback and evidence, resolve the blocker or change approach, then explicitly start a new run against the existing work.",
                        progress: progressState(), feedback,
                    };
                }
            }
        }
        const disagreements = feedback.reviews.filter((review) => !review.agree).map((review) => review.role);
        return {
            status: "limit-reached", rounds: attempts, limit: attempts,
            summary: `${loop.id} stopped at the explicitly supplied ${attempts}-round limit.`,
            reason: feedback.transportIssue ?? (disagreements.length
                ? `Reviewers still disagreed: ${disagreements.join(", ")}. ${feedback.owner.summary}`
                : `The do-er reported ${feedback.owner.status}: ${feedback.owner.summary}`),
            nextAction: "Continue from the existing work and the unresolved feedback in a new run; change the explicit round limit only if desired.",
            feedback,
        };
    });
}
