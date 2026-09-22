# Security model

Pi packages run with full system access. This extension spawns child `pi`
processes that inherit the parent environment (including provider credentials)
and can use tools according to their capability profile.

## What subagents can do

| Profile | Finalized tools | Writes? |
|---------|-----------------|---------|
| `explore` | Jev-chosen subset of locally permitted read-only candidates, plus available Pi context tools | No project-file writes |
| `review` | Same as explore | No project-file writes |
| `general` | Jev-chosen subset of the full available locally permitted catalog, plus available Pi context tools | Yes if write-capable tools are selected |

Parallel mode defaults to `explore` to avoid concurrent shared writes.

## Hard rules

1. **Read-only means no project-file mutation.** `bash` can rewrite the disk and is never part of
   an explore/review profile. Pi context-management tools (`new_context`,
   `get_context_remaining`, `history`, `notes`) are an explicit control-plane
   exception: they may update continuity notes/window state but cannot access
   the project write tools. The finalized tools reach the child as Pi's `--tools`
   allowlist (`--no-tools` when empty), and the selector's answer is re-validated
   locally: unknown, unavailable or unsafe choices cannot launch broader
   capability, and an empty selection never becomes "all tools". Pi 0.86.0 is the
   verified baseline for built-in, extension and late-registered tool enforcement;
   a host that cannot honor the allowlist is refused rather than silently weakened.
   Before the real task prompt, a package-local startup check verifies the routing
   bootstrap command source and has the child acknowledge the exact selected model
   and tool names; a mismatch aborts as a capability diagnostic and is never fixed
   by widening tools, switching models or approving project trust.
2. **Parallel writers** require `isolation: "worktree"`, distinct `cwd` values,
   or an explicit `allow_shared_writes: true` opt-in.
3. **Depth is capped** (`maxDepth`, default 2). Nested children at the ceiling do
   not re-register the subagent tool. Depth is scheduling metadata — `bash` or an
   env-scrubbing wrapper can still invoke `pi` directly, so treat it as an
   accidental-recursion guard, not a security boundary.
   **Spawn allowlists** (`spawns:` in agent frontmatter, env `PI_SUBAGENT_SPAWNS`)
   refine that same guard: a child may be limited to named personas, or to none
   (tool not registered). Like depth, this is not a sandbox — children can still
   shell out to `pi`.
4. **Process caps** limit concurrency both per parent session (`maxActiveProcesses`)
   and machine-wide (`maxGlobalActive`, default 16).
5. **Transcripts** under `~/.pi/subagent-sessions` may contain task content, tool
   output, and secrets that appeared in context. Protect that directory. Task text
   is delivered via stdin (not argv) so it stays out of `ps` listings, but it is
   still written into the child session log.
6. **Background permission prompts** are limited because children run headless
   (RPC mode). Extension UI dialogs raised inside a child are auto-cancelled so
   they can never hang a run — which also means a child can never obtain
   interactive consent. Prefer restricted tools for async/background runs.
7. **Steering messages** (`action: "steer"` and the overlay `s` key) inject text
   into a running child's conversation with user-level authority. Anything that
   can call the subagent tool can steer any live run in the same session.
8. **Process cleanup.** On POSIX, children run in their own process group so tree
   kills work for ordinary descendants. Parent (re)start reaps orphans recorded
   under `~/.pi/subagent-locks/runs/` so resume cannot race a still-alive writer.
   Grandchildren that call `setsid()` can still escape a simple process-group kill.
9. **Resume exclusivity.** Direct resume takes a durable per-session file lock;
   concurrent parents cannot append to the same child session.
10. **Profiles are tool-selection policy, not a sandbox.** Children inherit
   `$HOME`, SSH/cloud credentials, network access, and the parent filesystem.
   Git worktrees only isolate the checkout. For untrusted tasks, use an outer
   container/cgroup/network policy.
11. **`max_cost` is accounting, not a hard provider gate.** Usage arrives after a
    turn; orphans may spend money the ledger never sees. It caps provider-reported
    execution cost only: TypeSafe reports routing tokens, not currency, so selector
    cost is unreported and outside `max_cost`. Combine with provider account
    budgets for hard spend limits.

## Routing disclosure and credentials

Jev routing sends a minimal projection to TypeSafe: the current delegated task
text, the configured candidate model IDs and your per-model descriptions,
eligible candidate tool names and descriptions, and necessary constraints
(profile, requested thinking, whether structured output is needed). It does not
upload repository files, conversation history, full system prompts, persona text
or tool parameter schemas, and does not read them in the background. Resume, fork
and synthesis select from the new task instruction rather than the assembled
transcript. Task text and model descriptions are user content and can themselves
contain secrets; there is no guaranteed redaction.

Version `0.10.0` reads the TypeSafe credential from `jevRouting.apiKey` in the private user-level `~/.pi/subagent.json`. This is plaintext storage: restrict file access and protect editor backups and synchronized copies. Same-user processes, including children with filesystem access, may read it. Profiles and worktrees do not protect this file from those processes.

The transport sends the key only as an `Authorization` header to the fixed official HTTPS endpoint, with redirects disabled. It does not automatically copy the key into prompts, selector JSON bodies, argv, child manifests, logs, receipts or results. Never serialize or log the complete routing configuration. Rotate any credential pasted into a transcript or shared in conversation.

Published npm `0.9.0` uses the older environment-based mechanism. In `0.10.0`, `apiKeyEnv` is rejected with manual migration guidance and no environment fallback. Unrelated `PI_SUBAGENT_*` runtime settings remain supported.

New extension-managed dispatch is Pi-only. A `backend: "codex"` or
`backend: "claude"` new task is rejected before any selector or provider work,
including a backend inherited from agent frontmatter, rather than silently
switched to Pi. Existing native-backend runs stay manageable.

## Trust and project cwd

If `cwd` points outside the parent project, the child inherits whatever local
project config/trust applies to that path. Treat external `cwd` as elevated risk
and prefer read-only profiles when exploring third-party trees.

## Output artifacts

`output` files are written by the child. Resolve paths carefully and reject
duplicate output paths across parallel workers.

## Named agent files

Agent files (`.pi/agents/`, `.agents/agents/`, global agent dir) inject their
body into the child's system prompt and set persona, thinking and budget
defaults. Model and tool selection come from Jev routing; a legacy
`model`/`fallback_models` in frontmatter is ignored. A
project-level agent file shapes subagent behavior the same way project
extensions and skills do — review them like code when working in untrusted
repositories. Mitigations: capability profiles still fail closed (an agent
cannot grant write tools under `explore`/`review`), symlinked agent files are
skipped, names are validated against traversal characters, and files over
64KB are ignored.

## Machine-wide state

`~/.pi/subagent-locks/` holds session locks, global concurrency slots, and run
process identity records. It is per-user (under `$HOME`) and must not be shared
across untrusted users/containers without care — a compromised client could
interfere with lock reclaim on the same account.
