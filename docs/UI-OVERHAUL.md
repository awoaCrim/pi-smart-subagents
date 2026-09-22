# UI Overhaul Plan — Pi-Native Rendering

> **Status: fully implemented.** All five phases are done (`src/format.ts`,
> `src/ui.ts`, `src/extension.ts`, `src/notifications.ts`). Deviations from
> the plan: the inline spinner uses a wall-clock frame (Pi's working indicator
> drives repaints, so no timer is owned); the ledger command landed as
> `/subagent-cost` via `ctx.ui.notify`. Phase 4 shipped as the background-only
> ambient widget plus batched `steer` completion notifications with flush-time
> wait-suppression (see docs/UX.md). The `description` param is the task label
> across all surfaces. This document is retained as design rationale.

Goal: remove the duplicated cost footer, make inline chat rendering clean and
smooth, and align every surface with Pi's native conventions. Informed by a
code-level review against Pi's TUI docs/built-ins and a comparison with
`@tintinweb/pi-subagents` (Claude Code-style reference), `nicobailon/pi-subagents`
(highest-download orchestrator), and Claude Code's Task tool.

## Design principles (from the comparison research)

1. **Pi's tool shell owns state signaling.** The Box wrapper already paints
   `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` and animates the working
   indicator. We stop drawing our own ✓/✗/state-colored words and spinners that
   never animate.
2. **Cost is a per-run attribute, not a competing ledger.** No package that
   feels native adds a second persistent cost line. Dollar cost appears inside
   the run's own result block and on demand (`/subagent-cost`-style command);
   ambient surfaces show tokens/context-%, which Pi's footer doesn't cover.
3. **Fixed-height, mutate-in-place progress.** Streaming blocks never grow and
   never get replaced with differently-shaped text. Repaints are event-gated,
   with a trailing flush so the last update always lands.
4. **Three optional layers**: inline block (foreground), ambient widget
   (background only — never double-render), notification on completion.
   Overlay is for depth, not liveness.

---

## Phase 1 — Kill the duplicate cost footer (P0)

Files: `src/extension.ts` (`refreshFooter`), `src/ui.ts` (`FooterStatusModel`), `src/usage.ts`.

- `setStatus("subagent", …)` shrinks to a terse indicator, themed, only when
  actionable:
  - running: `⚙ 2 running` (`warning`)
  - undelivered results: `· 1 ready` (`success`)
  - nothing running/ready → `setStatus("subagent", undefined)`. Drop the
    `hasUsage` keep-alive entirely.
- Delete `root $…` / `combined $…` / `subagents $…` from the footer. Pi's
  native footer already shows session cost; child-run cost moves to:
  - the run's own inline result block (`$0.0123` as one dim stat),
  - a new **`/subagent-cost` command** printing parent/children/combined once,
    in-flow (replaces the always-on ledger; reuses `buildUsageLedger`),
  - the `/subagents` overlay header (already there),
  - `status` tool output (unchanged — the model still needs it).
- Fix `FooterStatusModel.update()` to react to ready-count changes, not just
  running-count. Remove the hardcoded width-160 render; a terse segment needs
  no truncation.

## Phase 2 — Native inline rendering (P0/P1)

Files: `src/format.ts`, `src/extension.ts` (renderCall/renderResult), `src/schema.ts`.

Adopt the Claude Code / tintinweb two-line collapsed block:

```
renderCall (static, one line):
▸ subagent  Find auth middleware and summarize     (toolTitle bold + muted preview)
▸ subagent  3 parallel tasks

renderResult, running (isPartial, fixed height, mutates in place):
⠹ ↻3 · 12.4k tok · 8s
  ⎿ reading src/auth/middleware.ts…

renderResult, done:
↻8 · 33.8k tok · $0.012 · 12.3s
  ⎿ Done — Found 5 middleware call sites…        (first line of final output)

renderResult, parallel — one block per task:
task-1 ↻5 · 21k tok · 9s   ⎿ editing 2 files…
task-2 ↻3 · 12k tok · 7s   ⎿ running tests…
```

Concrete changes:

- **Add an optional `description` param** (short human label, 3–5 words) to the
  tool schema; fall back to a truncated task preview. This is load-bearing for
  every surface (inline header, widget rows, notifications, overlay list).
- **`renderCall` = exactly one line.** Delete the title + `Task:` + tasks-preview
  block; delete the fake `expandHint()` literal and use
  `keyHint("app.tools.expand", "to expand")` (only when collapsed).
- **`renderResult` rebuilt around `options.isPartial` and `context`:**
  - reuse `context.lastComponent` (a `Text`) via `setText()` — stable row
    identity, no per-frame Container/closure rebuild; delete `lineComponent`.
  - partial view: stats line + one `⎿ activity` line derived from live text
    tail. No spinner glyph of our own unless we drive it: keep a timer in
    `context.state` bumping a frame + `context.invalidate()` at ~80–120 ms
    while `isPartial`, disposed when the final render arrives.
  - terminal view: stats (turns · tokens · $cost · fixed duration) + one-line
    summary; `⎿ Stopped` / `⎿ Wrapped up (max turns)` / error text for
    non-success. No ✓/✗ glyphs, no state-colored words — the shell shows it.
  - expanded: final output rendered via `Markdown` + `getMarkdownTheme()`,
    capped ~50 lines with a dim `… use wait/status for full output` trailer.
- **Delete from `format.ts`:** emoji profile icons (`🔍📋⚡` → single-cell
  themed glyphs if kept at all), duplicated parallel task list in results,
  unconditional elapsed line, `Date.now()`-based elapsed for finished tasks
  (freeze duration at `endedAt - startedAt`).
- **Bug fix:** `String(wrapTextWithAnsi(...))` comma-join at format.ts:166-169
  (use the returned `string[]` directly).

## Phase 3 — Smooth streaming (P0)

Files: `src/extension.ts` (`streamUpdate`), `src/registry.ts` (already coalesced).

- Replace the drop-based 250 ms throttle with a **trailing-edge flush**:
  non-structural updates schedule a deferred emit instead of being dropped, so
  the final state of a burst always renders. Structural updates still flush
  immediately.
- Stop baking time-varying text (`formatStatusPreview` with elapsed) into the
  streamed `content`. Stream stable data in `details` (state, usage, live-text
  tail, activity) and let `renderResult` compute elapsed at render time with
  its `context.state` ticker.
- Separate LLM-facing `content` (compact status string, updated rarely) from
  render-facing `details` (updated often) so UI smoothness never churns model
  context.

## Phase 4 — Background runs: widget + notifications (P1)

Files: `src/extension.ts`, new `src/notifications.ts`.

- **Ambient widget** (`ctx.ui.setWidget("subagent", …)`, above editor),
  **background runs only** (foreground already renders inline — avoids the
  double-render bug tintinweb hit):

  ```
  ● Subagents
  ├─ ⠹ review  Audit dependency licenses · ↻4 · 18k tok · 41s
  └─ 1 queued
  ```

  Cleared when no background runs. Config: `widget: "background" | "off"`.
- **Completion notifications** via `pi.sendMessage(…, { deliverAs: "steer",
  triggerTurn: true })` + `registerMessageRenderer`: themed compact box for the
  human (state, stats, first-line preview, artifact/session pointers),
  structured payload for the model. Replaces the bare `ctx.ui.notify` toast.
  - Smart-join: completions within a short window group into one notification;
    failures bypass batching and flush immediately.
  - Consumption suppression: a `wait` that already delivered the result
    suppresses the redundant notification (short hold + delivered flag — we
    already track `delivered`).

## Phase 5 — Overlay polish (P2)

Files: `src/ui.ts`.

- Rebuild the list on `SelectList` + `DynamicBorder` with injected
  `keybindings` instead of hand-rolled j/k/q handling and the custom `▶`
  prefix.
- Detail view: render transcript/final output through `Markdown`; themed
  section headers; keep scroll.
- Header keeps the full cost ledger (this is the right home for it).
- Stretch (only if demanded): live-follow transcript viewer for a running
  child, reading the child session `.jsonl` we already know the path to.

## Sequencing & risk

| Phase | Effort | Risk | User-visible win |
|-------|--------|------|------------------|
| 1 footer | S | low | removes the #1 complaint immediately |
| 3 streaming | S | low | fixes stutter; independent of visual redesign |
| 2 inline | M | medium (renderer rewrite + tests) | fixes "ugly" |
| 4 widget/notifications | M | medium (new message type) | background UX |
| 5 overlay | M | low | polish |

Phases 1+3 first (small, independent, biggest complaints), then 2, then 4/5.

Testing: extend `tests/format.test.ts` for the new block layouts (collapsed /
partial / terminal / parallel), add renderer identity tests (same component
instance reused across partial renders), and a streaming test asserting the
trailing flush delivers the last update of a burst.

## Anti-goals

- No second persistent cost surface anywhere.
- No growing inline blocks; no appending streamed output to history.
- No custom expand keybinding; Ctrl+O (`app.tools.expand`) only.
- No per-completion notification spam in fanouts.
- Never show raw un-themed strings in any surface.
