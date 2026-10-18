import { parse } from "acorn";
import { readFile, readdir, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const fingerprint = (text) => createHash("sha256").update(text).digest("hex");

export async function inside(root, relative) {
    const boundary = await realpath(root);
    const candidate = path.resolve(boundary, relative);
    const resolved = await realpath(candidate);
    const relation = path.relative(boundary, resolved);
    if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
        throw new Error(`Source path escapes selected project: ${relative}`);
    }
    return resolved;
}

async function readSource(root, relative) {
    const file = await inside(root, relative);
    if ((await lstat(file)).size > MAX_SOURCE_BYTES) throw new Error(`Source exceeds 2 MiB: ${relative}`);
    return readFile(file, "utf8");
}

function visit(node, callback) {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string") callback(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === "loc") continue;
        if (Array.isArray(value)) value.forEach((item) => visit(item, callback));
        else if (value && typeof value === "object") visit(value, callback);
    }
}

export function analyzeSource(source, file = "workflow.mjs") {
    if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
        throw new Error("Source must be a string of at most 2 MiB");
    }
    if (/\.ya?ml$/i.test(file)) return analyzeLoopYaml(source, file);
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
    const bindings = new Map();
    for (const statement of ast.body) {
        const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
        if (declaration?.type === "VariableDeclaration") {
            for (const item of declaration.declarations) {
                if (item.id.type === "Identifier") bindings.set(item.id.name, item.init);
            }
        }
    }
    function value(node, depth = 0) {
        if (!node || depth > 12) return undefined;
        if (node.type === "Literal") return node.value;
        if (node.type === "Identifier") return value(bindings.get(node.name), depth + 1);
        if (node.type === "ArrayExpression") return node.elements.map((item) => value(item, depth + 1));
        if (node.type === "ObjectExpression") {
            return Object.fromEntries(node.properties.filter((item) => item.type === "Property" && !item.computed)
                .map((item) => [item.key.name ?? item.key.value, value(item.value, depth + 1)]));
        }
        if (node.type === "CallExpression" && node.callee.type === "MemberExpression" &&
            node.callee.property.name === "map" && node.arguments[0]?.type === "ArrowFunctionExpression") {
            const items = value(node.callee.object, depth + 1);
            const fn = node.arguments[0];
            const body = fn.body;
            if (Array.isArray(items) && fn.params.length === 1 && fn.params[0].type === "Identifier" &&
                body.type === "ObjectExpression") {
                return items.map((item) => Object.fromEntries(body.properties
                    .filter((property) => property.type === "Property" && !property.computed)
                    .map((property) => [property.key.name ?? property.key.value,
                        property.value.type === "Identifier" && property.value.name === fn.params[0].name
                            ? item : value(property.value, depth + 1)])));
            }
        }
        return undefined;
    }
    const candidates = [...bindings];
    const definitionNames = new Set(["defineWorkflow"]);
    for (const statement of ast.body) {
        if (statement.type !== "ImportDeclaration") continue;
        for (const specifier of statement.specifiers) {
            if (specifier.type === "ImportSpecifier" && specifier.imported.name === "defineWorkflow") {
                definitionNames.add(specifier.local.name);
            }
        }
    }
    visit(ast, (call) => {
        if (call.type !== "CallExpression" || call.callee.type !== "Identifier" ||
            !definitionNames.has(call.callee.name) || call.arguments[0]?.type !== "ObjectExpression") return;
        let meta = call.arguments[0].properties.find((property) => property.type === "Property" &&
            (property.key.name ?? property.key.value) === "meta")?.value;
        const seen = new Set();
        while (meta?.type === "Identifier" && !seen.has(meta.name)) {
            seen.add(meta.name);
            meta = bindings.get(meta.name);
        }
        if (meta?.type === "ObjectExpression") {
            const owner = [...bindings].find(([, node]) => node === call)?.[0] ?? `inline:${call.loc.start.line}`;
            candidates.push([owner, meta]);
        }
    });
    const workflows = [];
    const registered = new Set();
    for (const [binding, node] of candidates) {
        if (node?.type !== "ObjectExpression") continue;
        if (registered.has(node.start)) continue;
        const metadata = value(node);
        if (typeof metadata?.name !== "string" || !Array.isArray(metadata.phases)) continue;
        registered.add(node.start);
        const phaseProperty = node.properties.find((property) => property.key?.name === "phases" || property.key?.value === "phases");
        const resolve = (expression) => {
            let current = expression;
            for (let i = 0; i < 12 && current?.type === "Identifier"; i++) current = bindings.get(current.name);
            return current;
        };
        let phaseExpression = resolve(phaseProperty?.value);
        if (phaseExpression?.type === "CallExpression") {
            const fn = phaseExpression.arguments[0];
            const title = fn?.body?.type === "ObjectExpression"
                ? fn.body.properties.find((property) => property.type === "Property" &&
                    (property.key.name ?? property.key.value) === "title")?.value : null;
            phaseExpression = fn?.type === "ArrowFunctionExpression" && title?.type === "Identifier" &&
                title.name === fn.params[0]?.name ? resolve(phaseExpression.callee.object) : null;
        }
        const phaseLiterals = phaseExpression?.type === "ArrayExpression" ? phaseExpression.elements.map((item) =>
            item?.type === "ObjectExpression" ? item.properties.find((property) => property.type === "Property" &&
                (property.key.name ?? property.key.value) === "title")?.value : item)
            .filter((item) => item?.type === "Literal" && typeof item.value === "string") : [];
        workflows.push({
            name: metadata.name, description: metadata.description ?? "", binding, file,
            argsSchema: metadata.argsSchema ?? null, limits: metadata.limits ?? null,
            line: node.loc.start.line,
            phases: metadata.phases.map((phase, index) => {
                const title = typeof phase === "string" ? phase : phase?.title;
                if (typeof title !== "string") throw new Error(`Cannot statically resolve phase ${index + 1} in ${binding}`);
                const literalIndex = phaseLiterals.findIndex((item) => item.value === title);
                const literal = literalIndex < 0 ? null : phaseLiterals.splice(literalIndex, 1)[0];
                return {
                    id: `design-${index}`, title, detail: phase?.detail ?? "",
                    line: literal?.loc.start.line ?? node.loc.start.line,
                    sourceStart: literal?.start ?? null, sourceEnd: literal?.end ?? null,
                };
            }),
        });
    }
    const operations = [];
    visit(ast, (node) => {
        if (node.type !== "CallExpression") return;
        const callee = node.callee;
        const method = callee.type === "MemberExpression" ? callee.property.name : callee.name;
        if (!["phase", "parallel", "pipeline", "step", "pause", "agent"].includes(method)) return;
        const receiver = callee.object?.name;
        if (callee.type === "MemberExpression" && receiver !== "ctx" && receiver !== "context") return;
        if (callee.type === "Identifier" && method !== "phase") return;
        operations.push({
            kind: method, line: node.loc.start.line, endLine: node.loc.end.line,
            label: typeof value(node.arguments[0]) === "string" ? value(node.arguments[0]) : null,
            expression: source.slice(node.start, Math.min(node.end, node.start + 240)),
        });
    });
    return { workflows, operations, imports: ast.body.filter((node) => node.type === "ImportDeclaration")
        .map((node) => node.source.value).filter((name) => name.startsWith(".")) };
}

function analyzeLoopYaml(source, file) {
    const document = parseDocument(source);
    if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("\n"));
    const steps = document.getIn(["workflows", "ReleaseLoop", "steps"], true);
    if (!Array.isArray(steps?.items) || !steps.items.length) throw new Error("YAML requires workflows.ReleaseLoop.steps");
    const phases = [], seen = new Set();
    const inspect = (nodes, parentId = null, depth = 0) => {
        for (const node of nodes.items) {
            const id = node.get?.("id"), title = node.get?.("name");
            if (typeof id !== "string" || typeof title !== "string" || seen.has(id)) throw new Error("YAML steps need unique ids and names");
            seen.add(id);
            const scalar = node.get("name", true);
            const range = scalar.range;
            const children = node.get("substeps", true);
            const owner = node.get("owner");
            const reviewers = node.get("reviewers", true)?.toJSON() ?? [];
            if (!children && (typeof owner !== "string" || !Array.isArray(reviewers) || !reviewers.length ||
                reviewers.some((role) => typeof role !== "string"))) throw new Error(`Loop ${id} needs a do-er and reviewers`);
            phases.push({
                id, title, parentId, depth, owner: owner ?? null, reviewers,
                detail: node.get("description") ?? "", completeWhen: node.get("completeWhen") ?? null,
                inputs: node.get("inputs", true)?.toJSON() ?? [], outputs: node.get("outputs", true)?.toJSON() ?? [],
                line: source.slice(0, range[0]).split("\n").length,
                sourceStart: range[0], sourceEnd: range[1],
            });
            if (children) {
                if (!Array.isArray(children.items)) throw new Error(`Invalid substeps in ${id}`);
                inspect(children, id, depth + 1);
            }
        }
    };
    inspect(steps);
    const description = document.getIn(["workflows", "ReleaseLoop", "description"]) ?? "YAML do-er/reviewer loops";
    return {
        workflows: ["autonomous-delivery", "lab-delivery"].map((name) => ({
            name, description, binding: `yaml:ReleaseLoop:${name}`, file, line: 1,
            argsSchema: null, limits: null, phases,
        })),
        operations: [], imports: [],
    };
}

export async function loadDesign(projectRoot) {
    const root = await realpath(projectRoot);
    const files = new Map();
    const warnings = [];
    const pending = [];
    try {
        const extensions = await readdir(await inside(root, ".github/extensions"), { withFileTypes: true });
        for (const extension of extensions) {
            if (extension.isDirectory()) pending.push(path.join(".github", "extensions", extension.name, "extension.mjs"));
        }
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        warnings.push("No project extensions directory found.");
    }
    // Installed delivery modules are also useful when their registration entry is disabled.
    for (const relative of ["gh-dynamic-workflows/workflow.mjs", "gh-dynamic-workflows/lab-workflow.mjs", "gh-dynamic-workflows/loops.yml"]) {
        try { await inside(root, relative); pending.push(relative); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const seen = new Set();
    while (pending.length) {
        const relative = path.normalize(pending.shift());
        if (seen.has(relative)) continue;
        seen.add(relative);
        if (seen.size > 128) throw new Error("Source import graph exceeds 128 modules");
        try {
            const source = await readSource(root, relative);
            const analysis = analyzeSource(source, relative);
            files.set(relative, { file: relative, source, hash: fingerprint(source), ...analysis });
            for (const specifier of analysis.imports) {
                if (path.extname(specifier) === ".mjs" || path.extname(specifier) === ".js") {
                    pending.push(path.normalize(path.join(path.dirname(relative), specifier)));
                }
            }
        } catch (error) { warnings.push(`${relative}: ${error.message}`); }
    }
    let contract = null;
    try {
        const source = await readSource(root, "docs/lab-flow.json");
        const data = JSON.parse(source);
        if (!Array.isArray(data.steps)) throw new Error("Flow contract must contain steps");
        contract = { file: "docs/lab-flow.json", ...data };
    } catch (error) { if (error.code !== "ENOENT") warnings.push(`Flow contract: ${error.message}`); }
    return {
        root, warnings, contract,
        files: [...files.values()].filter((file) => file.workflows.length || file.operations.length),
        workflows: [...files.values()].flatMap((file) => file.workflows),
        graphNotice: "JavaScript phases are a declaration outline. YAML indentation shows the actual release/sprint loop hierarchy and original roles, not a task dependency DAG. Dynamic assignments and run state resolve at runtime. Source is parsed, never imported or executed.",
    };
}
