# Usage and configuration reference

Return to the [English README](../README.md) or [Chinese README](../README.zh-CN.md) for installation. This reference documents the extension-managed Jev path and the separate explicit-spec SDK. The underlying subagent engine comes from Luke Parke's upstream extension; Jev routing and startup capability verification are additions in this fork.

---

### Credential setup

Version `0.10.0` and later read the TypeSafe key from `jevRouting.apiKey` in your private, user-level `~/.pi/subagent.json`. Set the key locally using an editor, preserve unrelated configuration and replace the placeholder in the [routing example](#jev-routing). Do not paste the key into chat, shell commands, source control or task descriptions.

This file stores the credential in plaintext. Restrict access to your user account and protect editor backups and synchronized copies. Same-user processes, including children with filesystem access, may read it; neither profiles nor worktrees provide an OS sandbox. See [SECURITY](SECURITY.md#routing-disclosure-and-credentials).

When upgrading from published npm `0.9.0`, remove `apiKeyEnv` and add `apiKey` with the actual key locally. The old field is rejected even if both fields are present. There is no environment fallback, automatic migration or default key. Published `0.9.0` still requires its older `apiKeyEnv` setup, while `0.10.0` uses the config-file credential contract.

Reload or restart Pi after changing extension code or `toolMode`; let active tasks finish first because reload can cancel them. Subsequent dispatches re-read routing configuration, so a later key or routing-destination edit takes effect on the next decision without setting an environment variable or restarting the process. This does not hot-switch the registered tool mode. Provider credentials for execution models are configured independently using Pi's own authentication mechanisms. Rotate credentials exposed in source, logs or conversation.

---

### Tool modes

`toolMode` controls the model-facing request surface of `subagent`, not the child engine or a security sandbox. Both modes keep `subagent_wait` and existing run management. The default is `compact`, including upgrades without an explicit setting. To expose advanced parameters, merge this fragment into your existing `~/.pi/subagent.json` without replacing routing credentials or other settings:

```json
{ "toolMode": "full" }
```

Only exact `compact` and `full` values are accepted; missing or invalid values fall back to compact. There is no environment or per-call override. The extension captures the mode when it registers. Editing the file alone does not change current schemas, guidance or acceptance; reload or restart Pi after active tasks finish. An ordinary session change does not rebuild the tools, and reload can cancel active work.

| Request surface | Compact | Full |
| --- | --- | --- |
| Shared task fields | `agent`, `description`, `profile`, `difficulty`, `cwd`, `timeout_ms`, `max_turns`, `max_cost`, `isolation` | All compact fields plus the advanced fields below |
| Advanced task fields | Not exposed | `system_prompt`, `tools`, `grace_turns`, `max_retries`, `context`, `output`, `output_schema`, `output_mode`, `resume`, `fork_resume`, `include_wip`, `allow_shared_writes`, `keep_background` |
| Root request fields | Shared fields plus `action`, `id`, `message`, `index`, `task`, `async`, `tasks` | Same plus `synthesis` |
| Actions | `status`, `wait`, `cancel`, `steer`, `diff`, `apply`, `discard` | Same plus `plan` |
| Property counts (root / task item) | 16 / 10 | 30 / 23 |

A `tasks[]` item contains `task` plus the shared task fields for its mode. `subagent_wait` remains `id` plus optional `timeout_ms`. Hidden fields reject, even if false or empty, including in mixed parallel batches; they are not silently dropped. Neither mode exposes manual `model`, `fallback_models` or `thinking` controls. Full mode makes advanced options available but does not enable them automatically.

Trusted named-agent and profile/config defaults still apply, including advanced defaults such as structured contracts or retry budgets. Existing results, session/artifact pointers and WIP worktrees remain collectable/manageable under compact. Resume requires full mode; compact status and inspector help explain this without preparing an unavailable call. The explicit-spec SDK and human `/btw` command keep their existing behavior.

### Sparse request arguments

Pass only fields needed for the chosen operation: management uses `action`/`id`, single work uses `task`, and parallel work uses `tasks`. Do not fill irrelevant optional fields with placeholders. Genuine combinations remain errors; full-mode `action: "plan"` is the exception and requires exactly one of `task` or `tasks`.

For a selected physical `openai-responses` model matching the outgoing request, the extension adds a missing `strict: false` declaration to its two direct tools. Without that flag, Responses can normalize optional properties into required fields and cause a status call to include conflicting task placeholders. The correction preserves schemas and local validation in both tool modes; it does not clean incoming arguments.

Existing `strict` values and an explicit `supportsStrictMode: false` compatibility setting are respected. Other APIs, virtual selections, mismatched model metadata and deferred/historical declarations are unchanged. The public Pi request hook does not identify a virtual route's physical model, so those paths are not guessed or advertised as repaired.

### Quick usage

These are request objects for the `subagent` tool, not shell commands. Examples work in compact unless marked full. New work calls Jev; omit `model` and `fallback_models`.

#### Foreground and named agents

Use an explicit read-only profile for exploration. Single tasks otherwise default to `general`.

```json
{
  "task": "Find all call sites of parseConfig and summarize patterns.",
  "description": "Map parseConfig usage",
  "profile": "explore"
}
```

A named agent supplies a persona and non-model defaults; Jev still chooses the execution model, while local policy resolves the ordinary tool set and Pi keeps native tool activity host-owned.

```json
{
  "task": "Review this diff for security issues.",
  "agent": "reviewer",
  "profile": "review"
}
```

#### Parallel tasks and synthesis

Parallel tasks default to `explore`. Both modes accept 1–10 tasks per batch, with a default concurrency of 10 per parent session. Explicit lower settings and the machine-wide limit can still constrain execution:

```json
{
  "tasks": [
    { "task": "Audit backend error handling.", "description": "Backend audit" },
    { "task": "Audit frontend error handling.", "description": "Frontend audit" }
  ]
}
```

In **full mode**, add `"synthesis": "Merge both audits into one prioritized findings list."` to the root request to start an additional read-only child with its own routing selection. Raw worker results remain available if synthesis fails.

#### Background work and collection

Start a background run and keep its returned run ID:

```json
{ "task": "Audit dependency licenses.", "profile": "review", "async": true }
```

Inspect without consuming the deliverable:

```json
{ "action": "status", "id": "<run-id>" }
```

Collect the result with the same tool:

```json
{ "action": "wait", "id": "<run-id>" }
```

Or pass this request to `subagent_wait`, which delegates to the same collection handler:

```json
{ "id": "<run-id>", "timeout_ms": 30000 }
```

An interrupted or timed-out wait does not cancel or consume a still-running task. A real dispatch is registered before local preflight and Jev selection, so prelaunch failures and selector receipts remain discoverable under the same run ID. `async: true` returns a background receipt after dispatch preparation; a foreground call also transfers to background ownership when its task reminder threshold is reached, including while preparation is still pending. Cancel explicitly when needed:

```json
{ "action": "cancel", "id": "<run-id>" }
```

#### Inspect a paid plan

**Full mode.** A plan runs local preflights and Jev selection without spawning a child or creating a run entry. It can incur selector fees; a later dispatch selects again. It checks the same model/tool/budget/isolation resolution as a launch. Each resolved plan line reports the supplied `difficulty` (or `(unspecified)` when none was given).

```json
{
  "action": "plan",
  "tasks": [
    { "task": "Implement feature A.", "profile": "general", "isolation": "worktree" }
  ]
}
```

#### Task difficulty

`difficulty` is an optional scope/reasoning hint added to Jev's routing context. It never hardcodes a model, reorders your candidates, changes tool permissions, or alters retry/failover behavior. When no agent, profile-default, or selected-candidate thinking value exists, it also supplies a small local thinking default: `simple` → `minimal`, `moderate` → `medium`, `complex` → `high`. This mapping does not override a trusted configured value and does not guarantee the model will use that level.

| Value      | Use for                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `simple`   | Bounded, well-specified read-only review; documentation/format checks; local verification.                                       |
| `moderate` | Multi-file analysis; ordinary bug fixes; focused research with known boundaries.                                                 |
| `complex`  | Architecture/design; cross-layer implementation; difficult debugging with an unknown root cause; high-risk or broad changes.     |

```json
{
  "task": "Review the auth diff for security issues.",
  "profile": "review",
  "difficulty": "simple"
}
```

Choose the lowest honest level. `simple` can steer Jev toward a candidate suited to bounded work and, when thinking is otherwise unspecified, uses Pi's `minimal` level; it does not guarantee a specific model or semantic effort because candidate descriptions, profile, candidate thinking and Jev's probability ranking still decide. Omit the field when you have no honest signal; older callers stay valid and no difficulty is inferred. An invalid value is rejected locally before any selector request. The difficulty itself is not stored in results, session entries or run snapshots, but the resolved thinking is shown in plans and routed result metadata.

#### Structured output

**Full mode for an explicit `output_schema` request.** Trusted named-agent contracts still work in compact. The child must produce a fenced `json:result` block matching the requested schema. After an otherwise successful answer, the parent validates it and allows one repair round. An unresolved schema failure preserves raw output as a partial result rather than discarding paid work. A terminal provider failure does not trigger a repair prompt or publish a structured result, even if its text contains valid JSON; it follows the availability-failure rules instead.

```json
{
  "task": "Audit the auth module.",
  "profile": "review",
  "output_schema": {
    "type": "object",
    "required": ["findings", "risk"],
    "properties": {
      "findings": { "type": "array", "items": { "type": "string" } },
      "risk": { "type": "string", "enum": ["low", "medium", "high"] }
    }
  }
}
```

#### Resume, fork and steering

**Full mode:** a fork starts from a branch of the persisted parent conversation. It is single-task only:

```json
{ "task": "Implement the plan we agreed on.", "context": "fork", "profile": "general" }
```

Find a resumable child session ID in status, then start a new invocation:

```json
{ "task": "Continue from your findings and propose a fix plan.", "resume": "<session-id>" }
```

Both operations select again. **Both modes** can steer an existing running child; parallel runs use `index` to select the worker:

```json
{ "action": "steer", "id": "<run-id>", "index": 0, "message": "Skip tests; focus on src and wrap up." }
```

#### Budgets and retries

Task `timeout_ms` is one elapsed reminder/foreground handoff threshold, **not a maximum execution duration**. The clock starts at invocation and includes configuration/preparation, local preflight, Jev selection, setup, queueing, startup, attempts and optional synthesis. A still-pending foreground call returns the full run ID and its current queued/running evidence at the threshold; the same run continues in background ownership. Use status/wait/steer/cancel rather than launching replacement work merely because it is slow.

Parallel work uses the shortest resolved item threshold on the shared invocation clock, even if that worker has finished while siblings remain. Each run receives at most one reminder: either the awaiting tool receipt or a parent steer message after an async startup receipt, never both. Completion before the threshold suppresses it. A reminder does not retry, reset budgets, renew paid-call authorization or consume output/native usage. The `notifications` setting controls completion messages only; the elapsed reminder is independent.

**Compatibility change:** saved tool, agent, profile and `defaultTimeoutMs` values now have this advisory meaning; names, precedence and numeric defaults are unchanged. Foreground abort cancels before transfer. After handoff or explicit async startup, the old initiating signal no longer cancels the run; explicit cancel and session/tree shutdown still do. `subagent_wait.timeout_ms` remains a caller-wait limit and does not restart the task clock. Private `/btw` keeps awaiting its answer and shows only a human reminder. Plan has no live run or handoff; its actual selector-request limit remains enforceable.

Turn/cost breaches still request a final answer and allow configured grace turns. Independent selector-request, startup-verification and protocol-stall faults still stop work; old terminal timeout snapshots remain readable. The trusted unranked SDK keeps its separate hard `TaskSpec.timeoutMs` contract. Before tools start, a recognized model-availability failure can advance through Jev's ranking within the unchanged attempt limits and cumulative execution budgets. Switching never calls Jev again.

Both modes expose `timeout_ms`, `max_turns` and `max_cost`:

```json
{ "task": "Audit dependencies.", "profile": "review", "max_turns": 15, "timeout_ms": 300000 }
```

**Full mode** additionally exposes per-call `grace_turns` and `max_retries`. Trusted agent/profile/config defaults remain effective in compact. `max_retries` is the total number of extra child attempts: `0` permits the initial attempt only, `1` permits at most two attempts, and `2` permits at most three. The built-in default is `1`; task, agent, profile and configuration overrides still apply. The list never wraps back to an earlier candidate. Pi's own in-process/provider retries are separate and unchanged, so a child can make multiple provider requests before the extension sees its final failure. See [ranked failover](#probability-ranked-failover) for the failure boundary.

```json
{ "task": "Audit dependencies.", "profile": "review", "max_turns": 15, "grace_turns": 2, "max_retries": 1 }
```

#### Isolated writers

Use separate worktrees for parallel changes:

```json
{
  "tasks": [
    { "task": "Implement feature A.", "profile": "general", "isolation": "worktree" },
    { "task": "Implement feature B.", "profile": "general", "isolation": "worktree" }
  ]
}
```

Inspect each finished patch:

```json
{ "action": "diff", "id": "<run-id>", "index": 0 }
```

Apply it as uncommitted changes in the parent checkout:

```json
{ "action": "apply", "id": "<run-id>", "index": 0 }
```

Discard an unwanted worktree and branch:

```json
{ "action": "discard", "id": "<run-id>", "index": 1 }
```

The `/subagents` overlay provides the same loop: `s` to steer, `a` to apply and `x` to discard.

---

### Side questions (`/btw`)

Ask a side question in Pi:

```text
/btw does this repo have a rate limiter?
```

Or open the question prompt:

```text
/btw
```

`/btw` runs a one-off read-only subagent for _you_, not for the model. It uses the same policy, budget, semaphore and process-lock machinery as any run, but delivers its answer as a custom session entry, which does not participate in LLM context. At its advisory threshold it shows a human-only notice and continues privately awaiting the final answer; no parent reminder/completion is sent, and the notice is not a completed answer. Useful for checking something mid-task without derailing the conversation or polluting the context window.

---

### Execution runtime

All extension-managed children run through Pi's RPC runtime. Jev selects the
execution model only; local active-tool, profile and explicit-tool policy activates
the complete ordinary locally permitted tool set, while the extension keeps
worktree isolation, process locks, depth limits, budgets, startup verification,
steering, resume/fork, and structured-output guarantees in one Pi path.

The low-level SDK and the Pi extension share this same child runtime contract;
there is no second execution runtime or implicit tool augmentation in the task
schema. Unsupported capability combinations are refused rather than silently
ignored.

---

### Profiles

| Profile                      | Tools                                                   | Writes                                      |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `explore` (parallel default) | all locally permitted active read-only tools | no project-file writes |
| `review`                     | same as explore                                         | no project-file writes                      |
| `general`                    | all active locally permitted ordinary tools after explicit-tool policy | yes when the local set includes write-capable tools; unknown custom tools count as writable |

Local policy activates the complete ordinary tool set that survives one Pi `getAllTools()` + active-name snapshot, profile restrictions and an explicit task `tools` ceiling. Registered-but-inactive direct definitions are not ordinary active tools; `model-only`, `codemode` and `deferred` definitions are native managed tools rather than ordinary local candidates. `hidden` definitions are excluded. Direct SDK/custom tools remain ordinary because classification follows official exposure, not source/name heuristics. They do not come from the agent file's `tools` defaults. Jev selects the execution model only and makes no per-tool choice; tool names and descriptions stay out of the selector HTTP payload. A local empty ordinary/native candidate set results in `--no-tools`, while any locally permitted tool is preserved in the child candidate allowlist rather than dropped by selector choice; startup may still negotiate an unforced omission.

Pi 0.99.0+ official non-direct, non-hidden definitions are native managed tools: they are carried automatically in the finalized child candidate allowlist and startup manifest, but are omitted from Jev questions and their activity remains host-owned. Older hosts without `exposure` metadata use Pi's default `direct` behavior. Source metadata is retained for provenance/diagnostics only, and annotations never establish write safety. The full finalized candidate allowlist (ordinary direct names plus derived native names) is sent as Pi's `--tools` set (`--no-tools` when empty). Before the real task prompt is sent, a verified private startup command confirms the selected model and negotiates the child-effective set from bounded ordinary-active/native-registration evidence; native names do not need to appear in the active list. A candidate that is absent in the child is reported as `omittedTools` and is non-fatal by default. An explicit `tools` request is carried as a forced capability requirement, so a missing requested name fails closed. Active names outside the finalized candidate set, duplicate/malformed evidence, or a source/model/nonce mismatch still abort with a startup diagnostic instead of broadening capabilities.

Parallel write-capable tasks sharing one checkout are rejected unless each uses `isolation: "worktree"`, distinct `cwd`, or explicit `allow_shared_writes: true` (full mode only).

---

### Configuration

Defaults can be overridden in `~/.pi/subagent.json`; runtime fields with an env var below also support env overrides (env wins over file):

| Setting                 | Env var                               | Default                               |
| ----------------------- | ------------------------------------- | ------------------------------------- |
| `toolMode`             | -                                     | `compact` (registration-time; see [tool modes](#tool-modes)) |
| `maxTasksPerRun`        | `PI_SUBAGENT_MAX_TASKS`               | 10                                    |
| `maxActiveProcesses`    | `PI_SUBAGENT_MAX_ACTIVE`              | 10                                    |
| `maxQueuedTasks`        | `PI_SUBAGENT_MAX_QUEUED`              | 32                                    |
| `maxGlobalActive`       | `PI_SUBAGENT_MAX_GLOBAL_ACTIVE`       | 16                                    |
| `defaultTimeoutMs`      | `PI_SUBAGENT_TIMEOUT_MS`              | 900000 (advisory task threshold)       |
| `maxDepth`              | `PI_SUBAGENT_MAX_DEPTH`               | 2                                     |
| `killGraceMs`           | `PI_SUBAGENT_KILL_GRACE_MS`           | 3000                                  |
| `sessionDir`            | `PI_SUBAGENT_SESSION_DIR`             | `~/.pi/subagent-sessions`             |
| `worktreeDir`           | `PI_SUBAGENT_WORKTREE_DIR`            | `~/.pi/subagent-worktrees`            |
| `lockDir`               | `PI_SUBAGENT_LOCK_DIR`                | `~/.pi/subagent-locks`                |
| `worktreeRetentionDays` | `PI_SUBAGENT_WORKTREE_RETENTION_DAYS` | unused (lifecycle GC)                 |
| `sessionRetentionDays`  | `PI_SUBAGENT_SESSION_RETENTION_DAYS`  | unused (lifecycle GC)                 |
| `lockRetentionDays`     | `PI_SUBAGENT_LOCK_RETENTION_DAYS`     | 7                                     |
| `taskDefaults`          | -                                     | none                                  |
| `jevRouting`            | -                                     | required for new dispatch (see below) |
| `graceTurns`            | `PI_SUBAGENT_GRACE_TURNS`             | 2                                     |
| `stallAfterMs`          | `PI_SUBAGENT_STALL_AFTER_MS`          | 90000                                 |
| `stallKillAfterMs`      | `PI_SUBAGENT_STALL_KILL_AFTER_MS`     | 90000                                 |
| `maxRetries`            | `PI_SUBAGENT_MAX_RETRIES`             | 1                                     |
| `widget`                | `PI_SUBAGENT_WIDGET`                  | `background` (`off` disables)         |
| `notifications`         | `PI_SUBAGENT_NOTIFICATIONS`           | `batched` (`off` disables completion messages, not elapsed reminders) |
| (bin)                   | `PI_SUBAGENT_BIN`                     | auto (`process.execPath` + CLI entry) |

Batch and concurrency defaults are shared by root and nested parent sessions; they do not bypass spawn permissions or depth limits. `maxTasksPerRun` can lower the accepted batch size, but the public schemas cap it at 10. `maxActiveProcesses` controls active child slots across that parent's runs, independently of batch size. The unchanged `maxGlobalActive` limit and depth reservations still apply across Pi parents, so a busy machine does not guarantee ten available slots.

#### Jev routing

New subagent dispatches are selected by Jev, TypeSafe's structured-decision API, against a dedicated candidate list you maintain in `~/.pi/subagent.json`. Fixed routing is gone: a `modelPolicy` block produces a migration error, and an explicit `model` or `fallback_models` on new work is rejected rather than bypassing selection. Management actions (`status`, `wait`, `cancel`, `steer`, `diff`, `apply`, `discard`) never call the selector and need no credential.

```json
{
  "jevRouting": {
    "selectorModel": "jev-latest",
    "baseUrl": "https://api.typesafe.ai/v1/systemone",
    "apiKey": "<your-typesafe-api-key>",
    "timeoutMs": 15000,
    "models": [
      {
        "model": "<provider/model-id>",
        "description": "<your characteristics notes, Chinese allowed>"
      }
    ]
  }
}
```

| `jevRouting` field | Default / requirement | Purpose |
| --- | --- | --- |
| `baseUrl` | Optional; exact official `https://api.typesafe.ai/v1/systemone` when omitted | Complete normalized HTTPS SystemOne request URL; no implicit path rewriting |
| `apiKey` | Required; private config only | Header-only TypeSafe credential; never put it in URL or routing data |

- `selectorModel` defaults to the stable alias `jev-latest`. Pin an exact version to control which selector version is requested. This does not guarantee deterministic choices; the extension records the version that actually answered.
- `apiKey` is required and has no default. It must be a non-blank string; surrounding whitespace is trimmed and embedded whitespace/control characters are rejected. Store it only in the private config file. The transport uses it only for the Authorization header and does not copy it into prompts, selector JSON bodies, argv, logs, receipts or results. `apiKeyEnv` is rejected with migration guidance; environment variables cannot supply or override the key.
- `baseUrl` is optional and is the complete SystemOne request URL. When omitted, the exact official default `https://api.typesafe.ai/v1/systemone` is used. The URL is canonicalized by the standard URL parser and never receives an implicit path suffix or replacement. It must be an absolute `https://` URL with a hostname, no username/password, query, fragment, whitespace or control characters, and no more than 2048 characters; invalid values reject new routing before HTTP. A custom destination receives the same minimal task/model routing disclosure, so configure it only when that endpoint is trusted. The normalized URL remains in the private frozen config snapshot, not in routing DTOs, prompts, receipts, persisted results or child arguments.
- `timeoutMs` defaults to 15000 and must be an integer between 100 and 600000. It bounds one logical task selection, including all its HTTP requests and queue waits. Parallel workers each have a selection allowance; advisory task `timeout_ms` does not shorten it. Deferred synthesis has a separate allowance.
- `models` holds 1 to 255 entries, each with an exact `provider/model-id` and a non-blank description. Those descriptions are what Jev matches against your task, so write them the way you would explain the model to a colleague. A candidate may include an optional trusted `thinking` default; it is not a request-body field.

Plan and background-start native usage attachments are limited to 1024 selector HTTP receipts per invocation. Larger requests fail with a request-splitting error; background work has not started at that point. Previously incurred selector tokens remain in the ledger. This bounds an atomic delivery record; local tool activation is resolved separately and is not part of the selector request count.

The candidate list is intersected with the models the local Pi registry reports as available. A configured model Pi cannot resolve is not eligible, and an empty eligible pool fails before any request. Adding a model anywhere else in Pi does not authorize it, and legacy `modelPolicy` entries are never imported automatically. An unknown `jevRouting` field is an error, not a silent default.

Jev receives only the current delegated task text, your model IDs and descriptions, the requested difficulty and the permission/output requirements it needs to choose the execution model. It does not receive tool names or descriptions, repository files, conversation history, full system prompts, persona text or tool parameter schemas. Task text and model descriptions are user content and may contain sensitive material, so treat what you delegate as disclosure to TypeSafe.

Every new extension-managed dispatch routes through Jev: `task`/`tasks[]`, `action:"plan"`, `/btw`, resume, fork, locally permitted nested dispatch and the optional `synthesis` child. `action:"plan"` calls Jev and runs the same local preflights, returns the resolved model and local tool plan and the selector usage, and creates no child or run entry. A later dispatch selects again; there is no cached decision to reuse. If optional synthesis selection fails, the worker plan and its usage stay valid and synthesis is reported as blocked with its diagnostic.

There is intentionally no `thinking` field in a `subagent` or `tasks[]` request; the closed request schema rejects manual thinking overrides. Thinking remains an opaque Pi/model-level string, with common values such as `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, but callers do not pass it in the request body. Resolution order is: agent frontmatter `thinking` > profile `taskDefaults.<profile>.thinking` > the selected candidate's optional `thinking` > the difficulty-derived default (`simple` → `minimal`, `moderate` → `medium`, `complex` → `high`) > the parent session's thinking level. Jev never chooses a thinking level. Pi may clamp or map the resolved value for a particular model; routed startup evidence reports `effectiveThinking` when the host exposes it, so a result can show `thinking:configured→effective`. Older/reduced hosts may omit that optional observation.

The extension re-reads `jevRouting` on each dispatch and injects non-secret routing guidance into the parent prompt, never the key. Configuration edits reach the next decision without a code change. Missing or invalid `jevRouting.apiKey`, or other invalid routing configuration, rejects new dispatch and plan with a remedy; management stays available.

The mandatory routing above is the Extension dispatch contract. The stable SDK exports (`runTasks` and `runSubagent`) are trusted low-level library APIs: they execute the explicit `TaskSpec` you pass and perform no implicit routing, config discovery or network call. Library callers own model and tool choice, and must not read these SDK calls as Jev enforcement.

#### Probability-ranked failover

Version `0.11.0` adds this behavior. Published `0.10.0` retries the selected model rather than advancing through the ranked candidates.

TypeSafe's Choice response includes a probability for every eligible option. The extension retains that distribution and tries higher-probability candidates first. These values express the selector's preference, not measured model uptime or success rates. The separate `confidence` value belongs to the original answer. A tied maximum keeps Jev's returned choice first; other ties follow configured candidate order. Low or zero probability is not a new exclusion threshold.

Local policy resolves one complete ordinary/native candidate set for every attempt; it is independent of the selected execution model and adds no selector HTTP requests. Each candidate still gets its own thinking default under the existing precedence and fresh model/capability negotiation. Unforced child omissions are recorded in `toolDiagnostics`; an active-capability mismatch, a missing forced name or other attestation failure stops the task instead of trying a broader capability set.

Switching requires a settled provider error and conclusive evidence that no tool execution has begun in this invocation. Recognized cases include an explicitly unavailable model, temporary throttling, service overload and identifiable transport failures. Authentication/configuration errors, quota or billing exhaustion, invalid requests, context limits, refusals, poor answers, schema failures, cancellation and exhausted budgets do not trigger a model switch. Recognition uses only the latest completed assistant error's bounded message and documented primitive `diagnostics.error.code`, never ordinary answer text or arbitrary diagnostic details. Authentication, quota and other excluded evidence take precedence over an availability code. Unfamiliar error formats stop conservatively. A tool-start event blocks restart even when no result arrived; missing or malformed protocol evidence is not permission to retry. Historical tool messages in a resumed or forked session are not new execution.

For an eligible failure, the next allowed extension attempt advances immediately to the next candidate; it does not first add a same-model retry. Conclusively pre-work local process failures can retry the same candidate under the same total attempt budget. Attempts also have a local resource ceiling of 255 launches, including infrastructure retries. An elapsed reminder, uncertainty after startup or a stall cannot be used to restart work that may have begun. Any explicitly supplied hard deadline remains enforceable. Pi's internal retries remain enabled or disabled according to your existing Pi settings, which this extension does not change.

Plan and status distinguish the original selector choice from the actual execution model. Results retain bounded attempt metadata, failure categories, output previews and child-session pointers; previews are attributed to the attempt that produced them. A later successful structured answer is not concatenated with failed JSON. If Pi retries within the same child, an empty latest answer stays empty; it never reuses text or JSON from the failed turn. If all attempts fail, the final failure/model/session remain authoritative. Earlier output remains available while its session is referenced on the active branch. Usage accumulates under the same run, without duplicating selector receipts; existing native-accounting limitations for thrown failures still apply.

A selector timeout or invalid response still stops dispatch. Failover uses only the validated ranking from that invocation, never an emergency model or a new selection. New invocations, including resume/fork and synthesis, select afresh. Trusted SDK specs without a ranked route retain their existing explicit fallback behavior.

#### Named agent files

Define reusable subagent personas as markdown files, discovered from the same conventional roots skills use (higher root wins name conflicts):

| Priority | Location                                                                | Scope                       |
| -------- | ----------------------------------------------------------------------- | --------------------------- |
| 1        | `.pi/agents/<name>.md`                                                  | project (authoritative)     |
| 2        | `.agents/agents/<name>.md`                                              | shared cross-tool workspace |
| 3        | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/`) | global                      |

The markdown body becomes the child's appended system prompt; frontmatter supplies defaults using the same snake_case names as the tool parameters:

```md
---
description: Security-focused code reviewer
# Legacy model/fallback fields are ignored; Jev owns model choice and local policy owns tool activation.
thinking: high
profile: review
max_turns: 20
spawns: false # or "*", "scout", "[reviewer, scout]"
---

You are a security auditor. Review code for injection flaws, auth issues,
and sensitive data exposure. Report findings with file:line evidence and
severity ratings.

@include shared/review-checklist.md
```

Agent files may also pin a structured contract with `output_schema: {"type": "object", …}` (single-line inline JSON) or `output_schema: @contract.json` (path relative to the agent file).

`spawns:` controls which agents a child of this persona may spawn: `false` disables further nesting (no tool registered in that child), `"*"` (or omit) is unrestricted, and a comma/bracket list is an allowlist (agentless tasks are rejected under an allowlist). The policy is passed to the child via `PI_SUBAGENT_SPAWNS` and enforced on each subsequent spawn.

Body lines that consist solely of `@include relative/path.md` expand that file one level deep (relative to the agent file, same 64KB/symlink guards as `@contract.json`). Missing or rejected includes leave the line verbatim; includes do not recurse.

Invoke with `{ task: "…", agent: "reviewer" }`. The agent file supplies persona, capability, thinking and budget defaults only: model selection stays with Jev routing; local active/profile/explicit-tool policy resolves the complete ordinary tool set, while Pi native tool activity remains host-owned, and a legacy `model`/`fallback_models` in frontmatter is ignored. An explicit `system_prompt` appends after the persona body. Profiles still enforce capability: `profile: review` filters candidates to read-only tools. Legacy agent `tools` defaults are ignored; an explicit task `tools` list requesting write tools under review fails closed. The agent catalog is advertised in the tool's system-prompt guidelines (session start) and in bare `status` output (live), and file changes are picked up within seconds; no restart needed.

#### Per-profile task defaults

`taskDefaults` in `~/.pi/subagent.json` remains available for non-model fields such as thinking, budgets, and retry counts. Its legacy `model` and `fallbackModels` fields are ignored; model routing belongs to `jevRouting`, while tool activation is resolved locally from Pi's active metadata plus profile/explicit-tool policy. A profile `thinking` value overrides the selected candidate's optional `thinking` default. Invalid fields are dropped field-by-field.

Notes on engine behavior (explicit advanced request fields below require full mode; trusted defaults and historical result management are unaffected):

- Tool `timeout_ms` is the advisory invocation clock described under [budgets and retries](#budgets-and-retries), not a hard stop or terminal `timeout` state. Explicit hard deadlines and historical timeout records keep their phase evidence; selector-request/startup/stall limits remain independent.
- Budget stops (`max_turns`, `max_cost`) trigger a **graceful wrap-up**: the child is steered to produce its final answer NOW and allowed `graceTurns` more turns before SIGTERM. Results end as `partial` with `wrappedUp: true` when the child concluded in time. `graceTurns: 0` restores immediate stops.
- A **stall watchdog** flags children with no protocol activity for `stallAfterMs` (a liveness probe distinguishes quiet-but-thinking from dead), then kills after `stallKillAfterMs` more silence. A stall is not proof that no tool ran and does not authorize ranked failover.
- **Ranked failover** follows the [availability and pre-tool rules](#probability-ranked-failover), bounded by total `maxRetries`, candidate exhaustion, cumulative budgets, cancellation and any explicit hard deadline. A selector failure has no emergency fallback. Task-quality, cancellation and budget failures never trigger model reselection.
- `context: "fork"` starts a single child from a real branched copy of the parent conversation (`--fork` on the parent's session file). It requires a persisted parent session, cannot combine with `resume`, and is rejected for parallel fanout (context duplication × N is a cost bug, not a feature).
- **Structured output** (`output_schema`): the contract is appended to the child's system prompt; the final message must end with a fenced `json:result` block. Validation runs parent-side against a dependency-free JSON-Schema subset (type/properties/required/items/enum/const; unknown keywords are ignored, never rejected). An otherwise successful but invalid answer gets **one steer-based repair round**; still-invalid results end `partial` with `structuredError` and raw text retained. Failed provider attempts neither repair nor publish structured output. Validated successful parallel results feed the `synthesis` child as clean JSON instead of prose.
- **Arg repair**: double-encoded task text (literal `\n` / `\"` escapes from LLM re-encoding) is conservatively de-mangled once at validation time. Identifier fields and paths are never touched. Protocol streams truncated after useful assistant output also end as `partial`.
- Aborting a `wait` returns immediately without cancelling the background run.
- Child processes are launched via the same Node runtime + CLI entry as the parent when possible (`PI_SUBAGENT_BIN` overrides). Bare `pi` on PATH is only a logged last resort.
- Direct resume is exclusive **across processes** via durable locks under `lockDir`. Lost runs block resume until startup orphan reconciliation kills (or confirms dead) the recorded child process group.
- `maxGlobalActive` bounds concurrent children across every Pi parent process on the machine (in addition to the per-session semaphore).
- Nested children at the depth ceiling do not re-register the subagent tool; only top-level parents run maintenance/orphan reclaim/worktree GC.
- Preserved worktrees live under `worktreeDir` (durable, not `/tmp`) and are garbage-collected on startup by **lifecycle**, not wall-clock retention: once a run is over (not live, past a 1h concurrency race guard), the worktree's unique work is archived as one applyable patch under `<repo-container>/_patches/` and the directory is reclaimed immediately. Branches holding commits that exist on no other ref are never deleted. `diff`/`apply`/`discard` transparently fall back to the archived patch when the directory is already gone. Live runs are never swept: the current session's live worktrees plus any worktree recorded on a running run record (concurrent Pi processes) are shielded machine-wide.
- Startup GC sweeps **every** repo container under `worktreeDir`, not just the current checkout's, so repos you stop visiting are still reclaimed. A container whose base repo no longer exists is kept and reported, never deleted; its worktrees' object stores lived inside the deleted repo, so unique work cannot be distinguished from a pristine checkout, let alone archived. Empty containers (no worktrees, no archived patches) are removed.
- Child session transcripts are likewise distilled on lifecycle: when a run is over and nothing on the parent branch references its session, the transcript is reduced to a small `.digest.json` (task, final output, model, usage, turn/tool/error counts) and the raw `.jsonl` is deleted. Resume needs the transcript, so anything referenced or busy machine-wide is kept.
- `keep_background: true` on a task keeps processes the child intentionally backgrounded (e.g. dev servers) alive after a clean exit.
- `include_wip: true` (with `isolation: "worktree"`) seeds the worktree with the parent checkout's uncommitted changes so the child sees your dirty baseline. `diff`/`apply` subtract that baseline when clean, else report the combined delta with an explicit `[includes parent WIP]` warning.

---

### Using the runner as a library

Import the stable public SDK from the package root or the explicit `/sdk` subpath; do not reach into `src/*` internals (those paths are not part of the supported contract):

```ts
import {
  runTasks,
  runSubagent,
  ChildRunner,
  WorktreeManager,
  Semaphore,
  ProcessLockManager,
  addUsage,
  normalizeUsage,
  emptyUsage,
  type TaskSpec,
  type TaskResult,
  type RunState,
  type UsageStats,
} from "@cr1ms0n/pi-subagent/sdk";
```

The package root is an alias for the same SDK: `import { runTasks } from "@cr1ms0n/pi-subagent"`.

The Extension dispatch path routes every new task through Jev, so callers never pass a model to it. The low-level SDK is the opposite contract: it is explicit-spec and performs no implicit routing, config discovery or network call, so embedding code supplies the model (and tool list) it resolved itself. This placeholder is illustrative only and configures nothing:

```ts
const task: TaskSpec = {
  task: "Audit src/ for unsafe parsing",
  profile: "explore",
  model: "<provider/model-id resolved by your embedding code>",
  timeoutMs: 10 * 60_000,
};
```

For trusted SDK specs without an extension route, `TaskSpec.timeoutMs` remains a hard child limit, including queue time; an optional absolute `deadline` can further bound setup and attempts. The extension tool's advisory snake_case field does not change that API or add implicit routing/reminders to SDK calls.

Prefer `runTasks()` for multi-task / worktree orchestration (same path the extension and pi-workflows use). `runSubagent()` runs a single child process directly without the extension host, but durable coordination is **opt-in**. Pass both `locks` (a `ProcessLockManager`) and a stable `runId` if you want global concurrency slots and orphan reclaim to see the child. Without those options no durable run record is written, so a parent restart cannot reclassify the process and nested children vanish from reconcile. There is intentionally no implicit default lock manager; embedding code that needs durability must construct and share one.

The Pi extension entry is unchanged: package `pi.extensions` still points at `./extensions/subagent.ts`.

---

### Cost accounting

`status`, `/subagent-cost`, and the `/subagents` overlay header show separate **root**, **subagent**, **routing**, and **combined** totals based on provider-reported usage. On Pi builds after v0.80.10, delivered runs also report their total usage natively on the tool result ([pi#6671](https://github.com/earendil-works/pi/pull/6671)), so Pi's own footer, `/session`, and RPC totals include subagent spend exactly once per run. Older Pi hosts ignore the field. Nested usage reported by a child's tool results (e.g. grandchild subagents) folds into the run's totals and budgets. The extension footer stays terse (running/ready counts only). Delivery and replay do not double count runs. See [docs/COST-ACCOUNTING.md](COST-ACCOUNTING.md).

Jev selection is billed separately from execution. TypeSafe reports tokens, not currency, so the ledger shows routing tokens as their own category, counts each selector request once by its request ID (including plan and pre-spawn failures), and marks routing cost as **unreported** rather than free. Numeric dollar totals exclude unreported routing spend, and `max_cost` caps provider-reported execution cost only; it does not cap TypeSafe charges. Route metadata (original selected model, ranked probabilities, locally activated ordinary tools, locally added controls, selector version, confidence, outcome, latency) travels with the run alongside usage. Actual attempt models are recorded separately; advancing through the ranking does not create another selector receipt.

---

### Engine contract

The [architecture contract](ARCHITECTURE.md) owns the complete lifecycle, persistence, permission and delivery invariants. The [security model](SECURITY.md) explains the limits of tool profiles and worktree isolation. For source layout and checks available in a fresh checkout, see [development](DEVELOPMENT.md).
