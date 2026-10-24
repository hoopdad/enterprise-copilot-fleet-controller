import test from "node:test";
import assert from "node:assert/strict";
import { validateContinuation, deliveryInstructions, continuationInstructions } from "../continuation.mjs";

const context = {
    blocked: [{ key: "s1/original", status: "needs-input" }, { key: "s1/capped", status: "limit-reached" },
        { key: "s1/error", status: "error" }, { key: "s1/stalled", status: "blocked", stopCause: "no-progress" }],
    recheckable: [{ key: "s1/e2e", loopId: "EndToEndTestLoop", status: "agreed", blockedKey: "s1/original" }],
    scheduledTaskIds: ["original", "accepted"], availableSprints: ["s1", "s2"],
};
const task = () => ({ id: "adapter", kind: "developer", sourceSprintId: "s2", sourceCriterion: "Original adapter construction." });
const report = () => ({ disposition: "continue", summary: "Build independently.",
    evidence: ["Inspected approved source and contract."],
    resumes: [{ key: "s1/original", after: ["adapter"], evidence: "Accepted handoff changes the specific prerequisite." }] });

test("continuation validates useful work and exact reassessment handoffs or explicit exhaustion", () => {
    const continuation = report();
    assert.equal(validateContinuation({ Continuation: continuation }, context, [task()]), continuation);
    assert.doesNotThrow(() => validateContinuation({ Continuation: { ...report(), resumes: [] } }, context, [task()]));
    assert.doesNotThrow(() => validateContinuation({ Continuation: { ...report(),
        resumes: [{ ...report().resumes[0], after: [] }] } }, context, []));
    assert.doesNotThrow(() => validateContinuation({ Continuation: {
        ...report(), disposition: "exhausted", resumes: [],
    } }, context, []));
});

test("malformed, ambiguous, capped and error reassessments fail without inventing permission or acceptance", () => {
    const cases = [
        undefined, null, {}, { ...report(), extra: "ignored" }, { ...report(), disposition: "success" },
        { ...report(), summary: "" }, { ...report(), evidence: [] }, { ...report(), evidence: [" "] },
        { ...report(), evidence: ["same", "same"] }, { ...report(), resumes: null },
        { ...report(), resumes: [null] }, { ...report(), resumes: [{ key: "s1/original", after: [] }] },
        { ...report(), resumes: [{ ...report().resumes[0], key: "unknown" }] },
        { ...report(), resumes: [{ ...report().resumes[0], key: "s1/capped" }] },
        { ...report(), resumes: [{ ...report().resumes[0], key: "s1/error" }] },
        { ...report(), resumes: [{ ...report().resumes[0], key: "s1/stalled" }] },
        { ...report(), resumes: [{ ...report().resumes[0], after: ["missing"] }] },
        { ...report(), resumes: [{ ...report().resumes[0], after: ["adapter", "adapter"] }] },
        { ...report(), resumes: [{ ...report().resumes[0], authority: "expanded" }] },
        { ...report(), resumes: [report().resumes[0], report().resumes[0]] },
    ];
    for (const Continuation of cases) {
        assert.throws(() => validateContinuation({ Continuation }, context, [task()]), /Continuation needs/);
    }
    assert.throws(() => validateContinuation({ Continuation: { ...report(), resumes: [] } }, context, []), /schedule useful/);
    assert.throws(() => validateContinuation({ Continuation: { ...report(), disposition: "exhausted" } }, context, [task()]), /schedule useful/);
    assert.throws(() => validateContinuation({ Continuation: report(), ReleasePlan: {} }, context, [task()]), /cannot replace/);
});

test("only exact supplied E2E prerequisites bound to the same blocker can be rechecked", () => {
    const resumes = [{ ...report().resumes[0], recheck: ["s1/e2e"] }];
    assert.doesNotThrow(() => validateContinuation({ Continuation: { ...report(), resumes } }, context, [task()]));
    for (const recheck of [null, "s1/e2e", [null], ["s2/e2e"], ["s1/original"], ["s1/e2e", "s1/e2e"]]) {
        assert.throws(() => validateContinuation({ Continuation: { ...report(),
            resumes: [{ ...resumes[0], recheck }] } }, context, [task()]), /exact resumable/);
    }
    for (const extra of [
        { recheckable: undefined },
        { recheckable: [{ ...context.recheckable[0], blockedKey: "s1/another" }] },
        { recheckable: [{ ...context.recheckable[0], loopId: "DevOpsWorkLoop" }] },
        { recheckable: [{ ...context.recheckable[0], status: "limit-reached" }] },
    ]) {
        assert.throws(() => validateContinuation({ Continuation: { ...report(), resumes } },
            { ...context, ...extra }, [task()]), /exact resumable/);
    }
});

test("continuation rejects duplicate work, invented backlog, cap evasion and early live DevOps", () => {
    for (const extra of [
        { id: "original" }, { id: "accepted" }, { kind: "devops" },
        { sourceSprintId: "invented" }, { sourceSprintId: undefined }, { sourceCriterion: "" },
    ]) {
        const tasks = [{ ...task(), ...extra }];
        assert.throws(() => validateContinuation({ Continuation: { ...report(), resumes: [] } }, context, tasks), /bounded source work/);
    }
    assert.throws(() => validateContinuation({ Continuation: { ...report(), resumes: [] } },
        { ...context, availableSprints: ["s1"] }, [task()]), /allowed sourceSprintId/);
});

test("original E2E requalification selects an exact accepted changed subject, never a failed stage or latest-work guess", () => {
    const key = "sprint/1/s1/DevOpsWorkLoop";
    const source = { key: "sprint/1/s1/task/maintenance/AssignedWorkDeveloperLoop",
        sprintId: "s1", commit: "b".repeat(40) };
    const current = { ...context, blocked: [{ key, loopId: "DevOpsWorkLoop", sprintId: "s1", status: "needs-replan" }],
        sourceSubjects: [source], e2e: { status: "agreed", testedRevision: "a".repeat(40) } };
    const value = { ...report(), resumes: [{ key, after: [], evidence: "Accepted changed source.", e2eSubject: source.key }] };
    assert.doesNotThrow(() => validateContinuation({ Continuation: value }, current, []));
    for (const mutation of [
        { e2e: { status: "agreed", testedRevision: source.commit } },
        ...["needs-input", "needs-replan", "limit-reached", "error"].map((status) => ({ e2e: { status } })),
        { e2e: { status: "agreed", stopCause: "no-progress" } },
        { sourceSubjects: [] }, { sourceSubjects: [{ ...source, commit: "not-a-revision" }] },
        { sourceSubjects: [{ ...source, sprintId: "foreign" }] },
        { blocked: [{ ...current.blocked[0], loopId: "SprintPlanLoop" }] },
    ]) assert.throws(() => validateContinuation({ Continuation: value }, { ...current, ...mutation }, []), /E2E requalification/);
    for (const e2eSubject of ["", "latest", "workflow-repair", "foreign/outcome"]) {
        assert.throws(() => validateContinuation({ Continuation: { ...value,
            resumes: [{ ...value.resumes[0], e2eSubject }] } }, current, []), /E2E requalification/);
    }
});

test("shared doctrine preserves useful construction, real authority and evidence-backed quiescence", () => {
    const instructions = [...deliveryInstructions, ...continuationInstructions].join("\n");
    assert.match(instructions, /walking skeleton/);
    assert.match(instructions, /never bypass a denial/);
    assert.match(instructions, /source files\/modules/);
    assert.match(instructions, /critical-path priorities/);
    assert.match(instructions, /ready\/executing work, feasible splits/);
    assert.match(instructions, /independent approved release backlog/);
    assert.match(instructions, /bounded investigation\/integration corrections/);
    assert.match(instructions, /unrelated failed task must not prevent/);
    assert.match(instructions, /original owner\/reviewers, not an automatic promotion/);
    assert.match(instructions, /unchanged exhaustion must not create a polling loop/);
});
