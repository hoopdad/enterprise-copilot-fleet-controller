import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadDesign, analyzeSource } from "./source.mjs";
import { WorkflowStore } from "./store.mjs";

const assets = new Map([
    ["", ["index.html", "text/html; charset=utf-8"]],
    ["app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
    ["observed.mjs", ["observed.mjs", "text/javascript; charset=utf-8"]],
    ["style.css", ["style.css", "text/css; charset=utf-8"]],
]);

async function body(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 2.1 * 1024 * 1024) throw new Error("Request exceeds source size limit");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startStudio(projectRoot, options = {}) {
    let design = await loadDesign(projectRoot);
    const store = new WorkflowStore(design.root, options);
    await store.discover();
    let lastDiscovery = Date.now();
    const token = randomBytes(32).toString("hex");
    const nonce = randomBytes(24).toString("base64");
    let origin;

    async function snapshot(selection = {}) {
        const discover = Date.now() - lastDiscovery > 10_000;
        const listing = await store.listRuns({ discover });
        if (discover) lastDiscovery = Date.now();
        const selected = selection.runId ? listing.runs.find((run) =>
            run.runId === selection.runId && run.sessionId === selection.sessionId)
            : listing.runs.find((run) => run.status === "running" && !run.stale) ?? listing.runs[0];
        if (selection.runId && !selected) throw new Error("Selected run is not in this project");
        const detail = selected ? await store.detail(selected.sessionId, selected.runId) : null;
        return { ...listing, detail };
    }

    const server = createServer(async (request, response) => {
        const send = (status, value) => {
            response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify(value));
        };
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Security-Policy",
            `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'`);
        try {
            if (request.headers.host !== new URL(origin).host) return send(403, { error: "Invalid host" });
            if (request.headers.origin && request.headers.origin !== origin) return send(403, { error: "Cross-origin request denied" });
            const url = new URL(request.url, origin);
            const prefix = `/${token}/`;
            if (!url.pathname.startsWith(prefix)) return send(404, { error: "Not found" });
            const route = url.pathname.slice(prefix.length);
            if (request.method === "GET" && assets.has(route)) {
                const [file, type] = assets.get(route);
                const content = await readFile(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
                response.writeHead(200, { "Content-Type": type });
                return response.end(content.replaceAll("__NONCE__", nonce));
            }
            if (request.method === "GET" && route === "api/design") return send(200, design);
            if (request.method === "POST" && route === "api/design/refresh") {
                design = await loadDesign(projectRoot);
                return send(200, design);
            }
            if (request.method === "GET" && route === "api/snapshot") {
                return send(200, await snapshot({
                    sessionId: url.searchParams.get("sessionId"), runId: url.searchParams.get("runId"),
                }));
            }
            if (request.method === "GET" && route === "api/progress") {
                const detail = await store.detail(url.searchParams.get("sessionId"), url.searchParams.get("runId"), {
                    beforeSeq: Number(url.searchParams.get("beforeSeq")), limit: 200,
                });
                return send(200, detail.progress);
            }
            if (request.method === "POST" && route === "api/analyze") {
                if (!request.headers["content-type"]?.startsWith("application/json")) {
                    return send(415, { error: "Expected application/json" });
                }
                const input = await body(request);
                const file = design.files.find((candidate) => candidate.file === input.file);
                if (!file) return send(400, { error: "File is not in the selected source graph" });
                return send(200, { file: file.file, ...analyzeSource(input.source, file.file) });
            }
            return send(404, { error: "Not found" });
        } catch (error) {
            options.onError?.(error);
            if (!response.headersSent) send(400, { error: error.message });
            else response.destroy(error);
        }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    return {
        server, url: `${origin}/${token}/`, projectRoot: design.root, snapshot,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
        }),
    };
}
