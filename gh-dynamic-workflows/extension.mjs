import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { metadata, createDeliveryRunner } from "./workflow.mjs";
import { labMetadata, createLabRunner } from "./lab-workflow.mjs";

await joinSession({
    workflows: [
        defineWorkflow({ meta: metadata, run: createDeliveryRunner() }),
        defineWorkflow({ meta: labMetadata, run: createLabRunner() }),
    ],
});
