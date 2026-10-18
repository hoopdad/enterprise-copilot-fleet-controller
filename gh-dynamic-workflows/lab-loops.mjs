const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const ownerSchema = {
    type: "object", required: ["status", "summary", "artifact"],
    properties: {
        status: { type: "string", enum: ["complete", "rework", "needs-input"] },
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
        verifiedProgress: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    },
};

export async function runLoop({ ctx, loop, key, context, attempts, maxNoProgressRounds, agents = {}, decode, dispatch }) {
    if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 1)) {
        throw new Error("An explicitly supplied loop attempt limit must be a positive integer");
    }
    if (maxNoProgressRounds !== undefined && (!Number.isSafeInteger(maxNoProgressRounds) || maxNoProgressRounds < 1)) {
        throw new Error("An explicitly supplied maxNoProgressRounds must be a positive integer");
    }
    const guarded = maxNoProgressRounds !== undefined;
    const doerSchema = guarded ? { ...ownerSchema, required: [...ownerSchema.required, "progress"] } : ownerSchema;
    const reviewSchema = guarded ? { ...reviewerSchema, required: [...reviewerSchema.required, "verifiedProgress"] } : reviewerSchema;
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
            const owner = await ctx.agent(JSON.stringify({
                kind: "doer", role: loop.owner, loop, context, feedback,
                ...(guarded ? { progressState: progressState() } : {}),
                instructions: [
                    "Carry out this loop's work, not just a proposal. Use ordinary repository tools as needed, including commands and deployment when authorized.",
                    "Follow actual project instructions and the supplied user authority. This workflow does not expand permissions.",
                    "Research and resolve technical issues within your work loop; do not invent prerequisite approval stages.",
                    "Return complete only when you consider this loop's completeWhen condition satisfied. Return rework for work you can continue, or needs-input for a decision or authority only the user can supply.",
                    "Use artifact keys matching the YAML outputs. ReleasePlan contains sprints with unique ids; SprintPlan contains assigned tasks with id, title, kind (ui/developer/designer/devops), owner and dependsOn.",
                    "Report actual failures and uncertainty. Accurate FAIL with feedback can satisfy the EndToEndTestLoop's agreement condition; do not turn it into a fabricated PASS.",
                    "For needs-input, state the exact missing decision or authority in summary and an actionable nextAction. Do not request new approval for already-authorized ordinary work.",
                    ...(guarded ? [
                        "Return progress: [{id,evidence}] for concrete advances made this round toward completeWhen; return [] if none. Use stable milestone/check/feedback IDs and exact inspectable file, test, or outcome evidence.",
                        "Previously existing work, changed prose, file churn, repeated tests/results, new labels for the same advance, and activity alone are not new progress. Do not reclaim anything in progressState.credited under another ID. Independent reviewers must verify advances against prior evidence.",
                        "Productive rounds have no total cap unless attempts was explicitly supplied. Consecutive rounds without new progress verified by every original reviewer stop at progressState.limit.",
                    ] : []),
                    ...(dispatch ? [
                        "For SprintPlanLoop, return complete with assigned SprintPlan.tasks when your plan is ready to dispatch. The orchestrator then dispatches dependency-ready original work loops before your planning reviewers inspect the plan and actual dispatch.",
                        "Do not start substitute agents yourself or report needs-input merely because dispatch is owned by the orchestrator. Planning agreement requires assignment and dispatch, not completion of implementation.",
                    ] : []),
                ],
            }), { agent: agents.doer ?? "workflow-doer", label: `${key}:doer:${attempt}`, schema: doerSchema });
            if (!object(owner) || !["complete", "rework", "needs-input"].includes(owner.status) ||
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
                const review = await ctx.agent(JSON.stringify({
                    kind: "reviewer", role, loop, context, owner, transportIssue, dispatch: dispatched?.context,
                    ...(guarded ? { progressState: progressState(), feedback } : {}),
                    instructions: [
                        "Independently review the actual work and the YAML completeWhen condition. Read the relevant files, not just the do-er's summary.",
                        "Return agree:true when you agree with the reported outcome. Feedback may include observations even when you agree; there is no zero-findings requirement.",
                        "Disagree with concrete feedback when more work is needed. Judge risk and evidence in context using the project's instructions, not an invented global policy.",
                        "A role named Stakeholder is a reviewer role, not a substitute for an actual required human authorization.",
                        ...(guarded ? [
                            "Return verifiedProgress: [id,...] containing only owner.progress IDs whose underlying evidence you independently inspected and verified as a substantive NEW advance this round toward completeWhen. Return [] if none, even if the summary claims progress.",
                            "Compare with progressState.credited and prior feedback. Never credit pre-existing work, repeated evidence, relabeled milestones, cosmetic edits, regression-free test reruns alone, or activity without improvement. A newly resolved finding, newly passing relevant failing test, or newly completed verifiable plan milestone can count.",
                            "Progress is separate from agreement: you can verify an advance while disagreeing that the loop is complete. Do not agree merely to avoid the stagnation stop.",
                        ] : []),
                        ...(dispatch ? [
                            "SprintPlan completion requires assigned todos and dispatched independent work, not finished implementation. Judge the orchestrator's actual dispatch context; do not require the Scrum Master to invent a second dispatcher or an additional approval stage.",
                        ] : []),
                    ],
                }), { agent: agents.reviewer ?? "workflow-reviewer", label: `${key}:reviewer:${role}:${attempt}`, schema: reviewSchema });
                if (!object(review) || typeof review.agree !== "boolean" || typeof review.feedback !== "string") {
                    throw new Error(`Invalid ${role} reviewer response in ${loop.id}`);
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
            if (agreed && owner.status === "complete" && !transportIssue) {
                return {
                    status: "agreed", artifact: owner.artifact, summary: owner.summary, reviews, rounds: attempt,
                    ...(dispatched ? { dispatch: dispatched.context } : {}),
                };
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
