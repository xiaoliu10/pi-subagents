import assert from "node:assert/strict";
import { it } from "node:test";
import { workflowChildActivity, workflowChildProgress, workflowChildSummary, parseWorkflowChildSummary } from "../../src/workflows/workflow-child-summary.ts";
import type { AgentProgress } from "../../src/shared/types.ts";

const progress = { agent: "worker", status: "running", model: "provider/model", thinking: "high", currentTool: "read", currentToolStartedAt: 100, lastActivityAt: 120, durationMs: 20, toolCount: 1, turnCount: 2, tokens: 10, inputTokens: 8, outputTokens: 2, task: "private", currentToolArgs: "private", recentOutput: ["private"] } as AgentProgress;
const input = { parentToolCallId: "tool", workflowRunId: "wf", workflowState: "running" as const, inventoryComplete: false, trace: ["a", "b"].map((key) => ({ operation: "run" as const, key, state: "started" as const })) };

it("projects independent bounded snapshots by stable key and clears terminal activity", () => {
	const snapshots = new Map([["b", workflowChildProgress(progress)], ["a", workflowChildProgress({ ...progress, currentTool: "bash", toolCount: 9 })]]);
	const summary = workflowChildSummary({ ...input, progress: snapshots });
	assert.deepEqual(summary.children.map((row) => [row.childId, row.activity?.currentTool, row.activity?.toolCount]), [["a", "bash", 9], ["b", "read", 1]]);
	assert.equal(summary.children[0].model, progress.model);
	assert.equal(summary.children[0].thinking, "high");
	assert.equal(JSON.stringify(summary).includes("private"), false);
	assert.deepEqual(parseWorkflowChildSummary(summary), summary);
	snapshots.set("a", workflowChildProgress({ ...progress, currentTool: undefined, currentToolStartedAt: undefined }));
	assert.equal(workflowChildSummary({ ...input, progress: snapshots }).children[0].activity?.currentTool, undefined);
	assert.equal(summary.children[0].activity?.currentTool, "bash", "published snapshots stay immutable");
	assert.ok(workflowChildSummary({ ...input, inventoryComplete: true, workflowState: "failed", progress: snapshots }).children.every((row) => row.activity === undefined));
});

it("keeps launch receipts running when the workflow inventory closes successfully or with an error", () => {
	for (const workflowState of ["completed", "failed", "stopped"] as const) {
		const summary = workflowChildSummary({ ...input, workflowState, inventoryComplete: true,
			children: [{ key: "a", state: "running", ok: false, runId: "child-a", output: "", artifactPaths: [] }],
		});
		assert.equal(summary.children.find((row) => row.childId === "a")?.state, "running");
		assert.equal(summary.children.find((row) => row.childId === "b")?.state, workflowState === "stopped" ? "stopped" : "failed");
	}
});

it("bounds UTF-8 and JSON bytes and rejects malformed activity strictly", () => {
	assert.equal(workflowChildActivity({ currentTool: "界".repeat(86) }).currentTool, undefined);
	assert.equal(workflowChildActivity({ currentTool: "界".repeat(85) }).currentTool?.length, 85);
	const activity = workflowChildActivity({ ...progress, currentTool: "\u0000".repeat(256), tokens: Number.MAX_VALUE });
	assert.ok(Buffer.byteLength(JSON.stringify(activity)) < 2048);
	assert.deepEqual(workflowChildActivity({ tokens: NaN, toolCount: -1, durationMs: Infinity }), {});
	const summary = workflowChildSummary({ ...input, progress: new Map([["a", workflowChildProgress(progress)]]) });
	for (const invalid of [null, [], { tokens: -1 }, { tokens: Infinity }, { tokens: "1" }, { currentTool: "界".repeat(86) }, { recentOutput: [] }, { currentToolArgs: "secret" }]) {
		assert.throws(() => parseWorkflowChildSummary({ ...summary, children: [{ ...summary.children[0], activity: invalid }] }), /activity/);
	}
	assert.throws(() => parseWorkflowChildSummary({ ...summary, children: [{ ...summary.children[0], state: "completed" }] }), /running state/);
});

it("carries the live step session file and running activity into child rows", () => {
	const steps = [{
		workflowKey: "a",
		agent: "worker",
		status: "running" as const,
		sessionFile: "/sessions/child-a.jsonl",
		currentTool: "bash",
		currentToolStartedAt: 100,
		lastActivityAt: 150,
		toolCount: 3,
		turnCount: 2,
		tokens: { input: 8, output: 2, total: 10 },
	}];
	const summary = workflowChildSummary({ ...input, steps });
	const row = summary.children.find((child) => child.childId === "a");
	assert.equal(row?.sessionFile, "/sessions/child-a.jsonl");
	assert.equal(row?.activity?.currentTool, "bash");
	assert.equal(row?.activity?.currentToolStartedAt, 100);
	assert.equal(row?.activity?.lastActivityAt, 150);
	assert.equal(row?.activity?.toolCount, 3);
	assert.equal(row?.activity?.turnCount, 2);
	assert.equal(row?.activity?.tokens, 10);
	assert.equal(row?.activity?.inputTokens, 8);
	assert.equal(row?.activity?.outputTokens, 2);
	assert.deepEqual(parseWorkflowChildSummary(summary), summary);
});

it("keeps the step session file on terminal child rows but drops running activity", () => {
	const summary = workflowChildSummary({ ...input, inventoryComplete: true, workflowState: "completed", steps: [{
		workflowKey: "a",
		agent: "worker",
		status: "completed" as const,
		sessionFile: "/sessions/child-a.jsonl",
		currentTool: "bash",
		currentToolStartedAt: 100,
		toolCount: 3,
		turnCount: 2,
	}]});
	const row = summary.children.find((child) => child.childId === "a");
	assert.equal(row?.state, "completed");
	assert.equal(row?.sessionFile, "/sessions/child-a.jsonl");
	assert.equal(row?.activity, undefined);
	assert.deepEqual(parseWorkflowChildSummary(summary), summary);
});

it("keeps the result session file on child-result rows and preserves a live file across result overwrite", () => {
	const steps = [{ workflowKey: "a", agent: "worker", status: "running" as const, sessionFile: "/sessions/child-a.jsonl" }];
	const children = [{ key: "a", state: "completed" as const, ok: true, output: "done", artifactPaths: [], results: [{ sessionFile: "/sessions/from-result.jsonl" }] }];
	const summary = workflowChildSummary({ ...input, inventoryComplete: true, workflowState: "completed", steps, children: children as never });
	const row = summary.children.find((child) => child.childId === "a");
	assert.equal(row?.state, "completed");
	assert.equal(row?.sessionFile, "/sessions/from-result.jsonl", "a result session file wins over the live step value");
	const withoutResult = workflowChildSummary({ ...input, inventoryComplete: true, workflowState: "completed", steps, children: [{ key: "a", state: "completed" as const, ok: true, output: "done", artifactPaths: [] }] });
	assert.equal(withoutResult.children.find((child) => child.childId === "a")?.sessionFile, "/sessions/child-a.jsonl", "the live step value survives the result overwrite when the result has no session");
});

it("rejects malformed sessionFile fields on child rows", () => {
	const summary = workflowChildSummary({ ...input, steps: [{ workflowKey: "a", agent: "worker", status: "running" as const, sessionFile: "/sessions/child-a.jsonl" }] });
	assert.throws(() => parseWorkflowChildSummary({ ...summary, children: [{ ...summary.children[0], sessionFile: 42 }] }), /sessionFile/);
	assert.throws(() => parseWorkflowChildSummary({ ...summary, children: [{ ...summary.children[0], sessionFile: "界".repeat(1366) }] }), /sessionFile/);
	assert.throws(() => parseWorkflowChildSummary({ ...summary, children: [{ ...summary.children[0], bogus: "x" }] }), /unsupported fields/);
});
