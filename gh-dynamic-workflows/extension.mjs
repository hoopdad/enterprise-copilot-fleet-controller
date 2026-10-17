import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { metadata, createDeliveryRunner } from "./workflow.mjs";
import { labMetadata, createLabRunner } from "./lab-workflow.mjs";
import { createTicketBroker, executionTool } from "./lab-executor.mjs";

async function assertReader(session) {
    const expected = await realpath(fileURLToPath(new URL("../.github/agents/delivery-reader.agent.md", import.meta.url)));
    const { agents } = await session.rpc.agent.reload();
    const reader = agents.find((agent) => agent.id === "delivery-reader");
    if (!reader?.path || await realpath(reader.path) !== expected ||
        !Array.isArray(reader.tools) || reader.tools.length !== 2 ||
        !reader.tools.includes("read") || !reader.tools.includes("search") ||
        Object.keys(reader.hooks ?? {}).length || Object.keys(reader.mcpServers ?? {}).length) {
        throw new Error("Required project delivery-reader agent is missing or not strictly read/search-only; review and reinstall it");
    }
}
async function assertLabProfiles(session) {
    const expected = {
        "lab-reader": ["read", "search"],
        "lab-author": ["read", "search", "edit"],
        "lab-operator": ["read", "search", "lab_execute_ticket"],
    };
    const { agents } = await session.rpc.agent.reload();
    for (const [name, tools] of Object.entries(expected)) {
        const agent = agents.find((candidate) => candidate.id === name);
        const location = await realpath(fileURLToPath(new URL(`../.github/agents/${name}.agent.md`, import.meta.url)));
        if (!agent?.path || await realpath(agent.path) !== location ||
            !Array.isArray(agent.tools) || agent.tools.length !== tools.length ||
            !tools.every((tool) => agent.tools.includes(tool)) ||
            Object.keys(agent.hooks ?? {}).length || Object.keys(agent.mcpServers ?? {}).length) {
            throw new Error(`Required project ${name} profile is missing or changed; review its exact tools and reinstall deliberately`);
        }
    }
}
const run = createDeliveryRunner();
const workflow = defineWorkflow({ meta: metadata, run: async (ctx) => {
    await assertReader(ctx.session);
    return run(ctx);
} });
const broker = createTicketBroker();
const labRun = createLabRunner({ broker });
const labWorkflow = defineWorkflow({ meta: labMetadata, run: async (ctx) => {
    await assertLabProfiles(ctx.session);
    return labRun(ctx);
} });
const session = await joinSession({ workflows: [workflow, labWorkflow], tools: [executionTool(broker)] });
await assertReader(session);
await assertLabProfiles(session);
