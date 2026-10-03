# Security model

Pi packages run with full system access. This extension spawns child `pi`
processes that inherit the parent environment (including provider credentials)
and can use tools according to their capability profile.

## What subagents can do

| Profile | Finalized tools | Writes? |
|---------|-----------------|---------|
| `explore` | All locally permitted active read-only tools | No project-file writes |
| `review` | Same as explore | No project-file writes |
| `general` | All active locally permitted ordinary tools after explicit-tool policy | Yes if the local set includes write-capable tools |

Parallel mode defaults to `explore` to avoid concurrent shared writes. Tool exposure follows Pi's official metadata: native non-direct definitions are carried for registration without being treated as ordinary profile candidates, while ordinary direct-tool safety remains fail-closed.

## Hard rules

1. **Read-only means no project-file mutation.** `bash` can rewrite the disk and is never part of
   an explore/review profile. The finalized tools reach the child as Pi's `--tools`
   allowlist (`--no-tools` only when the locally resolved ordinary/native set is empty).
   Local policy, not a selector tool answer, determines the ordinary set: active availability,
   profile restrictions and an explicit `tools` ceiling are applied before launch. Pi 0.86.0
   is the verified baseline for built-in, extension and late-registered tool enforcement;
   a host that cannot honor the allowlist is refused rather than silently weakened.
   Before the real task prompt, a package-local startup check verifies the routing bootstrap
   command source, exact selected model and bounded child capability evidence. The effective
   set is the intersection of the finalized candidate allowlist with observed ordinary
   activity and native registration; native definitions may be host-inactive. Unforced
   candidate omissions are recorded as diagnostics and do not abort, while a missing
   explicitly requested tool fails closed. Active names outside the finalized allowlist,
   malformed evidence or a provenance/model/nonce mismatch aborts as a capability diagnostic
   and is never fixed by widening tools or switching models.
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

## Official tool exposure boundary

Pi 0.99.0+ `getAllTools()` metadata is the only classification source for the native boundary. Active `direct` definitions in the same snapshot form the ordinary local capability set, including direct SDK/custom tools; local profile and explicit-tool policy decide which of that set reaches the child. `model-only`, `codemode` and `deferred` definitions are native managed tools: the parent carries their registered names automatically, child registration is observed as bounded capability evidence, and an unforced missing definition is omitted while Pi controls whether each is active. `hidden` definitions are excluded from both paths. If an older host omits `exposure`, the Pi default `direct` behavior is used; an unknown present exposure value is dropped rather than guessed.

`sourceInfo` is retained for provenance and nested-extension attestation only. `annotations`, names and extension source labels never prove that a tool is read-only. Ordinary unknown/custom direct tools remain writer-capable in `general` and are rejected by `explore`/`review` unless they are in the existing conservative read-only set. Native managed tools do not alter ordinary writer classification, and nested `subagent`/`subagent_wait` names remain subject to package depth/spawn policy.

The startup proof checks the exact model and negotiates the child-effective set from ordinary-active and native-registration evidence. A candidate absent from the child is recorded as `omittedTools` without aborting by default; an explicitly requested (`forcedTools`) name must be effective or startup fails closed. It rejects active names outside the finalized allowlist and retains source/model/nonce/host checks plus nested-tool provenance checks. No user-owned whitelist, source-name preset, forced activation beyond the explicit request contract, foreign config discovery or annotation-based sandbox exists.

## Routing disclosure and credentials

Jev routing sends a minimal projection to TypeSafe: the current delegated task
text, the configured candidate model IDs and your per-model descriptions, and the
necessary constraints (profile, the resolved thinking level, whether structured output
is needed). It does not send tool names or descriptions, upload repository files,
conversation history, full system prompts, persona text or tool parameter schemas, and
does not read them in the background. Resume, fork and synthesis select from the new
task instruction rather than the assembled transcript. Task text and model descriptions
are user content and can themselves contain secrets; there is no guaranteed redaction.

Version `0.10.0` reads the TypeSafe credential from `jevRouting.apiKey` in the private user-level `~/.pi/subagent.json`. This is plaintext storage: restrict file access and protect editor backups and synchronized copies. Same-user processes, including children with filesystem access, may read it. Profiles and worktrees do not protect this file from those processes.

The transport sends the key only as an `Authorization` header to the normalized per-invocation `jevRouting.baseUrl` destination, with `redirect: "error"`. When the field is omitted, the exact official HTTPS endpoint remains the default. A configured destination must be a complete absolute HTTPS URL with a hostname, at most 2048 characters, and no username/password, query, fragment, whitespace or control characters; HTTP and other schemes are rejected before any selector request. A custom destination intentionally changes which service receives the minimal task/model routing disclosure, so it must be trusted accordingly. The URL is configuration-only and is not copied into prompts, selector JSON bodies, argv, child manifests, logs, receipts or results. The key itself is never copied into prompts, selector JSON bodies, argv, child manifests, logs, receipts or results. Never serialize or log the complete routing configuration. Rotate any credential pasted into a transcript or shared in conversation.

Published npm `0.9.0` uses the older environment-based mechanism. In `0.10.0`, `apiKeyEnv` is rejected with manual migration guidance and no environment fallback. Unrelated `PI_SUBAGENT_*` runtime settings remain supported.

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
defaults. Model selection comes from Jev routing; local active/profile/explicit-tool policy resolves the complete ordinary tool set, while Pi native tool activity remains host-owned. A legacy
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
