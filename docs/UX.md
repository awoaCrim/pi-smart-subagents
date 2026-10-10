# pi-subagent UX

The extension uses Pi's native tool blocks, an above-editor background widget,
completion messages, a terse footer and the `/subagents` inspector. The stateful
surfaces consume registry projections through adapters; rendering does not own
execution, routing, delivery or accounting.

## Shared layout

Cards read in this order: task identity, explicit child state and duration,
activity/result/operation, reliability notes, then low-emphasis metrics. Pi's
shell still owns the tool-call background. A successful management call can
observe a running or failed child, so the child state is stated separately.

A foreground result at a typical terminal width looks like this (the first line
is Pi's tool-call header):

```text
subagent Review ready weapon semantics
✓ done · [9c933a98] · 7m11s
  ⎿ Found 2 P2 issues; no P0/P1. Fix before delivery.
  gpt-6-sol · 24 turns · 192k tokens (in+out) · $0.42
```

`done` describes execution, not a clean review verdict. Task labels prefer the
request's `description`; unlabelled calls use a bounded task preview. Models are
abbreviated in compact views and fully identified in expanded details. Turns and
tokens are labelled: `tokens (in+out)` is accumulated input plus output, not the
context-window size or cache total. Reported cost is retained; missing cost is
not interpreted as free usage. Selector currency remains unreported.

Every line is ANSI/terminal-width bounded. Narrow views drop secondary metrics
before state and short ID; expanded details retain full identifiers and usage.
Compact Markdown previews remove unambiguous headings, bullets, fences and
emphasis while preserving identifiers, paths and operators. Full output is not
rewritten. Expanded child output and `/btw` answers use Pi Markdown; raw operation
evidence, errors and transcripts wrap without interpreting diffs as Markdown.

## Foreground tool blocks

- The one-line call header shows the label, parallel task count, resume target or
  management action. `subagent_wait` has its own header even while arguments are
  incomplete.
- Streaming reuses the same component. Body, reliability-note and metrics slots
  are reserved at a given width so arriving output does not grow the block.
  Parallel views keep bounded per-task rows and an explicit hidden-task count.
- State words are `queued`, `running`, `done`, `partial`, `failed`, `cancelled`,
  `timeout` and `lost`. Failed/lost diagnostics, timeout phase, wrap-up reason,
  retry/stall/schema notes and effective-thinking differences stay visible.
- Live inline durations tick only while the host marks the result partial.
  Terminal durations freeze at `endedAt`. Immutable status/wait snapshots freeze
  at observation time, including stall age. Old snapshots without a usable clock
  omit duration instead of inventing an observation time.
- Expansion uses Pi's `app.tools.expand` binding (normally Ctrl+O). It adds full
  model identifiers, bounded route/attempt/capability diagnostics, usage,
  artifact/session/worktree pointers and wrapped output. Output caps show a
  remainder and point to the existing artifact or child session.
- Hard execution errors still throw and use Pi's error channel. Legacy or
  malformed result details fall back to the original textual content. Errors
  handled before an extension renderer runs remain owned by the host.

Structural streaming updates still emit immediately. Live-text bursts retain
trailing-edge coalescing; this presentation layer does not change that policy.

## Management and launch receipts

Async launch says **Started in background** and supplies the full run ID, without
claiming completion. If the run settles during startup accounting, the receipt
shows that captured terminal state and asks for `wait`, without consuming the result.
Plan says **no child spawned**; selection can still incur Jev charges, and dispatch
selects again.

Task `timeout_ms` is an advisory threshold. An overdue foreground call returns an
**Elapsed handoff** receipt with the same full ID and truthful queued/running evidence;
work continues in background ownership. An already-returned async run instead gets
one plain parent steer reminder. Parallel uses the shortest resolved item threshold
for the unfinished group; pending synthesis is identified separately from finished
workers. Reminder receipts/messages are not `timeout`, completion or final delivery,
and grant no renewed budget or paid-call allowance. Use status/wait/steer/cancel.
After transfer the old initiating signal no longer cancels work; explicit cancel
and session/tree shutdown still do.

`status` is an explicitly labelled captured observation. `status` without an ID
lists runs and the ledger; expand to inspect the full text. A completed `wait`
uses the ordinary result card. Timed-out/aborted waits and already-delivered runs
use receipts and retain their actual lifecycle: stopping a wait does not cancel
a child.

`steer` confirms a message was queued for delivery after the current turn, not
that the child has read it. `cancel` confirms a request, not completed shutdown.
`diff`, `apply` and `discard` show operation evidence instead of an old child
answer, including for parallel runs. Expanded evidence comes from the existing
capped tool content. Historical structured output does not replace live or archived
diff evidence; the original JSON result remains available through status/wait.
An additional visual cap has an explicit remainder and full-evidence pointer;
underlying output/artifact limits remain unchanged.

Apply lands changes as uncommitted working-tree changes and preserves the
worktree/archive. Warnings remain visible. Discard is explicit cleanup. Inspector
apply/discard actions ask for confirmation; tool actions follow their existing
explicit-request semantics.

## Background widget and completions

Live parent runs transferred by `async:true` or elapsed foreground handoff appear
above the editor; still-awaited foreground runs stay inline. Private `/btw` is excluded.
The widget uses the same identity/state/body/metrics order, short run IDs and
explicit hidden run/task counts. It shows at most four runs and two task rows per
parallel run. Unfilled live slots are intentionally reserved.

The TUI installs one width-aware component. Its single 250ms timer requests
repaints without reinstalling the widget. When no background run remains, or on
teardown, the widget and timer are cleared. RPC uses bounded string rows because
RPC does not render component factories.

Elapsed reminders are one-shot `subagent-reminder` steer messages, separate from
completion batching and the completion-only `notifications` setting. With
`notifications: "off"`, overdue reminders still reach the parent; completion
messages remain off. A foreground handoff receipt is not duplicated as a reminder
message, and a completed/cancelled run gets no false overdue reminder.

On completion, the parent receives the existing `subagent-completion` message
with `{ deliverAs: "steer", triggerTurn: true }`. Successes batch; failures flush
immediately. The human card shows the shared layout, known cost and per-task
outcomes. Expand for full model identifiers, bounded attempt history and
pointers; `/subagents` opens the inspector. The human card omits the developer
JSON collection hint; the model-facing message retains it.

A wait that consumes the run before the batch flush suppresses the redundant
message. A completion notification does not consume full-result delivery or
native usage; wait keeps its existing once-only delivery gate. Rendering never
marks a run delivered.

TUI terminal toasts are quiet when the inline result or completion card owns the
visible outcome. Background runs with notifications disabled retain a terminal
alert, including failures. RPC retains terminal alerts because it cannot draw
these custom cards. Action errors and worktree warnings are not suppressed.

## Footer and inspector

The footer shows only actionable counts:
`⚙ 2 running · 1 ready · /subagents`. It clears when nothing is running or ready.
The ledger is available in `/subagent-cost`, `status` content and the inspector
header, without competing with Pi's native cost footer.

`/subagents` shows task-first identity, state/time, then metrics. List capacity is
computed from actual entry heights within the overlay's 80% terminal-height
budget. Overflow counts and keyboard navigation keep the selected run reachable;
very short terminals use a one-line entry. Details page through full identifiers,
route/attempt/capability metadata, usage/cache breakdown, diagnostics, pointers
and transcript/output.

The tool surface defaults to compact; this is separate from compact visual layouts. In compact mode, session/output pointers remain visible, but resume help explains that `toolMode: "full"` plus reload/restart is required. Sessions with unverified ownership remain labelled `resume blocked` in status under either mode; changing mode does not clear that safety state. The inspector's `r` action warns instead of placing an unavailable resume request in the editor. Full mode retains the existing resume action. Finish active tasks before reloading; changing the config alone does not switch modes.

Existing keys remain:

- ↑↓ or j/k: select or scroll; PageUp/PageDown: detail scrolling.
- Enter: details; Esc/b: back; Esc/q: close the list.
- c: cancel; s: prompt for a steering message; d: dismiss; r: prepare resume;
  o: output pointers; a/x: confirmed apply/discard of a finished worktree.
- t in active-run details: toggle the live transcript. It polls the child session
  file every 500ms only while visible, follows the tail until scrolling upward,
  and stops on completion, exit or disposal. Missing files show a waiting state.

## Private `/btw` entries

`/btw` uses the same title/state/body order without inventing model, run or usage
fields absent from its payload. Running and answer entries remain separate
`appendEntry` events, hidden from the parent model. Expanded answers wrap in full.
At the advisory threshold, a human-only notice says the private answer is still
pending. It neither marks the entry done nor sends a parent reminder/completion.
The private TUI entry owns its final outcome, avoiding duplicate terminal toasts;
non-TUI notifications retain their existing behavior.

## Verification

`checks/render-harness.mjs` exercises shared formatting and actual extension
registration/execution against deterministic boundary fakes. It checks narrow
CJK/ANSI output, host Box padding, frozen snapshots, stable component/timer
lifecycle, inspector viewports, management evidence, notification/wait ordering,
usage delivery and `/btw` privacy. It does not call Jev or a provider and does not
replace a live interactive terminal check or semantic TypeScript checking.
See [development](DEVELOPMENT.md) for the command and dependency requirements.
