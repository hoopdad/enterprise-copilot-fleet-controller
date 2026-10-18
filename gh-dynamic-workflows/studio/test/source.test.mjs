import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { analyzeSource, loadDesign, inside } from "../source.mjs";
import { fixture, SOURCE } from "./fixture.mjs";

test("resolves declared map phases without executing workflow source", () => {
    const result = analyzeSource(SOURCE);
    assert.deepEqual(result.workflows[0].phases.map((phase) => phase.title), ["Intake", "Build", "Review"]);
    assert.deepEqual(result.operations.map((operation) => operation.kind), ["phase", "parallel", "agent", "step"]);
    assert.equal(globalThis.__studioExecuted, undefined);
    assert.ok(result.workflows[0].phases.every((phase) => phase.line > 0));
    const phase = result.workflows[0].phases[1];
    assert.equal(SOURCE.slice(phase.sourceStart, phase.sourceEnd), '"Build"');
});

test("does not invent phases or execute computed metadata", () => {
    const result = analyzeSource(`const metadata = {name:"dynamic",phases:makePhases()};`);
    assert.equal(result.workflows.length, 0);
    assert.throws(() => analyzeSource("const ="), SyntaxError);
    assert.throws(() => analyzeSource("x".repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
});

test("handles direct object phases and ignores comments and string lookalikes", () => {
    const result = analyzeSource(`// ctx.pause("fake")
const text = 'ctx.agent("fake")';
export const meta = {name:"direct",phases:[{title:"One",detail:"First"},{title:"Two"}]};
ctx.pause("real");`);
    assert.equal(result.workflows[0].phases[0].detail, "First");
    assert.deepEqual(result.operations.map((operation) => operation.kind), ["pause"]);
});

test("recognizes standard inline defineWorkflow metadata and aliases without duplicating referenced constants", () => {
    const result = analyzeSource(`
import { defineWorkflow as define } from "@github/copilot-sdk/extension";
const registered = define({
    meta: { name: "inline", phases: [{title: "Review"}, {title: "Verify"}] },
    run: async ctx => { ctx.phase("Review"); }
});
const metadata = {name: "constant", phases: ["Plan"].map(title => ({title}))};
const other = defineWorkflow({meta: metadata, run: async ctx => {}});
`);
    assert.deepEqual(result.workflows.map((workflow) => workflow.name), ["constant", "inline"]);
    assert.equal(result.workflows[1].binding, "registered");
    assert.deepEqual(result.workflows[1].phases.map((phase) => phase.title), ["Review", "Verify"]);
});

test("graph edits target title literals, never descriptions or unrelated map inputs", () => {
    const source = `const m = {name:"direct", phases:[{title:"One",detail:"Two"},{title:"Two"}]};
const n = {name:"mapped", phases:["X"].map(value => ({title:"X"}))};`;
    const result = analyzeSource(source);
    const second = result.workflows[0].phases[1];
    assert.equal(second.sourceStart, source.lastIndexOf('"Two"'));
    assert.equal(result.workflows[1].phases[0].sourceStart, null);
});

test("loads project sources once through normalized relative imports and reads optional contract", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const design = await loadDesign(f.project);
    assert.equal(design.workflows.length, 1);
    assert.equal(design.contract.steps[0].id, "intake");
    assert.deepEqual(design.warnings, []);
    assert.equal(globalThis.__studioExecuted, undefined);
    await assert.rejects(inside(f.project, path.join("..", "other")), /escapes/);
});

test("import escapes and parse failures are explicit warnings, not executed fallbacks", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    await writeFile(path.join(f.project, ".github", "extensions", "example", "extension.mjs"),
        `import "../../../../outside.mjs";`);
    await writeFile(path.join(f.base, "outside.mjs"), 'throw new Error("MUST NOT RUN")');
    const design = await loadDesign(f.project);
    assert.ok(design.warnings.some((warning) => warning.includes("escapes")));
    assert.equal(design.workflows.length, 1);
});

test("rejects symlinked source files that escape selected root", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const outside = path.join(f.base, "outside");
    await mkdir(outside);
    try { await symlink(outside, path.join(f.project, "linked"), "junction"); }
    catch (error) { if (error.code === "EPERM") return t.skip("Symlink permission unavailable"); throw error; }
    await assert.rejects(inside(f.project, "linked"), /escapes/);
});

test("the source YAML exposes original nested roles and edits/export never execute or save it", async (t) => {
    const source = await readFile(new URL("../../loops.yml", import.meta.url), "utf8");
    const analysis = analyzeSource(source, "gh-dynamic-workflows/loops.yml");
    const lab = analysis.workflows.find((workflow) => workflow.name === "lab-delivery");
    assert.equal(lab.phases.length, 14);
    const work = lab.phases.find((phase) => phase.id === "AssignedWorkUIDeveloperLoop");
    assert.equal(work.parentId, "SprintLoop");
    assert.equal(work.depth, 1);
    assert.equal(work.owner, "Developer");
    assert.deepEqual(work.reviewers, ["Architect", "Designer", "Critic"]);
    const changed = source.slice(0, work.sourceStart) + JSON.stringify("UI draft only") + source.slice(work.sourceEnd);
    assert.equal(analyzeSource(changed, lab.file).workflows[0].phases.find((phase) => phase.id === work.id).title, "UI draft only");
    assert.ok(source.includes('name: "Assigned Work - UI Developer Loop"'));
    assert.throws(() => analyzeSource("workflows: {}", "loops.yml"), /ReleaseLoop/);
    const f = await fixture();
    t.after(f.cleanup);
    await mkdir(path.join(f.project, "gh-dynamic-workflows"), { recursive: true });
    await writeFile(path.join(f.project, "gh-dynamic-workflows", "loops.yml"), source);
    const design = await loadDesign(f.project);
    assert.ok(design.workflows.some((workflow) => workflow.name === "lab-delivery" && workflow.phases.length === 14));
});
