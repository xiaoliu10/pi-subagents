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
	assert.ok(states.slice(beforeRecovery).includes(undefined), "recovery withdraws the stall attention state");
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
