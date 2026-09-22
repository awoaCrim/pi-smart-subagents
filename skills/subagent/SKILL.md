---
name: subagent
description: Delegate work to isolated child agents with the subagent tool. Jev routes each new dispatch to an execution model and individual tools from the user's configured candidate list; covers explore/review/general profiles, parallel fanout with best-effort synthesis, worktree isolation and the diff/apply/discard loop, background runs, steering, output_schema, context fork, and the Pi-only new-dispatch rule. Use when delegating exploration or implementation, running tasks in parallel, or when a subagent run needs inspecting, steering, or landing.
---

# Subagent

Delegate research, parallel exploration, and clean-context implementation to child
agents. Prefer `subagent` over long in-thread digressions when the work benefits
from isolation, parallelism, or a fresh context.

## When to use

- Map a codebase area without bloating the parent context (`profile: "explore"`).
- Review a diff read-only (`profile: "review"`).
- Implement behind a worktree and land via apply (`profile: "general"`, `isolation: "worktree"`).
- Fan out independent questions, optionally with `synthesis` to fold results.
- Background long work (`async: true`) and collect later with `wait` / `subagent_wait`.

## Core calls

```ts
// Omit model and fallback_models. Jev selects the execution model from the
// user's configured candidate list and the individual tools from the locally
// permitted catalog. An explicit model/fallback is rejected on new work.

// Single foreground task (default profile: general)
{ task: "Find call sites of parseConfig", description: "Map parseConfig" }

// Parallel read-only explorers (default profile for tasks[]: explore)
{
  tasks: [
    { task: "Map auth middleware", description: "Auth flow" },
    { task: "List env vars in server/", description: "Env inventory" }
  ],
  synthesis: "Merge into one prioritized brief"
}

// Background: notified on completion; wait/status still work
{ task: "Audit dependency licenses", async: true }
{ action: "status", id: "abc123" }
{ action: "wait", id: "abc123" }           // interruptible; does not cancel
{ action: "cancel", id: "abc123" }
// Same wait semantics as a dedicated tool:
// subagent_wait { id: "abc123", timeout_ms?: number }

// Worktree loop
{ task: "Implement feature A", profile: "general", isolation: "worktree" }
{ action: "diff", id: "abc123", index: 1 }
{ action: "apply", id: "abc123", index: 1 }
{ action: "discard", id: "abc123", index: 1 }

// Dry-run validation + resolved plan (no spawn).
// plan calls Jev and incurs selector fees, then a later dispatch selects again.
{ action: "plan", tasks: [{ task: "…", isolation: "worktree" }] }
```

## Profiles

| Profile   | Tools                                                     | Writes                                      |
| --------- | --------------------------------------------------------- | ------------------------------------------- |
| `explore` | locally permitted read-only tools + Pi context tools      | no project-file writes                      |
| `review`  | same as explore                                           | no project-file writes                      |
| `general` | Jev chooses from the full available locally permitted catalog + Pi context tools | yes if the selected tools include bash/edit/write |

Jev picks individual tool names, not a capability bundle. Candidates come from
the full available locally permitted catalog, not from agent `tools` defaults and
not from only the parent's active tools. An explicit `tools` list is a ceiling,
explore/review stay read-only regardless of the answer, and an empty selection
never means "all tools".

For Pi children, `new_context`, `get_context_remaining`, `history`, and
`notes` are added locally when the parent exposes them, so the selector never
asks about them. They are control-plane tools: they may update context
notes/window state, but never grant `bash`, `edit`, or `write` access. Route
metadata reports them as local additions.

The finalized tool subset is passed to the child as Pi's `--tools` allowlist
(`--no-tools` for a true empty set). Pi 0.86.0 is the verified baseline for
built-in, extension and late-registered tool enforcement; an unsupported host is
refused rather than silently weakened.

Parallel write-capable tasks sharing one checkout are rejected unless each uses
`isolation: "worktree"`, a distinct `cwd`, or `allow_shared_writes: true`.

## Backends

New dispatch is Pi-only. `backend: "codex"` or `backend: "claude"` on new work
is **refused** before any selector or provider work, including a backend
inherited from agent frontmatter, and is never silently switched to Pi. Existing
Codex/Claude runs remain manageable through `status`/`wait`/`cancel`/`steer`/
`diff`/`apply`/`discard`.

Another provider's execution model is still eligible through Pi when the user
lists it in their candidate configuration. Unsupported combinations inside the
Pi path are **refused**, not silently degraded:

|                          | pi             |
| ------------------------ | -------------- |
| `max_cost`               | yes (provider-reported execution only; not selector currency) |
| read-only profile        | tool allowlist |
| steering / grace wrap-up | yes            |
| `context: "fork"`        | yes            |
| `thinking`               | yes            |
| `output_schema`          | yes            |

## Budgets and safety

- Prefer `max_turns`, `max_cost`, and/or `timeout_ms` on long or write-capable runs.
  `timeout_ms` is absolute: local preflight, Jev selection, setup, queue and
  runtime all count against it.
- `output_schema` asks the child for a fenced `json:result` block. An otherwise successful invalid answer gets one repair round; a failed provider attempt neither repairs nor publishes structured output.
- `context: "fork"` continues from a fork of the parent session.
- Do not poll `status` in a tight loop. Use `wait` / `subagent_wait`, or let the
  completion notification arrive for `async: true` runs.
- Point the user at `/subagents` for the live inspector and `/subagent-cost` for
  the root / subagent / routing / combined ledger. Routing cost is reported as
  unreported (tokens only, no currency).

## Routing

Omit `model` and `fallback_models` on every new call: both are legacy fields,
and an explicit value is rejected rather than bypassing selection. Jev chooses
an initial execution model and probabilities for the user's eligible candidates, plus one task-based include/exclude decision per eligible tool shared by all attempts. The local policy then re-validates
the answer: unknown or unsafe tools cannot launch, explore/review stay read-only,
and management actions need no routing config or credential.

A Jev timeout or invalid decision still stops new dispatch; there is no emergency model. A valid route retains every candidate probability and tries higher values first. Tied maxima keep the returned choice first; other ties follow configured order. Low confidence and zero probability are accepted, not thresholds. Per-model probability is a selector preference, not uptime or a separate confidence score.

Recognized settled model-unavailable, temporary rate-limit/service and transport errors can advance to the next candidate only before any tool execution begins in the current invocation. Once a tool starts, or protocol evidence is uncertain, do not restart the child on another or the same model. Auth/configuration, quota/billing, context, invalid requests, task/schema quality, cancellation and exhausted budgets never trigger model switching. Historical resume/fork messages are not new tool execution.

`max_retries` limits all extension-level extra attempts: 0 means one initial attempt; 2 means at most three attempts. The built-in default remains 1. Availability failure advances directly to the next candidate; candidate exhaustion never wraps. Conclusively pre-work infrastructure failures may retry the same model within that budget. Every attempt shares tools, absolute deadline and cumulative reported cost/turn budgets, with fresh exact-model/tool startup verification. Switching makes no extra Jev call. Pi's internal provider retries are separate, unchanged and may delay fallback.

Plan/status distinguish original choice, ranked alternatives and actual attempts. Earlier failed output is retained as attributed previews/session pointers, not mixed into a later structured answer. All-failed tasks keep their final failure. Existing runs remain manageable without selector configuration or a credential.

An optional candidate `thinking` value is an opaque Pi thinking-level string;
common values include `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`, but model-specific values are passed through unchanged. It is a default:
explicit task, agent, and profile `taskDefaults.thinking` values override it.
The extension re-reads `jevRouting` on each dispatch and injects non-secret
routing guidance into the parent prompt. The user stores the TypeSafe credential
in `jevRouting.apiKey` in the private `~/.pi/subagent.json`; do not read, display
or copy the key into task text, prompts or output. Legacy `apiKeyEnv` is rejected
with migration guidance; there is no environment fallback. If the config or key
is missing or invalid, management remains available but new spawns, `/btw`, plan,
resume, fork and synthesis are rejected. This config-file credential contract ships in
npm 0.10.0; published npm 0.9.0 uses the old environment mechanism.
