export const failureCategories = [
    "Identity/access", "Network/connectivity", "Configuration", "Deployment/build",
    "Application logic", "UI/presentation", "Data", "Unknown",
];
const strings = { type: "array", items: { type: "string", minLength: 1 } };
export const workCardSchema = {
    type: "object",
    required: ["role", "action", "goal", "components", "flows", "flowSteps", "doneWhen",
        "failureCategories", "mustAct", "locations", "evidence", "cause", "verification",
        "humanAction", "humanActionEvidence"],
    additionalProperties: false,
    properties: {
        role: { type: "string", minLength: 1 },
        action: { type: "string", minLength: 1 },
        goal: { type: "string", minLength: 1 },
        components: strings, flows: strings, flowSteps: strings,
        doneWhen: { type: "string", minLength: 1 },
        failureCategories: { type: "array", items: { type: "string", enum: failureCategories }, uniqueItems: true },
        mustAct: { type: "string" }, locations: strings,
        evidence: { type: "string" }, cause: { type: "string" },
        verification: {
            type: "object", required: ["status", "evidence"], additionalProperties: false,
            properties: {
                status: { type: "string", enum: ["not-yet-verified", "passed", "failed", "partial"] },
                evidence: { type: "string" },
            },
        },
        humanAction: { type: "string" }, humanActionEvidence: { type: "string" },
    },
};
export const taskCardsSchema = { type: "array", items: {
    type: "object", required: ["id", "workCard"], additionalProperties: false,
    properties: { id: { type: "string", minLength: 1 }, workCard: workCardSchema },
} };

// Replayed legacy reports may omit cards; supplied metadata must never fail silently.
export function validateWorkCard(card, source) {
    if (card === undefined) return;
    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = (value) => typeof value === "string";
    const nonempty = (value) => text(value) && value.trim().length > 0;
    if (!object(card) || workCardSchema.required.some((key) => !Object.hasOwn(card, key)) ||
        Object.keys(card).some((key) => !Object.hasOwn(workCardSchema.properties, key)) ||
        ["role", "action", "goal", "doneWhen"].some((key) => !nonempty(card[key])) ||
        ["mustAct", "evidence", "cause", "humanAction", "humanActionEvidence"].some((key) => !text(card[key])) ||
        ["components", "flows", "flowSteps", "locations", "failureCategories"].some((key) =>
            !Array.isArray(card[key]) || card[key].some((item) => !nonempty(item))) ||
        card.failureCategories.some((category) => !failureCategories.includes(category)) ||
        new Set(card.failureCategories).size !== card.failureCategories.length ||
        !object(card.verification) || !["not-yet-verified", "passed", "failed", "partial"].includes(card.verification.status) ||
        !text(card.verification.evidence) ||
        Object.keys(card.verification).some((key) => !["status", "evidence"].includes(key)) ||
        (card.verification.status !== "not-yet-verified" && !nonempty(card.verification.evidence)) ||
        (Boolean(card.humanAction.trim()) !== Boolean(card.humanActionEvidence.trim()))) {
        throw new Error(`Invalid workCard in ${source}; scope, responsibility and verification must be explicit`);
    }
}

export function validateTaskCards(cards, tasks, source) {
    if (cards === undefined) return;
    if (!Array.isArray(cards) || !Array.isArray(tasks) || cards.length !== tasks.length ||
        cards.some((item) => !item || typeof item.id !== "string" || !item.id.trim() ||
            Object.keys(item).some((key) => !["id", "workCard"].includes(key))) ||
        new Set(cards.map((item) => item.id)).size !== cards.length) {
        throw new Error(`Invalid taskCards in ${source}; report each planned assignment exactly once`);
    }
    for (const item of cards) {
        validateWorkCard(item.workCard, `${source} task ${item.id}`);
        const task = tasks.find((task) => task.id === item.id);
        if (!item.workCard || !task?.workCard || !isDeepStrictEqual(item.workCard, task.workCard)) {
            throw new Error(`Invalid taskCards in ${source}; task ${item.id} must match its resolved SprintPlan card`);
        }
    }
}

export const workCardInstructions = [
    "Return workCard using the supplied schema. Its heading is role + ': ' + action, for example 'Developer: Fix database-write access in QuestionAnswer API'. Use a concise meaningful action naming the affected solution, not task IDs, loop names, 'assigned work' or generic 'remains blocked'. role is the role doing this turn; mustAct is the role responsible for the next action, or empty when none. Reviewers distinguish who found an issue from who must fix it.",
    "Reuse Architect-established component/flow names from Architecture/SprintArchitecture and assignment.workCard. A solution component is a meaningful technical building block (page, API endpoint/server, agent, database, Azure resource, identity, role assignment or Terraform resource). Ordinary page controls are page details unless custom components. Purpose-named components can have implementation children and linked supporting identities/permissions; shared support exists once and can link to several components.",
    "A flow begins with a trigger and describes behavior across named components, including storage/agent calls and return to the user when applicable. Use roughly one or two main items per tier plus supporting detail, not exhaustive low-level operations. Personas come from requirements when applicable; the Architect may name them as useful. Missing personas are not errors. Do not ask the user to name components, flows or personas.",
    "workCard components/flows/flowSteps identify this assignment's actual scope using canonical names; arrays may be empty when not applicable or not established. One assignment may span several components/flows or a persona's journeys; do not split it just to fit cards. goal and doneWhen describe this task's action and bounded acceptance, never imply the whole flow is working.",
    "workCard locations lists relevant repository-relative files or folders, not unrelated files. Studio shows one file, a meaningful common folder for several files, or omits a broad location when work spans many folders; exact locations remain in details.",
    "Categorize actual failures with failureCategories (multiple allowed); use [] when no failure. evidence states observed results; cause distinguishes confirmed from suspected causes and unknowns. 'Permission denied' alone does not identify a missing permission: say it is not yet identified. Do not invent a diagnosis.",
    "verification is {status:not-yet-verified|passed|failed|partial,evidence:string}. Use not-yet-verified and explicit limitations until actual relevant checks exist; other statuses require concrete evidence. Agent completion, report agreement and task acceptance are not proof that a flow works. humanAction and humanActionEvidence are both empty unless evidence establishes a user-only decision/authority/action; blocked alone never means the user must act.",
];

export const architectureCardInstructions = [
    "As Architect, establish and maintain solutionModel inside the existing Architecture/SprintArchitecture artifact (or its referenced design file): components:[{id,name,implementationOf?,supports:[componentId]}], flows:[{id,name,persona?,trigger,steps:[{id,description,components:[componentId]}]}]. Use stable unique IDs and purpose-based names; implementationOf denotes implementation children, supports links shared supporting structures. Distinguish resources with different purposes. Maintain existing names/IDs through sprint refinements and scoped amendments; update only affected scope. Downstream roles reuse these names without asking the user to name them.",
];

export const planningCardInstructions = [
    "Give every SprintPlan task a workCard matching the report schema. Set role to its assigned owner, action to a meaningful component/flow-focused task title, goal/doneWhen to bounded acceptance, and scope to Architect-established names. Use empty evidence/cause/humanAction/humanActionEvidence, failureCategories:[] and verification:{status:'not-yet-verified',evidence:''} for unperformed work; do not copy previous verification or failures into a new assignment. title should equal workCard.action; task.doneWhen should equal workCard.doneWhen. Preserve these fields for saved JSON plans, redispatch and scoped replacement tasks.",
    "For SprintPlanLoop also return top-level taskCards:[{id,workCard}] for every assigned task, exactly matching the resolved SprintPlan task cards, even when the actual plan is a saved JSON path. This compact display projection makes pending work understandable without asking Studio to read arbitrary plan files. It is metadata, not a second plan or acceptance gate.",
];
import { isDeepStrictEqual } from "node:util";
