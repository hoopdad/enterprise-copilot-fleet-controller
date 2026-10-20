import { test, expect } from "@playwright/test";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { startStudio } from "../server.mjs";
import { fixture, SOURCE, usageEvent, workEvent } from "./fixture.mjs";

let f;
let studio;
let yamlSource;
test("renders completed governance outcomes rather than missing-result warnings", async ({ page }) => {
    const local = await fixture();
    let instance;
    try {
        const cases = [
            ["triage", "Scrum Master", "Feedback reconciled", { summary: "Fix the original null criterion.",
                requiredCorrections: [{ id: "null", requirement: "Safe handoff.", evidence: "Failing null check.", action: "Handle null." }],
                scopeQuestions: [] }],
            ["scope-advice", "Architect", "Scope advice recorded", { assessments: [{ id: "polish", necessity: "enhancement",
                rationale: "Outside original handoff.", simplestOption: "Keep existing behavior." }] }],
            ["scope-decision", "Product Owner", "Scope decision recorded", { decisions: [{ id: "polish", disposition: "defer",
                rationale: "Original acceptance is sufficient.", action: "", acceptance: "", taskBoundary: "" }] }],
        ];
        instance = await startStudio(local.project, { sessionsRoot: local.sessionsRoot });
        for (const [stage, role, title, result] of cases) {
            local.mutate((db) => db.prepare("UPDATE workflow_agents SET label=?,status='completed' WHERE run_id='live-run'")
                .run(`yaml:AssignedWorkDeveloperLoop:governance:${stage}:${role}:1`));
            await appendFile(path.join(path.dirname(local.dbFile), "events.jsonl"),
                JSON.stringify(workEvent(`result-${stage}`, "a1", result)) + "\n");
            await page.goto(instance.url);
            const task = page.locator('[data-task="agent:a1"]');
            await expect(task).toContainText(title);
            await task.click();
            await expect(page.locator("#task-details")).toContainText(title);
            await expect(page.locator("#task-details")).toContainText("not an original acceptance vote");
            await expect(page.locator("#task-details")).not.toContainText("not retained");
            await expect(page.locator("#error")).toBeHidden();
        }
    } finally {
        await page.close();
        await instance?.close();
        await local.cleanup();
    }
});

test.beforeAll(async () => {
    f = await fixture();
    yamlSource = await readFile(new URL("../../loops.yml", import.meta.url), "utf8");
    await writeFile(path.join(f.project, "gh-dynamic-workflows", "loops.yml"), yamlSource);
    studio = await startStudio(f.project, { sessionsRoot: f.sessionsRoot });
});
test.afterAll(async () => {
    await studio?.close();
    await f?.cleanup();
});

test("agreed rework remains visibly incomplete rather than a green assignment PASS", async ({ page }) => {
    const local = await fixture();
    let instance;
    try {
        const label = "yaml:sprint/1/S1/task/research/AssignedWorkDeveloperLoop";
        local.mutate((db) => {
            db.prepare("UPDATE workflow_agents SET label=?,status='completed' WHERE run_id='live-run'")
                .run(`${label}:reviewer:Critic:7`);
            db.prepare("INSERT INTO workflow_agents(run_id,agent_id,phase_id,label,agent_type,status,started_at_ms,completed_at_ms) VALUES (?,?,?,?,?,?,?,?)")
                .run("live-run", "owner", "p1", `${label}:doer:7`, "workflow-doer", "completed", Date.now() - 3000, Date.now() - 1000);
        });
        await appendFile(path.join(path.dirname(local.dbFile), "events.jsonl"), [
            { type: "subagent.started", agentId: "owner", data: { toolCallId: "owner", workflowRunId: "live-run" } },
            workEvent("owner-rework", "owner", { status: "rework", summary: "Adapter remains unresolved.", artifact: {} }),
            workEvent("review-agreed", "a1", { agree: true, taskComplete: false, unmetCriteria: ["Clarify research scope."],
                feedback: "PASS: accurately reported unresolved capability." }),
        ].map((event) => JSON.stringify(event)).join("\n") + "\n");
        instance = await startStudio(local.project, { sessionsRoot: local.sessionsRoot });
        await page.goto(instance.url);
        const review = page.locator('[data-task="agent:a1"]');
        await expect(review).toContainText("Agrees: task still incomplete");
        await expect(review).toHaveClass(/waiting/);
        await review.click();
        await expect(page.locator("#task-details")).toContainText("not the assignment's combined acceptance or proof of live capability");
        await expect(page.locator("#error")).toBeHidden();
    } finally {
        await page.close();
        await instance?.close();
        await local.cleanup();
    }
});

test("shows unfinished task context, opens unstarted pending tasks, and refreshes to the actual final outcome", async ({ page }) => {
    const local = await fixture();
    let instance;
    try {
        const log = path.join(path.dirname(local.dbFile), "events.jsonl");
        await appendFile(log, [
            { type: "subagent.started", agentId: "planner", data: { toolCallId: "planner", workflowRunId: "live-run" } },
            workEvent("plan-context", "planner", { status: "complete", summary: "Assigned implementation.", artifact: {
                SprintPlan: { tasks: [{ id: "s1-ui", title: "Customer Activity Screen" }] },
            } }),
        ].map((event) => JSON.stringify(event)).join("\n") + "\n");
        local.mutate((db) => {
            db.prepare("UPDATE workflow_agents SET label=? WHERE run_id='live-run'")
                .run("yaml:sprint/1/S1/task/s1-ui/AssignedWorkUIDeveloperLoop:reviewer:Critic:1");
            db.prepare("UPDATE workflow_phases SET detail=? WHERE run_id='live-run' AND phase_id='p1'")
                .run("Inspect filtering and the selected customer.");
        });
        instance = await startStudio(local.project, { sessionsRoot: local.sessionsRoot });
        await page.goto(instance.url);
        await expect(page.locator("#connection")).toContainText("Connected");
        for (const status of ["running", "in-progress", "pending", "queued"]) {
            const pending = ["pending", "queued"].includes(status);
            local.mutate((db) => db.prepare("UPDATE workflow_agents SET status=?, started_at_ms=? WHERE run_id='live-run'")
                .run(status, pending ? null : Date.now() - 1000));
            await expect(page.locator("#agents .status > span")).toHaveText(status, { timeout: 6000 });
            await expect(page.locator("#graph .flow-node.task")).toHaveCount(pending ? 0 : 1);
            const task = pending ? page.locator("#agents .agent-open") : page.locator("#graph .flow-node.task");
            await task.click();
            await expect(page.locator("#task-drawer")).toBeVisible();
            await expect(page.locator("#task-drawer-title")).toHaveText("Customer Activity Screen");
            const summary = page.locator("#task-details .evidence-summary");
            await expect(summary).toContainText("RECORDED TASK CONTEXT");
            await expect(summary).toContainText(pending ? "Task pending" : "Work in progress");
            await expect(summary).toContainText("Assigned task: Customer Activity Screen");
            await expect(summary).toContainText("Critic reviewer");
            await expect(summary).toContainText("Inspect filtering and the selected customer");
            await expect(summary).not.toContainText("No final work response");
            await expect(summary).not.toContainText("No further detail was retained");
            if (pending) await expect(page.locator("#task-details")).toContainText("Not started");
            await page.locator("#close-task").click();
            await expect(task).toBeFocused();
        }
        await page.locator("#agents .agent-open").click();
        await appendFile(log, JSON.stringify(workEvent("final-context", "a1", {
            agree: true, feedback: "Verified that customer filtering preserves selection.",
        })) + "\n");
        local.mutate((db) => db.prepare("UPDATE workflow_agents SET status='completed', completed_at_ms=? WHERE run_id='live-run'")
            .run(Date.now()));
        const summary = page.locator("#task-details .evidence-summary");
        await expect(summary).toContainText("RECORDED AGENT OUTCOME", { timeout: 6000 });
        await expect(summary).toContainText("Verified that customer filtering preserves selection");
        await expect(summary).not.toContainText("Assigned task:");
        await expect(page.locator("#error")).toBeHidden();
    } finally {
        await page.close();
        await instance?.close();
        await local.cleanup();
    }
});

test("unifies live phase/agent activity, historical outcomes and export-only design drafts", async ({ page }) => {
    const pageErrors = [];
    const externalRequests = [];
    page.on("pageerror", (cause) => pageErrors.push(cause.message));
    page.on("request", (request) => {
        if (new URL(request.url()).origin !== new URL(studio.url).origin) externalRequests.push(request.url());
    });
    await page.goto(studio.url);
    await expect(page.locator("#connection")).toContainText("Connected");
    await expect(page.locator("#workflow")).toHaveValue("example");
    await expect(page.locator("#graph .flow-node.task")).toHaveCount(1);
    await expect(page.locator("#graph .flow-node.end")).toHaveCount(0);
    await expect(page.locator("#observed-phases .running")).toContainText("Build");
    await expect(page.locator("#observed-phases")).not.toContainText("Review");
    await expect(page.locator("#agents")).toContainText("<script>globalThis.injected=true</script>");
    expect(await page.evaluate(() => globalThis.injected)).toBeUndefined();
    expect(await page.evaluate(() => globalThis.__studioExecuted)).toBeUndefined();
    await page.locator("#graph .flow-node.task").click();
    await expect(page.locator("#task-drawer")).toBeVisible();
    await expect(page.locator("#task-details")).toContainText("not proof of successful delivery");
    await expect(page.locator("#task-details")).toContainText("1,200");
    await page.keyboard.press("Escape");
    await expect(page.locator("#task-drawer")).not.toBeVisible();
    await page.locator('[data-phase="p1"]').click();
    await expect(page.locator("#inspector")).toContainText("Build");
    await expect(page.locator("#progress .progress-row")).toHaveCount(200);
    await page.locator("#older-progress").click();
    await expect(page.locator("#progress .progress-row")).toHaveCount(400);
    await page.locator("#older-progress").click();
    await expect(page.locator("#progress .progress-row")).toHaveCount(405);
    await expect(page.locator("#older-progress")).toBeHidden();
    await page.locator("#attempt").selectOption("1");
    await expect(page.locator("#progress .progress-row")).toHaveCount(199);
    await page.locator("#attempt").selectOption("");
    await page.locator("#clear-phase").click();

    await page.locator('[data-view="history"]').click();
    await page.getByRole("button", { name: "example completed past-run" }).click();
    await expect(page.locator("#results")).toContainText("Missing approval");
    await expect(page.locator("#run-status")).toContainText("COMPLETED / BLOCKED");
    await expect(page.locator("#stop-notice")).toContainText("Missing approval");
    await expect(page.locator("#graph .flow-node.end.waiting")).toContainText("blocked");
    await expect(page.locator("#agents")).toContainText("unsettled");
    await page.waitForTimeout(2200);
    await expect(page.locator("#view-subtitle")).toContainText("past-run");
    await page.getByRole("button", { name: "example running stale-run" }).click();
    await expect(page.locator("#warnings")).toContainText("lease has expired");
    await expect(page.locator("#observed-phases .stale")).toContainText("Build");
    await expect(page.locator("#graph .flow-node.task.waiting")).toHaveCount(1);

    await page.locator('[data-view="design"]').click();
    await expect(page.locator("#graph .phase-node")).toHaveCount(3);
    await page.locator('[data-phase="design-1"]').click();
    await page.locator("#phase-title").fill("Visual draft");
    await page.getByRole("button", { name: "Preview title change" }).click();
    await expect(page.locator("#graph")).toContainText("Visual draft");
    await expect(page.locator("#source-editor")).toHaveValue(SOURCE.replace('"Build"', '"Visual draft"'));
    await page.locator("#source-editor").fill(SOURCE.replace('"Build"', '"Build draft"'));
    await page.locator("#preview-source").click();
    await expect(page.locator("#draft-message")).toContainText("Syntax parsed without execution");
    await expect(page.locator("#graph")).toContainText("Build draft");
    expect(await readFile(path.join(f.project, "gh-dynamic-workflows", "workflow.mjs"), "utf8")).toBe(SOURCE);
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#export-source").click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("workflow.draft.mjs");
    expect(await readFile(await download.path(), "utf8")).toContain("Build draft");
    await page.locator("#source-editor").fill("export const = broken");
    await page.locator("#preview-source").click();
    await expect(page.locator("#error")).toContainText("Unexpected token");
    await expect(page.locator("#draft-message")).toContainText("Preview failed");
    await expect(page.locator("#graph")).toContainText("Build draft");
    await page.locator("#source-editor").fill(SOURCE);
    await page.locator("#preview-source").click();
    await expect(page.locator("#error")).toBeHidden();
    await page.locator("#graph-layer").selectOption("contract");
    await expect(page.locator("#graph")).toContainText("intake");
    await page.locator("#graph .phase-node").click();
    await expect(page.locator("#inspector")).toContainText("expected-source-contract-not-live-proof");
    await page.locator("#theme").click();
    const theme = await page.locator("html").getAttribute("data-theme");
    expect(["light", "dark"]).toContain(theme);

    await page.locator('[data-view="live"]').click();
    await page.locator("#follow").click();
    await expect(page.locator("#view-subtitle")).toContainText("live-run");
    f.mutate((db) => db.exec("UPDATE workflow_runs SET revision = 20 WHERE run_id = 'live-run'"));
    await expect(page.locator("#inspector")).toContainText("20", { timeout: 6000 });
    expect(pageErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
    await expect(page.locator("#error")).toBeHidden();
});

test("remains usable in a narrow canvas and surfaces refresh failures", async ({ page }) => {
    await page.setViewportSize({ width: 650, height: 900 });
    await page.goto(studio.url);
    await expect(page.locator("#connection")).toContainText("Connected");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.route("**/api/snapshot*", (route) => route.fulfill({
        status: 500, contentType: "application/json", body: '{"error":"fixture unavailable"}',
    }));
    await expect(page.locator("#error")).toContainText("fixture unavailable", { timeout: 6000 });
    await expect(page.locator("#connection")).toContainText("Disconnected");
    await expect(page.locator("#graph .flow-node.task")).toHaveCount(1);
});

test("shows original nested YAML do-ers/reviewers and previews/exports without changing installed source", async ({ page }) => {
    await page.goto(studio.url);
    await expect(page.locator("#connection")).toContainText("Connected");
    await page.locator("#workflow").selectOption("lab-delivery");
    await page.locator('[data-view="design"]').click();
    await expect(page.locator("#graph .phase-node")).toHaveCount(14);
    await page.locator('[data-phase="DevOpsWorkLoop"]').click();
    await expect(page.locator("#inspector")).toContainText("DevOps Engineer");
    await expect(page.locator("#inspector")).toContainText("cloud-deployed system passes tests");
    await page.locator('[data-phase="AssignedWorkUIDeveloperLoop"]').click();
    await expect(page.locator("#inspector")).toContainText("Developer");
    await expect(page.locator("#inspector")).toContainText("Designer");
    await expect(page.locator("#inspector")).toContainText("SprintLoop");
    await page.locator("#phase-title").fill("UI do-er draft");
    await page.getByRole("button", { name: "Preview title change" }).click();
    await expect(page.locator("#graph")).toContainText("UI do-er draft");
    const event = page.waitForEvent("download");
    await page.locator("#export-source").click();
    const download = await event;
    expect(download.suggestedFilename()).toBe("loops.draft.yml");
    expect(await readFile(await download.path(), "utf8")).toContain("UI do-er draft");
    expect(await readFile(path.join(f.project, "gh-dynamic-workflows", "loops.yml"), "utf8")).toBe(yamlSource);
    await expect(page.locator("#error")).toBeHidden();
});

test("opens compact outcome details without page scrolling and refreshes exact model/token evidence", async ({ page }) => {
    const local = await fixture();
    let instance;
    try {
        const log = path.join(path.dirname(local.dbFile), "events.jsonl");
        const events = [
            { type: "subagent.started", agentId: "planner", data: { toolCallId: "planner", workflowRunId: "live-run" } },
            { type: "subagent.started", agentId: "a1", data: { toolCallId: "a1", workflowRunId: "live-run" } },
            workEvent("plan", "planner", { status: "complete", summary: "Assigned screen implementation.", artifact: {
                SprintPlan: { tasks: [{ id: "s1-ui", title: "Customer Activity Screen" }] },
            } }),
            usageEvent("u1", "a1", 1000, 700, 200, "actual-model-a"),
            usageEvent("u2", "a1", 2000, 1500, 300, "actual-model-b"),
            workEvent("result", "a1", { agree: false, feedback: "Reviewer found a processing bug in s1-ui. Filtering loses the selected customer." }),
        ];
        await writeFile(log, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
        local.mutate((db) => db.exec(`UPDATE workflow_agents SET status='completed',
            label='yaml:sprint/1/S1/task/s1-ui/AssignedWorkUIDeveloperLoop:reviewer:Critic:2'
            WHERE run_id='live-run'`));
        instance = await startStudio(local.project, { sessionsRoot: local.sessionsRoot });
        await page.goto(instance.url);
        const task = page.locator('[data-task="agent:a1"]');
        await expect(task).toContainText("Customer Activity Screen");
        await expect(task).toContainText("actual-model-a / actual-model-b");
        await expect(task.locator(".task-usage")).toContainText("Input3,000Cached2,200Output500");
        const before = await page.evaluate(() => window.scrollY);
        await task.click();
        await expect(page.locator("#task-drawer")).toBeVisible();
        expect(await page.evaluate(() => window.scrollY)).toBe(before);
        await expect(page.locator("#task-drawer-title")).toHaveText("Customer Activity Screen");
        await expect(page.locator("#task-details")).toContainText("Reviewer found a processing bug in Customer Activity Screen.");
        await expect(page.locator("#task-details")).toContainText("Changes requested");
        await expect(page.locator("#task-details")).toContainText("Critic reviewer");
        await expect(page.locator("#task-details .evidence-summary")).not.toContainText("S1");
        await page.locator("#task-details details summary").click();
        await expect(page.locator("#task-details details")).toHaveAttribute("open", "");
        await appendFile(log, JSON.stringify(usageEvent("u3", "a1", 50, 0, 50, "actual-model-b")) + "\n");
        await expect(page.locator("#task-details")).toContainText("3,050", { timeout: 6000 });
        await expect(page.locator("#task-details details")).toHaveAttribute("open", "");
        await expect(page.locator("#task-details details summary")).toBeFocused();
        await expect(page.locator("#task-drawer")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator("#task-drawer")).not.toBeVisible();
        await expect(task).toBeFocused();
        await page.setViewportSize({ width: 390, height: 800 });
        await task.click();
        await expect(page.locator("#task-drawer")).toBeInViewport();
        expect(await page.locator("#task-drawer").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        await page.locator("#close-task").click();
        await expect(page.locator("#task-drawer")).not.toBeVisible();
        await expect(page.locator("#error")).toBeHidden();
    } finally {
        await page.close();
        await instance?.close();
        await local.cleanup();
    }
});

test("grows an observed-only parallel flow, keeps task cards live, queries evidence and uses both palettes", async ({ page }) => {
    const local = await fixture();
    let instance;
    try {
        const start = Date.now() - 9000;
        local.mutate((db) => {
            db.prepare(`UPDATE workflow_agents SET label = 'Planner: Prepare implementation tasks', agent_type = 'planner',
                status = 'completed', started_at_ms = ?, completed_at_ms = ? WHERE run_id = 'live-run'`).run(start, start + 1000);
            const insert = db.prepare("INSERT INTO workflow_agents VALUES (?,?,?,?,?,?,?,?,?,?,?)");
            insert.run("live-run", "ui", "p1", "sprint/1/task/navigation/AssignedWorkUIDeveloperLoop:doer:1",
                "workflow-doer", "running", null, null, start + 1100, null, 0);
            insert.run("live-run", "api", "p1", "Developer: Implement API contract",
                "developer", "running", null, null, start + 1200, null, 0);
        });

        instance = await startStudio(local.project, { sessionsRoot: local.sessionsRoot });
        await page.goto(`${instance.url}?scoutTheme=light`);
        await expect(page.locator("#graph .flow-node.task")).toHaveCount(3);
        await expect(page.locator("#graph .flow-node.start")).toHaveCount(1);
        await expect(page.locator("#graph .flow-node.end")).toHaveCount(0);
        await expect(page.locator("#graph")).not.toContainText("Review");
        await expect(page.locator("#graph .flow-edge")).toHaveCount(3);
        await expect(page.locator("#graph .task.success")).toHaveCount(1);
        await expect(page.locator("#graph .task.waiting")).toHaveCount(2);
        const ui = page.locator('[data-task="agent:ui"]');
        const api = page.locator('[data-task="agent:api"]');
        expect((await ui.boundingBox()).y).toBe((await api.boundingBox()).y);
        const box = await ui.boundingBox();
        expect(box.width).toBe(box.height);
        await expect(ui).toContainText("Assigned Work UI Developer doer");
        await ui.click();
        await expect(page.locator("#task-details")).toContainText("workflow-doer");
        await expect(page.locator("#task-drawer")).toBeInViewport();
        await page.locator("#close-task").click();
        await page.locator("#team-question").fill("Who is working?");
        await page.locator("#team-query button").click();
        await expect(page.locator("#team-answer")).toContainText("Implement API contract");
        await expect(page.locator("#team-answer")).toContainText("NOT AN AGENT REPLY");
        await ui.click();
        local.mutate((db) => {
            db.prepare("UPDATE workflow_agents SET status = 'completed', completed_at_ms = ? WHERE run_id = 'live-run' AND agent_id IN ('ui','api')").run(start + 2000);
            db.prepare("INSERT INTO workflow_agents VALUES (?,?,?,?,?,?,?,?,?,?,?)")
                .run("live-run", "review", "p1", "Reviewer: Inspect implementation result", "reviewer", "running",
                    null, null, start + 2100, null, 0);
        });
        await expect(page.locator("#graph .flow-node.task")).toHaveCount(4, { timeout: 6000 });
        await expect(page.locator("#graph .flow-edge")).toHaveCount(5);
        await expect(ui).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("#task-details dd").filter({ hasText: /^completed$/ })).toHaveCount(1);
        await expect(page.locator("#team-answer")).toContainText("Inspect implementation result");
        await expect(page.locator("#team-answer")).not.toContainText("Implement API contract");
        await page.keyboard.press("Escape");
        local.mutate((db) => db.exec(`UPDATE workflow_runs SET status = 'completed',
            result_json = '{"status":"needs-input","reason":"Choose a release target"}' WHERE run_id = 'live-run'`));
        await expect(page.locator("#graph .end.waiting")).toContainText("needs-input", { timeout: 6000 });
        await page.locator("#graph .end").click();
        await expect(page.locator("#task-details")).toContainText("Choose a release target");
        await page.keyboard.press("Escape");
        await page.locator("#team-question").fill("Why did it stop?");
        await page.locator("#team-query button").click();
        await expect(page.locator("#team-answer")).toContainText("Choose a release target");
        local.mutate((db) => db.exec(`UPDATE workflow_runs SET result_json = '{"status":"success"}' WHERE run_id = 'live-run'`));
        await expect(page.locator("#graph .end.success")).toHaveCount(1, { timeout: 6000 });
        local.mutate((db) => db.exec(`UPDATE workflow_runs SET status = 'error', result_json = NULL, error = 'Validation failed' WHERE run_id = 'live-run';
            UPDATE workflow_agents SET status = 'error' WHERE run_id = 'live-run' AND agent_id = 'review'`));
        await expect(page.locator("#graph .end.error")).toHaveCount(1, { timeout: 6000 });
        await expect(page.locator("#graph .task.error")).toHaveCount(1);
        await expect(page.locator("#stop-notice")).toContainText("Validation failed");
        await expect(page.locator("body")).toHaveCSS("background-color", "rgb(245, 238, 223)");
        await expect(page.locator("#theme")).toHaveText("Cream / espresso");
        await page.locator("#theme").click();
        await expect(page.locator("#theme")).toHaveText("Midnight blue / copper");
        await expect(page.locator("body")).toHaveCSS("background-color", "rgb(12, 23, 41)");
        expect(await page.locator("body").evaluate((node) => getComputedStyle(node).getPropertyValue("--cp-accent").trim())).toBe("#dfa477");
        await page.setViewportSize({ width: 650, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await expect(page.locator("#error")).toBeHidden();
    } finally {
        await page.close();
        await instance?.close();
        await local.cleanup();
    }
});
