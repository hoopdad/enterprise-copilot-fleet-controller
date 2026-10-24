import { readFileSync } from "node:fs";
import { parse } from "yaml";

export function parseWorkflow(text) {
    const definition = parse(text);
    const steps = definition?.workflows?.ReleaseLoop?.steps;
    if (!Array.isArray(steps) || !steps.length) throw new Error("loops.yml requires workflows.ReleaseLoop.steps");
    const ids = new Set();
    const inspect = (nodes) => {
        for (const node of nodes) {
            if (!node || typeof node.id !== "string" || typeof node.name !== "string" || ids.has(node.id)) {
                throw new Error("Workflow steps need unique ids and names");
            }
            ids.add(node.id);
            if (Array.isArray(node.substeps)) inspect(node.substeps);
            else if (typeof node.owner !== "string" || !Array.isArray(node.reviewers) || !node.reviewers.length ||
                node.reviewers.some((role) => typeof role !== "string")) {
                throw new Error(`Loop ${node.id} requires a do-er and reviewers`);
            }
        }
    };
    inspect(steps);
    return definition;
}

export function loadWorkflow(file = new URL("./loops.yml", import.meta.url)) {
    return parseWorkflow(readFileSync(file, "utf8"));
}

export function flattenLoops(nodes) {
    return nodes.flatMap((node) => [node, ...(node.substeps ? flattenLoops(node.substeps) : [])]);
}

export const definition = loadWorkflow();
export function workflowMetadata(name) {
    return {
        name,
        description: "Execute evidence-backed YAML loops with independent construction, serialized deployment verification and work-conserving release delivery.",
        phases: flattenLoops(definition.workflows.ReleaseLoop.steps).map((node) => ({
            title: node.name,
            detail: `${node.completeWhen ?? node.description}${["AssignedWorkUIDeveloperLoop", "AssignedWorkDeveloperLoop"].includes(node.id)
                ? " Concurrent assignments are observed under Sprint Loop; their agent labels identify the original loop." : ""}`,
        })),
        argsSchema: { type: "object", required: ["projectRoot"], properties: {
            projectRoot: { type: "string" }, workflowPath: { type: "string" },
            specification: { type: ["string", "object"] }, input: { type: "object" },
            acceptance: { type: "array" }, repositories: { type: "array" },
            attempts: { type: "object" }, maxSprints: { type: "integer", minimum: 1,
                description: "Explicit cap on entered sprints, including partial sprints; omitted means no local cap." },
            maxNoProgressRounds: { type: "integer", minimum: 1 },
            concurrency: { type: "object", additionalProperties: false, properties: {
                doers: { type: "integer", minimum: 1 }, reviewers: { type: "integer", minimum: 1 },
            } },
            git: { type: "object", properties: { featureBranch: { type: "string", minLength: 1 } } },
            agents: { type: "object", additionalProperties: false, properties: {
                owner: { type: "string", minLength: 1 }, doer: { type: "string", minLength: 1 },
                reviewer: { type: "string", minLength: 1 },
            } },
        } },
    };
}
