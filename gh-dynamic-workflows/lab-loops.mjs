const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const ownerSchema = {
    type: "object", required: ["status", "summary", "artifact"],
    properties: {
        status: { type: "string", enum: ["complete", "rework", "needs-input"] },
        summary: { type: "string" }, artifact: { type: "object" },
        nextAction: { type: "string" },
    },
};
export const reviewerSchema = {
    type: "object", required: ["agree", "feedback"],
    properties: { agree: { type: "boolean" }, feedback: { type: "string" } },
};

export async function runLoop({ ctx, loop, key, context, attempts, agents = {}, decode, dispatch }) {
    if (attempts !== undefined && (!Number.isSafeInteger(attempts) || attempts < 1)) {
        throw new Error("An explicitly supplied loop attempt limit must be a positive integer");
    }
    return ctx.step(key, async () => {
        let feedback = null;
        for (let attempt = 1; attempts === undefined || attempt <= attempts; attempt++) {
            ctx.signal?.throwIfAborted();
            ctx.log(`${loop.name}: ${loop.owner}, round ${attempt}`);
            const owner = await ctx.agent(JSON.stringify({
                kind: "doer", role: loop.owner, loop, context, feedback,
                instructions: [
                    "Carry out this loop's work, not just a proposal. Use ordinary repository tools as needed, including commands and deployment when authorized.",
                    "Follow actual project instructions and the supplied user authority. This workflow does not expand permissions.",
                    "Research and resolve technical issues within your work loop; do not invent prerequisite approval stages.",
                    "Return complete only when you consider this loop's completeWhen condition satisfied. Return rework for work you can continue, or needs-input for a decision or authority only the user can supply.",
                    "Use artifact keys matching the YAML outputs. ReleasePlan contains sprints with unique ids; SprintPlan contains assigned tasks with id, title, kind (ui/developer/designer/devops), owner and dependsOn.",
                    "Report actual failures and uncertainty. Accurate FAIL with feedback can satisfy the EndToEndTestLoop's agreement condition; do not turn it into a fabricated PASS.",
                    "For needs-input, state the exact missing decision or authority in summary and an actionable nextAction. Do not request new approval for already-authorized ordinary work.",
                    ...(dispatch ? [
                        "For SprintPlanLoop, return complete with assigned SprintPlan.tasks when your plan is ready to dispatch. The orchestrator then dispatches dependency-ready original work loops before your planning reviewers inspect the plan and actual dispatch.",
                        "Do not start substitute agents yourself or report needs-input merely because dispatch is owned by the orchestrator. Planning agreement requires assignment and dispatch, not completion of implementation.",
                    ] : []),
                ],
            }), { agent: agents.doer ?? "workflow-doer", label: `${key}:doer:${attempt}`, schema: ownerSchema });
            if (!object(owner) || !["complete", "rework", "needs-input"].includes(owner.status) ||
                typeof owner.summary !== "string" || !object(owner.artifact)) {
                throw new Error(`Invalid do-er response in ${loop.id}; no completion was recorded`);
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
                    instructions: [
                        "Independently review the actual work and the YAML completeWhen condition. Read the relevant files, not just the do-er's summary.",
                        "Return agree:true when you agree with the reported outcome. Feedback may include observations even when you agree; there is no zero-findings requirement.",
                        "Disagree with concrete feedback when more work is needed. Judge risk and evidence in context using the project's instructions, not an invented global policy.",
                        "A role named Stakeholder is a reviewer role, not a substitute for an actual required human authorization.",
                        ...(dispatch ? [
                            "SprintPlan completion requires assigned todos and dispatched independent work, not finished implementation. Judge the orchestrator's actual dispatch context; do not require the Scrum Master to invent a second dispatcher or an additional approval stage.",
                        ] : []),
                    ],
                }), { agent: agents.reviewer ?? "workflow-reviewer", label: `${key}:reviewer:${role}:${attempt}`, schema: reviewerSchema });
                if (!object(review) || typeof review.agree !== "boolean" || typeof review.feedback !== "string") {
                    throw new Error(`Invalid ${role} reviewer response in ${loop.id}`);
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
