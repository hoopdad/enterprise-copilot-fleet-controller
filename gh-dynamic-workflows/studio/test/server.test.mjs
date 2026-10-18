import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createConnection } from "node:net";
import { startStudio } from "../server.mjs";
import { fixture, SOURCE, SESSION } from "./fixture.mjs";

test("serves authenticated loopback canvas, snapshots, previews and older progress without writes", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const server = await startStudio(f.project, { sessionsRoot: f.sessionsRoot });
    t.after(server.close);
    const initial = await readFile(f.dbFile);
    const root = await fetch(server.url);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-security-policy"), /object-src 'none'/);
    assert.ok(!(await root.text()).includes("__NONCE__"));
    const design = await (await fetch(`${server.url}api/design`)).json();
    const snapshot = await (await fetch(`${server.url}api/snapshot`)).json();
    assert.equal(snapshot.detail.runId, "live-run");
    assert.equal(snapshot.runs.length, 3);
    const selected = await (await fetch(`${server.url}api/snapshot?sessionId=${SESSION}&runId=past-run`)).json();
    assert.equal(selected.detail.result.status, "blocked");
    const preview = await fetch(`${server.url}api/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: design.workflows[0].file, source: SOURCE.replace('"Build"', '"Draft Build"') }),
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).workflows[0].phases[1].title, "Draft Build");
    assert.equal(globalThis.__studioExecuted, undefined);
    assert.equal(await readFile(path.join(f.project, "gh-dynamic-workflows", "workflow.mjs"), "utf8"), SOURCE);
    const progress = await (await fetch(`${server.url}api/progress?sessionId=${SESSION}&runId=live-run&beforeSeq=206`)).json();
    assert.equal(progress.lines.at(-1).seq, 205);
    assert.deepEqual(await readFile(f.dbFile), initial);
});

test("denies cross-origin, guessed routes, mutators and invalid preview sources explicitly", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const server = await startStudio(f.project, { sessionsRoot: f.sessionsRoot });
    t.after(server.close);
    const origin = new URL(server.url).origin;
    assert.equal((await fetch(`${origin}/api/snapshot`)).status, 404);
    assert.equal((await fetch(`${server.url}api/snapshot`, { headers: { Origin: "https://example.invalid" } })).status, 403);
    assert.equal((await fetch(`${server.url}api/run`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${server.url}api/save`, { method: "POST" })).status, 404);
    const result = await fetch(`${server.url}api/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: "../../x", source: "bad" }),
    });

    assert.equal(result.status, 400);
    assert.match((await result.json()).error, /not in the selected/);
});

test("closes the renderer even when a browser has an unused preconnected socket", { timeout: 5000 }, async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const studio = await startStudio(f.project, { sessionsRoot: f.sessionsRoot });
    const url = new URL(studio.url);
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    t.after(() => socket.destroy());
    t.after(() => studio.server.listening ? studio.close() : undefined);
    await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });
    await studio.close();
    assert.equal(studio.server.listening, false);
});
