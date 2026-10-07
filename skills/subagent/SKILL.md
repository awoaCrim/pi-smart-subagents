---
name: subagent
description: Delegate exploration, review or implementation to isolated child agents. Use for named agents, parallel or background tasks, budgets, steering and the worktree diff/apply/discard loop. Jev selects the model; local policy controls tools.
---

# Subagent

Delegate independent research, clean-context review or isolated implementation.
Give each task enough context to stand alone, a short `description`, and the lowest
honest `difficulty`: simple for bounded checks, moderate for ordinary multi-file
work, complex for architecture or unknown-root-cause debugging. Prefer a suitable
named `agent` when available; its persona must fit the task.

## Common calls

These examples work in the default compact mode. Omit `model`, `fallback_models`
and `thinking`; callers cannot select them.

```ts
// Single foreground task; single defaults to general, so select read-only explicitly.
{ task: "Map parseConfig callers", description: "Map config callers", profile: "explore", difficulty: "simple" }

// Parallel workers default to explore.
{ tasks: [
  { task: "Review auth validation", description: "Auth validation review", difficulty: "simple" },
  { task: "Review session expiry", description: "Session expiry review", difficulty: "simple" }
] }

// Background only when you have independent work to do meanwhile.
{ task: "Audit dependency licenses", description: "Dependency license audit", profile: "review", difficulty: "moderate", max_turns: 20, async: true }
{ action: "status", id: "<run-id>" }
{ action: "wait", id: "<run-id>" }
// Equivalent dedicated tool: subagent_wait { id: "<run-id>", timeout_ms: 30000 }
{ action: "steer", id: "<run-id>", message: "Focus on src and wrap up" }
{ action: "cancel", id: "<run-id>" }

// Isolated changes; inspect before applying. index selects a parallel worker.
{ task: "Implement the approved fix", description: "Implement approved fix", profile: "general", difficulty: "moderate", isolation: "worktree" }
{ action: "diff", id: "<run-id>", index: 0 }
{ action: "apply", id: "<run-id>", index: 0 }
{ action: "discard", id: "<run-id>", index: 0 }
```

## Permissions and delivery

- `explore` and `review` reject ordinary write-capable tools. `general` permits
  locally allowed tools and may write. These profiles and worktrees are not OS
  sandboxes. `cwd` selects the working directory.
- Parallel writers need separate worktrees or distinct checkouts. Applying a
  worktree lands uncommitted changes; inspect the diff first. Discard removes the
  selected worktree/branch or archived patch, so use it only for unwanted work.
- Named agents supply persona and trusted defaults, not permission to bypass
  policy. Jev chooses only the model. Local policy selects the complete permitted
  ordinary tool set; Pi owns native tool activity. Startup verifies the model
  and child capabilities, recording unforced omissions and refusing missing
  explicitly required tools. Unsupported combinations fail closed.
- Collect with `wait` or `subagent_wait`, rather than polling. Timeout or abort of
  a wait neither cancels nor consumes the run. Completion notifications do not
  consume the once-only full result. Use `cancel` to stop work. A failed setup
  can still have a collectable run ID; do not start duplicate work blindly.
- `max_turns`, `max_cost` and `timeout_ms` bound work. Timeout includes preflight,
  routing, setup, queue and execution. Turn/cost stops allow configured grace
  turns to wrap up. A foreground caller abort cancels its run; `async: true`
  lets work outlive the initiating call.
- Jev selection can incur separate fees. `max_cost` is a soft provider-reported
  execution-cost ceiling, not a cap on selector charges. Routing currency is unreported. A
  selector failure stops new dispatch; management needs no routing credential.
  Ranked model failover is limited to recognized settled availability errors
  before any tool starts; uncertain activity or task-quality failures do not
  authorize another attempt.
- Use `/subagents` for the inspector and `/subagent-cost` for the ledger.

## Advanced mode and setup

Compact keeps ordinary single/parallel/background work, budgets and management.
Advanced caller controls require `toolMode: "full"` in the existing private
`~/.pi/subagent.json` and an extension reload/restart. Finish active work before
reloading. A file edit alone does not switch the current tools. Never silently
remove a requested hidden option; explain the requirement instead.

Read [tool modes and advanced usage](../../docs/REFERENCE.md#tool-modes) only when
needed for resume/fork, synthesis, structured output, output files, explicit tool
or system-prompt overrides, per-call retry/grace tuning, WIP seeding, background
process retention, unsafe shared writes or paid `plan`. Full exposes these
options without enabling them. Trusted named/config defaults, old artifacts and
the explicit-spec SDK remain available independently of the public mode.

The user configures routing via `jevRouting` in the same private file; see
[routing setup](../../docs/REFERENCE.md#jev-routing). Never read, print or copy
its API key into task text, prompts or logs. Only trusted routing endpoints may
receive task/model information and the credential. Execution-provider auth is
separate. Do not install, publish or alter user configuration to bypass a failed
route.
