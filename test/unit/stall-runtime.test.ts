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

for (const mode of ["foreground", "background"] as const) {
	for (const resumes of [false, true]) {
		it(`${mode}: warning in flight survives drain suspension${resumes ? " and compaction re-arm" : " without late cancellation"}`, { timeout: 15_000 }, async () => {
			let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
			let release!: () => void;
			let signalWarning!: () => void;
			const warned = new Promise<void>((resolve) => { signalWarning = resolve; });
			const hung = new Promise<void>((resolve) => { release = resolve; });
			let warnings = 0;
			const onWarning = () => { warnings++; signalWarning(); };
			const session: ChildSession = {
				subscribe(handler) { listener = handler; return () => {}; },
				async prompt() { await hung; },
				async steer() {}, async followUp() {}, async abort() { release(); }, async dispose() {},
				messages: [], sessionId: "warning-drain-session", modelId: "mock/model",
			};
			const factory: ChildSessionFactory = { create: async () => session, async dispose() {} };
			const run = mode === "foreground"
				? runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Retry", {
					childSessionFactory: factory, controlConfig: stallControlConfig(60, 600),
					onControlEvent(event) { if (event.reason === "stall_warning") onWarning(); },
				})
				: runChildSession({ factory, launch, prompt: "Retry", stallProtection: stallPolicy(60, 600),
					appendChildEvent() {}, writeOutputLine(line) { if (line.startsWith("[stall]")) onWarning(); },
				});
			await warned;
			listener({ type: "agent_settled" });
			if (resumes) {
				listener({ type: "compaction_end", willRetry: true } as never);
				// Bound the old broken behavior too: release the factory's hung prompt
				// after 2s so this regression fails rather than orphaning a live attempt.
				const fallback = setTimeout(release, 2_000);
				const result = await run;
				clearTimeout(fallback);
				assert.equal(result.timedOut, true, "a wedged retried run must still be cancelled");
				assert.equal(warnings, 2, "resumed silence must start a fresh warning episode");
			} else {
				// Past the original cancellation point, but before the 1s drain timer:
				// settling normally must never be relabelled by a stale stall grace.
				await sleep(750);
				release();
				const result = await run;
				assert.equal(result.timedOut, undefined);
				assert.equal(warnings, 1);
			}
		});
	}
}

it("foreground: control.enabled=false disables the stall guard rather than cancelling without warning", { timeout: 15_000 }, async () => {
	const { session } = silentAfterStreamSession();
	const result = await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Wait", {
		childSessionFactory: { create: async () => session, async dispose() {} },
		controlConfig: resolveControlConfig({ enabled: false, stallProtection: { enabled: true, inactivityWindowMs: 60, graceMs: 60 } }),
		signal: AbortSignal.timeout(400),
	});
	assert.equal(result.timedOut, undefined);
	assert.equal(result.controlEvents?.length ?? 0, 0);
});

it("foreground: progress after a stall warning clears attention state and allows active notices again", { timeout: 15_000 }, async () => {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	let release!: () => void;
	let signalWarning!: () => void;
	const warned = new Promise<void>((resolve) => { signalWarning = resolve; });
	const hung = new Promise<void>((resolve) => { release = resolve; });
	const states: Array<string | undefined> = [];
	const session: ChildSession = {
		subscribe(handler) { listener = handler; return () => {}; },
		async prompt() {
			await sleep(10);
			listener({ type: "agent_start" } as never);
			await hung;
		},
		async steer() {}, async followUp() {}, async abort() { release(); }, async dispose() {},
		messages: [], sessionId: "recovered-state", modelId: "mock/model",
	};
	const run = runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Recover", {
		childSessionFactory: { create: async () => session, async dispose() {} },
		controlConfig: resolveControlConfig({ activeNoticeAfterMs: 1, stallProtection: { enabled: true, inactivityWindowMs: 60, graceMs: 600 } }),
		onControlEvent(event) { if (event.reason === "stall_warning") signalWarning(); },
		onUpdate(update) { states.push(update.details?.progress?.[0]?.activityState); },
	});
	await warned;
	const beforeRecovery = states.length;
	listener({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "recovered" }] } } as never);
	release();
	const result = await run;
	assert.equal(result.timedOut, undefined);
	assert.ok(states.slice(beforeRecovery).every((state) => state !== "needs_attention"), "recovery withdraws only the stall attention state and restores the prior active state");
	assert.ok(result.controlEvents?.filter((event) => event.type === "active_long_running").length! >= 2, "active notice is allowed again after recovery");
	assert.notEqual(states.at(-1), "needs_attention");
});

for (const mode of ["foreground", "background"] as const) {
	it(`${mode}: an interrupted attempt is not relabelled timedOut while its prompt settles slowly`, { timeout: 15_000 }, async () => {
		let release!: () => void;
		let started!: () => void;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		const hung = new Promise<void>((resolve) => { release = resolve; });
		const controller = new AbortController();
		let interrupt: (() => void) | undefined;
		const session: ChildSession = {
			subscribe() { return () => {}; }, async prompt() { started(); await hung; },
			async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
			messages: [], sessionId: "interrupt-race", modelId: "mock/model",
		};
		const factory: ChildSessionFactory = { create: async () => session, async dispose() {} };
		const run = mode === "foreground"
			? runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Stop", {
				childSessionFactory: factory, signal: controller.signal, controlConfig: stallControlConfig(60, 100),
			})
			: runChildSession({ factory, launch, prompt: "Stop", stallProtection: stallPolicy(60, 100),
				appendChildEvent() {}, writeOutputLine() {}, registerInterrupt(handler) { interrupt = handler; },
			});
		await ready;
		if (mode === "foreground") controller.abort();
		else interrupt!();
		await sleep(350); // Stall grace would have elapsed within the abort/settle window.
		release();
		const result = await run;
		assert.equal(result.timedOut, undefined);
		if (mode === "background") assert.equal(result.interrupted, true);
		assert.doesNotMatch(result.error ?? "", /stall policy/);
	});
}

for (const mode of ["foreground", "background"] as const) {
	for (const scenario of ["changing output", "metadata only", "identical output", "parallel unchanged output"] as const) {
		it(`${mode}: tool progress ${scenario} ${scenario === "changing output" ? "keeps healthy work alive" : "does not mask inactivity"}`, { timeout: 15_000 }, async () => {
			let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
			let updates = 0;
			let aborts = 0;
			let warnings = 0;
			const calls = scenario === "parallel unchanged output" ? ["build-a", "build-b"] : ["build-a"];
			const session: ChildSession = {
				subscribe(handler) { listener = handler; return () => {}; },
				async prompt() {
					for (const toolCallId of calls) listener({ type: "tool_execution_start", toolName: "bash", toolCallId, args: {} } as never);
					// This build outlives the entire inactivity + grace budget, but keeps
					// reporting meaningful output. Negative cases use the same heartbeat
					// frequency, without any actual change to that call's output.
					while (updates < 20 && !aborts) {
						await sleep(40);
						if (aborts) break;
						updates++;
						const toolCallId = calls[(updates - 1) % calls.length];
						const content = scenario === "metadata only"
							? []
							: [{ type: "text", text: scenario === "changing output" ? `compiled ${updates} modules` : `${toolCallId}: compiled 1 module` }];
						listener({ type: "tool_execution_update", toolName: "bash", toolCallId,
							partialResult: { content, details: { status: "running", heartbeat: updates } },
						} as never);
					}
					if (aborts) return;
					for (const toolCallId of calls) listener({ type: "tool_execution_end", toolName: "bash", toolCallId } as never);
					listener({ type: "message_end", message: fauxAssistantMessage("build complete") });
					listener({ type: "agent_settled" });
				},
				async steer() {}, async followUp() {}, async abort() { aborts++; }, async dispose() {},
				messages: [], sessionId: "tool-progress-regression", modelId: "mock/model",
			};
			const factory: ChildSessionFactory = { create: async () => session, async dispose() {} };
			const result = mode === "foreground"
				? await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Build", {
					childSessionFactory: factory, controlConfig: stallControlConfig(200, 200),
					onControlEvent(event) { if (event.reason === "stall_warning") warnings++; },
				})
				: await runChildSession({ factory, launch, prompt: "Build", stallProtection: stallPolicy(200, 200),
					appendChildEvent() {}, writeOutputLine(line) { if (line.startsWith("[stall]")) warnings++; },
				});
			if (scenario === "changing output") {
				assert.equal(result.timedOut, undefined, "new tool output must refresh inactivity in both native hosts");
				assert.equal(result.exitCode, 0);
				assert.equal(updates, 20);
				assert.equal(aborts, 0);
				assert.equal(warnings, 0, "productive updates must not create stall notifications");
			} else {
				assert.equal(result.timedOut, true, "unchanged per-call content cannot keep the run alive");
				assert.equal(result.exitCode, 1);
				assert.equal(aborts, 1);
				assert.equal(warnings, 1);
				assert.ok(updates < 20);
			}
		});
	}
}

for (const otherAttention of ["before stall", "during stall"] as const) {
	it(`foreground: withdrawing stall attention preserves tool attention raised ${otherAttention}`, { timeout: 15_000 }, async () => {
		let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
		let release!: () => void;
		let warned!: () => void;
		const warning = new Promise<void>((resolve) => { warned = resolve; });
		const hung = new Promise<void>((resolve) => { release = resolve; });
		const states: Array<string | undefined> = [];
		const session: ChildSession = {
			subscribe(handler) { listener = handler; return () => {}; },
			async prompt() {
				listener({ type: "tool_execution_start", toolCallId: "A", toolName: "bash", args: { command: "build A" } } as never);
				listener({ type: "tool_execution_start", toolCallId: "B", toolName: "bash", args: { command: "build B" } } as never);
				if (otherAttention === "before stall") {
					// An actual event after the open-tool threshold emits the first
					// attention without depending on the host's 1s activity tick.
					await sleep(30);
					listener({ type: "turn_end" } as never);
				}
				await warning;
				if (otherAttention === "during stall") listener({ type: "turn_end" } as never);
				// Completion is progress and withdraws the stall, but B remains open
				// and its independent tool attention must not disappear.
				listener({ type: "tool_execution_end", toolCallId: "A", toolName: "bash" } as never);
				listener({ type: "message_end", message: fauxAssistantMessage("done") });
				listener({ type: "agent_settled" });
				release();
				await hung;
			},
			async steer() {}, async followUp() {}, async abort() { release(); }, async dispose() {},
			messages: [], sessionId: "attention-ownership", modelId: "mock/model",
		};
		let recoveryIndex = 0;
		const result = await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Attention", {
			runId: `tool-attention-${otherAttention.replaceAll(" ", "-")}`,
			childSessionFactory: { create: async () => session, async dispose() {} },
			controlConfig: resolveControlConfig({ needsAttentionAfterMs: 600_000, activeNoticeAfterMs: 10,
				stallProtection: { enabled: true, inactivityWindowMs: 200, graceMs: 600 } }),
			onControlEvent(event) {
				if (event.reason === "stall_warning") { recoveryIndex = states.length; warned(); }
			},
			onUpdate(update) { states.push(update.details?.progress?.[0]?.activityState); },
		});
		assert.equal(result.timedOut, undefined);
		assert.ok(result.controlEvents?.some((event) => event.reason === "tool_open_threshold"));
		assert.ok(states.slice(recoveryIndex).every((state) => state === "needs_attention"), "stall withdrawal cannot erase independent attention");
	});
}

it("foreground: drain withdrawal clears only stall state before a healthy compaction retry", { timeout: 15_000 }, async () => {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	let warned!: () => void;
	const warning = new Promise<void>((resolve) => { warned = resolve; });
	const states: Array<string | undefined> = [];
	let afterWithdraw = 0;
	const session: ChildSession = {
		subscribe(handler) { listener = handler; return () => {}; },
		async prompt() {
			await warning;
			afterWithdraw = states.length;
			listener({ type: "agent_settled" });
			listener({ type: "compaction_end", willRetry: true } as never);
			listener({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "retry recovered" }] } } as never);
			listener({ type: "message_end", message: fauxAssistantMessage("done") });
			listener({ type: "agent_settled" });
		},
		async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
		messages: [], sessionId: "withdrawn-stall-retry", modelId: "mock/model",
	};
	const result = await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Retry", {
		childSessionFactory: { create: async () => session, async dispose() {} }, controlConfig: stallControlConfig(60, 600),
		onControlEvent(event) { if (event.reason === "stall_warning") warned(); },
		onUpdate(update) { states.push(update.details?.progress?.[0]?.activityState); },
	});
	assert.equal(result.exitCode, 0);
	assert.equal(result.timedOut, undefined);
	assert.equal(result.controlEvents?.filter((event) => event.reason === "stall_warning").length, 1);
	assert.ok(states.slice(afterWithdraw).every((state) => state !== "needs_attention"), "drain withdrawal must clean stall-owned state even before real recovery");
});

for (const stop of ["runtime replacement", "host shutdown"] as const) {
	it(`foreground: ${stop} wins over a warning in flight during slow settlement`, { timeout: 15_000 }, async () => {
		const reason = "Subagent stopped because the pi-subagents runtime that ran it was replaced (reload or session switch).";
		let stopChild!: (reason: string) => void;
		let release!: () => void;
		let warned!: () => void;
		const warning = new Promise<void>((resolve) => { warned = resolve; });
		const hung = new Promise<void>((resolve) => { release = resolve; });
		const session: ChildSession = {
			subscribe() { return () => {}; }, async prompt() { await hung; },
			async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
			messages: [], sessionId: "host-stop-race", modelId: "mock/model",
		};
		const run = runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Stop", {
			childSessionFactory: { create: async () => session, async dispose() {} }, controlConfig: stallControlConfig(60, 200),
			onChildSession(controls) { stopChild = controls.stop; },
			onControlEvent(event) { if (event.reason === "stall_warning") warned(); },
		});
		await warning;
		if (stop === "runtime replacement") stopChild(reason);
		else session.shutDown = true;
		await sleep(400); // Well past grace, still inside the existing settle window.
		release();
		const result = await run;
		assert.equal(result.timedOut, undefined);
		assert.equal(result.exitCode, 1);
		if (stop === "runtime replacement") {
			assert.equal(result.stopped, true);
			assert.equal(result.error, reason);
		} else assert.match(result.error ?? "", /parent session shut down/);
	});
}
