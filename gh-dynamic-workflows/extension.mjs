import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { metadata, createDeliveryRunner } from "./workflow.mjs";

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
const run = createDeliveryRunner();
const workflow = defineWorkflow({ meta: metadata, run: async (ctx) => {
    await assertReader(ctx.session);
    return run(ctx);
} });
const session = await joinSession({ workflows: [workflow] });
await assertReader(session);
