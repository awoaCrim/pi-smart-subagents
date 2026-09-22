# Changelog

## 0.11.0 - 2026-09-22

### Probability-ranked Jev failover

- Retain validated candidate probabilities and advance to the next eligible model after a recognized availability failure, only before any current-invocation tool execution begins. Unknown activity and task-quality failures do not authorize restart.
- Select one task-based tool subset for all attempts, resolve thinking per candidate, and verify each attempted model/tool set without another Jev request.
- Bound all extension-level extra attempts by `max_retries`, candidate exhaustion, the original deadline and cumulative execution budgets. Preserve Pi's internal retries and the trusted unranked SDK fallback contract.
- Record original and actual models, bounded attempt history and earlier output pointers across status, plan and reload. Preserve failure state and usage without publishing failed structured output or duplicating selector receipts.

## 0.10.0 — 2026-09-21

### Config-file Jev credential

- Read the TypeSafe credential from required `jevRouting.apiKey` in the private user configuration. Reject the old `apiKeyEnv` field with manual migration guidance; do not read or fall back to a credential environment variable.
- Keep the key out of generated routing guidance, selector request bodies and results; document plaintext-file access and backup risks. Existing-run management remains independent of routing setup.
- Ship the config-file credential contract in 0.10.0. The published 0.9.0 remains unchanged and requires the older `apiKeyEnv` setup; no automatic user-settings migration is performed.

### Documentation and repository maintenance

- Add matching English and Chinese READMEs with current installation, Jev setup, permission and cost guidance; move advanced usage into a public reference.
- Document the standalone checkout's available verification steps and separate source maintenance from npm publication.
- Keep local development tooling outside the public source tree while retaining the distributed subagent skill; add repository and issue metadata for future packages. These repository-maintenance changes do not change runtime behavior.

## 0.9.0 — 2026-09-21

### Jev model and tool routing

- Replace fixed `modelPolicy` routes for extension-managed work with required Jev selection from user-described, locally available model candidates and individual permitted tools. New work is Pi-only; management and explicit low-level SDK specs remain available.
- Route normal/parallel/background dispatch, paid plan, `/btw`, resume/fork and deferred synthesis through the shared selector. Reject legacy explicit model/fallback fields; accept valid low-confidence decisions without substituting an emergency model.
- Verify the child model and exact selected tool set before sending task text. Carry cancellation/deadlines through routing, preflight, startup and same-model retries.
- Persist bounded per-request selector receipts separately from execution usage, with deduplicated native delivery and unreported selector currency. Preserve resume-lock safety, fanout usage and retained worktree pointers across failures.
- Document manual configuration migration, minimum disclosure and rollback. No automatic settings rewrite, installation or live provider evaluation is included.

## 0.8.9 — 2026-09-16

### Restore the stable 0.8.7 behavior

- Restore the `0.8.7` source behavior after the withdrawn `0.8.8` release. Remote Context ownership and model gating remain in the separate `pi-openai-toolkit` project.

## 0.8.7 — 2026-09-14

### Provider-safe tool schemas

- Strip internal TypeBox `~...` metadata from the `subagent` and `subagent_wait` schemas before Pi provider adapters receive them, while retaining the original schemas for local runtime validation.

## 0.8.6 — 2026-09-14

### Pi context management in child profiles

- Keep Pi context-management tools available to child tool allowlists without granting project-file write access, so configured gateway models such as `uwoacrimson/gpt-5.6-luna` and `uwoacrimson/gpt-5.6-sol` can use `contextManagement` from `explore` and `review` profiles.

## 0.8.5 — 2026-09-10

### Read-only FFF search tools

- Classify `fffind`, `ffgrep`, and `fff-multi-grep` as read-only tools so `explore` and `review` profiles can use the `@ff-labs/pi-fff` search tools without granting write access.

## 0.8.4 — 2026-09-10

### Pi-owned thinking levels

- Treat route and task `thinking` values as opaque Pi strings instead of a
  hard-coded local enum, preserving model-specific values such as `max` and
  passing them to Pi unchanged. Pi remains responsible for model capability
  validation and mapping.

## 0.8.3 — 2026-09-10

### Model-policy thinking defaults

- Allow `modelPolicy.default` and named-agent routes in `~/.pi/subagent.json`
  to specify an optional `thinking` default (`off`, `minimal`, `low`, `medium`,
  `high`, or `xhigh`). Explicit task, agent, and profile defaults still win;
  unsupported backends reject resolved thinking instead of silently ignoring it.

## 0.8.1 — @cr1ms0n community fork (2026-09-08)

- Require an explicit model matching user-owned default/agent model policy.
- Restrict fallback models and their order to the configured route.
- Inject the effective model mapping into the parent prompt.
- Show actual attempt models in inline, background, inspector and completion UI.
- Preserve older completion payloads and encode Windows parallel/synthesis record filenames.
- Keep thinking-level selection unchanged from upstream.

The entries below are retained upstream history from @parke.dev/pi-subagent.


## 0.8.2 — 2026-09-10

### Background completion delivery

- Automatic terminal notifications for `async: true` runs now use Pi's `steer`
  delivery queue with `triggerTurn: true`, making completion messages available
  before the parent's next LLM call. Foreground runs, explicit management
  actions, message content, batching, persistence, and usage accounting are
  unchanged.

### Machine-wide worktree GC

- Startup maintenance now sweeps every repo container under `worktreeDir` via
  `WorktreeManager.sweepAll()`, not just the current checkout's — stale
  containers for repos you stop visiting are finally reclaimed. Each
  container's base repo is resolved from the create-time `base-repo` marker or
  the linked worktree's gitdir pointer, then swept with the existing `sweep()`
  safety model (archive unique work, never delete unreachable branches, 1h
  min-age, keepPaths shielding).
- Containers whose base repo is gone are **kept and reported**
  (`GlobalSweepReport.orphanedContainers`), never deleted: their object stores
  lived inside the deleted repo, so unique work cannot be proven absent or
  archived. Empty leftovers (no worktrees, no archived patches) are removed.
- Run process records now carry `worktreeCwd` so live worktree-isolated runs
  from **other concurrent Pi processes** are shielded from the global sweep,
  same as this session's live runs.
- Known limitation: `pi-workflows` reuses `WorktreeManager` with the default
  root (its worktrees land in the same containers and are reclaimed by the
  global sweep) but writes run records to a separate lock root, so its live
  worktrees are shielded only by the 1h min-age window, not by run records.

## 0.8.0

### Lifecycle-driven storage GC (no more wall-clock retention)

Sessions and worktrees are now reclaimed when their run is **over**, not after
N days. "Over" means: terminal run state, not referenced by the parent branch,
not owned by any running run record machine-wide, and past a 1-hour
concurrency race guard.

- **Child session transcripts** are distilled to a small `.digest.json`
  preserving the meaningful impact — task, final output, model/thinking,
  usage totals, turn/tool/error counts, duration — and the raw `.jsonl` is
  deleted (`src/distill.ts`). Sessions referenced by the active branch or busy
  in any live run are never touched, so resume keeps working.
- **Worktrees** holding unique work are archived as one applyable
  `git apply --3way` patch under `<repo-container>/_patches/` and the multi-GB
  directory (checkout + node_modules) is reclaimed immediately. Branches whose
  commits exist on no other ref are still never deleted. If archiving fails,
  the worktree is kept — work is never destroyed unpreserved.
- `diff` / `apply` / `discard` transparently fall back to the archived patch
  when the worktree directory is already reclaimed.
- `sessionRetentionDays` and `worktreeRetentionDays` are accepted but inert.

## 0.7.0

### Public library SDK

- Added stable `@parke.dev/pi-subagent` and `@parke.dev/pi-subagent/sdk`
  entrypoints for programmatic consumers.
- Exported orchestration, runner, worktree, process-lock, semaphore, backend,
  usage, and task/result types without requiring `src/*` imports.
- The Pi extension manifest remains `./extensions/subagent.ts` and is unchanged.
- Deep `src/*` package imports are intentionally no longer public once this
  export map ships.

## 0.6.0

### Multi-backend children: pi, Codex, Claude Code

`backend: "pi" | "codex" | "claude"` on any task, parallel item, or agent
frontmatter. Children run on the vendor CLI as a child process, so **every
existing safety guarantee still applies** — git worktree isolation, machine-wide
process locks, nesting-depth limits, orphan reclaim, PID-identity group kill —
and **no new dependencies** are added. (The reference implementation this was
adapted from embeds `@anthropic-ai/claude-agent-sdk` in-process; the `claude`
CLI exposes everything needed without that weight.)

Internally this is a new `BackendAdapter` seam (`src/backend.ts`,
`src/backends/`). `ChildRunner` keeps all the backend-agnostic machinery;
adapters own only invocation building, event-stream parsing, the stdin command
dialect, and a capability record. The `pi` backend is a verbatim extraction of
the previous inline logic.

**Capabilities are enforced, not assumed.** Requests a backend cannot honor are
refused at validation time with an explanation, because silently dropping a
budget or a read-only guarantee turns a safety feature into a no-op:

|                                  | pi                | codex                               | claude                 |
| -------------------------------- | ----------------- | ----------------------------------- | ---------------------- |
| `max_cost`                       | ✅                | ❌ refused (tokens only, no cost)   | ✅ `total_cost_usd`    |
| read-only profile                | ✅ tool allowlist | ✅ `--sandbox read-only` (OS-level) | ✅ `--allowedTools`    |
| steering / graceful wrap-up      | ✅                | ❌ no stdin channel                 | ❌ one-shot print mode |
| `resume`                         | ✅                | ✅                                  | ✅                     |
| `context:'fork'` / `fork_resume` | ✅                | ❌ refused                          | ✅ `--fork-session`    |
| `thinking`                       | ✅                | ❌                                  | ❌                     |
| `output_schema`                  | ✅                | ✅ `--output-schema`                | ✅ `--json-schema`     |

Parsers were written against event streams captured verbatim from the real
CLIs (codex-cli 0.144.6, claude-code 2.1.219) and are fixture-tested including
truncated-stream, API-error and rate-limit paths.

### Live transcript for every backend

Pressing `t` on a running run in `/subagents` previously assumed pi's session
layout and entry schema, so codex/claude runs showed "waiting for child
session…" forever. Vendor transcripts are now located by session id and
rendered through per-backend renderers, with each vendor's boilerplate
(codex's sandbox preamble, claude's queue bookkeeping) filtered out.

Tests: 277 → 308.

**Verified live:** codex end-to-end through the runner; the `max_cost` refusal
message; codex's read-only sandbox blocking a shell write with "operation not
permitted"; and both vendor transcripts tailing real on-disk session files.
Claude's happy path is fixture-tested only — the development account was
rate-limited during this work.

## 0.5.1

### `subagent_wait` — dedicated blocking-collect tool

- New **`subagent_wait`** tool (`{ id, timeout_ms? }`) sits alongside `subagent`.
  Collecting a background run is the one management step a model reaches for
  reflexively mid-flow, and burying it behind the `action:` union cost a
  discovery step. This matches the shape the highest-adoption package in the
  ecosystem converged on (`pi-subagents` ships `subagent` + `subagent_wait`).
- Implemented as a thin front-end that rewrites its arguments into the
  equivalent `action:"wait"` request and reuses the main tool's `execute`, so
  delivery / `markDelivered` / output-cap semantics cannot drift between the
  two surfaces. `action:"wait"` remains fully supported.
- **`timeout_ms`** added to the shared wait path (so `action:"wait"` gains it
  too): on timeout the run is explicitly **not** cancelled and **not** marked
  delivered, so it stays collectable by a later wait.

### `/btw` — side questions hidden from the main agent

- New **`/btw <question>`** command (or bare `/btw` for a prompt). The aside
  runs as a normal subagent run — full policy, profile, budget, semaphore and
  process-lock machinery — but its result is delivered with `pi.appendEntry()`
  - an entry renderer, which by design does not participate in LLM context.
    The user gets an answer rendered in the transcript while the main agent keeps
    working, unaware of both question and answer.
- Ported from [davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup)'s
  by-the-way feature, adapted to our process-per-child model.

Tests: 273 → 276. Both features' load-bearing invariants are mutation-checked.

## 0.5.0

### Native Pi cost accounting (pi#6671)

- **Upward**: the tool result that delivers a run (foreground completion or
  the first `wait`) now carries the run's total provider usage as a native
  `usage` field. Pi builds after v0.80.10 persist it on the session entry and
  fold it into the footer cost, `/session` statistics (`Tools/summaries`
  bucket), and RPC `get_state` totals — resolving the undercount that
  motivated [pi#6509](https://github.com/earendil-works/pi/issues/6509).
  Attachment is delivered-flag gated: exactly once per run UUID; status,
  replayed waits, steer, worktree actions, and plan responses never attach
  usage. Older Pi hosts silently ignore the field (no minimum version bump).
- **Downward**: tool-result messages in a child's event stream that carry
  nested usage (e.g. grandchild subagents on a new-Pi child) now fold into
  the run's cumulative usage, so `max_cost` budgets and the
  root/subagent/combined ledger see true subtree spend. Pre-#6671 children
  never emit the field; behavior there is unchanged.
- Known native-total gaps documented in COST-ACCOUNTING.md: dismissed-without-
  wait background runs and failed/lost runs (thrown errors carry no usage)
  reach only the extension ledger.

## 0.4.0

### Agent ecosystem (PLAN phase 2)

- **`spawns:` allowlist** in agent frontmatter (`false` / `"*"` / name list):
  controls which agents a persona's children may spawn. The policy travels via
  `PI_SUBAGENT_SPAWNS`; `spawns: false` children don't register the subagent
  tool at all. Malformed env fails closed to disabled. Accidental-recursion
  guard, not a security boundary (documented in SECURITY.md).
- **`@include relative/path.md`** in agent bodies: one-level prompt
  composition with the same 64KB/symlink guards as `@contract.json`;
  missing/rejected includes stay verbatim.
- **Resumable-session discovery**: bare `status` lists `session <id8>
(resumable)` under completed runs; run-specific `status` shows full ids, and
  the prompt guidelines mention `resume:`.
- **`action: "plan"`** dry-run: full validation plus worktree/fork/output
  preflights, returning the resolved per-task plan (model, tools, budgets,
  isolation, notes) without spawning — same errors as the real call.

### Engine hardening (PLAN phase 3)

- **Depth-tiered global slots**: slot records carry `depth` and shallow tiers
  reserve capacity for deeper ones, so a spawn tree wider than
  `maxGlobalActive` can no longer deadlock while parents wait on children.
  Old slot files without `depth` count as depth 0.
- **`include_wip: true`** (worktree isolation only): seeds the worktree with
  the parent checkout's uncommitted changes. `diff`/`apply` subtract the WIP
  patch when clean, else report the combined delta with an explicit
  `[includes parent WIP]` warning; an untouched WIP-only worktree counts as
  unchanged and is cleaned up.
- **Faster stale-lock reclaim**: a lease-expired cross-host (or unverifiable
  foreign) owner is reclaimable after one lease period; the 2× window remains
  only where clock skew is plausible (same host, identity unknown).
- **Library-use warning**: `runSubagent()` without `locks` + `runId` writes no
  durable run record (children invisible to orphan reclaim) — now documented
  loudly in JSDoc and README.

### Observability (PLAN phase 4)

- **Live transcript view**: in `/subagents`, `t` on a running run tails the
  child's session file (500ms poll, auto-follow, scroll-up pauses); `s` steer
  works from the same view.
- **`widget: "off"` / `notifications: "off"`** config keys (env
  `PI_SUBAGENT_WIDGET` / `PI_SUBAGENT_NOTIFICATIONS`) for quiet mode.
- Status previews append `[stalled <dur>]` and `[attempt N]` so background
  polling surfaces watchdog/retry state without the overlay.

## 0.3.1

- Remove `publishConfig.provenance` (it blocked the one-time local bootstrap
  publish of the new package name; OIDC publishes generate provenance
  automatically). First release published end-to-end via Trusted Publishing
  under `@parke.dev`.

## 0.3.0

### Structured results

- **`output_schema`**: declare a JSON Schema per task (or in agent-file
  frontmatter as inline JSON / `@contract.json`). The contract is appended to
  the child's system prompt; the final message must end with a fenced
  `json:result` block. Validation runs parent-side against a dependency-free
  JSON-Schema subset (type/properties/required/items/enum/const; unknown
  keywords ignored). Invalid output triggers **one steer-based repair round**
  before the child is allowed to settle; still-invalid results end `partial`
  with `structuredError` and the raw text delivered — paid work is never
  discarded. Valid results deliver as clean JSON and surface as
  `details.results[].structuredOutput`.
- **Typed synthesis handoff**: validated parallel results feed the `synthesis`
  child as JSON blocks instead of prose tails, with per-task validity flags.
- **Arg repair**: double-encoded task/system-prompt text (literal `\n`/`\"`
  escapes) is conservatively de-mangled once at validation time; identifier
  fields and path-like strings are never touched.
- UI: terminal rows annotate `✓ schema` / `schema ✗`.

## 0.2.1

- **Package moved to `@parke.dev/pi-subagent`** (owned by the `parke.dev` npm
  org). `@lukehagar/pi-subagent` is deprecated at 0.2.0 and will receive no
  further updates; install the new scope with
  `pi install npm:@parke.dev/pi-subagent`. No code changes besides the rename.
- CI/release workflows on actions/checkout@v7 + actions/setup-node@v7;
  CI matrix trimmed to supported LTS lines (22, 24); `engines.node` corrected
  to `>=22.19.0` (the actual pi-coding-agent floor).

## 0.2.0

Major feature release: reliability engine, named agents, background-run UX,
and a complete TUI overhaul.

### Named agent files

- Reusable subagent personas as markdown files with YAML frontmatter, discovered
  from `.pi/agents/` (project), `.agents/agents/` (shared workspace), and
  `$PI_CODING_AGENT_DIR/agents/` (global). Invoke with `agent: "name"`.
- Body becomes the child's appended system prompt; frontmatter supplies defaults
  (`model`, `thinking`, `profile`, `tools`, budgets, `fallback_models`, `isolation`).
- Precedence per field: explicit params > agent file > per-profile `taskDefaults`
  > parent inheritance. Capability profiles fail closed regardless of what an
  > agent file declares.
- Catalog advertised in the tool's system-prompt guidelines and live in bare
  `status` output; file changes picked up within seconds.

### Reliability

- **Graceful budget stops**: at `max_turns`/`max_cost` the child is steered to
  wrap up and given `grace_turns` (default 2) for a final answer before SIGTERM.
  Results end `partial` with `wrappedUp: true` when the child concluded in time.
- **Retry with model fallback**: transient failures (queue timeouts, stalls,
  spawn errors, provider errors, protocol truncation) retry automatically up to
  `max_retries` extra attempts, escalating through `fallback_models`. Usage
  accumulates across attempts; `attempts`/`attemptedModels` recorded. Task-quality
  failures never retry.
- **Stall watchdog**: protocol silence for `stallAfterMs` (90s) flags the task
  and probes liveness via `get_state`; continued silence for `stallKillAfterMs`
  more kills the child (feeding retry) instead of burning the whole timeout.
- **PID-reuse protection on macOS/BSD**: process start-time identity via
  `ps -o lstart=`; group kills verify identity before signalling.

### Orchestration

- **Mid-run steering** (`action: "steer"`): children run in Pi RPC mode with a
  live stdin command channel; inject guidance delivered after the current turn.
- **Context forking** (`context: "fork"`): child starts from a real branched
  copy of the parent conversation. Single-task only; fails fast when the parent
  session is not persisted.
- **Worktree loop**: `diff` / `apply` / `discard` actions on finished runs with
  changed worktrees. `apply` lands the combined patch as uncommitted changes via
  `git apply --3way`; never commits, never auto-deletes.
- **Parallel synthesis** (`synthesis: "…"`): one read-only child folds parallel
  outputs into a brief delivered first, with explicit truncation markers.
- **Per-task `description`** labels and per-profile `taskDefaults` config
  (model/thinking/budget routing without naming agents).

### Background runs

- **Completion notifications**: terminal async runs send a batched `followUp`
  message so the parent reacts without polling. Successes group within a short
  window; failures flush immediately; a consuming `wait` suppresses the
  redundant notification. Themed compact box for humans.
- **Ambient widget**: live above-editor tree (spinner, stats, activity tail)
  for background runs only — foreground runs already render inline.

### TUI overhaul

- One-line `renderCall`; fixed-shape mutate-in-place streaming blocks; compact
  terminal stats with state glyphs; per-task rows for parallel runs; frozen
  durations at `endedAt`; reliability annotations (`[attempt 2]`,
  `[stalled 2m]`, `◐ wrapped up`).
- Terse footer (running/ready counts only); cost ledger moved to
  `/subagent-cost`, `status`, and the `/subagents` overlay header.
- Overlay rebuilt: themed header with counters + ledger, two-line list rows,
  structured detail view, steering (`s`), worktree apply/discard (`a`/`x`).
- Trailing-edge streaming flush (the last update of a burst always renders);
  stable component identity across partial renders.

### Performance

- Transcript joins only on message boundaries (was O(N²) per stdout chunk).
- Memoized per-result snapshot projection (only changed tasks re-project).
- Trailing-edge coalescing for streamed tool updates.

### Fixes

- Resolve the Pi CLI entry through bin symlinks (npm/Homebrew shims) instead of
  falling back to bare `pi` on PATH.
- Headless children auto-cancel extension UI dialogs so they can never hang.
- Prompt-rejection in RPC mode fails fast instead of idling forever.

## 0.1.3

- Require `type: object` tool schema for provider compatibility.

## 0.1.2

- Publish scoped `@lukehagar/pi-subagent` on npm; release workflow hardening.
