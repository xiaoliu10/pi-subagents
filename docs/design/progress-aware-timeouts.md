# Longer subagent deadlines with progress-aware stall protection

Date: 2026-10-19. Status: implemented on `fix/progress-aware-subagent-timeouts` (see "Implementation reconciliation" below); opt-in by default and disabled for everyone until enabled in config.

## Intent and authority

The operator selected a local global default of two hours, a checkpoint ten minutes before that deadline, and a plugin-layer improvement covering both CLI and Desktop. Do not merge, publish, replace the installed package, or kill live tasks. Preserve existing workspace changes in the source checkout by using this isolated worktree.

## Current implementation (local source evidence)

- `src/runs/foreground/subagent-executor.ts`: standalone foreground and async single launches resolve configured `timeoutMs`, falling back to thirty minutes.
- `src/runs/background/async-execution.ts:buildAsyncRunnerSteps`: composite steps currently use `agent.defaultTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS`; changing the global standalone setting alone does not cover all children.
- `src/runs/shared/subagent-control.ts`: activity and open-tool monitoring emits attention notices, not termination. Thinking levels scale the default quiet threshold.
- `src/runs/foreground/execution.ts` and `src/runs/background/run-child-session.ts`: hard per-tool timers and bounded abort/settlement paths already exist. Prefer reusing these termination paths over inventing process killing.
- `src/runs/background/subagent-runner.ts`: status heartbeat and output activity are separate; writing status or touching a watcher must not count as productive child work.
- Global config path: `~/.pi/agent/extensions/subagent/config.json`. Owner settings now request `timeoutMs: 7200000` and `checkpointBeforeDeadlineMs: 600000`. Config source load verified those values. The installed-package direct import could not resolve a peer dependency outside the normal Pi loader; no claim of live-process reload is made.

Data flow: launch defaults -> agent/call deadline resolution -> child runtime events -> attention/stall monitor -> existing abort + bounded settlement -> failed/timedOut receipt + preserved partial output.

## External research (primary sources)

- https://github.com/nicobailon/pi-subagents/issues/1157 describes active workflow validation being killed at 1800000ms despite a longer workflow limit. Avoid independently hidden short child defaults.
- https://github.com/nicobailon/pi-subagents/issues/978 documents inherited background pipes hanging a child indefinitely. Removing all deadlines is not acceptable.
- https://github.com/nicobailon/pi-subagents/pull/2199 proposes opting out of inference deadlines for local inference; closed without merge. Slow model queueing is not proof of a deadlock.
- https://github.com/edxeth/pi-subagents README distinguishes total timeout from idle timeout and explicitly warns that a silent build looks like a stuck tool. Inactivity is a policy threshold, not a proven deadlock.

## Options

1. Only increase total deadline: minimal configuration and immediate benefit, but a wedged tool can still waste two hours; does not cover all composite defaults.
2. Add an opt-in progress-aware inactivity guard at the delegation layer and fix child deadline default resolution: recommended. Reuse existing cancellation and receipts; do not invent a Desktop-only polling layer or kill unrelated processes.

## Safety and acceptance contract

- Explicit call/agent deadlines retain priority; global defaults must reach ordinary workflow children without accidentally creating a top-level composite deadline. Document parent remaining-budget behavior separately from child default behavior.
- Opt-in stall policy; no silent behavior change for other users. A proposed initial inactivity window is 30 minutes followed by a visible two-minute grace warning. Keep the total two-hour cap independent.
- Meaningful streamed model output, completed tools, and real tool progress reset inactivity. Status heartbeat, polling, repeated identical metadata, and mere process existence do not.
- Waiting for supervisor/user decisions or background coordination is not a stall. Avoid a suspended timer firing immediately when that wait ends; grant a fresh interval.
- Warn before stall cancellation; make a best-effort checkpoint request if supported. Cancellation must target the child attempt, preserve partial output, state the timeout cause, dispose timers/listeners, and not claim successful completion or proven process death.
- The policy cannot perfectly distinguish silent legitimate tools from deadlock. State that limitation; explicit per-call longer policy or disabling stall protection must remain possible.
- Blocking the host event loop cannot be reliably policed by an in-process timer. Do not claim this guard solves every WASM/process wedge.
- Test progress refresh, repeated metadata, coordination wait, startup/silence, cleanup, separate wall deadline, foreground/background parity, workflow config inheritance and explicit overrides. Use short/fake clocks, never thirty-minute sleeps.

## Rollout

1. Immediate local config (already written); validate actual resolver and short simulated launches without touching live runs.
2. Isolated branch implementation, focused tests, integration validation, independent review, OPEN PR in the user's fork. No release without explicit authorization.
3. Only after a published/approved package is installed, enable new stall settings locally and verify lifecycle behavior. Existing thirty-minute runs are not retroactively extended.

## Implementation reconciliation (what actually shipped)

Verified against the code on this branch; where behavior differs from the proposal above, this section is authoritative.

### Deadline defaults

- `buildAsyncRunnerSteps` resolves each runner child's deadline as `agent.defaultTimeoutMs ?? config.timeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS` (30m backstop kept for unset config). `executeAsyncChain` and both executor call sites (fresh/resume chains and management appends) pass the resolved `config.timeoutMs` down. The runner still caps every child at the parent composite's remaining budget (`runSingleStepWithTimeout`), and async composites still have no default top-level deadline.
- Scripted-workflow `runs.run` children already inherited the config default through the single-agent launch resolver (`resolveSingleAgentLaunchTimeout`) for async children and the foreground workflow-child path for `async: false`; covered by existing tests, no change needed there.

### Stall policy (opt-in, `control.stallProtection`)

- One shared state machine (`src/runs/shared/stall-guard.ts`) used by both `src/runs/foreground/execution.ts` (foreground, warning via the existing `needs_attention` control event with reason `stall_warning`, cancellation via the existing tool-timeout terminate path) and `src/runs/background/run-child-session.ts` (runner children, warning line into the step output log/progress tab, cancellation via the existing `terminateForTimeout` → abort + bounded settle). No process killing; receipts are `timedOut` with the inactivity cause and preserved partial output.
- Progress classification lives in one tested helper: changed assistant stream content, completed messages (including tool results and delivered steers), and tool start/end per `toolCallId`. Watchdog/status heartbeats, turn/agent/compaction bookkeeping, provider retries, and byte-identical repeated stream updates never reset the window. Startup silence and no-first-token are covered from guard creation.
- Coordination tools (`contact_supervisor`, `intercom`, `bg_wait`) suspend the policy while open, and so does an open nested `subagent` delegation call (the nested child is itself bounded and carries its own policy); wake grants a fresh full window. The graceful final drain (`agent_settled` / terminal assistant stop) also suspends — the drain and hard-finish timers own that bounded wait — and a compaction retry that resumes the run re-arms a fresh window.
- Config resolution follows the existing control ladder: per-call `control.stallProtection` replaces the global value wholesale (including an explicit disable); invalid shapes fall back like other control knobs; the resolved policy is frozen and flows to child runtimes through the existing `controlConfig` plumbing, and async recovery descriptors validate `stallProtection` strictly. `enabled` must be exactly `true`.
- Deliberate deviations from the proposal: **no automatic checkpoint steer before a stall cancellation** — injecting a prompt into a possibly healthy child derails it on a false positive; the visible warning is the signal. And the wall deadline was never at risk: it stays independent and authoritative (tested with progress flowing).

### Honest unsupported scope (do not claim otherwise)

- Inactivity is a policy threshold, not a proven deadlock. A silent healthy build, a slow provider, or a codemode script wrapping a supervisor wait is indistinguishable from a wedge by events alone. Per-call longer `timeoutMs` does not disable the policy; disable `control.stallProtection` for that call instead.
- External CLI and external job runner children are unwired: no trustworthy per-tool progress signal exists, so the policy is not applied and never silently claimed for them. Wall deadlines and runner controls still bound them.
- A child that blocks the host event loop cannot be policed by any in-process timer; abort does not prove descendants exited and cannot recover a blocked host.

### Validation

- New tests: `test/unit/stall-guard.test.ts` (state machine + classifier + resolution), `test/unit/stall-runtime.test.ts` (real foreground `runSync` and background `runChildSession` seams with the repository's factory mocks: true stall cancel with partial output, healthy long work, coordination-wait suspend + fresh window on wake, wall deadline authority, startup silence, no-opt-in behavior unchanged), `subagent-control` resolution/freeze cases, and `async-execution` config-default cases that fail under the old hidden-30m behavior (verified by temporarily reverting).
- Initial implementation validation: `npm run typecheck` clean; unit failure names matched the pristine base. The final integration run passed (1231 passed, 0 failed; 1239 total including skips). Subsequent review-fix validation is recorded below.


## Independent review fixes and known follow-ups

- Warning-in-flight suspension now clears `warningActive` and both timers. A resumed drain/compaction starts a fresh window and warning episode; the defensive stale-warning branch re-arms instead of returning inert. Both real hosts have warning-in-flight drain and compaction retry tests. Temporarily restoring the pre-fix guard makes both compaction retry tests fail (still running after 2s); restoring the fix makes them pass with two warnings and a timed-out receipt.
- Foreground guard creation depends on `control.enabled !== false`. Recovery invokes `onRecovered`, clears foreground stall attention state, and allows active notices again; historical warning events are not erased. New stall episodes bypass lifetime control-event dedup because the guard already deduplicates per episode. Background warnings remain output-log / progress-tab only, with no stall ControlEvent or notification.
- Async recovery descriptors reject explicit invalid/out-of-range timer values, then normalize through `resolveStallProtection` to supply missing defaults and freeze the policy. Foreground abort and background interrupt win over late stall callbacks during bounded settlement.
- Known test follow-ups (not claimed complete): some existing short-clock assertions use 20–50ms real-time margins and may flake on overloaded CI; migrating them to deterministic fake clocks would improve reliability. Executor pass-through wiring (management append / resumed chain into the builder) is code-inspected, not directly exercised by a full executor-wiring test; builder default/override coverage is not a substitute for that missing test. The focused runtime tests exercise factory mocks, not live model/network sessions.
- Review-fix validation: the requested focused unit suites (`stall-guard`, `stall-runtime`, `subagent-control`, `async-execution`, `timeout-defaults`, `run-child-session`, `tool-timeout`, `foreground-control`, `control-notices`) plus `async-recovery-descriptor` passed 166/166 on three consecutive runs; `npm run typecheck` and `git diff --check` passed. Logs: `/tmp/progress-review-focused.log`, `/tmp/progress-review-focused-{2,3}.log`, `/tmp/progress-review-typecheck-final.log`. Old-guard red control: `/tmp/progress-review-p1-old-red.log` (2 expected failures: foreground/background retry protection). The full unit and integration suites were not re-run for this follow-up; prior full-suite results above belong to the initial implementation only.
