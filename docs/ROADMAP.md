# Roadmap

> **Historical upstream roadmap.** Retained for rationale and deferred ideas, not as this fork's current release schedule. Phases 2-4 are recorded as shipped in [the historical execution plan](PLAN.md); their future-tense sketches below do not mean these features are missing. Jev routing supersedes the old model-selection assumptions. Use [the current reference](REFERENCE.md), [architecture contract](ARCHITECTURE.md) and [development checks](DEVELOPMENT.md) for current behavior and available tooling. Historical test claims are not verification results for this checkout.

> Execution details for the remaining phases (work breakdown, acceptance
> criteria, test plans, release gates) live in [PLAN.md](./PLAN.md). This
> document holds the rationale, design sketches, and deferral decisions.

Prioritized improvement plan, consolidated from four review passes: the
competitor field study (@tintinweb, nicobailon), the strategic review, the
fresh-eyes engine review, and the oh-my-pi task-system comparison. Each item
carries a design sketch grounded in the current code, an effort/impact rating,
and explicit risks. Ordering within a phase is the intended implementation
order; phases are independently shippable releases.

Legend: effort S (<½ day) / M (1–2 days) / L (3+ days) · impact ▲ high / △ medium

---

## Phase 1 — Structured results (v0.3.0) — ✅ SHIPPED

The single biggest remaining quality gap. Free-text child output forces the
parent to re-parse prose, which is fragile and burns tokens. oh-my-pi's
`yield` protocol validates the design; we adapt it to our process boundary.

> Implemented in `src/structured.ts` + runner/policy/output wiring: 1.1
> (output_schema with settle-gated validation and one steer-based repair
> round, agent-file `output_schema:` inline or `@file.json`), 1.2 (validated
> JSON handoff to synthesis), 1.3 (conservative arg repair). E2E-verified
> against real Pi.

### 1.1 `output_schema` — validated structured output ▲ M

**What:** optional JSON Schema per task. The child must end with a fenced
` ```json:result ` block (or a final JSON object) satisfying the schema; we
validate on our side of the process boundary and surface `result.parsed` in
details plus a `structured: true` flag.

**Design:**
- Schema field `output_schema: Type.Optional(Type.Object({}, { additionalProperties: true }))`
  on `TaskFields` (`src/schema.ts`). Validate at policy time that it parses as
  a JSON Schema (typebox `Value.Check` against a permissive meta-check).
- Inject a compact contract into the child via the existing
  `--append-system-prompt` path (`src/runner.ts` `spec.systemPrompt` join):
  "Your final message MUST end with a ```json:result fenced block matching
  this schema: …". Persona prompt first, schema contract last (highest
  salience).
- Parse in `ProtocolParser.finalize()` (`src/protocol.ts`): scan the final
  assistant text for the fenced block, fall back to a trailing bare JSON
  object. Attach `structuredOutput?: unknown` + `structuredError?: string` to
  `TaskResult` (`src/types.ts`), thread through `toPersistedResult` /
  `compactDetails`.
- **Retry integration (the payoff):** schema-invalid output is NOT a transient
  failure (no model fallback), but gets one **steer-based repair round** —
  reuse the wrap-up machinery in `src/runner.ts` (`handleBudgetBreach`
  pattern): steer "your result did not validate: <errors>; re-emit the fenced
  block" and allow 1 extra turn. Mirrors oh-my-pi's yield-reminder ladder
  without needing an in-process tool.
- Delivery: when `output_schema` is set and validation succeeded, `wait`/
  foreground text is the pretty-printed JSON; `details.results[n].parsed`
  carries the object. Validation failure after the repair round → state
  `partial`, `structuredError` set, raw text still delivered (never lose paid
  work).
- Agent files (`src/agents.ts`): allow `output_schema` in frontmatter as an
  inline JSON value or `@file.json` reference, so personas can carry contracts.

**Dependency:** none new — use typebox `Value.Check` with a schema compiled
via `Type.Unsafe` wrapping, or plain structural validation for the JSON-Schema
subset we accept (`type/properties/required/items/enum`). Do NOT add ajv.

**Risks:** models ignoring the contract (mitigated by the repair steer); the
fenced-block convention colliding with task content (use a unique fence tag).

### 1.2 `{outputs}` handoff for synthesis + sequential patterns △ S

**What:** when parallel tasks used `output_schema`, feed the synthesis child
the *validated objects* (JSON) instead of prose tails, and include per-task
validity flags. Pure upgrade to `runSynthesis` (`src/extension.ts`).

### 1.3 Arg repair for mangled task text △ S

oh-my-pi's `repair-args.ts` steal. LLMs sometimes double-encode JSON into
string fields. Detect structural escape patterns (`\"`, `\\n`, `\u00XX`) in
`task` / `system_prompt` / `synthesis` at policy time and de-mangle once when
the decoded form parses cleanly. **Never** touch identifier fields (`agent`,
`model`, `id`) or `tools`. ~50 lines in `src/policy.ts` + table tests.

---

## Phase 2 — Agent ecosystem depth (v0.3.x)

Builds on the named-agent files just shipped. All items are additive
frontmatter/behavior; no format break.

### 2.1 `spawns:` allowlist in agent frontmatter ▲ S

**What:** per-agent control over which agents its children may use — finer
than the global depth cap. oh-my-pi steal (`spawn-policy.ts`).

**Design:**
- Frontmatter `spawns: false | "*" | "a, b"` parsed in `src/agents.ts`.
- Enforcement at spawn time: the parent's *own* spawn policy travels to the
  child via env (`PI_SUBAGENT_SPAWNS`) next to `PI_SUBAGENT_DEPTH`
  (`src/runner.ts` childEnv). `validateSubagentRequest` (`src/policy.ts`)
  reads it: `false` → reject any spawn; list → the requested `agent:` (or
  agentless composition) must be allowed. Fail closed on malformed env, same
  as `parseDepth`.
- `spawns: false` children also get the subagent tool filtered out (extend
  the existing `tool !== "subagent"` filter logic to honor policy, not just
  the depth ceiling).

**Risk:** env is advisory (children can shell out to `pi` directly) — document
as accidental-recursion guard, exactly like depth (SECURITY.md item 3).

### 2.2 Resumable-session discovery △ S

Fresh-eyes gap G6: resuming requires already knowing the child session id.
Extend bare `status` output (`src/extension.ts`): completed runs list
`session <id8> (resumable)` per result, and add a one-line hint to
`promptGuidelines`. No new action needed — the data is already in snapshots;
we just don't advertise it.

### 2.3 Dry-run validation (`action: "plan"`) △ S

Fresh-eyes gap G11: policy failures (write-guard, unknown agent, bad tools)
currently surface only after enqueue. Add `action: "plan"` that runs
`validateSubagentRequest` + worktree/git preflight (`isGitRepo` for
isolation:'worktree' tasks) and returns the resolved per-task spec
(`resolutionNotes`, effective model/tools/budgets) without spawning.
Cheap: the validation path is already pure.

### 2.4 Agent file ergonomics △ S

- `system_prompt: "@path.md"` references (relative to the agent file), so
  personas can share prompt fragments. Resolve in `src/agents.ts` with the
  same symlink/size guards.
- `/subagents` overlay: an `agents` line in the header showing catalog count,
  and unknown-agent errors already list availability (done) — add the catalog
  to `/subagent-cost`'s sibling command? No — keep one surface, skip.

---

## Phase 3 — Engine hardening (v0.4.0)

Remaining items from the fresh-eyes review plus oh-my-pi's concurrency lesson.
Individually small, collectively they close the last known failure modes.

### 3.1 Queue-slot release granularity ▲ M

oh-my-pi's deadlock lesson (their issue #3749): a semaphore slot held for a
child's full lifetime deadlocks spawn trees wider than the limit. We're
partially exposed: a nested parent (depth 1) holds a per-session slot in *its*
runtime while its own children queue — different semaphores per process, so
the per-session limiter is safe, but the **machine-wide `maxGlobalActive`
slot** (`src/process-lock.ts` global slots) IS held across the child's whole
run, including while that child waits on its own children's global slots.

**Design:** exempt nested parents from double-counting — a child process
should release/not-hold its global slot while it is itself blocked waiting
for descendants. Simplest correct fix given our process boundary: count only
*leaf* work against the global cap by having the runner acquire the global
slot **after** semaphore acquire and release it during any period the child
reports zero active LLM streaming (not knowable today) — OR, pragmatically:
raise the effective cap per depth level (`maxGlobalActive` applies per depth
tier: `slots(depth) = maxGlobalActive - depth * reserved`). Decide at
implementation time; write the deadlock repro test first
(`tests/process-lock.test.ts`: tree of width > cap).

### 3.2 Dirty-baseline worktrees △ M

oh-my-pi steal. `worktrees.create` (`src/worktree.ts`) snapshots `HEAD`,
silently excluding the parent's uncommitted changes — a writer agent asked to
"fix the bug I'm mid-way through" can't see the WIP.

**Design:** optional `include_wip: true` on worktree tasks: after
`git worktree add`, apply `git diff HEAD` from the base checkout (plus
untracked files via `git ls-files -o --exclude-standard` copy) into the
worktree, uncommitted. `diff`/`apply` must then diff against
`baseCommit + WIP` — capture a synthetic baseline patch in the handle and
subtract it (oh-my-pi's filtered-delta approach, simplified: store the WIP
patch, exclude its hunks from `diff` output via `git diff` against a temp
index). Keep default OFF; document that apply-back of WIP-seeded worktrees
reports the combined delta if subtraction fails, with a warning.

### 3.3 Lease-expiry reclaim latency △ S

Fresh-eyes #10: a crashed same-host owner is reclaimed instantly via
`isAlive`, but a *cross-host* (or identity-unverifiable) dead owner blocks
resume for up to 2× lease. Reduce the stale window to
`leaseExpiresAt < now()` (one lease, not two) when the process identity is
verifiably dead-or-foreign-host, keeping the 2× grace only when identity is
unknown. One condition in `src/process-lock.ts:300` + clock-skew comment.

### 3.4 API-consumer orphan records △ S

Fresh-eyes #8: `runSubagent()` without `locks`/`runId` writes no run record,
so its children are invisible to orphan reclaim. Either (a) document loudly in
the JSDoc that durable reclaim requires `locks` + `runId` (S), or (b) create a
default ProcessLockManager when omitted (M, changes API behavior). Choose (a)
now, revisit if the SDK surface grows users.

---

## Phase 4 — Observability polish (v0.4.x)

### 4.1 Live transcript view in `/subagents` △ M

The UI-overhaul "stretch" item, now more valuable with steering: the detail
view shows the *checkpointed* transcript (capped, message-boundary updates).
Tail the child's session `.jsonl` (we know the path: `sessionDir` +
`sessionId`) for the selected running run, rendering the last N events live.
Read-only file tailing; no RPC changes. Pairs with the existing `s` steer key
to close the observe→steer loop in one surface.

### 4.2 Widget/notification config △ S

`widget: "background" | "off"` and `notifications: "batched" | "off"` in
`SubagentConfig` — some users will want quiet mode. Trivial gates around
`refreshWidget` / `CompletionBatcher` in `src/extension.ts`.

### 4.3 Stall/attempt events in checkpoints for `status` △ S

`stalledSince`/`attempts` already render inline and in details; also include
them in `formatStatusPreview` so background `status` polling shows
`[stalled 2m]` / `[attempt 2]` without opening the overlay.

---

## Explicitly deferred (decided, with reasons)

| Item | Reason |
|---|---|
| Inter-agent messaging (`hub`-style) | Star topology + synthesis + steer covers ~85%; even oh-my-pi (full engine access) scopes it to "quick coordination". Revisit only on demonstrated demand. |
| CoW filesystem isolation | Requires native code; impossible in a TS-only extension. `git worktree` stays. |
| In-process execution mode | Would forfeit our moat (crash durability, orphan reclaim, version isolation). |
| Chains / DAG workflows | The orchestrating LLM sequences calls fine; `resume` + structured outputs (1.1) compose. nicobailon's chain complexity is a warning, not an invitation. |
| Scheduling (cron) | Different product. A separate extension could call our tool. |
| Tiny-model label generation | `description` param covers it at zero cost. |
| Eager-delegation system prompt | Fork-only capability; our `promptGuidelines` already nudge. |
| Agent management UI (eject/create wizard) | Files are the UI; keep one config surface. |

## Sequencing summary

| Release | Contents | Theme |
|---|---|---|
| v0.3.0 | 1.1, 1.2, 1.3 | structured results |
| v0.3.x | 2.1, 2.2, 2.3, 2.4 | agent ecosystem |
| v0.4.0 | 3.1, 3.2, 3.3, 3.4 | engine hardening |
| v0.4.x | 4.1, 4.2, 4.3 | observability |

Every phase keeps the standing invariants (docs/ARCHITECTURE.md): capability
profiles fail closed, explicit params beat file/config defaults, delivery-once,
partial work is never discarded, and no feature may require the parent to be
alive for a child's work to survive.
