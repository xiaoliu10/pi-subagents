import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runSubagent, type SubagentRunConfig } from "../../src/runs/background/subagent-runner.ts";
import { createFakeChildSessions } from "../support/fake-child-session.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";
import type { ChildSession, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";

let previousAgentDir: string | undefined;
let agentDir: string;

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-live-child-agent-"));
	fs.chmodSync(agentDir, 0o700);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	fs.rmSync(agentDir, { recursive: true, force: true });
});

function baseConfig(root: string, id: string, steps: SubagentRunConfig["steps"]): SubagentRunConfig {
	const asyncDir = path.join(root, `${id}-async`);
	fs.mkdirSync(asyncDir, { recursive: true });
	return {
		id,
		steps,
		resultPath: path.join(root, `${id}-result.json`),
		cwd: root,
		asyncDir,
		sessionId: `session-${id}`,
		artifactConfig: { enabled: false },
		share: false,
		placeholder: "{previous}",
	};
}

function readStatus(root: string, id: string): AsyncStatus {
	return JSON.parse(fs.readFileSync(path.join(root, `${id}-async`, "status.json"), "utf-8")) as AsyncStatus;
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let ok = false;
		try {
			ok = predicate();
		} catch {
			// status.json can be mid-rename; keep polling.
		}
		if (ok) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`timed out waiting for ${label}`);
}

describe("async status exposes the live child while it runs", () => {
	it("publishes the child's session file and current tool to status.json before the child settles", { timeout: 20_000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-live-child-run-"));
		const queue = path.join(root, "queue");
		fs.mkdirSync(queue, { recursive: true });
		const liveSessionFile = path.join(root, "live-child", "session.jsonl");
		fs.mkdirSync(path.dirname(liveSessionFile), { recursive: true });
		fs.writeFileSync(liveSessionFile, "session-header\n", "utf-8");
		const releaseTool = path.join(root, "release-tool");
		const releaseFinish = path.join(root, "release-finish");
		fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({
			steps: [
				{ waitForPath: releaseTool, jsonl: [{ type: "tool_execution_start", toolName: "bash", args: { command: "echo live" } }] },
				{
					waitForPath: releaseFinish,
					jsonl: [
						{ type: "tool_execution_end", toolName: "bash" },
						{
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "live child finished" }],
								model: "mock/test-model",
								stopReason: "stop",
								usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
							},
						},
					],
				},
			],
		}));
		const fake = createFakeChildSessions(() => queue);
		// Real file-backed sessions expose their transcript path the moment the session exists, even for
		// directory storage; the scripted child leaves the directory empty, so the wrapper stands in for it.
		const factory: ChildSessionFactory = {
			async create(launch) {
				const session = await fake.factory.create(launch);
				return Object.create(session, { sessionFile: { enumerable: true, get: () => liveSessionFile } }) as ChildSession;
			},
			async dispose() { await fake.factory.dispose(); },
		};
		const config = baseConfig(root, "live-child", [{ agent: "worker", task: "stream live" }]);
		try {
			const run = runSubagent(config, factory);
			await waitFor("steps[0].sessionFile in status.json", () => readStatus(root, "live-child").steps?.[0]?.sessionFile === liveSessionFile);
			assert.equal(fake.sessions.length, 1, "the child session must be live while status.json already names its transcript");
			assert.ok(fs.existsSync(liveSessionFile), "the published session file must exist on disk while the child runs");
			const sizeBefore = fs.statSync(liveSessionFile).size;
			fs.appendFileSync(liveSessionFile, "turn-1\n", "utf-8");
			assert.ok(fs.statSync(liveSessionFile).size > sizeBefore, "the transcript keeps growing at the published path");
			fs.writeFileSync(releaseTool, "", "utf-8");
			await waitFor("steps[0].currentTool in status.json", () => readStatus(root, "live-child").steps?.[0]?.currentTool === "bash");
			assert.ok(readStatus(root, "live-child").steps?.[0]?.currentToolStartedAt, "the current tool must carry its start time");
			fs.writeFileSync(releaseFinish, "", "utf-8");
			await run;
			const settled = readStatus(root, "live-child");
			assert.equal(settled.steps?.[0]?.status, "complete");
			assert.equal(settled.steps?.[0]?.sessionFile, liveSessionFile, "the terminal step keeps the session file");
			assert.equal(settled.steps?.[0]?.currentTool, undefined, "the terminal step clears the live tool");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
