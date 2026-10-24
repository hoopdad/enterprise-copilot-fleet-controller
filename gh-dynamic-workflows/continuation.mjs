const text = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true };

export const terminalInvocation = (outcome) =>
    ["limit-reached", "error"].includes(outcome.status) || outcome.stopCause === "no-progress";

export const continuationSchema = {
    type: "object", additionalProperties: false,
    required: ["disposition", "summary", "evidence", "resumes"],
    properties: {
        disposition: { type: "string", enum: ["continue", "exhausted"] },
        summary: { type: "string", minLength: 1 },
        evidence: { ...strings, minItems: 1 },
        resumes: { type: "array", items: {
            type: "object", additionalProperties: false, required: ["key", "after", "evidence"],
            properties: { key: { type: "string", minLength: 1 }, after: strings,
                evidence: { type: "string", minLength: 1 }, recheck: strings,
                e2eSubject: { type: "string", minLength: 1 } },
        } },
    },
};

export function validateContinuation(artifact, context, tasks) {
    const report = artifact.Continuation;
    if (!object(report) || Object.keys(report).some((key) => !Object.hasOwn(continuationSchema.properties, key)) ||
        !["continue", "exhausted"].includes(report.disposition) || !text(report.summary) ||
        !Array.isArray(report.evidence) || !report.evidence.length || report.evidence.some((item) => !text(item)) ||
        new Set(report.evidence).size !== report.evidence.length ||
        !Array.isArray(report.resumes) || report.resumes.some((item) => !object(item) ||
            Object.keys(item).some((key) => !["key", "after", "evidence", "recheck", "e2eSubject"].includes(key)) ||
            !text(item.key) || !text(item.evidence) || !Array.isArray(item.after) ||
            item.after.some((id) => typeof id !== "string" || !tasks.some((task) => task.id === id)) ||
            new Set(item.after).size !== item.after.length ||
            !context.blocked.some((blocked) => blocked.key === item.key &&
                !terminalInvocation(blocked)) ||
            item.recheck !== undefined && (!Array.isArray(item.recheck) ||
                item.recheck.some((key) => typeof key !== "string" ||
                    !context.recheckable?.some((prior) => prior.key === key && prior.blockedKey === item.key &&
                        prior.loopId === "EndToEndTestLoop" && prior.status === "agreed")) ||
                new Set(item.recheck).size !== item.recheck.length)) ||
        new Set(report.resumes.map((item) => item.key)).size !== report.resumes.length) {
        throw new Error("Continuation needs an explicit disposition, evidence and exact resumable blocker/handoff references");
    }
    if (report.disposition === "exhausted" && (tasks.length || report.resumes.length) ||
        report.disposition === "continue" && !tasks.length && !report.resumes.length) {
        throw new Error("Continuation must either schedule useful work/reassessment or explicitly report exhaustion, not both");
    }
    for (const task of tasks) {
        if (task.kind === "devops" || context.scheduledTaskIds.includes(task.id) ||
            !context.availableSprints.includes(task.sourceSprintId) || !text(task.sourceCriterion)) {
            throw new Error(`Continuation task ${task.id} needs new bounded source work, an allowed sourceSprintId and sourceCriterion; live DevOps stays in its original stage`);
        }
    }
    for (const resume of report.resumes) {
        if (resume.e2eSubject === undefined) continue;
        const subject = context.sourceSubjects?.find((item) => item.key === resume.e2eSubject);
        const blocked = context.blocked.find((item) => item.key === resume.key);
        if (!subject || !/^[0-9a-f]{40}$/.test(subject.commit ?? "") || blocked.loopId !== "DevOpsWorkLoop" ||
            subject.sprintId !== blocked.sprintId || context.e2e?.status !== "agreed" ||
            context.e2e.testedRevision === subject.commit || terminalInvocation(context.e2e)) {
            throw new Error("E2E requalification needs an exact accepted changed-source subject and an agreed original E2E before the affected DevOps stage; never reset a failed or capped invocation");
        }
    }
    if (artifact.ReleasePlan !== undefined) throw new Error("Continuation cannot replace the approved ReleasePlan");
    return report;
}

export const deliveryInstructions = [
    "Work-conserving delivery: a release-blocking condition is not automatically a construction blocker. Localize missing permission/evidence/capability to the actual operations, components, flow steps and downstream criteria. Continue useful authorized construction elsewhere; never bypass a denial or treat fixture/local evidence as deployed/live success.",
    "Use a walking skeleton to expose integration early, not as a global gate that blocks other flows. Bind approved criteria to named components, source modules, contract handoffs and actual verification evidence. Build as much approved work as possible before waiting. Shared files require coordination, not automatic whole-subsystem dependency chains.",
    "ReleasePlan sprint order is not an implicit dependency. Optional sprint.dependsOn lists unique existing sprint IDs and requires their full acceptance; declare it only when that is genuinely necessary. Prefer a reviewed smaller task/contract handoff when full-sprint acceptance is not required. Never consume a missing prerequisite or pull work around an explicit whole-sprint dependency.",
    "delivery describes accepted work, partial/pending sprints and unresolved blockers. Do not consume an unresolved prerequisite merely because another task/report was accepted. Use only the smallest necessary reviewed handoff; preserve unmet criteria and original reviewers. An agreed accurate failure report is not a working capability.",
    "Before needs-input, inspect applicable authorized input, dispositions, exact artifacts/commits and direct handoffs for the answer. Distinguish missing execution access from missing project authority, technical investigation from user-only decisions, and construction from blocked live verification. State the precise unblock condition and unaffected work; do not retry unchanged denied operations or uncertain effects.",
];

export const continuationInstructions = [
    "This is a work-exhaustion/continuation amendment using the existing Architect and Scrum Master loops, not release acceptance or a new reviewer stage. Preserve every original blocker, criterion, user restriction and accepted handoff. Inspect continuation.blocked and their audit references, delivery and the approved ReleasePlan before declaring no work remains.",
    "Architect: assess each blocker's actual blast radius against the named solution components/flows and existing source files/modules. Identify missing useful construction, accepted contract/fixture options, independent flows and bounded evidence discovery. Separate what cannot execute from what can still be built. Return the scoped SprintArchitecture findings; never invent a supported operation, grant permissions or weaken the original task to call it done.",
    "Scrum Master: audit ready/executing work, feasible splits of blocked tasks, independent approved release backlog (including later sprints), and bounded investigation/integration corrections. Recompute critical-path priorities and refill the queue with substantial useful work. Do not return needs-input solely because one stream cannot finish. No new features, repetitive reports, unchanged tests, duplicate accepted work or task relabeling to manufacture progress.",
    "Return artifact.SprintPlan.tasks and artifact.Continuation:{disposition:'continue'|'exhausted',summary,evidence:[inspectable findings],resumes:[{key,after:[newTaskId],evidence}]}. Every new task needs sourceSprintId from continuation.availableSprints and sourceCriterion citing its approved criterion, plus normal doneWhen/exclusions/handoff and component/flow workCard. Use a separate amendment file; preserve the original plan on disk. Do not replace ReleasePlan. New task IDs cannot appear in continuation.scheduledTaskIds.",
    "Keep actual deployment/live tests in the original later DevOps stage. Feasible script/adapter construction can be bounded developer work when authorized; fixture acceptance must not waive real-service criteria. Dependencies within this amendment name only its new tasks; prior accepted handoffs and limitations are available by exact references in delivery.",
    "resumes identifies exact current blocker keys whose conditions have materially changed. after names only the new tasks actually needed to unlock that blocker; an unrelated failed task must not prevent its reassessment. Use after:[] only for concrete newly obtained authoritative evidence cited in evidence. Never repeat unchanged authority denials, uncertain external effects, exhausted research or a capped/error invocation. Reassessment runs the original owner/reviewers, not an automatic promotion to accepted.",
    "If changed source invalidates an earlier accepted E2E result required by blocked DevOps, include resumes[].recheck:[exactKey] from continuation.recheckable for that same blockedKey. Cite the changed source/evidence. Only the supplied original E2E prerequisite may be reopened, never accepted construction or deployment effects. After necessary handoffs are accepted, the original E2E owner and all original reviewers run before the original DevOps reassessment. An incomplete E2E holds DevOps; an accurate agreed test failure does not establish package/live readiness. Preserve all capped invocations and historical unknown effects.",
    "For changed-source original E2E before an exact blocked DevOps stage, set resumes[].e2eSubject to the exact accepted outcome key in continuation.sourceSubjects, not the latest DeveloperWork or a new task ID. This runs the existing original E2E with fresh durable attempt labels and its canonical semantic outcome key before DevOps. It preserves historical reports, original roles/reviewers and the retained implementation commit. An already tested subject or failed/capped/error E2E cannot be reset this way. Omit e2eSubject for reassessments that do not require changed-subject qualification.",
    "exhausted requires empty tasks and resumes, with concrete findings establishing no ready work, feasible split, independent approved backlog work, or bounded unlocking investigation remains. When new accepted construction or another branch materially advances, the runner may request a fresh audit; unchanged exhaustion must not create a polling loop. Waiting is incomplete, never successful delivery.",
    "Continuation planning complete means the amendment/exhaustion assessment is ready for the original reviewers. New tasks are dispatched before planning review and joined afterward, just like normal SprintPlan. Planning agreement does not require new implementation to finish. Exhaustion agreement certifies the bounded assessment, not original sprint/release completion.",
];
