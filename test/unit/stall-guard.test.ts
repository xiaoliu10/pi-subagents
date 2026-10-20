import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChildSessionEvent } from "../../src/runs/shared/child-session.ts";
import {
	createStallGuard,
	childEventStallProgress,
	formatStallCancelMessage,
	formatStallWarningMessage,
	resolveStallProtection,
} from "../../src/runs/shared/stall-guard.ts";

const policy = (overrides: Partial<{ inactivityWindowMs: number; graceMs: number }> = {}) => ({
	enabled: true as const,
	inactivityWindowMs: 40,
	graceMs: 120,
	...overrides,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("resolveStallProtection", () => {
	it("is off unless explicitly opted in", () => {
		assert.equal(resolveStallProtection(undefined), undefined);
		assert.equal(resolveStallProtection({}), undefined);
		assert.equal(resolveStallProtection({ enabled: false }), undefined);
		// Opt-in means exactly true; truthy non-boolean values do not enable it.
		assert.equal(resolveStallProtection({ enabled: "yes" as unknown as boolean }), undefined);
	});

	it("fills defaults and rejects invalid explicit values", () => {
		assert.deepEqual(resolveStallProtection({ enabled: true }), {
			enabled: true,
			inactivityWindowMs: 30 * 60 * 1000,
			graceMs: 2 * 60 * 1000,
		});
		assert.equal(resolveStallProtection({ enabled: true, inactivityWindowMs: 0, graceMs: 1.5 })?.inactivityWindowMs, 30 * 60 * 1000);
		assert.equal(resolveStallProtection({ enabled: true, graceMs: -3 })?.graceMs, 2 * 60 * 1000);
		assert.equal(resolveStallProtection({ enabled: true, inactivityWindowMs: 2_147_483_648 })?.inactivityWindowMs, 30 * 60 * 1000);
	});

	it("returns a frozen policy so inherited propagation cannot be mutated", () => {
		const resolved = resolveStallProtection({ enabled: true, inactivityWindowMs: 5 });
		assert.ok(resolved);
		assert.equal(Object.isFrozen(resolved), true);
	});

	it("formats honest warning and cancellation messages", () => {
		const warning = formatStallWarningMessage(policy({ inactivityWindowMs: 1_800_000, graceMs: 120_000 }));
		assert.match(warning, /30m/);
		assert.match(warning, /120s/);
		const cancel = formatStallCancelMessage(policy({ inactivityWindowMs: 1_800_000, graceMs: 120_000 }));
		assert.match(cancel, /inactivity policy decision, not a proven deadlock/);
		assert.match(cancel, /stallProtection/);
	});
});

describe("childEventStallProgress", () => {
	const streamUpdate = (text: string): ChildSessionEvent => ({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text }] },
	} as unknown as ChildSessionEvent);

	it("counts streamed deltas and completed messages and tools as progress", () => {
		assert.equal(childEventStallProgress(streamUpdate("half"), undefined).progress, true);
		assert.equal(childEventStallProgress({ type: "message_end", message: { role: "assistant", content: [] } } as unknown as ChildSessionEvent, undefined).progress, true);
		assert.equal(childEventStallProgress({ type: "tool_execution_start", toolName: "bash" } as unknown as ChildSessionEvent, undefined).progress, true);
		assert.equal(childEventStallProgress({ type: "tool_execution_end", toolName: "bash" } as unknown as ChildSessionEvent, undefined).progress, true);
	});

	it("does not count repeated identical stream metadata as progress", () => {
		const once = childEventStallProgress(streamUpdate("same"), undefined);
		assert.equal(once.progress, true);
		const repeated = childEventStallProgress(streamUpdate("same"), once.snapshot);
		assert.equal(repeated.progress, false);
		assert.equal(repeated.snapshot, once.snapshot);
	});

	it("does not count lifecycle, retry, watchdog, or empty-content updates as progress", () => {
		for (const event of [
			{ type: "turn_start" },
			{ type: "agent_start" },
			{ type: "auto_retry_start", willRetry: true },
			{ type: "compaction_start" },
			{ type: "agent_settled" },
			// Watchdog heartbeat shape: custom type carrying status only.
			{ type: "watchdog_status", status: "running", revision: 7 },
			{ type: "message_update", message: { role: "assistant", content: [] } },
			{ type: "message_update", message: { role: "user", content: [{ type: "text", text: "repeat" }] } },
		] as unknown as ChildSessionEvent[]) {
			assert.equal(childEventStallProgress(event, undefined).progress, false, event.type);
		}
	});

	it("keeps the previous snapshot when a non-progress update arrives mid-stream", () => {
	 const first = childEventStallProgress(streamUpdate("grew"), undefined);
	 const noise = childEventStallProgress({ type: "auto_retry_start" } as unknown as ChildSessionEvent, first.snapshot);
	 assert.equal(noise.snapshot, first.snapshot);
	});
});

describe("createStallGuard", () => {
	interface Harness {
		warnings: number[];
		cancellations: number[];
		guard: ReturnType<typeof createStallGuard>;
	}

	const start = (overrides: Partial<{ inactivityWindowMs: number; graceMs: number }> = {}): Harness => {
		const warnings: number[] = [];
		const cancellations: number[] = [];
		const guard = createStallGuard(policy(overrides), {
			onWarning: ({ silentMs }) => warnings.push(silentMs),
			onCancel: ({ silentMs }) => cancellations.push(silentMs),
		});
		return { warnings, cancellations, guard };
	};

	it("warns after the window and cancels after the grace when nothing progresses", async () => {
		const harness = start();
		await sleep(90);
		assert.equal(harness.warnings.length, 1);
		assert.equal(harness.cancellations.length, 0);
		await sleep(120);
		assert.equal(harness.cancellations.length, 1);
		harness.guard.dispose();
	});

	it("lets long healthy work run: regular progress never warns", async () => {
		const harness = start();
		for (let i = 0; i < 6; i++) {
			await sleep(30);
			harness.guard.observeChildEvent({ type: "tool_execution_end", toolName: "bash" } as unknown as ChildSessionEvent);
		}
		assert.equal(harness.warnings.length, 0);
		assert.equal(harness.cancellations.length, 0);
		harness.guard.dispose();
	});

	it("repeated identical metadata does not keep the child alive", async () => {
		const harness = start();
		const update = { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "identical" }] } } as unknown as ChildSessionEvent;
		for (let i = 0; i < 8; i++) {
			harness.guard.observeChildEvent(update);
			await sleep(15);
		}
		assert.equal(harness.warnings.length, 1, "the heartbeat-shaped repetition must not reset the window");
		harness.guard.dispose();
	});

	it("progress during the grace window cancels the pending cancellation and re-arms fresh", async () => {
		// Long grace: only the warning transitions are raced here.
		const harness = start({ graceMs: 400 });
		await sleep(90);
		assert.equal(harness.warnings.length, 1);
		assert.equal(harness.guard.isWarning(), true);
		harness.guard.observeChildEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }] } } as unknown as ChildSessionEvent);
		assert.equal(harness.guard.isWarning(), false);
		// The first episode's grace cancellation point passes without a cancellation.
		await sleep(180);
		assert.equal(harness.cancellations.length, 0, "grace cancellation must be cancelled by progress");
		// A fresh full window must elapse before the next warning (dedup per episode).
		assert.equal(harness.warnings.length, 2);
		harness.guard.dispose();
	});

	it("suspends during coordination waits and grants a fresh full window on wake", async () => {
		const harness = start();
		harness.guard.setCoordinationWait(true);
		// Far past window + grace while suspended.
		await sleep(220);
		assert.equal(harness.warnings.length, 0, "a supervisor/user wait must never count as a stall");
		harness.guard.setCoordinationWait(false);
		// The pre-wait silence must not count: less than a fresh window must not warn.
		await sleep(20);
		assert.equal(harness.warnings.length, 0);
		await sleep(60);
		assert.equal(harness.warnings.length, 1, "after waking, only a full fresh window may warn");
		harness.guard.dispose();
	});

	it("a suspension with a warning in flight withdraws the episode and stays protected after wake", async () => {
		// Regression: suspend while warningActive left warningActive stuck at true,
		// and the next window's callback returned early — the guard went inert for
		// the rest of the run.
		const harness = start({ graceMs: 400 });
		await sleep(90);
		assert.equal(harness.warnings.length, 1);
		assert.equal(harness.guard.isWarning(), true);
		harness.guard.setCoordinationWait(true);
		assert.equal(harness.guard.isWarning(), false, "suspending withdraws the warning and the pending cancellation");
		harness.guard.setCoordinationWait(false);
		// Far past the original grace point: the run must still be protected.
		await sleep(60);
		assert.equal(harness.warnings.length, 2, "a fresh episode warns after a full new window");
		await sleep(80);
		assert.equal(harness.cancellations.length, 0, "the new episode's grace is still running");
		harness.guard.dispose();
	});

	it("onRecovered fires once per episode when progress lands during the grace window", async () => {
		const recoveries: number[] = [];
		const warnings: number[] = [];
		const guard = createStallGuard(policy(), {
			onWarning: () => warnings.push(1),
			onCancel: () => {},
			onRecovered: ({ silentMs }) => recoveries.push(silentMs),
		});
		await sleep(90);
		assert.equal(warnings.length, 1);
		guard.observeChildEvent({ type: "tool_execution_end", toolName: "bash" } as unknown as ChildSessionEvent);
		assert.equal(recoveries.length, 1);
		assert.ok(recoveries[0] >= 40);
		// A second stall episode warns again but only recovers when progress lands during ITS grace.
		await sleep(90);
		assert.equal(warnings.length, 2);
		assert.equal(recoveries.length, 1);
		guard.observeChildEvent({ type: "tool_execution_end", toolName: "bash" } as unknown as ChildSessionEvent);
		assert.equal(recoveries.length, 2);
		guard.dispose();
	});

	it("dispose prevents every late callback", async () => {
		const harness = start();
		await sleep(90);
		assert.equal(harness.warnings.length, 1);
		harness.guard.dispose();
		// The grace cancellation point passes after dispose.
		await sleep(150);
		assert.equal(harness.cancellations.length, 0);
		harness.guard.observeChildEvent({ type: "tool_execution_end" } as unknown as ChildSessionEvent);
		assert.equal(harness.warnings.length, 1);
	});

	it("cancelled guards stay inert even when fed further events", async () => {
		const harness = start({ inactivityWindowMs: 20, graceMs: 40 });
		await sleep(100);
		assert.equal(harness.cancellations.length, 1);
		harness.guard.observeChildEvent({ type: "tool_execution_end" } as unknown as ChildSessionEvent);
		await sleep(100);
		assert.equal(harness.warnings.length + harness.cancellations.length, 2, "no further callbacks after cancellation");
	});
});

describe("per-call tool progress fingerprints", () => {
	const event = (type: string, toolCallId?: string, partialResult?: unknown) => ({ type, toolCallId, toolName: "bash", partialResult }) as unknown as ChildSessionEvent;
	const output = (text: string, revision = 1) => ({ content: [{ type: "text", text }], details: { status: "running", revision } });

	it("only changed text content refreshes, independent of details/metadata or message-stream snapshots", () => {
		const cache = new Map<string, string | undefined>();
		const classify = (value: ChildSessionEvent) => childEventStallProgress(value, "model snapshot", cache);
		classify(event("tool_execution_start", "A"));
		assert.deepEqual(classify(event("tool_execution_update", "A", output("compiled 1"))), { progress: true, snapshot: "model snapshot" });
		assert.equal(classify(event("tool_execution_update", "A", output("compiled 1", 2))).progress, false);
		for (const partialResult of [undefined, {}, { content: [] }, { content: [{ type: "text", text: "   \n" }] }, { content: [{ type: "status", text: "running" }], details: { bytes: 123 } }]) {
			assert.equal(classify(event("tool_execution_update", "A", partialResult)).progress, false);
		}
		assert.equal(classify(event("tool_execution_update", "A", output("compiled 1", 3))).progress, false, "empty/metadata updates cannot erase the content fingerprint");
		assert.equal(classify(event("tool_execution_update", "A", output("compiled 2"))).progress, true);
	});

	it("isolates concurrent call IDs and only retains fixed-size digests until end", () => {
		const cache = new Map<string, string | undefined>();
		const classify = (value: ChildSessionEvent) => childEventStallProgress(value, undefined, cache);
		for (const id of ["A", "B"]) {
			classify(event("tool_execution_start", id));
			assert.equal(classify(event("tool_execution_update", id, output(`${id} ready`))).progress, true);
		}
		for (let revision = 0; revision < 10; revision++) {
			for (const id of ["A", "B"]) assert.equal(classify(event("tool_execution_update", id, output(`${id} ready`, revision))).progress, false);
		}
		const large = "compiler output\n".repeat(100_000);
		assert.equal(classify(event("tool_execution_update", "A", output(large))).progress, true);
		assert.equal(cache.get("A")?.length, 64, "never retain the full output string/object");
		assert.equal(classify(event("tool_execution_update", "A", output(large))).progress, false);
		assert.equal(classify(event("tool_execution_update", "A", output(`${large}done`))).progress, true, "changes beyond the first chunk are still detected");
		classify(event("tool_execution_end", "A"));
		assert.equal(cache.has("A"), false);
		assert.equal(classify(event("tool_execution_update", "A", output("late output"))).progress, false);
		assert.equal(classify(event("tool_execution_update", undefined, output("ambiguous"))).progress, false);
		assert.equal(classify(event("tool_execution_update", "unknown", output("unknown"))).progress, false);
		assert.equal(cache.size, 1, "unmatched/late events cannot grow the cache");
		classify(event("tool_execution_end", "B"));
		assert.equal(cache.size, 0);
	});
});
