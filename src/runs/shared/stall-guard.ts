/**
 * Opt-in progress-aware stall protection: one tested state machine shared by the
 * foreground child runtime and the background runner's in-process child
 * sessions. It never kills processes and never invents a settlement path; the
 * hosts wire its `onCancel` into their existing abort + bounded settle flow.
 *
 * What counts as meaningful progress is decided in exactly one place
 * (`childEventStallProgress`): streamed model content, completed messages and
 * tool results, and tool starts/ends. Watchdog status writes, turn/agent
 * bookkeeping, provider retries, and repeated identical stream metadata do NOT
 * reset the window.
 *
 * Coordination waits (`isStallCoordinationTool`: contact_supervisor, intercom,
 * bg_wait, and nested `subagent` delegation) suspend the policy; ending the
 * wait grants a fresh full window so a suspended timer can never fire
 * immediately after an unblock.
 *
 * This policy states inactivity, not proven deadlock: a silent healthy tool
 * (long build, slow network, codemode wrapping a supervisor wait) is
 * indistinguishable from a wedge by events alone. That is why the window is
 * opt-in, generous, warned about, and overridable per call.
 */
import type { ChildSessionEvent } from "./child-session.ts";
import type { ResolvedStallProtection, StallProtectionConfig } from "../../shared/types.ts";
import { isToolTimeoutExempt } from "./tool-timeout.ts";

/**
 * Tools whose legitimate purpose is to wait: human/supervisor coordination and
 * nested delegation. An open `subagent` call is a parent cooperatively waiting
 * on its own bounded child (that child resolves its own deadline and carries
 * its own stall policy), so the outer silence is not a stall. A codemode script
 * that wraps one of these tools is indistinguishable from a wedge and stays a
 * documented limitation.
 */
export function isStallCoordinationTool(toolName: string | undefined): boolean {
	return isToolTimeoutExempt(toolName) || toolName === "subagent";
}

export const DEFAULT_STALL_INACTIVITY_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_STALL_GRACE_MS = 2 * 60 * 1000;

const MAX_STALL_TIMER_MS = 2_147_483_647;

function parseStallPositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_STALL_TIMER_MS) return undefined;
	return value;
}

/**
 * Resolve the opt-in stall policy. Disabled (the default) resolves to undefined
 * so nothing else has to branch on an enabled flag. Explicit window/grace
 * values must be positive integers no larger than the schedulable timer bound;
 * invalid values fall back to the defaults like every other control knob.
 */
export function resolveStallProtection(raw: StallProtectionConfig | undefined): ResolvedStallProtection | undefined {
	if (!raw || typeof raw !== "object" || raw.enabled !== true) return undefined;
	return Object.freeze({
		enabled: true as const,
		inactivityWindowMs: parseStallPositiveInt(raw.inactivityWindowMs) ?? DEFAULT_STALL_INACTIVITY_WINDOW_MS,
		graceMs: parseStallPositiveInt(raw.graceMs) ?? DEFAULT_STALL_GRACE_MS,
	});
}

export function formatStallWarningMessage(config: ResolvedStallProtection): string {
	const windowMinutes = Math.round(config.inactivityWindowMs / 60_000);
	const graceSeconds = Math.round(config.graceMs / 1000);
	return `No meaningful progress for about ${windowMinutes}m. If this is a wedge it will be cancelled in about ${graceSeconds}s; any real progress (model output, tool result) cancels the warning.`;
}

export function formatStallCancelMessage(config: ResolvedStallProtection): string {
	const windowMinutes = Math.round(config.inactivityWindowMs / 60_000);
	const graceSeconds = Math.round(config.graceMs / 1000);
	return [
		`Subagent was cancelled by the progress-aware stall policy after ${windowMinutes}m without meaningful progress and a ${graceSeconds}s warning grace that also saw no progress.`,
		"This is an inactivity policy decision, not a proven deadlock: a silent healthy tool (long build, slow provider, codemode wrapping a supervisor wait) can look identical. Re-run with an explicit longer timeoutMs and this policy still applies; disable control.stallProtection for work that legitimately stays silent.",
	].join("\n");
}

/** Events reported by the guard to its host. `silentMs` is informational. */
export interface StallGuardCallbacks {
	onWarning: (info: { silentMs: number }) => void;
	onCancel: (info: { silentMs: number }) => void;
	/** Fired once per episode when real progress arrives during the grace window, withdrawing the warning and the pending cancellation. */
	onRecovered?: (info: { silentMs: number }) => void;
}

export interface StallGuardDeps {
	now?: () => number;
	setTimeout?: typeof setTimeout;
	clearTimeout?: typeof clearTimeout;
}

export interface StallGuard {
	/** Feed every child session event; the guard ignores whatever is not progress. */
	observeChildEvent(event: ChildSessionEvent): void;
	/**
	 * Suspend while a coordination/wait tool is active; resume grants a fresh
	 * full window regardless of how long the child was already silent.
	 */
	setCoordinationWait(waiting: boolean): void;
	/** True between the visible warning and either progress (recovery) or cancellation. */
	isWarning(): boolean;
	/** Terminal paths must dispose; a disposed guard never fires callbacks. */
	dispose(): void;
}

/**
 * Pure classification of one child session event for stall purposes.
 * `previousSnapshot` carries the last seen assistant stream content so
 * repeated identical metadata (the same message object re-emitted) does not
 * count as progress while genuine deltas do.
 */
export function childEventStallProgress(
	event: ChildSessionEvent,
	previousSnapshot: string | undefined,
): { progress: boolean; snapshot: string | undefined } {
	const message = (event as { message?: unknown }).message;
	switch (event.type) {
		case "message_update": {
			if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") {
				return { progress: false, snapshot: previousSnapshot };
			}
			const snapshot = JSON.stringify((message as { content?: unknown }).content ?? null);
			if (snapshot === previousSnapshot) return { progress: false, snapshot: previousSnapshot };
			// An empty or unchanged-content update is metadata, not progress.
			const content = (message as { content?: unknown }).content;
			const hasSubstance = Array.isArray(content) && content.some((part) => {
				const typed = part as { type?: string; text?: string };
				return (typed.type === "text" && typeof typed.text === "string" && typed.text.length > 0)
					|| typed.type === "toolCall" || typed.type === "thinking";
			});
			return { progress: hasSubstance, snapshot: hasSubstance ? snapshot : previousSnapshot };
		}
		case "message_end":
			// Any completed message (assistant reply, tool result, delivered steer) is progress.
			return { progress: Boolean(message), snapshot: undefined };
		case "tool_execution_start":
		case "tool_execution_end":
			return { progress: true, snapshot: undefined };
		default:
			// turn/agent lifecycle, compaction, auto-retry, watchdog status, usage
			// ticks: bookkeeping and heartbeats, never progress.
			return { progress: false, snapshot: previousSnapshot };
	}
}

export function createStallGuard(
	config: ResolvedStallProtection,
	callbacks: StallGuardCallbacks,
	deps: StallGuardDeps = {},
): StallGuard {
	const now = deps.now ?? Date.now;
	const scheduleTimeout = deps.setTimeout ?? setTimeout;
	const clearScheduled = deps.clearTimeout ?? clearTimeout;
	let disposed = false;
	let cancelled = false;
	let warningActive = false;
	let waiting = false;
	let progressAt = now();
	let streamSnapshot: string | undefined;
	let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;

	const clearTimers = (): void => {
		if (inactivityTimer) {
			clearScheduled(inactivityTimer);
			inactivityTimer = undefined;
		}
		if (graceTimer) {
			clearScheduled(graceTimer);
			graceTimer = undefined;
		}
	};

	const armInactivity = (): void => {
		if (disposed || cancelled || waiting) return;
		if (inactivityTimer) clearScheduled(inactivityTimer);
		inactivityTimer = scheduleTimeout(() => {
			inactivityTimer = undefined;
			if (disposed || cancelled || waiting) return;
			if (warningActive) {
				// Defensive: a warning is still marked active without its grace timer
				// (only possible through a stale suspension race). Restart the episode
				// instead of returning inert — the guard must never lose its protection.
				warningActive = false;
				clearTimers();
				armInactivity();
				return;
			}
			warningActive = true;
			try {
				callbacks.onWarning({ silentMs: Math.max(0, now() - progressAt) });
			} catch {
				// A failing warning callback must not block the cancellation path.
			}
			graceTimer = scheduleTimeout(() => {
				graceTimer = undefined;
				if (disposed || cancelled || waiting || !warningActive) return;
				warningActive = false;
				cancelled = true;
				clearTimers();
				callbacks.onCancel({ silentMs: Math.max(0, now() - progressAt) });
			}, config.graceMs);
			graceTimer.unref?.();
		}, config.inactivityWindowMs);
		inactivityTimer.unref?.();
	};

	const guard: StallGuard = {
		observeChildEvent(event) {
			if (disposed || cancelled) return;
			const classified = childEventStallProgress(event, streamSnapshot);
			streamSnapshot = classified.snapshot;
			if (!classified.progress) return;
			const silentMs = Math.max(0, now() - progressAt);
			progressAt = now();
			if (warningActive) {
				// Real progress arrived during the grace window: cancel the warning
				// and the pending cancellation, then re-arm a fresh full window.
				warningActive = false;
				if (graceTimer) {
					clearScheduled(graceTimer);
					graceTimer = undefined;
				}
				try {
					callbacks.onRecovered?.({ silentMs });
				} catch {
					// Recovery reporting is advisory; the re-arm below must still happen.
				}
			}
			armInactivity();
		},
		setCoordinationWait(next) {
			if (disposed || cancelled || next === waiting) return;
			waiting = next;
			if (waiting) {
				// Suspending also withdraws any warning in flight and its pending
				// cancellation: a drain/coordination pause is not a recovery, but the
				// episode restarts cleanly (with a fresh warning) if the run resumes
				// and goes silent again. Without this the stale warningActive flag
				// would leave the guard inert for the rest of the run.
				warningActive = false;
				clearTimers();
				return;
			}
			// Waking from a coordination wait grants a fresh interval: the elapsed
			// silence before the wait must not count against the child.
			progressAt = now();
			armInactivity();
		},
		isWarning: () => warningActive,
		dispose() {
			if (disposed) return;
			disposed = true;
			warningActive = false;
			clearTimers();
		},
	};
	// The window runs from creation, so startup silence and a child that never
	// gets its first token are covered by the same policy.
	armInactivity();
	return guard;
}
