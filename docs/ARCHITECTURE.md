# Architecture contract

`pi-subagent` is split by ownership boundary:

- `runner.ts`: one child process, Pi RPC protocol (JSONL commands on stdin, events on
  stdout — a superset of `--mode json`), cancellation, process trees, budgets, and a live
  stdin command channel used for mid-run steering. Extension UI dialogs from headless
  children are auto-cancelled so they can never hang a run; stdin is closed after
  `agent_settled` so RPC children shut down cleanly. Budget breaches steer a wrap-up
  message and allow grace turns before SIGTERM (`wrappedUp` marks a clean conclusion).
  A stall watchdog flags protocol silence, probes liveness via `get_state`, and kills
  after a second window so retry can take over. Group kills verify process start-time
  identity (Linux `/proc`, macOS/BSD `ps lstart`) before signalling a possibly-recycled
  PID; transcript joins happen only on message boundaries, not per-chunk ticks.
- Retry lives in [orchestrator.ts](../src/orchestrator.ts). Ranked extension tasks advance through a locally finalized Jev candidate plan only for recognized settled availability failures before any current-invocation tool starts. [model-failover.ts](../src/model-failover.ts) owns conservative evidence classification and bounded attempt helpers. Tools stay fixed, thinking resolves per candidate, and usage accumulates once. Unknown execution evidence blocks restart. The trusted unranked SDK retains its separate `isTransientFailure` and explicit fallback contract.
- `context: "fork"` spawns the child with `--fork <parent session file>` so it starts
  from a real branched copy of the parent conversation. Fail-fast when the parent
  session is not persisted; single-task only.
- `registry.ts`: one parent-session runtime, run state, snapshots, resume locks, and the
  single LiveRun→snapshot/persisted-result projections used by every consumer.
- `semaphore.ts`: per-parent-runtime child-process limit.
- `process-lock.ts`: machine-wide durable coordination under `~/.pi/subagent-locks/` —
  exclusive per-child-session resume locks, global concurrency slots, and run process
  identity records for orphan reconcile. Ranked tasks keep one record running across attempts and final artifact/worktree work; the orchestrator terminalizes it once. A bounded list of attempt sessions protects earlier transcripts from other parents' maintenance while the task is live.
- `launch.ts`: resolve the child `pi` invocation via `PI_SUBAGENT_BIN` or
  `process.execPath` + CLI entry (bare PATH name only as last-resort fallback).
- `persistence.ts`: versioned active-branch event folding, the bounded routing-event decoder
  (`subagent-routing-v1`), and bounded child transcript metadata.
- `maintenance.ts`: filesystem GC (session files) and abort-race helpers; kept out of persistence.
- `usage.ts`: provider-reported root/subagent/combined accounting, plus a separate
  once-per-request routing-token category whose currency is reported as unreported.
- `policy.ts` / `schema.ts`: discriminated request validation and safe capability profiles. `schema.ts` retains the canonical TypeBox validators and derives provider-safe tool-schema projections; `extension.ts` registers those projections while validating calls with the originals. Pi context-management control-plane tools remain available to child allowlists without granting project-file write access.
- `routing-types.ts` / `routing-policy.ts` / `jev-router.ts` / `dispatch-routing.ts`:
  the mandatory Jev route. `routing-types.ts` owns the selector DTOs, decision/receipt
  shapes and local resource limits; `routing-policy.ts` owns the strict `jevRouting`
  parser, the candidate intersection with locally available models, and the injected
  model-facing guidance; `jev-router.ts` owns the injectable TypeSafe transport,
  response validation, deadlines and per-request receipts, including a validated full probability ranking and model-independent task tool decisions; `dispatch-routing.ts` resolves every worker before any launch and refuses a partially selected fanout. Local policy finalizes a frozen candidate attempt plan with per-model thinking and one shared tool set. The router has no engine imports and makes no parent UI calls.
- `config.ts`: defaults ← `~/.pi/subagent.json` ← `PI_SUBAGENT_*` env overrides.
- `structured.ts`: structured-output contract (dependency-free JSON-Schema subset
  validation, fenced json:result extraction, contract/repair prompts) and
  conservative double-encoded-arg repair. The runner gates the child's settle on
  validation and runs one steer-based repair round after an otherwise successful invalid answer. Ranked provider-error/aborted attempts skip repair and cannot publish structuredOutput from failed text. The latest completed assistant text replaces earlier text even when empty, so a host retry cannot reuse the failed turn's JSON.
- `agents.ts`: named agent files (`.pi/agents/`, `.agents/agents/`, global agent dir).
  Flat-YAML frontmatter + markdown persona body; resolved in policy with explicit
  params > agent file > profile taskDefaults > parent inheritance. Catalog refreshes
  lazily (5s TTL) so new files work mid-session; symlinks and oversized files skipped.
- `notifications.ts`: background-run completion batching. Successes group within a
  debounce window (hard cap on hold time); failures bypass batching and flush
  immediately; delivered-state is re-checked at flush time so a consuming `wait`
  suppresses the redundant notification.
- `ui.ts`: renderers, footer status and `/subagents` inspector. The ambient widget
  (extension-side) shows BACKGROUND runs only — foreground runs render inline as the
  tool result, so widget display would double-render them.
- `extension.ts`: wiring only; no business logic. Nested children at the depth ceiling do
  not re-register the tool; only top-level parents run maintenance.

Invariants:

1. A run belongs to exactly one parent session key and cannot update another session.
2. No more than `maxActiveProcesses` children run per extension runtime, and no more than
   `maxGlobalActive` across every Pi parent process on the machine.
3. Cancellation prevents queued tasks from spawning.
4. A child session may have only one direct resume writer at a time, enforced by an
   in-memory lock *and* a durable file lock under `lockDir` that survives crashes and
   coordinates across independent parent processes.
5. Parallel write-capable tasks need isolated worktrees/distinct cwd or explicit unsafe opt-in.
6. Every tool response is globally capped to 50 KB / 2,000 lines; full data lives in artifacts/transcripts.
7. Status is compact; wait is the one-shot deliverable.
8. On shutdown or tree navigation, child runs are cancelled and awaited for a bounded grace period.
9. On startup, orphan process groups recorded under `lockDir` are reaped (SIGTERM then SIGKILL)
   before any matching child session is eligible for resume. `$state: "lost"` is a labeling
   that keeps `resumeBlocked` until reconciliation proves death.
10. Billed execution usage is folded once per root message and once per full child run UUID.
    Selector usage is a separate category folded once per selector request ID, with currency
    reported as unreported rather than inferred.
11. Checkpoint persistence events are lightweight (state, usage, process identity, pointers).
    Full transcripts and final output are persisted exactly once, in the terminal event. Ranked attempt histories carry bounded metadata/session pointers at checkpoints, with output previews only in terminal projections (1 KiB per preview, 16 KiB total). Active-branch retention includes earlier attempt session references.
12. High-frequency registry "changed" events coalesce (trailing window); state transitions,
    new child sessions, billed-usage advances, and terminal events flush immediately.
13. `wait` is interruptible: aborting a wait returns promptly and does NOT cancel the
    background run. Only `cancel` (or parent shutdown) aborts a run.
14. Budget stops (`max_turns`/`max_cost`) with at least one completed turn end as `partial`
    and deliver their output normally. Streams truncated after useful assistant output also
    end as `partial`. Timeouts report `state: "timeout"` with `timeoutPhase`.
15. `timeout_ms` covers the whole task, including semaphore queue time, but the phase
    (queued / starting / running) is recorded so agents can apply the right retry policy.
16. Worktrees live under a durable root (`~/.pi/subagent-worktrees`), never a purgeable OS
    tmpdir. Startup maintenance (top-level parents only) prunes stale git registrations,
    removes unchanged leftovers, and sweeps changed-but-expired worktrees. Live-run
    worktrees are always shielded. `include_wip` worktrees carry the parent's WIP patch in
    the handle: `diff`/`apply` subtract it when subtraction is clean and otherwise report
    the combined delta with an explicit `[includes parent WIP]` warning — never silently
    wrong; a worktree containing only the untouched WIP patch counts as unchanged.
17. Process-tree reaping after a clean exit can be disabled per task with `keep_background`
    (for legitimately backgrounded work such as dev servers); forced stops always reap.
18. Protocol completion prefers Pi's `agent_settled` event. Legacy `agent_end` without
    `willRetry` is accepted for older Pi builds; `agent_end` with `willRetry: true` is
    treated as non-terminal.
19. Depth and spawn-policy parsing fail closed on malformed values: env scrubbing cannot
    silently reset the depth counter to top-level, and a malformed `PI_SUBAGENT_SPAWNS`
    disables spawning rather than unrestricting it.
20. Budget breaches (`max_turns`/`max_cost`) steer a wrap-up message and allow grace
    turns before SIGTERM; a child that concludes within grace ends `partial` with
    `wrappedUp: true`. `graceTurns: 0` restores immediate stops.
21. Extension-managed ranked tasks permit at most `maxRetries` extra child attempts, locally capped at 255 total launches. A recognized settled availability failure advances to the next candidate only with conclusive no-tool activity; started or unknown activity blocks all new-child restart. Candidate exhaustion never wraps to the primary. Conclusively pre-work infrastructure retry may repeat the same candidate within the same budget. No retry calls Jev or broadens tools. Usage and budget comparisons include prior attempts. Authentication, quota/billing, invalid requests, context limits, task-quality, cancellation, task-deadline and budget stops do not cause model failover. The trusted unranked SDK keeps its legacy transient/explicit-fallback behavior.
22. The stall watchdog treats protocol silence as suspect, not fatal: after
    `stallAfterMs` the task is flagged and probed via `get_state` (a live child's
    answer clears the flag); only continued silence for `stallKillAfterMs` more kills
    the child. A stall does not authorize restart on the ranked path: silence cannot establish that no work began.
23. Only `async: true` runs notify on completion and appear in the ambient widget.
    Notification delivery respects delivered-once: a `wait` that consumed the run
    suppresses the notification. The actual final model and a bounded attempt-chain tail with its total count use the same display projection as compact results.
24. Named agent files supply per-field defaults only; explicit request params always
    win, and capability profiles fail closed regardless of what an agent file declares.
25. Structured-output validation never discards paid work: schema failure after the
    repair round downgrades completed → partial with `structuredError`, and the raw
    text still delivers. Validation is enforced on the parent side of the process
    boundary — the child cannot self-attest.
26. Arg repair only decodes free-text fields with high-signal escape patterns
    (literal \n or \") and no real newlines; identifier fields, tool lists, and
    Windows-path-like strings are never modified.
27. Global slots are depth-tiered: `tryAcquireGlobalSlot(runId, depth)` admits only while
    `activeAtOrBelowDepth(depth) < maxGlobalActive - reservedFor(depth)`, holding slots
    back for deeper tiers so a full-width spawn tree cannot deadlock on its own children.
    Slot records without a `depth` field count as depth 0.
28. `action: "plan"` is a truth oracle: it runs the exact validation, Jev selection and
    local preflights of a real spawn and returns the resolved plan and its selector usage
    without spawning. It creates no registry entry, and its fee-bearing selection is not
    cached for a later dispatch.
29. Every new extension-managed invocation (`task`/`tasks[]`, `action:"plan"`, `/btw`,
    resume, fork, nested dispatch and the optional synthesis child) crosses one selector
    interface before any child starts. The dedicated candidate list intersected with locally available models is the only source of execution models. One validated full probability ranking belongs to the invocation, and fallback reuses it without another selection. The original selectedModel/confidence remain immutable; result.model reports the actual attempt. The full locally permitted tool catalog is the only tool candidate source, and one model-independent selection is shared by every attempt. Legacy `model`/`fallback_models`
    fields are rejected on new work, and an empty selected tool set never becomes
    inheritance or "all tools".
30. The finalized tool subset is passed to the child as Pi's `--tools` allowlist
    (`--no-tools` when empty). Pi 0.86.0 is the verified baseline for built-in, extension
    and late-registered tool enforcement; a host that cannot honor the allowlist is
    refused rather than silently weakened, and no older release is advertised as
    equivalent.
    Startup verification is the enforcement companion: the Pi adapter supplies a
    package-local preflight extension plus a bounded non-secret expectation, verifies that
    the nonce-specific bootstrap command exists from the expected package source, then
    requires the child to acknowledge the exact selected model and finalized tool names
    (including nested-tool source) before the real task prompt is sent. Missing or
    mismatched acknowledgement is a capability/startup diagnostic, never compensated by broadening tools or choosing another model. Every ranked replacement gets its own exact-model/shared-tools acknowledgement before the task prompt.
31. An absolute task deadline is created before preflight/selection, and routing, setup,
    queue and retries all count against it. Pending selector work is tracked per session
    runtime, aborted on cancellation, shutdown or session switch, and every post-await
    transition re-checks captured runtime/session ownership so a late response cannot
    launch into a replaced session. Replacement attempts await prior child cleanup, retain run/worktree/resume ownership and recheck cancellation, deadline and cumulative task budgets before launch. Durable task records remain running during replacement and finalization, protecting all known attempt sessions and the worktree across parent processes; only child slots are released per attempt. Pi/provider internal retries and global retry settings remain unchanged.
32. Before any paid selection, plan and dispatch share a side-effect-free direct-resume
    availability check (in-memory owner, `resumeBlocked`, durable lock ownership and
    staleness) that acquires, renews or reaps nothing. Dispatch still takes the
    authoritative lock atomically at the existing launch point, and forked resumes skip
    the exclusive direct-resume check.
