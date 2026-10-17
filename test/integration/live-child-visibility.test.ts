import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { AsyncStatus, SubagentState } from "../../src/shared/types.ts";
import { makeMinimalCtx, makeAgent, createEventBus, events } from "../support/helpers.ts";
import { installAsyncExecutionHooks, available, createSubagentExecutor, ASYNC_DIR, tempDir, mockPi } from "../support/async-execution-fixture.ts";

async function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let value: T | undefined;
		try { value = probe(); } catch { /* status.json can be mid-rename; keep polling. */ }
		if (value !== undefined) return value;
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function readStatus(statusPath: string): AsyncStatus {
	return JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
}

describe("workflow exposes the live child's transcript and tool while running", { skip: !available }, () => {
	installAsyncExecutionHooks();
	it("publishes sessionFile and currentTool for a running child in the workflow status", async () => {
		const toolRelease = path.join(tempDir, "release-tool");
		const finishRelease = path.join(tempDir, "release-finish");
		mockPi.onCall({ matchArgIncludes: "Stream live activity", steps: [
			{ waitForPath: toolRelease, jsonl: [events.toolStart("bash", { command: "echo live" })] },
			{ waitForPath: finishRelease, jsonl: [events.toolEnd("bash"), events.assistantMessage("live child finished")] },
		] });
		mockPi.onCall({ matchArgIncludes: "Blocker wait", delay: 600, output: "blocker done" });
		const state: SubagentState = { baseCwd: tempDir, currentSessionId: "session-live", completionOwnerId: "owner-live",
			asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
			cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null,
			watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} },
		};
		const executor = createSubagentExecutor!({ pi: { events: createEventBus(), getSessionName: () => undefined }, state, config: {}, asyncByDefault: false,
			tempArtifactsDir: tempDir, getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
		const updates: Array<Record<string, any>> = [];
		const launch = await executor.execute("live-child-visibility", { async: true, workflowScript: `
			const child = await runs.run("child", { agent: "worker", task: "Stream live activity", async: true });
			await runs.run("blocker", { agent: "worker", task: "Blocker wait" });
			return child.runId;
		` }, new AbortController().signal, (update) => updates.push(structuredClone(update.details)), makeMinimalCtx(tempDir));
		assert.notEqual(launch.isError, true, launch.content[0]?.text);
		const workflowId = launch.details.asyncId!;
		const workflowStatusPath = path.join(ASYNC_DIR, workflowId, "status.json");
		const childRunId = await waitFor("child runId in workflow status", () => {
			const status = readStatus(workflowStatusPath);
			return status.steps?.[0]?.runId;
		});
		const childStatusPath = path.join(ASYNC_DIR, childRunId, "status.json");

		// Before any child event: the runner status already names the live transcript,
		// and the spawned child process materializes the file on disk as its session starts.
		const sessionFile = await waitFor("child steps[0].sessionFile", () => readStatus(childStatusPath).steps?.[0]?.sessionFile);
		assert.equal(typeof sessionFile, "string");
		await waitFor("the published transcript file on disk", () => fs.existsSync(sessionFile) ? true : undefined);
		assert.equal(readStatus(childStatusPath).state, "running");
		// The scripted child does not stream events into its transcript like a real pi child,
		// so simulate one of the child's transcript writes and confirm the published path serves it.
		const sizeBefore = fs.statSync(sessionFile).size;
		fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message_end", simulated: "child transcript write" })}\n`, "utf-8");
		assert.ok(fs.statSync(sessionFile).size > sizeBefore, "the published path must serve the growing transcript");

		// Release the tool start; the child step must show the live tool.
		fs.writeFileSync(toolRelease, "go");
		const childStep = await waitFor("child steps[0].currentTool", () => {
			const step = readStatus(childStatusPath).steps?.[0];
			return step?.currentTool === "bash" ? step : undefined;
		});
		assert.ok(childStep.currentToolStartedAt, "the child step must carry the tool start time");

		// The workflow-level view while everything is still running: persisted workflowChildren
		// and the streamed progress updates must expose the child with its live tool.
		const workflowRow = await waitFor("workflow children row with live tool", () => {
			const persisted = readStatus(workflowStatusPath).workflowChildren?.children
				?.find((child) => child.childId === "child" && child.activity?.currentTool === "bash");
			if (persisted) return persisted;
			return updates.flatMap((update) => update.workflowChildren?.children ?? [])
				.find((child) => child.childId === "child" && child.activity?.currentTool === "bash");
		});
		assert.equal(workflowRow.state, "running");
		assert.equal(workflowRow.runId, childRunId, "the live row must be tied to the child run");
		assert.equal(readStatus(workflowStatusPath).state, "running", "the workflow must still be running");

		fs.writeFileSync(finishRelease, "go");
		await waitFor("workflow completion", () => readStatus(workflowStatusPath).state === "complete" ? true : undefined, 30_000);
		const settledWorkflow = readStatus(workflowStatusPath);
		assert.equal(settledWorkflow.workflowChildren?.children.find((child) => child.childId === "child")?.state, "completed");
		const settledChild = readStatus(childStatusPath);
		assert.equal(settledChild.steps?.[0]?.status, "complete");
		assert.equal(settledChild.steps?.[0]?.currentTool, undefined, "the terminal step clears the live tool");
		assert.equal(settledChild.steps?.[0]?.sessionFile, sessionFile, "the terminal step keeps the transcript path");
	});
});
