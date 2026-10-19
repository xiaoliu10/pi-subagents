import assert from "node:assert/strict";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { makeAgentConfigs } from "../support/helpers.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { resolveControlConfig } from "../../src/runs/shared/subagent-control.ts";
import { formatStallCancelMessage, resolveStallProtection } from "../../src/runs/shared/stall-guard.ts";
import type { ChildSession, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import type { InProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

const launch = { session: {
	cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false,
	hooks: [], noSkills: true, noContextFiles: true,
	runtime: { fanoutChild: false, fast: false, depth: 1, waitTool: { enabled: false } },
} } as InProcessChildLaunch;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Short opt-in policy for tests; window and grace have comfortable margins. */
const stallPolicy = (inactivityWindowMs = 60, graceMs = 200) => resolveStallProtection({ enabled: true, inactivityWindowMs, graceMs })!;

const stallControlConfig = (inactivityWindowMs?: number, graceMs?: number) => resolveControlConfig({
	enabled: true,
	stallProtection: { enabled: true, ...(inactivityWindowMs !== undefined ? { inactivityWindowMs } : {}), ...(graceMs !== undefined ? { graceMs } : {}) },
});

/** A child that streams once and then goes silent forever until aborted. */
function silentAfterStreamSession(): { session: ChildSession; abortCount: () => number } {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	let release!: () => void;
	const hung = new Promise<void>((resolve) => { release = resolve; });
	let aborts = 0;
	const session: ChildSession = {
		subscribe(handler) { listener = handler; return () => {}; },
		async prompt() {
			listener({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "half a thought" }] }, assistantMessageEvent: { type: "text_delta", delta: "half a thought" } } as never);
			await hung;
		},
		async steer() {}, async followUp() {},
		async abort() { aborts++; release(); },
		async dispose() {},
		messages: [], sessionId: "stall-session", modelId: "mock/model",
	};
	return { session, abortCount: () => aborts };
}

it("background: cancels a truly silent child after window + grace, stating the inactivity cause and preserving partial output", { timeout: 15_000 }, async () => {
	const { session, abortCount } = silentAfterStreamSession();
	const lines: string[] = [];
	const result = await runChildSession({
		factory: { create: async () => session, async dispose() {} },
		launch,
		prompt: "Finish",
		stallProtection: stallPolicy(60, 150),
		appendChildEvent() {},
		writeOutputLine: (line) => lines.push(line),
	});
	assert.equal(result.timedOut, true);
	assert.equal(result.exitCode, 1);
	assert.match(result.error ?? "", /progress-aware stall policy/);
	assert.match(result.error ?? "", /not a proven deadlock/);
	assert.equal(result.outputPartial, true);
	assert.match(result.finalOutput ?? "", /Partial output before timeout:\nhalf a thought$/);
	assert.ok(lines.some((line) => line.includes("[stall]")), "the visible warning must reach the step output log");
	assert.equal(abortCount(), 1, "cancellation goes through the child's abort, never a process kill");
});

it("background: allows long healthy work whose stream keeps moving", { timeout: 15_000 }, async () => {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	const session: ChildSession = {
		subscribe(handler) { listener = handler; return () => {}; },
		async prompt() {
			// ~210ms of steady progress against a 100ms window.
			for (let i = 0; i < 7; i++) {
				listener({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `working ${i}` }] } } as never);
				await sleep(30);
			}
			const message = fauxAssistantMessage("done");
			listener({ type: "message_end", message });
			listener({ type: "agent_settled" });
		},
		async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
		messages: [], sessionId: "healthy-session", modelId: "mock/model",
	};
	const result = await runChildSession({
		factory: { create: async () => session, async dispose() {} },
		launch,
		prompt: "Work",
		stallProtection: stallPolicy(100, 150),
		appendChildEvent() {},
		writeOutputLine() {},
	});
	assert.equal(result.timedOut, undefined);
	assert.equal(result.exitCode, 0);
	assert.match(result.finalOutput ?? "", /done/);
});

it("background: a coordination wait suspends the policy and waking grants a fresh full window", { timeout: 15_000 }, async () => {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	let release!: () => void;
	const hung = new Promise<void>((resolve) => { release = resolve; });
	let settled = false;
	const done = runChildSession({
		factory: {
			create: async () => ({
				subscribe(handler) { listener = handler; return () => {}; },
				async prompt() {
					listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "contact_supervisor", args: {} } as never);
					await hung;
					const message = fauxAssistantMessage("answered");
					listener({ type: "message_end", message });
					listener({ type: "agent_settled" });
				},
				async steer() {}, async followUp() {}, async abort() { release(); }, async dispose() {},
				messages: [], sessionId: "wait-session", modelId: "mock/model",
			}) as ChildSession,
			async dispose() {},
		},
		launch,
		prompt: "Ask",
		stallProtection: stallPolicy(60, 60),
		appendChildEvent() {},
		writeOutputLine() {},
	}).then((result) => { settled = true; return result; });
	// Far past window + grace while the supervisor wait is open: no cancellation.
	await sleep(220);
	assert.equal(settled, false, "a supervisor/user wait must never be cancelled as a stall");
	// Waking grants a fresh full window: less than one window after the wake, the
	// still-silent child is not cancelled even though it was already silent long
	// before the wait.
	const wokeAt = Date.now();
	listener({ type: "tool_execution_end", toolCallId: "call-1", toolName: "contact_supervisor" } as never);
	await sleep(40);
	assert.equal(settled, false, "the pre-wait silence must not count after waking");
	const result = await done;
	// After a full fresh window + grace of continued silence, the policy cancels.
	assert.equal(result.timedOut, true);
	assert.ok(Date.now() - wokeAt >= 100, "cancellation must wait for the fresh window + grace after the wake");
	assert.match(result.error ?? "", /progress-aware stall policy/);
});

it("background: an open nested subagent delegation suspends the policy like a coordination wait", { timeout: 15_000 }, async () => {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	let release!: () => void;
	const hung = new Promise<void>((resolve) => { release = resolve; });
	let settled = false;
	const done = runChildSession({
		factory: {
			create: async () => ({
				subscribe(handler) { listener = handler; return () => {}; },
				async prompt() {
					// The parent silently waits inside nested delegation for its own bounded child.
					listener({ type: "tool_execution_start", toolCallId: "call-2", toolName: "subagent", args: {} } as never);
					await hung;
					const message = fauxAssistantMessage("nested done");
					listener({ type: "message_end", message });
					listener({ type: "agent_settled" });
				},
				async steer() {}, async followUp() {}, async abort() { release(); }, async dispose() {},
				messages: [], sessionId: "nested-wait-session", modelId: "mock/model",
			}) as ChildSession,
			async dispose() {},
		},
		launch,
		prompt: "Delegate",
		stallProtection: stallPolicy(60, 60),
		appendChildEvent() {},
		writeOutputLine() {},
	}).then((result) => { settled = true; return result; });
	// Far past window + grace while the nested delegation wait is open: no cancellation.
	await sleep(220);
	assert.equal(settled, false, "a cooperative nested delegation wait must never be cancelled as a stall");
	// The nested child settles; the parent finishes cleanly inside its fresh window.
	listener({ type: "tool_execution_end", toolCallId: "call-2", toolName: "subagent" } as never);
	release();
	const result = await done;
	assert.equal(result.timedOut, undefined);
	assert.equal(result.exitCode, 0);
});

it("background: the wall deadline stays authoritative even while progress keeps flowing", { timeout: 15_000 }, async () => {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	let timeoutHandler: (() => void) | undefined;
	let release!: () => void;
	const hung = new Promise<void>((resolve) => { release = resolve; });
	const session: ChildSession = {
		subscribe(handler) { listener = handler; return () => {}; },
		async prompt() {
			for (let i = 0; i < 10; i++) {
				listener({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `chunk ${i}` }] } } as never);
				await sleep(20);
			}
			await hung;
		},
		async steer() {}, async followUp() {}, async abort() { release(); }, async dispose() {},
		messages: [], sessionId: "wall-session", modelId: "mock/model",
	};
	const result = await runChildSession({
		factory: { create: async () => session, async dispose() {} },
		launch,
		prompt: "Work",
		stallProtection: stallPolicy(500, 500),
		appendChildEvent() {},
		writeOutputLine() {},
		registerTimeout: (handler) => {
			timeoutHandler = handler;
			// The runner's wall deadline fires mid-progress; progress must not disarm it.
			setTimeout(() => timeoutHandler?.(), 60);
		},
	});
	assert.equal(result.timedOut, true);
	assert.match(result.error ?? "", /Subagent timed out/);
	assert.doesNotMatch(result.error ?? "", /stall policy/);
});

it("background: cancels startup silence (no first token) through the startup signal", { timeout: 15_000 }, async () => {
	const factory: ChildSessionFactory = {
		create(input) {
			return new Promise((_resolve, reject) => {
				input.signal?.addEventListener("abort", () => reject(new Error("startup cancelled")), { once: true });
			});
		},
		async dispose() {},
	};
	const result = await runChildSession({
		factory,
		launch,
		prompt: "Never starts",
		stallProtection: stallPolicy(50, 60),
		appendChildEvent() {},
		writeOutputLine() {},
	});
	assert.equal(result.timedOut, true);
	assert.match(result.error ?? "", /progress-aware stall policy/);
	assert.equal(result.toolCount, 0);
});

it("foreground: cancels a truly silent child, emits the visible stall warning, and preserves partial output", { timeout: 15_000 }, async () => {
	const { session } = silentAfterStreamSession();
	const result = await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Finish", {
		childSessionFactory: { create: async () => session, async dispose() {} },
		controlConfig: stallControlConfig(60, 200),
	});
	assert.equal(result.timedOut, true);
	assert.equal(result.exitCode, 1);
	assert.equal(result.error, formatStallCancelMessage(stallPolicy(60, 200)));
	assert.equal(result.outputPartial, true);
	assert.match(result.finalOutput ?? "", /Partial output before timeout:\nhalf a thought$/);
	assert.ok(result.controlEvents?.some((event) => event.reason === "stall_warning" && /No meaningful progress/.test(event.message)), "the warning must be visible before cancellation");
	assert.ok(result.timeoutRecovery, "the timed-out receipt carries the existing recovery summary");
});

it("foreground: allows healthy streaming work to complete normally", { timeout: 15_000 }, async () => {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	const session: ChildSession = {
		subscribe(handler) { listener = handler; return () => {}; },
		async prompt() {
			for (let i = 0; i < 7; i++) {
				listener({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `working ${i}` }] } } as never);
				await sleep(30);
			}
			const message = fauxAssistantMessage("done");
			listener({ type: "message_end", message });
			listener({ type: "agent_settled" });
		},
		async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
		messages: [], sessionId: "healthy-foreground", modelId: "mock/model",
	};
	const result = await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Work", {
		childSessionFactory: { create: async () => session, async dispose() {} },
		controlConfig: stallControlConfig(100, 200),
	});
	assert.equal(result.timedOut, undefined);
	assert.equal(result.exitCode, 0);
});

it("foreground: without the opt-in nothing changes — a silent child ends only through the pre-existing signal path", { timeout: 15_000 }, async () => {
	const { session } = silentAfterStreamSession();
	const result = await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Finish", {
		childSessionFactory: { create: async () => session, async dispose() {} },
		// No controlConfig.stallProtection: the wall deadline remains the only terminator.
		signal: AbortSignal.timeout(120),
	});
	assert.equal(result.timedOut, undefined);
	assert.equal(result.exitCode, 1);
	assert.doesNotMatch(result.error ?? "", /stall policy/);
	assert.match(result.error ?? "", /stopped before it could complete|Subagent stopped/);
});
