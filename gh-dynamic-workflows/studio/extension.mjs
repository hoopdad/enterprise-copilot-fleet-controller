import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const instances = new Map();
const inputSchema = {
    type: "object", required: ["projectRoot"],
    properties: { projectRoot: { type: "string", description: "Explicit local project root whose workflow source and sessions may be observed read-only." } },
};

await joinSession({
    canvases: [createCanvas({
        id: "workflow-studio",
        displayName: "Workflow Studio",
        description: "One pane for Dynamic Workflow source/design drafts, live phase and agent timelines, and historical results. Never starts, changes or stops a workflow.",
        inputSchema,
        actions: [{
            name: "snapshot",
            description: "Inspect the selected project's durable workflow runs without reading prompts or modifying execution.",
            handler: async (ctx) => {
                const instance = instances.get(ctx.instanceId);
                if (!instance) throw new Error("Open this canvas instance first");
                const snapshot = await instance.snapshot();
                return {
                    projectRoot: instance.projectRoot, observedAt: snapshot.observedAt,
                    runs: snapshot.runs, warnings: snapshot.warnings,
                    current: snapshot.detail && {
                        runId: snapshot.detail.runId, status: snapshot.detail.status,
                        phases: snapshot.detail.phases, liveAgentCount: snapshot.detail.liveAgentCount,
                        agentCount: snapshot.detail.agents.length, progress: snapshot.detail.progress,
                    },
                };
            },
        }],
        open: async (ctx) => {
            const projectRoot = ctx.input?.projectRoot;
            if (typeof projectRoot !== "string" || !projectRoot.trim()) throw new Error("An explicit projectRoot is required");
            let instance = instances.get(ctx.instanceId);
            if (instance && instance.requestedRoot !== projectRoot) {
                throw new Error("Use a new instanceId to observe another project");
            }
            if (!instance) {
                let startStudio;
                try { ({ startStudio } = await import("./server.mjs")); }
                catch (error) {
                    if (error.code === "ERR_MODULE_NOT_FOUND" && ["acorn", "yaml"].some((name) => error.message.includes(name))) {
                        throw new Error("Workflow Studio dependencies are missing. Run npm --prefix .\\gh-dynamic-workflows\\studio ci --omit=dev in the extension's project, then reopen the canvas.", { cause: error });
                    }
                    throw error;
                }
                instance = await startStudio(projectRoot);
                instance.requestedRoot = projectRoot;
                instances.set(ctx.instanceId, instance);
            }
            return { title: "Workflow Studio", url: instance.url };
        },
        onClose: async (ctx) => {
            const instance = instances.get(ctx.instanceId);
            if (instance) {
                instances.delete(ctx.instanceId);
                await instance.close();
            }
        },
    })],
});

process.once("SIGTERM", () => {
    Promise.all([...instances.values()].map((instance) => instance.close()))
        .then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
});
