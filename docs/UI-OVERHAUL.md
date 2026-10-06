# Subagent UI design rationale

This document records the implemented presentation choices. The current layouts,
controls and lifecycle contract are described in [UX.md](UX.md). Earlier phased
plans are superseded; they should not be read as claims that SelectList,
DynamicBorder, custom inline timers or a repository-wide test runner exist.

## One grammar across existing surfaces

Foreground results, background widgets and completion cards share task identity,
explicit child state/time, activity or result, reliability notes and secondary
metrics. Management receipts use the same vocabulary while describing the
operation itself. The inspector provides deeper evidence; the footer stays a
small running/ready indicator. No dashboard, new keybinding or user setting is
introduced.

Pi's tool shell indicates whether the tool call succeeded. It cannot distinguish
an accepted cancel request from a stopped child, or a successful status lookup
from a failed observed run. Explicit child state is therefore intentional, even
inside a success-coloured shell. A completed review can still report issues.

Stats follow the answer rather than preceding it. `turns` and `tokens (in+out)`
replace unexplained compact symbols. The actual execution model appears once in
a compact single-task card; full model, original route and attempt history belong
in expanded detail. Models from separate parallel tasks are not a retry chain.

## Stable live output, immutable history

Foreground streaming keeps the host's reusable `LineBlock` and reserves live
slots. The host working indicator drives repaints; the inline renderer does not
own a permanent timer. Terminal durations use `endedAt`, while captured
management snapshots use their observation time. Missing historical timestamps
do not become a new live clock when a transcript is reopened.

The TUI background widget is a width-aware component, installed once per live
period and repainted through `tui.requestRender()`. Replacing a widget through
`setWidget()` disposes the previous component in Pi; it must not be used as a
repaint primitive. RPC gets string rows and a separately owned refresh timer.

## Evidence before decoration

Compact previews clean only unambiguous Markdown scaffolding. Expanded output
uses Pi's Markdown renderer; diagnostic text and operation evidence use raw
wrapping so patch syntax survives. A diff/apply/discard result never substitutes
the child's earlier answer. Every additional display cap identifies omitted
lines and the existing full-evidence source.

At narrow widths state and short ID take priority over optional metrics. The
inspector measures entries in terminal rows, not run counts, to keep selection
inside the host's clipped viewport. Full identifiers and evidence remain
scrollable in details.

## Visible ownership is not delivery

Foreground output stays inline; only background runs enter the ambient widget.
Completion cards replace redundant TUI terminal toasts. Notifications-off and
RPC retain their alert fallback. `/btw` keeps private `appendEntry` delivery.

These are display choices. Completion batching, flush-time wait suppression,
`triggerTurn`, full-result `markDelivered`, native usage attachments, execution,
routing and safety policy remain in their existing owners. Rendering must never
mutate any of them.

## Verification boundary

The reusable offline harness checks real extension registration and management
execution with fake provider/process/worktree boundaries, plus real Pi TUI
width handling and Box padding. It covers both completion/wait orders, private
entries, timers and short inspector viewports. It does not prove live terminal
appearance or provider execution, and esbuild syntax checks are not a semantic
typecheck. See [DEVELOPMENT.md](DEVELOPMENT.md).
