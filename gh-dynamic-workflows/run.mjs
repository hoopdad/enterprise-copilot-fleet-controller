import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import { mkdir, open, readFile, writeFile, appendFile } from "node:fs/promises";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const message = (value) => typeof value === "string" ? value : value?.message ?? JSON.stringify(value);
const compact = (value, length = 420) => {
    const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return text.length > length ? `${text.slice(0, length)}...` : text;
};

export function parseEnvelope(text) {
    const record = JSON.parse(text.trim().split(/\r?\n/).at(-1));
    return record?.type === "workflow.result" ? record.data?.run : record;
}

export function parseOptions(argv) {
    const options = { workflow: "lab-delivery", input: "delivery-input.json", addDirs: [], checkOnly: false };
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === "--check-only") { options.checkOnly = true; continue; }
        if (!["--workflow", "--input", "--add-dir"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
        const value = argv[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
        if (flag === "--add-dir") options.addDirs.push(value);
        else options[flag.slice(2)] = value;
    }
    return options;
}

export function describeOutcome(envelope, result) {
    if (!object(envelope) || !["completed", "error", "halted", "paused", "cancelled"].includes(envelope.status)) {
        throw new Error("Copilot did not emit a recognized workflow run envelope");
    }
    if (envelope.status !== "completed") {
        return {
            status: envelope.status, sdkStatus: envelope.status, runId: envelope.runId,
            reason: message(envelope.failure ?? envelope.error) ?? `SDK run ended as ${envelope.status}.`,
            nextAction: "Inspect the saved CLI logs and durable run before continuing; do not blindly repeat uncertain external operations.",
            exitCode: envelope.status === "cancelled" ? 130 : envelope.status === "paused" ? 3 : 1,
        };
    }
    if (!object(result) || !["completed", "limit-reached", "needs-input", "blocked"].includes(result.status)) {
        throw new Error("SDK completed, but its result has no recognized application outcome");
    }
    const stop = result.outcomes?.findLast((outcome) => outcome.status === result.status &&
        (!result.stoppedKey || outcome.key === result.stoppedKey));
    return {
        status: result.status, sdkStatus: envelope.status, runId: envelope.runId ?? result.runId,
        stoppedAt: result.stoppedAt ?? stop?.loopId, rounds: result.rounds ?? stop?.rounds,
        stopCause: result.stopCause ?? stop?.stopCause, progress: result.progress ?? stop?.progress,
        summary: result.summary ?? stop?.summary ?? (result.status === "completed" ? "Original YAML loops completed." : undefined),
        reason: result.reason ?? stop?.reason ?? stop?.feedback?.transportIssue ?? stop?.feedback?.owner?.summary,
        reviewers: (stop?.feedback?.reviews ?? stop?.reviews ?? []).filter((review) => !review.agree),
        nextAction: result.nextAction ?? stop?.nextAction ?? (result.status === "completed" ? undefined
            : "Continue from the existing work and the reported unresolved feedback in a new run."),
        completedSprints: result.completedSprints, exitCode: result.status === "completed" ? 0 : 2,
    };
}

export function formatOutcome(outcome, files) {
    return [
        `Workflow: ${compact(outcome.status)}${outcome.sdkStatus ? ` (SDK: ${compact(outcome.sdkStatus)})` : ""}`,
        outcome.runId && `Run: ${compact(outcome.runId)}`,
        outcome.stoppedAt && `Stopped at: ${compact(outcome.stoppedAt)}${outcome.rounds ? `, round ${outcome.rounds}` : ""}`,
        outcome.summary && `Summary: ${compact(outcome.summary)}`,
        outcome.reason && `Reason: ${compact(outcome.reason)}`,
        ...(outcome.reviewers ?? []).slice(0, 3).map((review) => `Disagreement - ${compact(review.role, 80)}: ${compact(review.feedback, 240)}`),
        outcome.nextAction && `Next: ${compact(outcome.nextAction)}`,
        `Full outcome: ${files.outcome}`,
        outcome.sdkStatus === "completed" && `Application result: ${files.result}`,
        `CLI logs: ${files.stdout} ; ${files.stderr}`,
    ].filter(Boolean).join("\n") + "\n";
}

export async function runWorkflow(options, { cwd = process.cwd(), spawn = spawnChild, write = (text) => process.stdout.write(text) } = {}) {
    const input = path.resolve(cwd, options.input);
    const args = JSON.parse(await readFile(input, "utf8"));
    if (!object(args) || typeof args.projectRoot !== "string" || !args.projectRoot.trim()) {
        throw new Error("Workflow input requires a nonempty projectRoot");
    }
    if (options.checkOnly) {
        write(`Configuration loaded: ${input}\nWorkflow: ${options.workflow}\nNo workflow, cloud command or experiment was started.\n`);
        return { status: "checked", exitCode: 0 };
    }
    const directory = path.join(cwd, "gh-dynamic-workflows", ".delivery-runs", randomUUID());
    await mkdir(directory, { recursive: true });
    const files = Object.fromEntries(["stdout", "stderr", "result", "outcome"].map((key) =>
        [key, path.join(directory, key === "stdout" || key === "stderr" ? `${key}.log` : `${key}.json`)]));
    await writeFile(path.join(directory, "launch.json"), JSON.stringify({ workflow: options.workflow, input, startedAt: new Date().toISOString() }, null, 2));
    write(`Running ${options.workflow}. Full logs: ${directory}\n`);
    let outcome;
    let processOutcome, diagnostic;
    try {
        const stdout = await open(files.stdout, "wx");
        try {
            const stderr = await open(files.stderr, "wx");
            try {
                const cliArgs = [
                    "--experimental", "--allow-all-tools",
                    ...options.addDirs.flatMap((directory) => ["--add-dir", path.resolve(cwd, directory)]),
                    "workflow", "run", options.workflow, "--args", `@${input}`,
                    "--silent", "--output-format", "json", "--result-file", files.result,
                ];
                const child = spawn("copilot", cliArgs, {
                    cwd, stdio: ["inherit", stdout.fd, stderr.fd],
                    env: { ...process.env, GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: "true" },
                });
                const stopped = processOutcome = await new Promise((resolve, reject) => {
                    child.once("error", reject);
                    child.once("close", (code, signal) => resolve({ code, signal }));
                });
                diagnostic = (await readFile(files.stderr, "utf8")).trim().split(/\r?\n/).slice(-3).join(" ");
                const envelope = parseEnvelope(await readFile(files.stdout, "utf8"));
                const result = envelope.status === "completed" ? JSON.parse(await readFile(files.result, "utf8")) : undefined;
                outcome = describeOutcome(envelope, result);
                if (stopped.code !== 0) {
                    outcome.cliExitCode = stopped.code;
                    outcome.signal = stopped.signal;
                    if (stopped.signal || outcome.sdkStatus === "completed") {
                        outcome.status = stopped.signal ? "interrupted" : "cli-error";
                        outcome.reason = `Copilot exited with ${stopped.signal ?? `code ${stopped.code}`}. ${outcome.reason ?? outcome.summary ?? ""}`;
                        outcome.exitCode = stopped.signal === "SIGINT" ? 130 : 1;
                    }
                }
            } finally { await stderr.close(); }
        } finally { await stdout.close(); }
    } catch (error) {
        const detail = `${processOutcome && processOutcome.code !== 0 ? `Copilot exited with ${processOutcome.signal ?? `code ${processOutcome.code}`}. ` : ""}Launcher error: ${error.message}`;
        await appendFile(files.stderr, `${detail}\n`);
        const interrupted = processOutcome?.signal === "SIGINT" || processOutcome?.code === 130;
        outcome = {
            status: interrupted ? "interrupted" : "error", reason: `${detail}${diagnostic ? ` CLI: ${diagnostic}` : ""}`,
            nextAction: "Inspect the saved CLI logs. No successful workflow outcome was established.",
            exitCode: interrupted ? 130 : 1,
        };
    }
    await writeFile(files.outcome, JSON.stringify({ ...outcome, files, finishedAt: new Date().toISOString() }, null, 2));
    write(formatOutcome(outcome, files));
    return { ...outcome, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try { process.exitCode = (await runWorkflow(parseOptions(process.argv.slice(2)))).exitCode; }
    catch (error) { process.stderr.write(`Workflow launcher failed: ${error.message}\n`); process.exitCode = 1; }
}
