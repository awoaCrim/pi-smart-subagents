# Execution plan — remaining roadmap phases

> **Historical upstream plan.** Retained as design rationale for phases that shipped before this fork's Jev routing changes. Version targets, test paths and `npm run release:check` below describe the upstream monorepo, not tools available in this standalone checkout. See [the current reference](REFERENCE.md), [architecture contract](ARCHITECTURE.md) and [development checks](DEVELOPMENT.md) for the maintained behavior and verification instructions. Historical gate statements are not verification results for the current checkout.

Formalization of [ROADMAP.md](./ROADMAP.md) phases 2–4 into implementable work
items. Where the roadmap holds rationale and design sketches, this document
holds the execution contract: exact scope, file-level work breakdown,
acceptance criteria, test plan, and release gates. Each work item is sized to
be implementable in isolation (one branch / one reviewable diff) by a person
or subagent given only this document and the codebase.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

Shipped so far: Phase 1 (structured results) in v0.3.0; phases 2–4 landed
together and shipped as a single v0.4.0 (the staged v0.4.0/v0.5.0/v0.5.x
gates below were collapsed — all items met their gates concurrently).

---

## Ground rules (apply to every item)

1. **Invariants hold.** Every item must preserve docs/ARCHITECTURE.md
   invariants 1–26. Items that touch spawn/kill/lock paths must state which
   invariants they interact with in the PR description.
2. **Precedence order is sacred:** explicit request params > agent file >
   per-profile `taskDefaults` > parent inheritance. New fields slot into this
   order; nothing reorders it.
3. **Fail closed, degrade open.** Policy/validation errors reject before
   spawn with actionable messages. Runtime failures after money is spent
   preserve partial work (`partial`, never silent discard).
4. **Every item ships with:** unit tests, an integration test through the
   extension harness when the tool surface changes, doc updates (README +
   ARCHITECTURE invariants if applicable + CHANGELOG entry), and a green
   `npm run release:check`.
5. **Schema changes are additive.** `additionalProperties: false` on the tool
   schema means older callers break on unknown fields — new fields are always
   optional, never renamed, never repurposed.
6. **Fake-pi first.** New child behaviors get a deterministic fake-pi mode
   (tests/helpers/fake-pi.mjs) before any real-Pi E2E. Real-Pi E2E is run
   manually for runner-level changes and noted in the PR.

---

## Phase 2 — Agent ecosystem depth → v0.4.0

Theme: deepen the named-agent system shipped in 0.2.0 without adding a second
config surface. All items are additive.

### 2.1 `spawns:` allowlist in agent frontmatter  `[x]`  (S, high)

Per-agent control over which agents a child may spawn — finer than the global
depth cap, mirroring oh-my-pi's spawn policy.

**Behavior contract**
- Frontmatter `spawns:` accepts `false`, `"*"`, or a comma/bracket list of
  agent names. Absent = unrestricted (`"*"`), matching today's behavior.
- The policy travels to the child via a new env var `PI_SUBAGENT_SPAWNS`
  (set in `src/runner.ts` childEnv, next to `PI_SUBAGENT_DEPTH`):
  - unset/`*` → unrestricted
  - empty string → spawning disabled
  - `a,b` → only agents `a` or `b` may be requested; **agentless composition
    is also rejected** (a restricted parent may only delegate to named,
    vetted personas).
- Enforcement lives in `validateSubagentRequest` (`src/policy.ts`): parse the
  env like `parseDepth` — **fail closed on malformed values** (treat as
  disabled, not unrestricted).
- A child whose policy is `spawns: false` additionally does not register the
  subagent tool at all (extend the boot-depth check in
  `src/extension.ts` `registerSubagent`).
- This is an accidental-recursion guard, not a security boundary (children
  can shell out to `pi`); document in SECURITY.md next to the depth rule.

**Work breakdown**
- `src/agents.ts`: parse `spawns` frontmatter into
  `spawns?: false | "*" | string[]` on `AgentDefinition`.
- `src/policy.ts`: `SPAWNS_ENV_VAR`, `parseSpawnPolicy(value)` (exported,
  pure), enforcement branch in `validateSubagentRequest` before task
  normalization.
- `src/runner.ts`: set `PI_SUBAGENT_SPAWNS` in childEnv from
  `spec.spawns` (new TaskSpec field, resolved from the agent definition in
  policy).
- `src/extension.ts`: skip tool registration when the boot spawn policy is
  disabled (same pattern as `bootDepth >= 100`).

**Acceptance criteria**
- Agent file `spawns: false` → its children get no subagent tool; direct
  tool calls (if forced) are rejected with a message naming the restriction.
- `spawns: reviewer` → child may `agent: "reviewer"` only; `agent: "scout"`
  and agentless tasks are rejected with the allowlist in the error.
- Malformed env (`PI_SUBAGENT_SPAWNS="\x00junk"`) → spawning disabled, not
  unrestricted.
- Unrestricted paths (no agent file, no `spawns`) behave exactly as today —
  zero regression in existing tests.

**Tests:** policy unit tests (parse + enforce + fail-closed), agents.ts parse
tests, one integration test spawning through a restricted persona (fake-pi).

### 2.2 Resumable-session discovery in `status`  `[x]`  (S)

**Behavior contract:** bare `status` output lists, for each completed run
with a session id, a line `  session <id8> (resumable)` under the run
preview; run-specific `status` includes full session ids. One new
`promptGuidelines` bullet: resume via `resume: "<session id>"`.

**Work breakdown:** `src/extension.ts` status branch only (snapshot data
already carries `results[].sessionId`); no schema change.

**Acceptance criteria:** a finished run's session id is discoverable from
`status` alone (no overlay, no prior knowledge); delivered/dismissed runs
still listed until evicted.

**Tests:** extend the existing status integration test.

### 2.3 Dry-run validation — `action: "plan"`  `[x]`  (S)

**Behavior contract**
- `{ action: "plan", ...any single/parallel params }` runs full validation +
  preflight and returns the resolved plan without spawning:
  per task — label, agent (if any), model, thinking, profile, RO/RW,
  effective tools, budgets, isolation, and `resolutionNotes`.
- Preflight beyond policy: worktree tasks check `isGitRepo(cwd)`;
  `context:'fork'` checks the parent session file exists; `output` paths
  check the parent directory is writable (stat only, no writes).
- Validation failures return the same errors the real call would — `plan` is
  a truth oracle, never a softer check.

**Work breakdown**
- `src/schema.ts`: add `"plan"` to the Action union. **Note:** unlike other
  actions, `plan` combines WITH task fields — adjust the mode-exclusivity
  check in `src/policy.ts` (`action:"plan"` + task/tasks is the valid shape;
  `plan` alone is an error).
- `src/policy.ts`: thread a `planOnly` flag through `ValidationResult`.
- `src/extension.ts`: on plan mode, run worktree/fork/output preflights and
  return a formatted plan text + `details.plan` array. No registry entry, no
  run id.

**Acceptance criteria:** a parallel request with a shared-cwd writer
violation reports the same error via `plan` as via execution; a valid plan
reports resolved model/tools per task; nothing is spawned (no run appears in
`status` afterward).

**Tests:** policy unit tests for the new mode shape; integration test
asserting plan output + absence of registry entries.

### 2.4 Agent-file prompt composition — `@file.md` references  `[x]`  (S)

**Behavior contract:** an agent body line consisting solely of
`@include relative/path.md` is replaced by that file's contents (relative to
the agent file, same 64KB/symlink/name guards as `output_schema: @ref`).
One level only — includes do not recurse. Missing/oversized/symlinked
includes leave the line verbatim (degrade open, never fail discovery).

**Work breakdown:** `src/agents.ts` only (`parseAgentFile` body
post-processing + shared guard helper with `parseSchemaValue`).

**Tests:** agents unit tests (resolution, missing file, symlink rejection,
no recursion).

**Release gate v0.4.0:** 2.1–2.4 merged · all tests green · README agent-file
docs updated (spawns, @include) · SECURITY.md spawn-policy note · CHANGELOG ·
tag.

---

## Phase 3 — Engine hardening → v0.5.0

Theme: close the last known failure modes from the fresh-eyes review and the
oh-my-pi concurrency lesson. Highest-risk phase; every item starts with a
failing repro test.

### 3.1 Global-slot granularity for spawn trees  `[x]`  (M, high)

**Problem (repro first):** `maxGlobalActive` slots (`src/process-lock.ts`
`tryAcquireGlobalSlot`, held in `src/runner.ts` for the child's entire run)
are consumed by nested parents while they block on their own children — a
spawn tree wider than the cap deadlocks.

**Step 1 — repro test (merge even before the fix):**
`tests/process-lock.test.ts`: with `maxGlobalActive: 2`, simulate a depth-1
parent holding a slot while two of its children queue for slots; assert the
current behavior deadlocks/times out, then flip the assertion with the fix.

**Step 2 — chosen design: depth-reserved tiers.** Deterministic and simple:
slot files gain a `depth` field; `tryAcquireGlobalSlot(runId, depth)` enforces
`activeAtOrBelowDepth(depth) < maxGlobalActive - reservedFor(depth)` where
`reservedFor(depth) = min(depth, maxDepth-1)` slots are held back for deeper
tiers. With defaults (cap 16, maxDepth 2): depth-0 children may hold at most
15 slots, guaranteeing depth-1 spawns always have ≥1 slot — deadlock becomes
impossible by construction. Rejected alternative (release-while-waiting) needs
child-side cooperation signals we don't have.

**Work breakdown:** `src/process-lock.ts` (slot record field + tiered
acquire), `src/runner.ts` (pass depth), migration: slot files without `depth`
count as depth 0.

**Acceptance criteria:** repro test passes; existing single-level fanout
behavior unchanged (16 leaf tasks still run 16-wide); a full-width tree at
depth 0 + spawning children completes without timeout.

### 3.2 Dirty-baseline worktrees — `include_wip`  `[x]`  (M)

**Behavior contract**
- New task field `include_wip: true` (worktree isolation only; rejected
  otherwise): after `git worktree add`, the parent checkout's uncommitted
  changes (`git diff HEAD` + untracked files) are applied to the worktree,
  uncommitted.
- The WIP patch is stored in the `WorktreeHandle`; `diff` and `apply`
  subtract it: `diff` shows agent-only changes when subtraction is clean,
  and falls back to the combined delta **with an explicit
  `[includes parent WIP]` warning** when it is not (never silently wrong).
- Default off. `finalize`'s changed-detection treats a worktree containing
  only the untouched WIP patch as unchanged (clean up, don't preserve).

**Work breakdown:** `src/worktree.ts` (create option, WIP capture/apply,
handle field, subtraction in `diff`), `src/orchestrator.ts` (thread the
flag), `src/schema.ts`/`src/policy.ts` (field + validation), extension
worktree actions unchanged (they read the handle).

**Acceptance criteria:** worktree child sees parent WIP; `diff` on an
untouched WIP-seeded worktree reports no agent changes; `apply` lands only
agent changes on the clean-subtraction path; combined-delta fallback carries
the warning.

**Tests:** worktree unit tests with a dirty repo fixture (staged + unstaged +
untracked), orchestrator integration test.

### 3.3 Lease-expiry reclaim latency  `[x]`  (S)

**Behavior contract:** in `src/process-lock.ts` stale-lock evaluation
(`acquireSessionLock`), a lock whose owner is *verifiably dead* (same host,
`isAlive === false` with a start-time identity match) is reclaimable
immediately (already true) — and a lock whose lease is expired is reclaimable
after **one** lease period (`leaseExpiresAt < now`) when the owner's host
differs or identity is unverifiable-but-lease-expired, keeping the current
2× window only when clock skew is plausible (same host, identity unknown).
Document the skew assumption inline.

**Tests:** table-driven stale-evaluation tests over (host match ×
identity-verifiable × lease state).

### 3.4 API-consumer orphan documentation  `[x]`  (S)

`runSubagent()` without `locks` + `runId` writes no durable run record, so
its children are invisible to orphan reclaim. Add a prominent JSDoc warning
on `runSubagent` and `RunnerOptions.locks`, plus a README "Using the runner
as a library" note. Decision recorded: no implicit default lock manager (an
API user who wants durability opts in; magic global state is worse).

**Release gate v0.5.0:** 3.1 repro + fix · 3.2–3.4 · ARCHITECTURE invariants
updated (tiered slots → new invariant; WIP worktrees → amend invariant 16) ·
real-Pi E2E for 3.1/3.2 noted in PR · CHANGELOG · tag.

---

## Phase 4 — Observability polish → v0.5.x

Theme: close the observe→steer loop. UI-only; no engine risk.

### 4.1 Live transcript view in `/subagents`  `[x]`  (M)

**Behavior contract**
- In the overlay detail view of a **running** run, pressing `t` toggles a
  live transcript pane: tail of the child's session file
  (`sessionDir/<sessionId>.jsonl` — resolve via the same glob the session
  retention sweep uses), rendered as compact lines (role-prefixed text,
  `→ tool` / `← result` markers), auto-following unless scrolled up.
- Read-only file tailing on a 500ms poll while visible; no RPC traffic, no
  reads when hidden or for finished runs (finished runs keep the existing
  checkpointed transcript).
- Degrades gracefully: session file not yet created → "waiting for child
  session…"; unparseable lines skipped.

**Work breakdown:** `src/ui.ts` (detail-view mode flag, tail state, `t`
key), a small pure `tailSessionFile(path, maxLines)` helper in
`src/maintenance.ts` or new `src/transcript.ts` (unit-testable), adapter
method `getSessionFilePath(id)` on `SubagentAdapter`.

**Acceptance criteria:** transcript follows a live child within one poll
interval; scroll-up pauses follow; `s` steering still works from the same
view (observe → steer without leaving the overlay).

**Tests:** pure tail-helper tests (partial lines, rotation, missing file);
UI model test for the mode toggle.

### 4.2 Widget/notification config  `[x]`  (S)

`SubagentConfig` gains `widget: "background" | "off"` (default `background`)
and `notifications: "batched" | "off"` (default `batched`), env
`PI_SUBAGENT_WIDGET` / `PI_SUBAGENT_NOTIFICATIONS`. Gates in
`refreshWidget` and the `CompletionBatcher` wiring (`src/extension.ts`).
Config-sanitizer + integration tests for the off states.

### 4.3 Reliability flags in status previews  `[x]`  (S)

`formatStatusPreview` (`src/format.ts`) appends `[stalled <dur>]` for active
runs with `stalledSince` and `[attempt N]` when `attempts > 1`, so background
`status` polling and streamed tool updates surface watchdog/retry state
without the overlay. Format unit tests; keep the preview single-line and
within existing truncation.

**Release gate v0.5.x:** 4.1–4.3 · UX.md updated · CHANGELOG · tag.

---

## Cross-cutting checklists

**Definition of done (per item)**
- [ ] Failing test written first for behavior changes (mandatory for Phase 3)
- [ ] Unit tests + integration test (if tool surface changed)
- [ ] Fake-pi mode added when child behavior is involved
- [ ] README + relevant docs/ updated; ARCHITECTURE invariant added/amended
      when a guarantee changes
- [ ] CHANGELOG entry under the next unreleased version
- [ ] `npm run release:check` green
- [ ] Roadmap/plan status boxes updated (`[ ]` → `[x]`)

**Release procedure** (per docs/RELEASING.md): bump version + CHANGELOG →
commit → `git tag pi-subagent-vX.Y.Z` → push tag → monorepo CI publishes
this package (GitHub Release + npm via OIDC with provenance).

**Re-planning triggers** — revisit this plan (not just execute it) if:
- Pi upstream ships native subagent/task support (re-evaluate overlap),
- the RPC protocol changes shape (runner assumptions in 2.1/4.1),
- Claude Code's agent-teams stabilizes AND user demand for inter-agent
  messaging materializes (deferred item in ROADMAP.md),
- `@parke.dev/pi-subagent` adoption surfaces a failure mode not covered by
  phases 3–4 (reliability reports take priority over planned work).
