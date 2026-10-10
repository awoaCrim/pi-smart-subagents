#!/usr/bin/env node
/**
 * Offline regression harness for the subagent TUI presentation layer.
 *
 * It bundles the REAL production modules (`src/format.ts`, `src/ui.ts`,
 * `src/extension.ts`, `src/notifications.ts`) with an installed esbuild and
 * exercises them through their public seams against deterministic fakes. There
 * are no provider calls, no credentials, no network access and no repository
 * writes unless --fixtures explicitly targets it; nothing here is a substitute for a semantic typecheck or a live
 * terminal session.
 *
 * Usage:
 *   node checks/render-harness.mjs [--src-root <dir>] [--pi-root <dir>] [--keep] [--fixtures <dir>]
 *
 * `--pi-root` defaults to $PI_GLOBAL_DIR, a locally resolvable peer, then npm root -g. The harness only needs that directory for its esbuild
 * binary and the Pi peer modules used by `src/extension.ts`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extensionScenarios } from './extension-scenarios.mjs';
import { surfaceScenarios } from './surface-scenarios.mjs';
import { responsesScenarios } from './responses-scenarios.mjs';
import { timeoutScenarios } from './timeout-scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const SRC = path.resolve(argValue("--src-root", path.join(here, "..")));
const localRequire = createRequire(import.meta.url);
const PI_ROOT = (() => {
  const explicit = argValue('--pi-root', process.env.PI_GLOBAL_DIR);
  if (explicit) return path.resolve(explicit);
  try { return path.dirname(localRequire.resolve('@earendil-works/pi-coding-agent/package.json')); } catch {}
  const npm = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm root -g'], { encoding: 'utf8' })
    : spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  const root = path.join(npm.stdout.trim(), '@earendil-works/pi-coding-agent');
  if (!npm.status && fs.existsSync(root)) return root;
  throw new Error('Installed Pi not found. Use --pi-root <installed pi-coding-agent directory>.');
})();
const KEEP = args.includes("--keep");

const failures = [];
let passed = 0;
function ok(condition, name, detail) {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail === undefined ? "" : ` — ${detail}`}`);
}
function eq(actual, expected, name) {
  if (Object.is(actual, expected)) ok(true, name);
  else ok(false, name, `expected ${String(expected)}, got ${String(actual)}`);
}
function eqJson(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(name) { console.log(`\n== ${name} ==`); }

const require = createRequire(path.join(PI_ROOT, "package.json"));
const ESBUILD = (() => {
  try { return require.resolve("esbuild/bin/esbuild"); }
  catch { return require.resolve("@esbuild/win32-x64/esbuild.exe"); }
})();

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tui-harness-"));
const stubDir = path.join(temp, "stubs");
fs.mkdirSync(stubDir, { recursive: true });

// The harness bundles only the presentation modules. `@earendil-works/pi-tui`
// is aliased to the installed copy when present so width/ANSI math is real.
const piTui = path.dirname(path.dirname(require.resolve('@earendil-works/pi-tui')));
if (!fs.existsSync(piTui)) throw new Error('The installed Pi TUI peer is required for real terminal-width checks.');
const alias = { "@earendil-works/pi-tui": piTui };

function bundle(name, entry, extra = {}) {
  const outfile = path.join(temp, `${name}.mjs`);
  const result = spawnSync(process.execPath, [
    ESBUILD, entry, "--bundle", "--format=esm", "--platform=node", "--target=node22",
    `--outfile=${outfile}`,
    "--external:@earendil-works/pi-coding-agent",
    ...(alias ? [`--alias:@earendil-works/pi-tui=${piTui}`] : ["--external:@earendil-works/pi-tui"]),
    ...(extra.external ?? []).flatMap((dep) => [`--external:${dep}`]),
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`esbuild failed for ${name}:\n${result.stderr || result.stdout}`);
  }
  return outfile;
}

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  dim: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
};
const usage = (over = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, ...over });

let F;
let U;
let TUI;

try {
  const formatBundle = bundle("format", path.join(SRC, "src/format.ts"));
  F = await import(pathToFileURL(formatBundle).href);
  // Real ANSI-aware width math from the installed Pi TUI, so "fits the width"
  // assertions measure terminal columns rather than code units.
  TUI = await import(pathToFileURL(path.join(piTui, 'dist/index.js')).href);
  F = { ...F, visibleWidth: TUI.visibleWidth };
  const uiBundle = bundle("ui", path.join(SRC, "src/ui.ts"));
  U = await import(pathToFileURL(uiBundle).href);

  // -------------------------------------------------------------------------
  section("shared grammar");
  // -------------------------------------------------------------------------
  {
    const item = {
      id: "9c933a98-1111-2222-3333-444455556666",
      state: "completed",
      durationMs: 431_000,
      durationKind: "frozen",
      body: "Found 2 P2 issues; no P0/P1. Fix before delivery.",
      metrics: { model: "uwoacrimson/gpt-6-sol", turns: 24, tokens: 192_000, cost: 0.42 },
    };
    const lines = F.renderCardLines(item, { theme, width: 80 });
    ok(lines.some((line) => line.includes("9c933a98")), "card shows short run id", lines.join("|"));
    ok(lines.some((line) => line.includes("Completed") || line.includes("done")), "card shows explicit state word", lines.join("|"));
    ok(lines.some((line) => /7m11s/.test(line)), "card shows labelled duration", lines.join("|"));
    ok(lines.some((line) => line.includes("24 turns")), "turns are explicitly labelled", lines.join("|"));
    ok(lines.some((line) => line.includes("192k tokens (in+out)")), "tokens labelled cumulative in+out", lines.join("|"));
    ok(lines.every((line) => F.visibleWidth(line) <= 80), "card respects width 80", lines.join("|"));
    ok(lines.some((line) => line.includes("gpt-6-sol") && !line.includes("uwoacrimson/")), "compact row abbreviates the model", lines.join("|"));
    const shownModelCount = lines.join("\n").split("gpt-6-sol").length - 1;
    eq(shownModelCount, 1, "actual model appears once in a compact card");
  }

  // Frozen snapshots never age; a bounded observation does not exceed it.
  {
    const snapshot = {
      mode: "single", state: "completed", startedAt: 0, endedAt: 431_000,
      results: [{ label: "a", state: "completed", usage: usage({ turns: 1, input: 10 }), finalOutput: "done" }],
    };
    const early = F.renderRunLines(snapshot, { theme, width: 100, now: 1_000_000 });
    const late = F.renderRunLines(snapshot, { theme, width: 100, now: 9_000_000 });
    eqJson(early, late, "terminal card does not age with the render clock");
    ok(early.some((line) => line.includes("7m11s")), "terminal card freezes at endedAt", early.join("|"));

    const legacySnapshot = {
      mode: "single", state: "completed", startedAt: 0,
      results: [{ label: "a", state: "completed", usage: usage(), finalOutput: "done" }],
    };
    const legacyEarly = F.renderRunLines(legacySnapshot, { theme, width: 100, now: 60_000 });
    const legacyLate = F.renderRunLines(legacySnapshot, { theme, width: 100, now: 600_000 });
    eqJson(legacyEarly, legacyLate, "endless legacy snapshot does not age either");
    ok(!legacyEarly.some((line) => /m\d*s|\d+s/.test(line)), "unknown-duration card omits the duration", legacyEarly.join("|"));

    // A captured observation is a hard bound for both the duration and the
    // stalled note of an immutable snapshot.
    const stalled = {
      mode: "single", state: "running", startedAt: 0, endedAt: 60_000,
      presentation: { kind: "snapshot", id: "abc", observedAt: 60_000, durationKind: "frozen" },
      results: [{ label: "a", state: "running", usage: usage(), stalledSince: 10_000 }],
    };
    const captured = F.renderRunLines(stalled, { theme, width: 100, now: 10_000_000 });
    ok(captured.some((line) => line.includes("1m")), "captured snapshot uses its observation bound", captured.join("|"));
    ok(captured.some((line) => line.includes('stalled 50s')), 'a frozen snapshot preserves the stall at observation time', captured.join('|'));
    eqJson(captured, F.renderRunLines(stalled, { theme, width: 100, now: 20_000_000 }), 'frozen stall does not age');
  }

  // -------------------------------------------------------------------------
  section("markdown-safe previews");
  // -------------------------------------------------------------------------
  {
    eq(F.cleanPreviewLine("## Findings"), "Findings", "heading marker removed");
    eq(F.cleanPreviewLine("- Item one"), "Item one", "list marker removed");
    eq(F.cleanPreviewLine("```ts"), undefined, "fence line skipped");
    eq(F.cleanPreviewLine("> quoted"), "quoted", "quote marker removed");
    eq(F.cleanPreviewLine("**bold text**"), "bold text", "bounded strong emphasis removed");
    eq(F.cleanPreviewLine("see [docs](https://x/y)"), "see docs", "link label kept, url dropped");
    eq(F.cleanPreviewLine("run `npm test`"), "run npm test", "inline code unwrapped");
    eq(F.cleanPreviewLine("price is 2*3*4"), "price is 2*3*4", "bare operators untouched");
    eq(F.cleanPreviewLine("read src/a_b/c_d.ts"), "read src/a_b/c_d.ts", "snake_case path untouched");
    eq(F.cleanPreviewLine("C:\\Users\\me\\file_name.txt"), "C:\\Users\\me\\file_name.txt", "windows path untouched");
    eq(F.cleanPreviewLine("set x = a|b && c"), "set x = a|b && c", "diagnostic operators untouched");
    eq(F.cleanPreviewLine("__init__ and _private"), "__init__ and _private", "dunder identifiers untouched");
    eq(F.cleanPreviewLine("   "), undefined, "blank line has no preview");
    ok(F.previewText("```\n## Real line\nmore", 40) === "Real line", "preview skips fence and heading scaffolding");
    ok(F.previewText(undefined) === undefined, "missing output has no preview");
    const astral = "🙂".repeat(4);
    eq(Array.from(F.clampText(astral, 3)).length, 3, "clampText is code-point safe");
    ok(F.clampText(astral, 3).endsWith("…"), "clampText marks the cut");
  }

  // -------------------------------------------------------------------------
  section("identity and metrics helpers");
  // -------------------------------------------------------------------------
  {
    eq(F.displayLabel("  ", "task"), "task", "blank label falls back");
    eq(F.formatModelList(["a/x", "b/y", "c/z", "d/w"], 2), "a/x, b/y +2", "model list bounded with total");
    eq(F.formatModelList(["a/x", "a/x"], 2), "a/x", "model list de-duplicates");
    eq(F.formatMetricsText(undefined), "", "missing metrics render empty");
    eq(F.formatMetricsText({ model: "uwoacrimson/gpt-6-sol", turns: 3, tokens: 1500, cost: 0.01 }),
      "gpt-6-sol · 3 turns · 1.5k tokens (in+out) · $0.010", "metrics row vocabulary is labelled");
  }

  // -------------------------------------------------------------------------
  section("widths, CJK and ANSI");
  // -------------------------------------------------------------------------
  {
    const cjk = {
      mode: "single", state: "failed", startedAt: 0, endedAt: 1000, id: "deadbeef-0000",
      results: [{ label: "审查中间件实现", state: "failed", errorMessage: "路径 src/认证/中间件.ts 读取失败（EACCES）", usage: usage({ turns: 2, input: 300 }) }],
    };
    for (const width of [20, 40, 80, 120]) {
      const lines = F.renderRunLines(cjk, { theme, width });
      ok(lines.length > 0, `width ${width}: card renders`, String(lines.length));
      ok(lines.every((line) => F.visibleWidth(line) <= width), `width ${width}: CJK error card fits`, lines.map((l) => `${F.visibleWidth(l)}:${l}`).join("|"));
    }
    const ansiLines = F.renderCardLines({
      id: "abc12345",
      state: "completed",
      durationMs: 4200,
      label: "Audit deps",
      body: "checked 12 packages",
      metrics: { model: "m" },
    }, { theme, width: 40 });
    ok(ansiLines.every((line) => F.visibleWidth(line) <= 40), "card fits at width 40 with themed output", ansiLines.join("|"));
    const narrow = F.renderCardLines({
      id: "abc12345",
      state: "failed",
      label: "审查中间件",
      body: "boom",
      metrics: { model: "uwoacrimson/gpt-6-sol", turns: 1, tokens: 10 },
    }, { theme, width: 20 });
    ok(narrow.every((line) => F.visibleWidth(line) <= 20), "width 20 card fits", narrow.join("|"));
    ok(narrow.some((line) => line.includes("abc12345")), "width 20 keeps the short id", narrow.join("|"));
    ok(narrow.some((line) => line.includes("failed") || line.includes("done")), "width 20 keeps the state word", narrow.join("|"));
    ok(!narrow.some((line) => line.includes("gpt-6-sol")), "width 20 drops optional metrics", narrow.join("|"));
  }

  // -------------------------------------------------------------------------
  section("parallel cards and hidden counts");
  // -------------------------------------------------------------------------
  {
    const tasks = Array.from({ length: 9 }, (_, index) => ({
      label: `task-${index + 1}`,
      state: index < 2 ? "running" : "queued",
      model: `prov/model-${index + 1}`,
      usage: usage({ turns: index, input: 100 * (index + 1) }),
    }));
    const parallel = { mode: "parallel", state: "running", startedAt: 0, id: "feedface-0000", results: tasks };
    const collapsed = F.renderRunLines(parallel, { theme, width: 100, isPartial: true });
    ok(collapsed.some((line) => line.includes("+3 more tasks")), "parallel card counts hidden tasks", collapsed.join("|"));
    ok(collapsed.length <= 12, "parallel card is bounded", String(collapsed.length));
    ok(!collapsed.some((line) => line.includes("model-3") && line.includes("model-4")), "no cross-task retry chain in rows", collapsed.join("|"));
    const expanded = F.renderRunLines(parallel, { theme, width: 100, isPartial: true, expanded: true });
    ok(expanded.some((line) => line.includes("task-9")), "expanded parallel card reaches the last task", expanded.join("|"));
    ok(!expanded.some((line) => line.includes("more tasks")), "expanded card has no hidden-task marker");
    ok(expanded.every((line) => F.visibleWidth(line) <= 100), "expanded parallel card fits", expanded.join("|"));
  }

  // -------------------------------------------------------------------------
  section("live row stability");
  // -------------------------------------------------------------------------
  {
    const live = (over = {}) => ({
      mode: "single", state: "running", startedAt: 0, id: "aaaaaaaa-0000",
      results: [{ label: "Audit", state: "running", usage: usage(), finalOutput: undefined, ...over }],
    });
    const before = F.renderRunLines(live(), { theme, width: 80, isPartial: true, now: 1_000 });
    const after = F.renderRunLines(live({ usage: usage({ turns: 3, input: 1_000 }), finalOutput: "reading files" }), {
      theme, width: 80, isPartial: true, now: 2_000,
    });
    eq(before.length, after.length, "live card keeps its row count as data arrives");
  }

  // -------------------------------------------------------------------------
  section("management receipts vs child state");
  // -------------------------------------------------------------------------
  {
    const receipt = {
      mode: "single", state: "running", startedAt: 0, id: "beefbeef-0000",
      presentation: {
        kind: "receipt", operation: "steer queued", id: "beefbeef-0000",
        receipt: "Message queued for task 0; delivered after its current assistant turn.",
        observedAt: 5_000, durationKind: "unknown",
      },
      results: [{ label: "Audit", state: "running", usage: usage(), finalOutput: "OLD CHILD OUTPUT SENTINEL" }],
    };
    const lines = F.renderRunLines(receipt, { theme, width: 100, now: 9_999_999 });
    const text = lines.join("\n");
    ok(text.includes("steer queued"), "receipt operation is visible", text);
    ok(text.includes("Message queued"), "receipt body is visible", text);
    ok(!text.includes("OLD CHILD OUTPUT SENTINEL"), "receipt does not show a stale child summary", text);
    ok(text.includes("running"), "receipt still states the real child lifecycle", text);
    ok(!/\d+m\d+s|\b\d+s\b/.test(text), "an unknown-duration receipt does not invent a duration", text);

    const diffReceipt = {
      mode: "single", state: "completed", startedAt: 0, endedAt: 1000, id: "beefbeef-0001",
      presentation: {
        kind: "receipt", operation: "diff", id: "beefbeef-0001",
        receipt: "Worktree diff for task 0 (branch feat/x).",
        detailLines: ["a.ts | 3 ++", "+++ b/a.ts"],
        observedAt: 2000, durationKind: "unknown",
      },
      results: [{ label: "Audit", state: "completed", usage: usage(), finalOutput: "CHILD ANSWER SENTINEL" }],
    };
    const diffCollapsed = F.renderRunLines(diffReceipt, { theme, width: 100 }).join("\n");
    ok(!diffCollapsed.includes("CHILD ANSWER SENTINEL"), "diff shows evidence, not the child answer", diffCollapsed);
    ok(diffCollapsed.includes("diff/evidence lines"), "collapsed diff points at expandable evidence", diffCollapsed);
    const diffExpanded = F.renderRunLines(diffReceipt, { theme, width: 100, expanded: true }).join("\n");
    ok(diffExpanded.includes("a.ts | 3 ++"), "expanded diff shows the stat", diffExpanded);
    ok(!diffExpanded.includes("CHILD ANSWER SENTINEL"), "expanded diff still does not show the old child answer", diffExpanded);
    ok(diffExpanded.includes("branch feat/x"), "expanded diff keeps its pointer", diffExpanded);
  }

  // -------------------------------------------------------------------------
  section("call headers");
  // -------------------------------------------------------------------------
  {
    const header = F.renderCallLine({ task: "Find auth middleware and summarize", description: "Auth scan" }, theme, 80);
    ok(header.includes("Auth scan"), "call header prefers the description label", header);
    ok(!header.includes("Find auth middleware"), "call header does not echo the raw prompt when labelled", header);
    const unlabelled = F.renderCallLine({ task: "Find auth middleware" }, theme, 80);
    ok(unlabelled.includes("Find auth middleware"), "call header falls back to the task preview", unlabelled);
    const background = F.renderCallLine({ task: "x", description: "Scan", async: true }, theme, 80);
    ok(background.includes("background"), "background runs are marked in the call header", background);
    const wait = F.renderWaitCallLine({ id: "abcdef123456", timeout_ms: 30_000 }, theme, 80);
    ok(wait.includes("subagent_wait"), "alias wait header names the wait tool", wait);
    ok(wait.includes("abcdef12"), "alias wait header shows the target run id", wait);
    ok(wait.includes("30s"), "alias wait header shows the timeout", wait);
    const raw = F.renderWaitCallLine({}, theme, 80);
    ok(raw.includes("wait"), "alias wait header degrades without an id", raw);
  }

  // -------------------------------------------------------------------------
  section("legacy and error fallbacks");
  // -------------------------------------------------------------------------
  {
    const empty = F.renderFallbackLines("", { theme, width: 80 });
    ok(empty.length > 0, "empty output still renders a card", empty.join("|"));
    const plain = F.renderFallbackLines("Started run abc. You will be notified on completion.", { theme, width: 80 });
    ok(plain.join("\n").includes("Started run abc"), "startup receipt keeps its text", plain.join("|"));
    const legacy = F.renderFallbackLines("line one\nline two\nline three", { theme, width: 80 });
    ok(legacy.some((line) => line.includes("+2 more lines")), "collapsed legacy output counts hidden lines", legacy.join("|"));
    const expanded = F.renderFallbackLines("line one\nline two\nline three", { theme, width: 80, expanded: true });
    ok(expanded.join("\n").includes("line three"), "expanded legacy output keeps every line", expanded.join("|"));
    const err = F.renderFallbackLines("Run x failed: EACCES", { theme, width: 80, state: "failed" });
    ok(err.join("\n").includes("failed"), "error fallback keeps an explicit state word", err.join("|"));
    ok(expanded.every((line) => F.visibleWidth(line) <= 80), "fallback lines fit the width", expanded.join("|"));
  }

  // -------------------------------------------------------------------------
  section("widget rows");
  // -------------------------------------------------------------------------
  {
    const runs = [0, 1, 2, 3, 4].map((index) => ({
      id: `run${index}000-0000`,
      state: "running",
      startedAt: 0,
      mode: index === 0 ? "parallel" : "single",
      results: index === 0
        ? [0, 1, 2, 3].map((task) => ({ label: `t${task}`, state: "running", model: `p/m${task}`, usage: usage({ turns: 1, input: 10 }), liveText: "reading files" }))
        : [{ label: `job-${index}`, state: "running", model: `p/m${index}`, usage: usage({ turns: 1, input: 10 }), liveText: "working" }],
    }));
    for (const width of [20, 40, 80, 120]) {
      const lines = F.widgetRunLines(runs, { theme, width, now: 5_000, spinnerFrame: 0 });
      ok(lines.every((line) => F.visibleWidth(line) <= width), `widget fits width ${width}`, lines.join("|"));
    }
    const widget = F.widgetRunLines(runs, { theme, width: 120, now: 5_000, spinnerFrame: 0 });
    ok(widget.some((line) => line.includes("+1 more run")), "widget counts hidden runs", widget.join("|"));
    ok(widget.some((line) => line.includes("+2 more tasks")), "widget counts hidden tasks", widget.join("|"));
    ok(widget.length <= 30, "widget rows stay bounded", String(widget.length));
    const single = F.widgetRunLines([runs[1]], { theme, width: 80, now: 5_000, spinnerFrame: 0 });
    ok(single.some((line) => line.includes("run1000")), "widget shows the stable short id", single.join("|"));
    const liveOnly = F.widgetRunLines([{ id: "live0001-0000", state: "running", startedAt: 0, mode: "single", results: [{ label: "x", state: "running" }] }], {
      theme, width: 80, now: 65_000, spinnerFrame: 0,
    });
    ok(liveOnly.join("\n").includes("1m5s"), "live widget ticks its elapsed time", liveOnly.join("|"));
  }

  // -------------------------------------------------------------------------
  section("completion cards");
  // -------------------------------------------------------------------------
  {
    const single = F.renderCompletionLines([{
      id: "c0ffee00-0000",
      state: "completed",
      durationMs: 431_000,
      tasks: [{ label: "Review", state: "completed", model: "uwoacrimson/gpt-6-sol", turns: 24, tokens: 192_000, diagnostic: "Found 2 P2 issues; no P0/P1." }],
    }], { theme, width: 100 });
    const text = single.join("\n");
    ok(text.includes("9c933a98") || text.includes("c0ffee00"), "completion card identifies the run", text);
    ok(text.includes("Found 2 P2 issues"), "completion card shows the bounded diagnostic", text);
    eq((text.match(/gpt-6-sol/g) ?? []).length, 1, "completion card shows the model once");
    ok(!/wait\s*\{\s*id\s*\}/.test(text), "no developer-facing wait hint in the card", text);
    ok(single.every((line) => F.visibleWidth(line) <= 100), "completion card fits its width", single.join("|"));

    const parallel = F.renderCompletionLines([{
      id: "c0ffee01-0000",
      state: "partial",
      durationMs: 60_000,
      mode: "parallel",
      label: "Fanout",
      tasks: [0, 1, 2, 3, 4, 5].map((index) => ({ label: `t${index}`, state: index === 0 ? "failed" : "completed", model: `p/m${index}`, turns: 1, tokens: 10, diagnostic: "ok" })),
    }], { theme, width: 100 });
    const ptext = parallel.join("\n");
    ok(ptext.includes("+2 more tasks"), "parallel completion counts hidden tasks", ptext);
    ok(ptext.includes("failed") || ptext.includes("done"), "parallel completion keeps per-task state", ptext);
    const expanded = F.renderCompletionLines([{
      id: "c0ffee02-0000", state: "completed", durationMs: 1000,
      tasks: [{ label: "Review", state: "completed", turns: 2, tokens: 20, attemptedModels: ["a/one", "b/two", "c/three"], attemptedModelsTotal: 3, pointers: ["/tmp/report.md"] }],
    }], { theme, width: 100, expanded: true });
    const etext = expanded.join("\n");
    ok(/attempt 3|attempt/.test(etext), "expanded completion shows the attempt history", etext);
    ok(etext.includes("a/one") && etext.includes("c/three"), "expanded completion lists the attempt models", etext);
  }

  // -------------------------------------------------------------------------
  section("/btw entry");
  // -------------------------------------------------------------------------
  {
    const collapsed = F.renderBtwLines({ state: "done", label: "why is the sky blue", answer: "## Because\nRayleigh scattering dominates." }, { theme, width: 80 });
    const text = collapsed.join("\n");
    ok(text.includes("by the way"), "btw card keeps its title", text);
    ok(text.includes("why is the sky blue"), "btw card keeps its label", text);
    ok(text.includes('Because'), 'btw card shows the first meaningful cleaned line', text);
    ok(!text.includes("##"), "btw preview strips the heading marker", text);
    ok(!text.includes("tokens") && !text.includes("turns"), "btw invents no metrics", text);
    ok(!text.includes("model"), "btw invents no model", text);
    const expanded = F.renderBtwLines({ state: "failed", label: "x", answer: "line one\nline two" }, { theme, width: 80, expanded: true });
    ok(expanded.join("\n").includes("line two"), "expanded btw keeps every line", expanded.join("|"));
    for (const width of [20, 40, 80]) {
      ok(F.renderBtwLines({ state: "done", label: "🛰️ 长标签测试", answer: "答案内容" }, { theme, width }).every((line) => F.visibleWidth(line) <= width), `btw fits width ${width}`);
    }
  }

  // -------------------------------------------------------------------------
  section("status preview clock");
  // -------------------------------------------------------------------------
  {
    const terminal = {
      id: "abcdef12-0000", sessionKey: "s", mode: "single", state: "completed",
      startedAt: 0, endedAt: 10_000, taskPreviews: [], delivered: false, results: [],
    };
    eq(F.formatStatusPreview(terminal, 90_000), F.formatStatusPreview(terminal, 9_000_000), "terminal status preview is frozen");
    ok(F.formatStatusPreview(terminal, 9_000_000).includes("10s"), "terminal status preview uses endedAt");
    const live = { ...terminal, state: "running", endedAt: undefined, results: [{ label: "a", state: "running", usage: usage() }] };
    ok(F.formatStatusPreview(live, 5_000).includes("5s"), "live status preview ticks");
    const captured = F.formatStatusPreview(live, 9_000_000, 5_000);
    ok(captured.includes("5s"), "a captured status read is bounded by its observation time");
    const legacyLive = { ...terminal, state: "running", startedAt: 0, endedAt: undefined, results: [] };
    ok(F.formatStatusPreview(legacyLive, 7_000).includes("7s"), "legacy live run still reports elapsed");
    const legacyDone = { ...terminal, endedAt: undefined };
    ok(!/\d+s/.test(F.formatStatusPreview(legacyDone, 7_000)), "legacy terminal snapshot reports no duration");
  }

  // -------------------------------------------------------------------------
  section("notification ownership and batching");
  // -------------------------------------------------------------------------
  {
    const notificationsBundle = bundle("notifications", path.join(SRC, "src/notifications.ts"));
    const N = await import(pathToFileURL(notificationsBundle).href);
    const batches = [];
    const batcher = new N.CompletionBatcher((ids) => batches.push([...ids]), { debounceMs: 20, maxWaitMs: 60 });
    batcher.add("run-a", false);
    batcher.add("run-b", false);
    eq(batches.length, 0, "successes are held for the debounce window");
    await new Promise((resolve) => setTimeout(resolve, 60));
    eq(batches.length, 1, "held successes flush as one batch");
    eqJson(batches[0].sort(), ["run-a", "run-b"], "batch carries both run ids");
    const failBatches = [];
    const failing = new N.CompletionBatcher((ids) => failBatches.push([...ids]), { debounceMs: 500 });
    failing.add("run-c", false);
    failing.add("run-d", true);
    eqJson(failBatches[0], ["run-c", "run-d"], "a failure flushes immediately with held successes");
    failing.dispose();
    batcher.dispose();
    const disposed = new N.CompletionBatcher(() => { throw new Error("must not flush"); }, { debounceMs: 5 });
    disposed.add("run-e", false);
    disposed.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // -------------------------------------------------------------------------
  section("widget component lifecycle");
  // -------------------------------------------------------------------------
  {
    let runs = [{ id: "w1", sessionKey: "s", mode: "single", state: "running", startedAt: 0, taskPreviews: [], delivered: false, results: [] }];
    let renders = 0;
    const widget = new U.SubagentWidget({
      getRuns: () => runs,
      subscribe: () => () => {},
    }, theme);
    const mounted = widget.attach({ requestRender() { renders++; } }, theme);
    ok(mounted === widget, "attach returns the same component identity");
    const first = widget.render(80);
    ok(first.length > 0, "widget renders live runs", first.join("|"));
    ok(widget.render(80).length === first.length, "repeated renders keep the row count");
    await new Promise((resolve) => setTimeout(resolve, 550));
    ok(renders >= 2, 'mounted widget repaints over at least two animation ticks');
    runs = [];
    const afterDisposalOfRuns = widget.render(80);
    eqJson(afterDisposalOfRuns, [], "widget renders nothing when no run is live");
    const after = renders;
    await new Promise((resolve) => setTimeout(resolve, 550));
    ok(renders <= after + 1, 'widget stops animation after no live runs remain');
    widget.dispose();
    widget.dispose();
    eqJson(widget.render(80), [], "a disposed widget renders nothing");
    // The owned timer must not keep the process alive: if it did, this script
    // would hang; `unref` is asserted structurally.
  }

  section('outcomes, warnings, expanded evidence and inspector viewport');
  {
    const ansiTheme = { ...theme, fg: (_token, text) => `\u001b[36m${text}\u001b[39m`, bold: (text) => `\u001b[1m${text}\u001b[22m` };
    const states = ['queued', 'running', 'completed', 'partial', 'failed', 'lost', 'cancelled', 'timeout'];
    for (const state of states) {
      for (const width of [20, 40, 80, 120]) {
        const lines = F.renderRunLines({ mode: 'single', id: '11223344-rest', state, startedAt: 0, endedAt: ['queued','running'].includes(state) ? undefined : 1000,
          results: [{ label: '审查路径', state, model: 'provider/long_model_identifier', usage: usage({ turns: 4, input: 20, cost: .2 }), timeoutPhase: 'routing', errorMessage: '路径读取失败', wrappedUp: state === 'partial', finalOutput: '# Report\n详细结果', attempts: 3, attemptedModels: ['provider/a','provider/b'], stalledSince: 100, structuredError: 'schema evidence' }] },
          { theme: ansiTheme, width, isPartial: ['queued','running'].includes(state), now: 1000 });
        ok(lines.every((line) => F.visibleWidth(line) <= width), `${state} ANSI/CJK fits ${width}`);
        ok(lines.join('\n').includes(F.formatState(state)), `${state} explicit lifecycle remains visible at ${width}`);
      }
    }
    const full = F.renderRunLines({ mode: 'single', state: 'failed', results: [{ state: 'failed', model: 'provider/full_model_identifier', errorMessage: 'long error '.repeat(80) + 'ERROR-TAIL', usage: usage({ cost: 1.23, turns: 7, input: 9 }) }] }, { theme, width: 20, expanded: true }).join('\n');
    ok(full.includes('ERROR-TAIL') && full.includes('$1.23'), 'expanded narrow result recovers diagnostic and known cost');
    for (const width of [20, 40]) {
      const warning = { mode: 'single', state: 'running', results: [{ state: 'running', stalledSince: 0, attempts: 3, attemptedModels: ['provider/very_long_name_one','provider/very_long_name_two'], thinking: 'off', effectiveThinking: 'high' }] };
      const compact = F.renderRunLines(warning, { theme, width, isPartial: true, now: 65000 }).join('\n');
      ok(compact.includes('stalled'), `combined reliability flags keep stall visible at ${width}`);
      const expanded = F.renderRunLines(warning, { theme, width, isPartial: true, expanded: true, now: 65000 }).join('\n');
      ok(expanded.includes('stalled') && expanded.includes('attempt 3') && expanded.includes('thinking:'), `expanded live warnings recover all flags at ${width}`);
    }
    const legacy = { mode: 'single', state: 'running', startedAt: 0, results: [{ state: 'running', stalledSince: 5 }] };
    eqJson(F.renderRunLines(legacy, { theme, width: 80, now: 10 }), F.renderRunLines(legacy, { theme, width: 80, now: 900000 }), 'non-streaming legacy active snapshot never ages');
    for (const phase of ['routing','queued','starting','running','cancelling']) {
      const lines = F.renderRunLines({ mode: 'single', state: 'timeout', results: [{ state: 'timeout', timeoutPhase: phase }] }, { theme, width: 80 });
      ok(lines.join('\n').includes(`timeout (${phase})`), `timeout phase ${phase} retained`);
    }
    const parallelEvidence = F.renderRunLines({ mode: 'parallel', state: 'completed', results: [{ label: 'first', state: 'completed', finalOutput: 'abcdefghijklmnopqrstuvwxyzABCDEFGH' }, { label: 'second', state: 'completed', finalOutput: 'second output' }] }, { theme, width: 20, expanded: true }).join('').replaceAll(' ', '');
    ok(parallelEvidence.includes('abcdefghijklmnopqrstuvwxyzABCDEFGH'), 'parallel expanded wrapping loses no right-edge characters');
    const longBtw = F.renderBtwLines({ state: 'done', label: 'side question', answer: '长段落内容'.repeat(100) + 'BTW-TAIL' }, { theme, width: 40, expanded: true }).join('\n');
    ok(longBtw.includes('BTW-TAIL'), 'expanded private answer wraps the full paragraph');
    const runs = Array.from({ length: 20 }, (_, i) => ({ id: `id${String(i).padStart(6,'0')}`, sessionKey: 's', mode: 'single', state: 'completed', startedAt: 0, endedAt: 1000, delivered: true, taskPreviews: [], results: [{ label: `Review-${i}`, state: 'completed', model: 'provider/full_identifier', usage: usage({ turns: 3, input: 20 }), finalOutput: 'Output '.repeat(100) + 'INSPECTOR-TAIL' }] }));
    for (const rows of [4, 8, 12, 24, 40]) {
      const adapter = { getActiveRuns: () => [], getCompletedRuns: () => runs, getRunById: (id) => runs.find((r) => r.id === id), getReadyCount: () => 0, getUsageSummary: () => 'usage summary', cancelRun() {}, dismissRun() {}, resumeRun: async () => {}, showOutput() {} };
      const overlay = U.createSubagentsOverlay({ requestRender() {}, terminal: { rows } }, ansiTheme, adapter, () => {});
      for (let index = 0; index < runs.length; index++) {
        const lines = overlay.render(40);
        const cap = Math.floor(rows * .8);
        ok(lines.length <= cap && lines.slice(0,cap).some((line) => line.includes('▶')), `inspector ${rows} rows keeps selected ${index} after host clipping`);
        overlay.handleInput('j');
      }
      overlay.handleInput('\r');
      let all = '', bounded = true;
      for (let i = 0; i < 100; i++) { const lines = overlay.render(40); bounded &&= lines.length <= Math.floor(rows*.8); all += lines.join('\n'); overlay.handleInput('j'); }
      ok(bounded, `detail ${rows} viewport remains bounded throughout scrolling`);
      ok(all.includes('INSPECTOR-TAIL') && all.includes('full_identifier'), `inspector ${rows} rows can reach full detail`);
      overlay.dispose();
    }
  }

  section('actual extension registration and execution');
  await extensionScenarios({ SRC, PI_ROOT, temp, theme, TUI, ok, eq, eqJson });

  section('compact/full surface, raw gates and registration lifecycle');
  await surfaceScenarios({ SRC, PI_ROOT, temp, theme, TUI, ok, eq, eqJson });

  section('actual Responses serialization and sparse declaration boundary');
  await responsesScenarios({ SRC, PI_ROOT, temp, theme, TUI, ok, eq, eqJson });

  section("advisory invocation clocks, handoff and synthetic RPC safeguards");
  await timeoutScenarios({ SRC, PI_ROOT, temp, theme, TUI, ok, eq, eqJson });

  // -------------------------------------------------------------------------
  section("single-run render regression fixtures");
  // -------------------------------------------------------------------------
  {
    const fixturesDir = path.resolve(argValue('--fixtures', path.join(temp, 'fixtures')));
    fs.mkdirSync(fixturesDir, { recursive: true });
    const themeWrite = (lines) => `${lines.join("\n")}\n`;
    const cases = {
      "single-success.txt": F.renderRunLines({
        mode: "single", state: "completed", startedAt: 0, endedAt: 431_000, id: "9c933a98-0000-0000-0000-000000000000",
        results: [{ label: "Review ready weapon semantics", state: "completed", model: "uwoacrimson/gpt-6-sol", usage: usage({ turns: 24, input: 120_000, output: 72_000, cost: 0.42 }), finalOutput: "Found 2 P2 issues; no P0/P1. Fix before delivery." }],
      }, { theme, width: 80 }),
      "single-live.txt": F.renderRunLines({
        mode: "single", state: "running", startedAt: 0, id: "aaaaaaaa-0000-0000-0000-000000000000",
        results: [{ label: "Audit deps", state: "running", model: "uwoacrimson/gpt-6-luna", usage: usage({ turns: 3, input: 12_400 }), finalOutput: "reading src/auth/middleware.ts…" }],
      }, { theme, width: 80, isPartial: true, now: 8_000 }),
      "receipt-diff.txt": F.renderRunLines({
        mode: "single", state: "completed", startedAt: 0, endedAt: 1000, id: "beefbeef-0000-0000-0000-000000000000",
        presentation: { kind: "receipt", operation: "diff", id: "beefbeef-0000-0000-0000-000000000000", receipt: "Worktree diff for task 0 (branch feat/tui).", detailLines: [" src/a.ts | 3 ++-"], observedAt: 2000, durationKind: "unknown" },
        results: [{ label: "Audit", state: "completed", usage: usage(), finalOutput: "CHILD ANSWER SENTINEL" }],
      }, { theme, width: 80 }),
      "snapshot-frozen.txt": F.renderRunLines({
        mode: "single", state: "completed", startedAt: 0, endedAt: 431_000, id: "deadbeef-0000-0000-0000-000000000000",
        presentation: { kind: "snapshot", operation: "status", id: "deadbeef-0000-0000-0000-000000000000", observedAt: 431_000, durationKind: "frozen" },
        results: [{ label: "Audit", state: "completed", usage: usage({ turns: 4, input: 800 }), finalOutput: "done" }],
      }, { theme, width: 80, now: 9_000_000 }),
      "legacy-empty.txt": F.renderFallbackLines("Started run 1234. You will be notified on completion.", { theme, width: 80 }),
      "widget-dense.txt": F.widgetRunLines([
        { id: "w1", state: "running", startedAt: 0, mode: "single", results: [{ label: "Audit deps", state: "running", model: "p/m1", usage: usage({ turns: 4, input: 18_000 }), liveText: "checking license headers…" }] },
        { id: "w2", state: "queued", startedAt: 0, mode: "single", results: [{ label: "License scan", state: "queued" }] },
      ], { theme, width: 80, now: 41_000, spinnerFrame: 2 }),
      "btw.txt": F.renderBtwLines({ state: "done", label: "why is the sky blue", answer: "## Because\nRayleigh scattering dominates." }, { theme, width: 80 }),
    };
    for (const [name, lines] of Object.entries(cases)) {
      const file = path.join(fixturesDir, name);
      const content = themeWrite(lines);
      fs.writeFileSync(file, content, "utf8");
      for (const line of lines) {
        if (F.visibleWidth(line) > 80) failures.push(`fixture ${name} overflows: ${line}`);
      }
    }
    console.log(`fixtures written to ${path.relative(SRC, fixturesDir)}`);
  }
} catch (error) {
  failures.push(`harness error: ${error?.stack ?? error}`);
} finally {
  if (!KEEP) {
    // Synthetic RPC children use this cwd. Let close callbacks drain during
    // Windows retries, and never hide a behavioral failure with cleanup's error.
    try { await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch (error) { failures.push(`temporary fixture cleanup failed (${temp}): ${error?.message ?? error}`); }
  } else console.log(`\nbundles kept at ${temp}`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
}
