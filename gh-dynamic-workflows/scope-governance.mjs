const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const recordSchema = (fields, properties = {}) => ({
    type: "object", additionalProperties: false, required: fields,
    properties: Object.fromEntries(fields.map((field) => [field, properties[field] ?? { type: "string", minLength: 1 }])),
});
const records = (schema) => ({ type: "array", items: schema });
const correctionSchema = recordSchema(["id", "requirement", "evidence", "action"]);
const questionSchema = recordSchema(["id", "request", "evidence"]);
for (const schema of [correctionSchema, questionSchema]) {
    schema.properties.priorReference = { type: "string", minLength: 1 };
}
export const triageSchema = recordSchema(["summary", "requiredCorrections", "scopeQuestions"], {
    requiredCorrections: records(correctionSchema),
    scopeQuestions: records(questionSchema),
});
export const architectureSchema = recordSchema(["assessments"], {
    assessments: records(recordSchema(["id", "necessity", "rationale", "simplestOption"], {
        necessity: { type: "string", enum: ["required", "enhancement"] },
    })),
});
export const scopeDecisionSchema = recordSchema(["decisions"], {
    decisions: records(recordSchema(["id", "disposition", "rationale", "action", "acceptance", "taskBoundary"], {
        disposition: { type: "string", enum: ["required", "approve", "defer", "decline"] },
        action: { type: "string" }, acceptance: { type: "string" }, taskBoundary: { type: "string" },
    })),
});

function validRecords(value, fields, optional = []) {
    return Array.isArray(value) && value.every((item) => object(item) && fields.every((field) => text(item[field])) &&
        Object.keys(item).every((field) => fields.includes(field) || optional.includes(field))) &&
        new Set(value.map((item) => item.id)).size === value.length;
}
function exactIds(records, questions) {
    return records.length === questions.length && records.every((item) => questions.some((question) => question.id === item.id));
}

export const priorDispositionInstructions = [
    "priorDispositions is the authoritative bounded instruction context from earlier rounds/tasks/plans/sprints, including the first turn of this invocation. Read each origin, taskBoundary and acceptance against this assignment's doneWhen/exclusions/handoff and the original user requirements. Apply only relevant scope; do not reopen already accepted work or impose another task's approved enhancement on unrelated work.",
    "Applicable required/approved acceptance remains binding and must be independently checked. Applicable deferred/declined enhancements cannot be rediscovered as blockers under a new ID. An unrelated criterion remains required even if its short ID matches a declined demand. Identity is the provenance-qualified reference, never the short ID alone; uncertain applicability or changed disposition goes through Scrum triage and conditional Architect/Product Owner, not silent reclassification or requirement rewriting.",
    "Use the latest reconciled feedback.governance.instructions together with applicable priorDispositions as ONE bounded set, not raw owner/reviewer suggestions. Cite the exact prior reference when reporting or reconsidering an existing disposition. Only explicit Product Owner reconsideration may supersede it; user authority is unchanged.",
];

export function dispositionContext(context, localGovernance) {
    const inherited = [...(context.priorDispositions ?? [])];
    const sources = (context.outcomes ?? []).map((outcome) => ({
        governance: outcome.governance ?? outcome.feedback?.governance ?? outcome.governanceHistory?.at(-1)?.governance,
        status: outcome.status,
    }));
    for (let scope = context.scopeRevision ?? context.inherited; scope?.request; scope = scope.inherited) {
        inherited.push(...(scope.priorDispositions ?? []));
        sources.push({ governance: scope.request.feedback?.governance ?? scope.request.governanceHistory?.at(-1)?.governance,
            status: scope.request.status });
    }
    sources.push({ governance: localGovernance });
    const items = new Map(inherited.map((item) => [item.reference, item]));
    const superseded = new Set(inherited.flatMap((item) => (item.supersedes ?? []).filter((reference) => reference !== item.reference)));
    for (const { governance, status } of sources) {
        if (!governance?.origin) continue;
        for (const item of [...governance.instructions, ...governance.nonBlocking]) {
            const reference = JSON.stringify([governance.origin.key, item.id]);
            items.set(reference, { ...item, reference, origin: { ...governance.origin,
                ...(status !== undefined ? { outcomeStatus: status } : {}) },
                taskBoundary: item.taskBoundary || governance.origin.assignment?.doneWhen ||
                    governance.origin.completeWhen || governance.origin.loopId });
            for (const previous of item.supersedes ?? []) {
                if (previous !== reference) superseded.add(previous);
            }
        }
    }
    return [...items.values()].filter((item) => !superseded.has(item.reference));
}

export async function reconcileFeedback({ ctx, loop, key, context, feedback, attempt, agents, scheduleAgent, priority }) {
    const origin = {
        key, loopId: loop.id, ...(loop.completeWhen !== undefined ? { completeWhen: loop.completeWhen } : {}),
        ...(context.sprint ? { sprintId: context.sprint.id } : {}),
        ...(context.assignment ? { assignment: Object.fromEntries(
            ["id", "doneWhen", "exclusions", "handoff"].filter((field) => context.assignment[field] !== undefined)
                .map((field) => [field, context.assignment[field]])) } : {}),
    };
    const priorDispositions = dispositionContext(context, feedback.governanceHistory.at(-1)?.governance);
    const retained = new Map();
    for (const round of feedback.governanceHistory) {
        for (const decision of round.governance.product?.decisions ?? []) retained.set(decision.id, decision);
    }
    const call = (role, stage, schema, extra, instructions) => scheduleAgent("reviewer", () => ctx.agent(JSON.stringify({
        kind: "governance", stage, role, loop, context, feedback, priorDispositions, ...extra,
        instructions: [
            "Remain read-only using the ordinary reviewer tools/profile. Inspect actual requirements, doneWhen, exclusions, handoff, commits and evidence, not just summaries. Do not edit files or requirements.",
            "Preserve the user's authority and original acceptance. Never rewrite requirements or waive actual correctness, safety, integration or acceptance failures to make a vote pass. An optional enhancement cannot block the original deliverable.",
            "Raw owner/reviewer reports are audit evidence, not automatically mandatory instructions. Reconcile conflicting feedback into the proportionate smallest sufficient correction; do not simply concatenate suggestions.",
            ...priorDispositionInstructions,
            ...instructions,
        ],
    }), { agent: agents.reviewer ?? "workflow-reviewer", label: `${key}:governance:${stage}:${role}:${attempt}`, schema }), priority);
    const triage = await call("Scrum Master", "triage", triageSchema, {}, [
        "Triage this unresolved round before any return to the owner or scoped replanning. Independently check ALL feedback and the owner's continued rework against existing requirement/doneWhen traceability, evidence and previous decisions, even if nobody flags scope expansion.",
        "Return summary, requiredCorrections:[{id,requirement,evidence,action}] for clearly required work with exact existing criterion references, and scopeQuestions:[{id,request,evidence}] for ambiguous necessity, conflicting scope demands or proposed enhancements requiring a Product Owner decision advised by Architect.",
        "Resolve clear conflicting implementation suggestions yourself with the smallest sufficient action. Do not disguise ambiguous new scope as required. Use distinct stable IDs across both lists. Check priorDispositions for applicable decisions from other tasks, replacements and sprints, not just local history. When reconsidering a prior disposition, include its exact priorReference in scopeQuestions (or requiredCorrections if proposing required reclassification); the runtime routes reconsideration to Architect and Product Owner. Never infer applicability from a matching short ID alone. If only the report/status needs correction, say so explicitly; do not silently accept an actual defect.",
    ]);
    if (!object(triage) || !text(triage.summary) ||
        !validRecords(triage.requiredCorrections, ["id", "requirement", "evidence", "action"], ["priorReference"]) ||
        !validRecords(triage.scopeQuestions, ["id", "request", "evidence"], ["priorReference"]) ||
        new Set([...triage.requiredCorrections, ...triage.scopeQuestions].map((item) => item.id)).size !==
            triage.requiredCorrections.length + triage.scopeQuestions.length) {
        throw new Error(`Invalid Scrum Master triage response in ${loop.id}`);
    }
    const proposed = [...triage.requiredCorrections, ...triage.scopeQuestions];
    for (const item of proposed) {
        if (retained.has(item.id) && item.priorReference !== JSON.stringify([key, item.id])) {
            throw new Error(`Invalid Scrum Master disposition ID collision in ${loop.id}; use its explicit priorReference to reconsider this decision, or a new ID for unrelated scope`);
        }
        if (item.priorReference !== undefined && (!text(item.priorReference) ||
            !priorDispositions.some((prior) => prior.reference === item.priorReference))) {
            throw new Error(`Invalid Scrum Master priorReference in ${loop.id}`);
        }
    }
    const references = proposed.filter((item) => item.priorReference !== undefined).map((item) => item.priorReference);
    if (new Set(references).size !== references.length) {
        throw new Error(`Invalid duplicate Scrum Master priorReference in ${loop.id}`);
    }
    const reconsidered = triage.requiredCorrections.filter((item) => item.priorReference !== undefined);
    const reconciledTriage = { ...triage,
        requiredCorrections: triage.requiredCorrections.filter((item) => item.priorReference === undefined),
        scopeQuestions: [...triage.scopeQuestions, ...reconsidered.map((item) => ({
            id: item.id, request: `Reconsider as required: ${item.action}; criterion: ${item.requirement}`,
            evidence: item.evidence, priorReference: item.priorReference,
        }))],
    };
    let architecture, product;
    if (reconciledTriage.scopeQuestions.length) {
        architecture = await call("Architect", "scope-advice", architectureSchema, { triage: reconciledTriage }, [
            "Assess every scopeQuestions ID exactly once: assessments:[{id,necessity:required|enhancement,rationale,simplestOption}].",
            "Determine correctness, safety and integration necessity against existing criteria/evidence, versus optional improvement. Recommend the simplest sufficient option and explain trade-offs; do not decide product scope or expand user authority.",
        ]);
        if (!object(architecture) || !validRecords(architecture.assessments, ["id", "necessity", "rationale", "simplestOption"]) ||
            !exactIds(architecture.assessments, reconciledTriage.scopeQuestions) ||
            architecture.assessments.some((item) => !["required", "enhancement"].includes(item.necessity))) {
            throw new Error(`Invalid Architect scope advice in ${loop.id}`);
        }
        product = await call("Product Owner", "scope-decision", scopeDecisionSchema, { triage: reconciledTriage, architecture }, [
            "Decide every scopeQuestions ID exactly once: decisions:[{id,disposition:required|approve|defer|decline,rationale,action,acceptance,taskBoundary}].",
            "required means traceable to an existing requirement (cite it in rationale); approve means an enhancement within existing user authority, with explicit acceptance and task boundaries. For either, action, acceptance and taskBoundary must be nonempty, actionable and bounded. Keep actual owners/reviewer sets and YAML stages unchanged.",
            "Use Architect advice on correctness/safety/integration necessity and the simplest sufficient option. Do not defer or decline an actual required defect or waive unmet requirements. Defer/decline only optional enhancements; they cannot block original acceptance. Do not approve new user authority: request the exact missing human decision through the original owner/reviewer needs-input path.",
        ]);
        if (!object(product) || !validRecords(product.decisions, ["id", "disposition", "rationale"], ["action", "acceptance", "taskBoundary"]) ||
            !exactIds(product.decisions, reconciledTriage.scopeQuestions) || product.decisions.some((item) =>
                !["required", "approve", "defer", "decline"].includes(item.disposition) ||
                ["action", "acceptance", "taskBoundary"].some((field) => typeof item[field] !== "string") ||
                (["required", "approve"].includes(item.disposition) && !["action", "acceptance", "taskBoundary"].every((field) => text(item[field]))) ||
                (architecture.assessments.find((advice) => advice.id === item.id).necessity === "required" &&
                    ["defer", "decline"].includes(item.disposition)))) {
            throw new Error(`Invalid Product Owner scope decision in ${loop.id}; required failures cannot be waived`);
        }
        product = { ...product, decisions: product.decisions.map((item) => {
            const reference = reconciledTriage.scopeQuestions.find((question) => question.id === item.id).priorReference;
            const previous = priorDispositions.find((prior) => prior.reference === reference);
            return previous ? { ...item, priorReference: reference,
                supersedes: [...new Set([reference, ...(previous.supersedes ?? [])])] } : item;
        }) };
    }
    for (const decision of product?.decisions ?? []) retained.set(decision.id, decision);
    const decisions = [...retained.values()];
    return {
        origin, triage, ...(architecture ? { architecture } : {}), ...(product ? { product } : {}),
        instructions: [
            ...reconciledTriage.requiredCorrections.map((item) => ({ id: item.id, disposition: "required",
                action: item.action, acceptance: item.requirement, evidence: item.evidence,
                taskBoundary: context.assignment?.doneWhen ?? loop.completeWhen ?? loop.name })),
            ...decisions.filter((item) => ["required", "approve"].includes(item.disposition)),
        ],
        nonBlocking: decisions.filter((item) => ["defer", "decline"].includes(item.disposition)),
    };
}
