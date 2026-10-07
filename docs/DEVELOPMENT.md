# Development and verification

This is a standalone ESM TypeScript package loaded by Pi, not the upstream monorepo. Start with the [README](../README.md) for installation and the [architecture contract](ARCHITECTURE.md) before changing engine behavior.

---

### Checkout and runtime

[package.json](../package.json) declares Node.js 22.19.0 or newer and Pi/TypeBox peer dependencies. There is no compiled distribution or build step. The extension entry is [extensions/subagent.ts](../extensions/subagent.ts); the supported SDK exports are in [src/index.ts](../src/index.ts).

To use a local checkout, replace the example path with your own:

```bash
pi install /absolute/path/to/pi-smart-subagents
```

Pi registers a local path without copying it. Do not enable that checkout and another copy of the same extension together. Reload or restart Pi after package changes. Keep user settings, provider credentials and real session files outside the repository.

The product skill at [skills/subagent/SKILL.md](../skills/subagent/SKILL.md) is distributed with the package. Maintainer-specific agents, workflows, task records and local verification artifacts are not required to use or inspect the public source.

---

### Source ownership

| Responsibility | Owner |
| --- | --- |
| Pi registration and lifecycle wiring | [extension.ts](../src/extension.ts) |
| Request schema, permission checks and normalization | [schema.ts](../src/schema.ts), [policy.ts](../src/policy.ts), [config.ts](../src/config.ts), [agents.ts](../src/agents.ts) |
| Jev transport, candidate policy and dispatch | [routing-types.ts](../src/routing-types.ts), [routing-policy.ts](../src/routing-policy.ts), [jev-router.ts](../src/jev-router.ts), [dispatch-routing.ts](../src/dispatch-routing.ts) |
| Local preflight and child capability verification | [dispatch-preflight.ts](../src/dispatch-preflight.ts), [startup-check.ts](../src/startup-check.ts), [child-preflight.ts](../src/child-preflight.ts) |
| Child processes, retries and protocol | [runner.ts](../src/runner.ts), [orchestrator.ts](../src/orchestrator.ts), [protocol.ts](../src/protocol.ts), [backend adapters](../src/backends/) |
| Concurrency, ownership and durable worktrees | [semaphore.ts](../src/semaphore.ts), [process-lock.ts](../src/process-lock.ts), [registry.ts](../src/registry.ts), [worktree.ts](../src/worktree.ts) |
| Persistence, accounting and output | [persistence.ts](../src/persistence.ts), [usage.ts](../src/usage.ts), [output.ts](../src/output.ts), [structured.ts](../src/structured.ts) |
| TUI, notifications and transcript display | [format.ts](../src/format.ts), [ui.ts](../src/ui.ts), [notifications.ts](../src/notifications.ts), [transcript.ts](../src/transcript.ts) |

Keep engine rules in their owning modules. The extension is a composition root, and renderers consume narrow projections rather than owning a second run store. The architecture document covers the remaining modules and invariants.

---

### Checks available in this checkout

There are no npm scripts, devDependencies or TypeScript project configuration. The checkout includes a focused offline TUI and tool-surface regression harness under `checks/`, not a repository-wide engine test suite. `npm test`, `npm run typecheck` and the upstream release-check scripts are not available here. Installing dependencies alone does not create those commands. The historical [plan](PLAN.md) and [roadmap](ROADMAP.md) refer to upstream tooling and previous release work.

#### Documentation and whitespace

Review the English and Chinese READMEs together: commands, config keys, feature claims, language links, anchors and license references must agree. Check links against the intended public Git tree, not only files that happen to exist in a maintainer's checkout. Keep the English-source blob reference in the Chinese README current when changing the translation.

For tracked changes:

```bash
git diff --check
```

For a prepared commit:

```bash
git diff --cached --check
```

These commands do not check Markdown links, translation accuracy or untracked files. Review those separately. Documentation-only changes do not require a provider call or a claim that engine tests passed.

#### Offline TUI and tool-surface regression harness

With Pi and its esbuild/TUI peers already installed:

```bash
node checks/render-harness.mjs
# Or point at an installed Pi package explicitly:
node checks/render-harness.mjs --pi-root /path/to/node_modules/@earendil-works/pi-coding-agent
```

The resolver uses `--pi-root`, `PI_GLOBAL_DIR`, a locally resolvable peer, then
`npm root -g`. No dependency is downloaded. Bundles and fixtures go to a unique
temporary directory, removed afterward. Use `--keep` to inspect them or
`--fixtures /path/to/output` to retain text fixtures at an explicit destination.

The harness exercises real formatting, components, extension registration and
management execution, with deterministic config/provider/process/worktree
boundaries. It uses the installed Pi TUI for ANSI/CJK width and Box-padding
checks. It does not read user credentials, call Jev/providers, modify user
settings or write to the checkout unless `--fixtures` explicitly targets it.
The mode fixtures await async registration and check compact/full schemas, raw
field gating before dispatch, registration snapshots, trusted defaults, historical
result management, wait-alias validation and once-only delivery. Full-only plan
coverage uses explicit full configuration. Payload-size checks use fixed synthetic
catalogs and routing data; UTF-8 bytes are not token, latency or memory measurements.
The Responses scenarios also run the installed Pi AI serializer with synthetic tools, a fake credential and an intentional pre-HTTP capture. They check the registered request hook, missing-versus-explicit `strict: false`, copy-on-change/immutability, compatibility no-ops and genuine mode conflicts. Fetch is denied and network attempts must remain zero. This boundary coverage catches declaration defects that calling `execute()` alone cannot expose.

This is not a semantic typecheck, live-provider generation test or interactive terminal smoke test. The focused serializer fixture was verified against Pi 1.0.0; report a different installed host's result separately rather than assuming its serializer has the same compatibility defaults.

#### Tool-surface size fixture

`checks/surface-fixture.mjs` measures registered definitions for both tools plus
injected routing guidance using empty and fixed synthetic named-agent catalogs.
It uses fake config and one synthetic candidate, never the user's settings.
Use an existing baseline commit and output paths outside the public package:

```bash
node checks/surface-fixture.mjs --revision <baseline-commit> --output /tmp/subagent-before.json
node checks/surface-fixture.mjs --baseline /tmp/subagent-before.json --output /tmp/subagent-after.json
```

Like the main harness, it accepts `--pi-root` for installed peers and downloads
nothing. Results contain normalized serialized UTF-8 byte counts, field counts
and skill bytes. `--baseline` requires identical fixture data and checks compact
payload <=60%, full payload <=100%, and skill <=50% of baseline bytes; a failed size
gate exits nonzero. Compare the same catalog in each revision. Git blob skill bytes
may differ from Windows checkout bytes because of CRLF conversion, so report the
chosen baseline and do not count a newline conversion as an instruction change.

#### Offline TypeScript syntax check

When the global Pi installation includes esbuild, the following Bash/Git Bash command enumerates production TypeScript files, parses and strips their types, and writes only to a unique temporary directory. It removes that directory afterward. It does not download a tool or modify source files.

```bash
node --input-type=module - "$(npm root -g)" <<'NODE'
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const esbuild = path.join(process.argv[2], "@earendil-works/pi-coding-agent/node_modules/esbuild/bin/esbuild");
if (!fs.existsSync(esbuild)) throw new Error("Global Pi esbuild is unavailable; no syntax check was run.");
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith(".ts")) files.push(file);
  }
}
walk("src");
walk("extensions");
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-syntax-"));
try {
  for (const file of files.sort()) {
    const result = spawnSync(process.execPath, [esbuild, file, "--loader:.ts=ts", "--format=esm",
      "--target=node22", `--outfile=${path.join(outputDir, "check.js")}`], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Syntax transform failed for ${file}`);
  }
  process.stdout.write(`Parsed ${files.length} TypeScript files; no semantic typechecking performed.\n`);
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
NODE
```

This catches malformed TypeScript only. It does not resolve imports, check types or validate peer APIs. If your Pi installation does not expose that esbuild path, report the missing check rather than claiming success or installing new tooling silently.

A semantic typecheck requires a separately configured TypeScript environment and compatible peers. There is no repository-owned command for it here. Any external harness or isolated fixture run must be reported with its actual setup, scope and limitations; private maintainer fixtures are not a test suite shipped in this checkout.

#### Package contents

Review the npm file list without generating or publishing a tarball:

```bash
npm pack --dry-run --ignore-scripts --json
```

The output should contain production source, the distributed skill, public documentation, both READMEs, changelog, license and package metadata. It must not contain local settings, agent instructions, tasks, backups, transcripts, credentials, tarballs or generated test bundles. Git exclusions and the package `files` allowlist are separate controls; inspect both when changing packaging.

A dry run verifies packaging, not application behavior. For an actual release, follow the additional artifact and installation checks in [release maintenance](RELEASING.md).

---

### Behavior verification

For engine changes, trace the affected architecture invariants and exercise the owned boundary with an injected transport, fake process or isolated host when such a harness is available. State what was exercised and keep paid partial output/accounting semantics intact.

A real `subagent` call and `action: "plan"` both invoke Jev and may incur charges. A plan avoids spawning a child; it is not an offline test. Obtain explicit permission before live routing/provider smoke tests, use synthetic task data and keep real user sessions out of fixtures.

Report syntax transforms, semantic typechecks, package checks, fixture assertions and live-provider checks separately. Do not summarize them as “tests passed” when no test suite was run.
