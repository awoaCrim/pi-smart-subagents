# pi-subagent UX

## Overview
The standalone pi-subagent provides rich TUI support for monitoring, inspecting, and interacting with isolated subagent runs (single and parallel modes): inline streaming blocks, a terse footer, an ambient widget for background runs, batched completion notifications, mid-run steering, a worktree apply loop, and the `/subagents` inspector. UI logic is kept independent from `runner`/`registry` via small structural adapters (`SubagentAdapter`).

## Design principles

1. **Pi's tool shell owns state signaling.** The Box wrapper paints
   `toolPendingBg` / `toolSuccessBg` / `toolErrorBg`, so inline blocks do not
   repeat state words or draw their own success/error framing.
2. **Cost is a per-run attribute, not a competing ledger.** Dollar cost appears
   inside the run's own result block; the parent/children/combined ledger is
   available on demand via `/subagent-cost`, in `status` tool output, and in the
   `/subagents` overlay header. The footer never shows cost.
3. **Fixed-height, mutate-in-place progress.** Streaming blocks keep a stable
   shape (stats line + one `⎿ activity` line; parallel adds one line per task)
   and the same component identity is reused across partial renders.
4. **Trailing-edge streaming flush.** Structural updates (state transition, new
   session id, billed turn) emit immediately; live-text bursts coalesce with a
   deferred flush so the last update of a burst always lands.

## Surfaces

### Inline tool block (foreground runs)
- `renderCall` is exactly one line: `subagent <task preview>` (or
  `N parallel tasks — first task…`, `wait a1b2c3d4`, `… · background`).
- `renderResult` while streaming (fixed shape, spinner animates via wall-clock
  frame; Pi's working indicator drives repaints):
  ```
  ⠹ ↻3 · 12.4k tok · 8s
    ⎿ reading src/auth/middleware.ts…
  ```
- Terminal single run:
  ```
  ↻8 · 33.8k tok · $0.012 · 12s
    ⎿ Found 5 middleware call sites…
    → /tmp/report.md
  ```
- Parallel: one line per task with a themed state glyph
  (`◌ queued · ⠹ running · ✓ done · ✗ failed · ◐ partial · − cancelled · ◷ timeout`),
  per-task stats, and a one-line tail (live activity or first output line).
- Expanded (Ctrl+O / `app.tools.expand`): full task output capped with a dim
  `… +N lines` trailer pointing at the artifact/child session.
- Expanded detail adds a bounded route summary for Jev-routed runs: original selection, ranked probabilities, shared selected tools (plus locally added control-plane tools), selector version, answer-level confidence, outcome and selection latency. The actual execution model stays separate from the original choice. Large lists show a preview and total count; old runs without new fields remain readable. Compact results and completion notifications show at most the last five attempt models and label a shortened chain with its total attempt count.
- Durations freeze at `endedAt`; running durations tick at render time.
- Reliability annotations render inline: `[attempt 2]` during retry/failover, the actual attempt model and bounded attempt chain, `[stalled 2m]` while the stall watchdog is flagging silence, and `◐ wrapped up` on budget-stopped runs that concluded gracefully. Availability failures can switch models only before tools begin; a stalled indicator is not a promise of another attempt.

### Footer status
Terse and actionable only: `⚙ 2 running · 1 ready · /subagents`. Cleared when
nothing is running or ready. No cost — Pi's footer already shows session cost.

### Ambient widget (background runs only)
An above-editor widget renders while `async: true` runs are live — foreground
runs already render inline as the tool result, so they never appear here
(avoids double-render):

```
● Subagents
├─ ⠼ Audit deps · ↻4 · 18k tok · 41s
│   ⎿ checking license headers…
└─ ◌ License scan · 12s
```

Cleared when the last background run settles. Spinner and elapsed animate on
a 250ms interval that exists only while background runs are live.

### Completion notifications (background runs only)
When an async run reaches a terminal state, a `steer` message (custom type
`subagent-completion`) is queued for the parent LLM before its next LLM call,
so it can react without polling. The human sees a themed compact box (state
glyph, label, stats, one-line preview, artifact pointers); the LLM sees plain
text with run ids and a `wait { id }` pointer.

- Successes within a short window batch into one message (no fanout spam);
  failures bypass batching and flush immediately, carrying held successes.
- A `wait` that already delivered the run suppresses the redundant
  notification (delivered-state is re-checked at flush time).
- Model/attempt annotations use the actual execution history, not the immutable original Jev choice. Fallback creates no extra completion notification or delivery path.

### `/subagents` overlay
- Header: title + running/ready counters + full usage ledger + rule.
- List: two lines per run — glyph/id/state/stats, then the task preview.
  Selection cursor `▶`, animated spinner for live runs.
- Detail: run stats, summary, then per-task sections (glyph, label,
  model/selector route/profile/thinking, usage, pointers, transcript/final
  output/errors), scrollable with ↑↓/j/k and PageUp/PageDown.
- Actions: `c` cancel, `s` steer (prompts for a message, injects it into the
  running child), `d` dismiss, `r` resume, `o` output pointers, `a` apply a
  finished run's changed worktree into the main checkout (confirm dialog),
  `x` discard worktree + branch (confirm dialog), Enter drill-down,
  Esc/b back, Esc/q close.
- Live transcript (`t` on a **running** run's detail): tails the child's
  session file (`sessionDir/<…sessionId…>.jsonl`) on a 500ms poll while the
  pane is visible — compact role/tool lines, auto-follow unless you scroll
  up (which pauses follow). No RPC reads; hidden/finished runs never poll.
  Missing file shows “waiting for child session…”. `s` steering still works
  from the same pane so observe → steer stays on one surface.

### `/subagent-cost`
Prints the root/subagents/routing/combined ledger once, on demand. Routing
tokens appear as their own category and their currency as unreported; the known
dollar totals exclude that unreported selector spend.

### Mid-run steering
Children run in Pi RPC mode, so their stdin stays open as a command channel.
`action: "steer"` (or `s` in the overlay) queues a message that is delivered
after the child's current assistant turn, before its next LLM call — course
correction without cancel + retry. Parallel runs steer one task via `index`.

### Worktree loop
Finished runs with changed worktrees support `diff` / `apply` / `discard`
actions (tool) and `a` / `x` keys (overlay). `apply` lands the worktree's
combined patch (committed + uncommitted + untracked vs base) onto the main
checkout as **uncommitted working-tree changes** via `git apply --3way`; it
never commits and never deletes the worktree. `discard` is the explicit
cleanup step and always confirms first.

### Parallel fan-in
`synthesis: "<instruction>"` on a parallel run asks for one read-only child
after all tasks settle that folds their outputs into a single brief, delivered
first in the result. It is best effort and deferred: its route is selected only
when aggregation is actually needed after the workers finish, so it never blocks
worker launch. A selector or child failure keeps the raw worker outputs, their
usage and a bounded `Optional synthesis blocked: …` diagnostic instead of
discarding or re-routing them.

### Plan results (tool output, not TUI)
`action:"plan"` returns the initial model, a bounded probability-ranked candidate preview, common tools, effective total attempt limit and selector usage. Probabilities are selector preferences, not uptime estimates, and `confidence` belongs to the original answer. A plan reports no actual attempts; a later invocation selects again. It starts no child and creates no run entry, so plan never adds an overlay row or ambient widget. A plan whose optional synthesis selection fails still returns the valid worker plan and labels only that stage blocked with its diagnostic.

### Failed-attempt output

Earlier attempts retain bounded, attributed output previews and child-session pointers. If all attempts fail, the final state, failure reason, model and session stay authoritative; earlier text does not become that model's answer or a successful structured result. A human-readable earlier preview names its source attempt. Successful final JSON is never concatenated with failed JSON. Full output remains in existing child sessions, which are retained while referenced on the active branch. Compact views remain within their existing output limits.

## States
- **Queued/Running**: spinner + live stats + activity tail from live text.
- **Completed/Partial/Failed/Cancelled/Timeout/Lost**: state glyph, frozen
  duration, usage summary, output pointers; failures show the error message.
- **Delivered vs Undelivered**: footer/overlay track pending delivery.
- **Notification**: one per terminal transition to avoid spam.

## Integration Notes
- Extension wires via `ctx.ui.custom((tui, theme, kb, done) => createSubagentsOverlay(tui, theme, adapter, done), {overlay: true})`.
- Adapter provides getActiveRuns/getCompletedRuns/cancelRun etc. without tight coupling.
- Inline renderers reuse `context.lastComponent` (a `LineBlock`) so the row keeps
  a stable component identity across partial renders.
- Streamed tool updates separate LLM-facing `content` (compact status string)
  from render-facing `details` (state, usage, live-text tail, run timing).
- Tests combine pure UI models with a headless Pi extension harness: format
  helpers, block layouts (collapsed/streaming/terminal/parallel), navigation,
  truncation (ANSI-safe via `visibleWidth`), ready state, lifecycle/disposal.
- Follows Pi TUI guidelines (render(width), handleInput, invalidate,
  requestRender, dispose). The overlay owns a single animation interval.

See ARCHITECTURE.md for ownership boundaries. All rendering respects terminal width and ANSI safety.
