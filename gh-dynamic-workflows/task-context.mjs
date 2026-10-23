import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const pick = (value, fields) => Object.fromEntries(fields.filter((field) => value?.[field] !== undefined)
    .map((field) => [field, value[field]]));

export const contextInstructions = [
    "Context is a current task packet, not the full execution history. outcomes contains status/audit references; dependencies contains direct handoffs, checks, findings and limitations. Open referenced JSON files and relevant source/commits; an audit reference is not acceptance.",
    "Keep instruction discovery and ordinary Git/test/build commands inside projectRoot. Use supplied applicable instructions; do not routinely scan parent directories or the user's home for AGENTS.md. Read an external source only when the task actually needs it and its path is authorized. CLI path permissions and project resource/data boundaries remain binding; do not broaden them for convenience.",
    "If a mixed shell command is denied, inspect its requested paths and operations. A denied ancestor-directory probe does not establish that repository-local Git or tests are denied. Omit the unnecessary external probe and separately attempt the authorized repository-local operation before declaring needs-input. Never retry the denied external access through another tool, bypass authentication/content exclusions, or treat a genuinely required denied operation as approved. Report the precise remaining denial and distinguish it from operations that succeeded.",
    "Read applicable document paths and audit files before changing their contracts or claiming their acceptance. Full original reports, reviews and scope history remain available there and in SDK journals. Do not reconstruct missing facts, treat omitted history as success, or reopen accepted work merely because its full report is not inline.",
    "Repository docs/requirements and tests are the scope ledger. Historical audits remain readable but old dispositions and acceptance votes never bypass executable checks. Keep handoffs concise: status, source/commit references, checks and inspectable evidence, remaining limitations and receiving owner.",
    "Only original user requirements, explicitly approved amendments and demonstrated defects preventing those requirements justify mandatory corrections. Cite the authority and explain the falsifiable failure; agent-authored requirements, role seniority and historical suggestions do not grant authority. Everything else stays optional, including Architect, Product Owner and Scrum Master suggestions.",
];

export function historyLocation(root, runId) {
    if (typeof runId !== "string" || !runId || runId === "." || runId === ".." || /[\\/:]/.test(runId)) {
        throw new Error("Context history requires a single run identifier");
    }
    return { root, directory: path.join("gh-dynamic-workflows", ".delivery-runs", runId, "context") };
}

export async function archiveContext(history, label, value) {
    if (!history || value === undefined || value === null) return undefined;
    const content = JSON.stringify(value, null, 2) + "\n";
    const name = createHash("sha256").update(label).update("\0").update(content).digest("hex") + ".json";
    const relative = path.join(history.directory, name);
    const file = path.join(history.root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    try {
        await writeFile(file, content, { flag: "wx", encoding: "utf8" });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await readFile(file, "utf8") !== content) throw new Error(`Context audit conflicts with its original bytes: ${relative}`);
    }
    return { path: relative, label };
}

export function outcomeContext(outcome, audit) {
    if (!outcome || typeof outcome !== "object") return outcome;
    return {
        ...pick(outcome, ["key", "loopId", "taskId", "status", "summary", "artifact", "reason", "nextAction", "workCard",
            "rounds", "stopCause", "limit", "replacements", "checks", "limitation", "correctionAssessments"]),
        ...(outcome.reviews ? { reviews: outcome.reviews.map((review) =>
            pick(review, ["role", "checksValid", "findings", "accepted", "verifiedProgress", "workCard"])) } : {}),
        ...(audit ? { audit } : {}),
    };
}

export function outcomeIndex(outcome, audit) {
    return { ...pick(outcome, ["key", "loopId", "taskId", "status"]), ...(audit ? { audit } : {}) };
}

export function documentContext(document, audit) {
    if (!document || typeof document !== "object" ||
        !(typeof document.path === "string" || typeof document.report === "string")) return document;
    return { ...pick(document, ["path", "report", "branch", "commit", "version", "state", "status",
        "liveReady", "adapterBinding"]), ...(audit ? { audit } : {}) };
}
