# Cost accounting

`pi-subagent` reports four independent ledgers:

- **root** — provider-reported usage from assistant messages on the active parent-session branch.
- **subagents** — provider-reported cumulative usage from child-run checkpoints and terminal events on that same branch.
- **routing**: usage reported by the Jev/TypeSafe selector, one record per selector HTTP request.
- **combined**: root + subagents + routing.

These totals appear in `subagent { action: "status" }`, per-run status, the
`/subagent-cost` command, and the `/subagents` overlay header. The footer stays
terse (running/ready counts only) because Pi's native footer already shows
session cost, including subagent spend, on Pi builds with native tool-result
usage accounting (see below).

## Source of truth

The extension does not estimate prices. It uses Pi's normalized provider response:

```ts
message.usage.cost.total
```

It also retains provider-reported input/output/cache category costs, token counts, reasoning tokens, context size, and completed turn count when supplied.

## Routing (selector) accounting

Jev selection is billed separately from child execution:

- TypeSafe reports input and output **tokens**, not billed currency. The routing
  ledger therefore reports tokens and marks its currency as **unreported**. Do not
  read the numeric `0` currency placeholder in the native usage schema as the
  selector being free: it is the API-required number for an unreported value.
- Numeric dollar totals for root/subagent/combined exclude unreported routing
  spend. The status line says so explicitly rather than silently omitting it.
- `max_cost` remains the provider-reported execution ceiling for the child and
  its subtree. It cannot cap TypeSafe charges, so a run can stay under `max_cost`
  while still incurring selector fees.
- No selector price is inferred from a public price page or a local model table.

A routing record exists per selector HTTP request, not per logical selection: a
model question plus one or more packed tool-question requests each produce their
own record, and all of them count once by full request ID. Plan selections and
pre-spawn failures are included, because no child run exists to carry them.

Successful route metadata (decision ID, selector model and reported version(s),
original selected model, ranked candidate probabilities, shared selected tools, locally added control-plane tools, confidence, success outcome, latency and receipt IDs) travels with the run and both registry projections. Actual attempt models are recorded separately; fallback never rewrites the initial selection as a new decision. Per-request failure outcomes and safe error codes stay in selector receipts. It carries no descriptions, raw request bodies, headers,
credentials or invented rationale.

Receipts pending append visibility remain in a bounded session-local overlay until the
active branch exposes the matching record. Persistence retries reuse the receipt ID,
not the paid selector request. If persistence cannot be confirmed, new child launch is
blocked and a branch change is cancelled; a forced shutdown reports that durable usage
may be incomplete. This cannot repair an unavailable storage adapter after process exit.

## Native Pi usage accounting

Pi builds after v0.80.10 persist an optional `usage` field on tool-result messages ([pi#6671](https://github.com/earendil-works/pi/pull/6671)) and fold it into the native footer total, `/session` statistics (as `Tools/summaries`), and RPC `get_state` totals.

The extension participates in both directions:

- **Upward**: the tool result that *delivers* a run (foreground completion, or the first `wait`) carries the run's total provider usage as native `usage`. Attachment is gated on the same delivered-flag transition as output delivery, so it happens exactly once per run UUID. Status, replayed waits, steer, diff/apply/discard, and plan responses never attach run execution usage; plan may report its own selector usage through its result instead (rule 10). Older Pi hosts copy only `content`/`details` from tool results and silently ignore the field; that is safe on every version this package supports.
- **Downward**: a child's event stream may contain tool-result messages that themselves carry nested usage (for example, a grandchild subagent on a new-Pi child). The parent folds that into the run's cumulative usage, so `max_cost` budgets and the execution/routing ledgers see true subtree spend. Pre-#6671 children simply never emit the field.

Known undercounts in the **native** total (the extension ledger still counts these from persisted entries):

- A background run dismissed in the overlay (or via status) without a delivering `wait` never produces a tool result, so its spend reaches only the extension ledger.
- A failed or lost run raises an error instead of returning a tool result; any pre-failure usage likewise reaches only the extension ledger. The same native limitation applies to selector usage on a thrown error: the extension ledger retains it, but a thrown tool call cannot attach a native usage object. This is documented rather than converted into a success.

Because the native footer counts parent assistant messages plus delivered tool-result usage, and the extension's **combined** counts the same runs by UUID, the reported token totals agree when every run and selector receipt was successfully delivered as native usage. Thrown errors and undelivered plan/dispatch failures can leave selector usage only in the extension ledger; currency totals never include unreported selector fees.

## Deduplication rules

1. Root assistant messages are counted once by session-entry ID.
2. Each subagent run is counted once by full run UUID; the newest live/checkpoint/terminal cumulative value replaces older values.
3. Delivery, dismissal, status, and checkpoint events never add cost.
4. If an old run is evicted from in-memory UI history, its latest persisted usage still contributes to the session ledger.
5. Active and immediately completed runs supplement or replace stale persisted checkpoints until newer session entries become visible; the full run UUID prevents double counting afterward.
6. Resumed and forked invocations are distinct billed runs. Their new provider usage is counted once, even though they reuse prior context.
7. Ranked failover and permitted same-model pre-work retries accumulate into one run usage record. Every attempt's provider-reported usage counts once under the same run UUID; attempted-model metadata is descriptive, not another ledger input. Advancing to a ranked candidate makes no additional selector request and creates no new receipt. The initial selector decision remains distinct from the actual execution model.
8. The optional parallel `synthesis` child bills into the same run as an extra result.
9. Selector requests are counted once by full selector request ID, including plan
   requests and pre-spawn rejected decisions. Route references inside task results
   never add selector usage again, and each receipt is folded once across
   replay/status/repeated wait.
10. Native `usage` on the delivering tool result mirrors rule 2's run totals and is attached at most once per run (delivered-flag gated), so Pi-side totals cannot double count a run either. Worker pre-spawn routing tokens attach once at async start; the first delivery/wait attaches child execution usage plus any deferred-synthesis routing tokens not yet delivered; foreground completion attaches all invocation routing tokens plus execution tokens. Plan attaches only its own routing usage. Missing usage on an interrupted or invalid response stays **unknown**, never an invented zero. A partial or malformed token report retains individually validated counts while marking completeness unknown; for example, valid input with invalid output is not a complete report.

Native routing attachment commits atomically: foreground/wait use the run's single
`delivered` event for linked receipts; plan and async-start use one `native-delivery`
request-ID batch on the routing event stream. A throwing append does not consume a
prefix or set the in-memory run delivered flag. Transient persistence failures retry
without another selector call. A batch holds at most 1024 receipt IDs; larger plan or
background requests must be split. Background requests check this bound before any
child/run registration. Already incurred selector usage stays in the ledger.

## Branch semantics

Only `sessionManager.getBranch()` is used. Costs from abandoned sibling branches are excluded. When a parent session is forked, its inherited active-branch terminal entries remain part of that fork's historical total; new runs are added to the fork independently.

## Failure and cancellation

Any usage reported before a failure, timeout, budget stop, cancellation, or parent crash is retained in a cumulative checkpoint/terminal record. A run with no provider response contributes zero rather than an estimate.

All ranked attempts share the absolute task deadline and cumulative `max_cost`/`max_turns` budget. Prior usage is an offset for the next child's budget comparisons, not part of that child's returned usage, so aggregation adds each attempt only once. A replacement cannot start after reported cost or turns meets its ceiling. In-attempt completed-turn checks and wrap-up grace remain unchanged. Pi's internal provider retries are not counted as separately launched extension attempts.

When every attempt fails, earlier output previews retain their originating model/session and the final task remains failed. Preserving billed work does not convert failure into `partial` or success. The existing native undercount for thrown failures still applies; the extension ledger retains all reported attempt usage.

## Provider limitations

Accounting is only as precise as the provider data normalized by Pi:

- Some providers may report zero or incomplete costs.
- `reasoning` is a subset of output tokens and is not added to output again.
- `contextTokens` is the latest turn's context size, not an additive billed-token field.
- The extension deliberately does not infer missing prices from a local model table, and TypeSafe's token-only reports are never converted into a dollar estimate.
