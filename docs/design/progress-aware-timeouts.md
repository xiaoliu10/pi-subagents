# Longer subagent deadlines with progress-aware stall protection

Date: 2026-10-19. Status: implementation proposal approved in principle by the operator; exact runtime behavior must be verified before shipping.

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
