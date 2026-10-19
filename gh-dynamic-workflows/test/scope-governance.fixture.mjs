export function governanceResponse(input) {
    if (input.stage === "triage") {
        const { owner, reviews, transportIssue } = input.feedback;
        const findings = [
            ...(transportIssue ? [transportIssue] : []),
            ...reviews.filter((review) => !review.agree || review.taskComplete === false)
                .map((review) => `${review.role}: ${review.feedback} ${(review.unmetCriteria ?? []).join("; ")}`),
            ...(owner.status !== "complete" ? [`Resolve ${owner.status}: ${owner.summary}`] : []),
        ];
        return { summary: "Checked original scope and evidence; correct the existing deliverable.",
            requiredCorrections: findings.map((finding, index) => ({
                id: `correction-${index}`, requirement: input.context.assignment?.doneWhen ?? input.loop.completeWhen,
                evidence: finding, action: `Smallest sufficient correction: ${finding}`,
            })), scopeQuestions: [] };
    }
    if (input.stage === "scope-advice") return {
        assessments: input.triage.scopeQuestions.map((item) => ({
            id: item.id, necessity: "enhancement", rationale: "Not necessary for original acceptance.",
            simplestOption: "Keep the existing bounded handoff.",
        })),
    };
    if (input.stage === "scope-decision") return {
        decisions: input.triage.scopeQuestions.map((item) => ({
            id: item.id, disposition: "defer", rationale: "Keep original scope.",
            action: "", acceptance: "", taskBoundary: "",
        })),
    };
    throw new Error(`Unexpected governance stage: ${input.stage}`);
}
