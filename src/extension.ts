import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Usage } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { defaultConfig, loadConfig, readConfigFile, type SubagentConfig } from "./config.js";
import {
  formatDuration,
  formatRankedPreview,
  formatStatusPreview,
  formatTokens,
  isActiveState,
  oneLine,
  projectRoutingForDisplay,
  projectAttemptsForDisplay,
  renderCallLine,
  renderRunLines,
  SPINNERS,
  stateGlyph,
  type InlineRunView,
} from "./format.js";
import { createGetPiCommand, getLaunchResolution } from "./launch.js";
import { abortAsPromise } from "./maintenance.js";
import { sweepSessionsLifecycle } from "./distill.js";
import { runTasks } from "./orchestrator.js";
import { OutputManager } from "./output.js";
import { parseDepth, parseSpawnPolicy, SPAWNS_ENV_VAR, validateSubagentRequest, type PreparedTask, type ParentContext, type PreparationOptions, type ResolvedTask } from "./policy.js";
import type { ChildRunner } from "./runner.js";
import { ProcessLockManager, runRecordSessionIds } from "./process-lock.js";
import { SessionScopedRunRegistry, snapshotFromLiveRun } from "./registry.js";
import {
  ProviderSubagentParamsSchema,
  ProviderSubagentWaitParamsSchema,
  SubagentParamsSchema,
  SubagentWaitParamsSchema,
  type SubagentParams,
  type SubagentWaitParams,
} from "./schema.js";
import { BTW_ENTRY_TYPE, btwLabel, type BtwEntry } from "./btw.js";
import { Semaphore } from "./semaphore.js";
import type { RunSnapshot, TaskResult, TaskSpec, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";
import { addUsage, buildUsageLedger, formatLedger, hasBilledUsage, routingUsage, toPiUsage, type UsageLedger } from "./usage.js";
import { resolveBackendSessionFilePath, resolveSessionFilePath } from "./transcript.js";
import { CompletionBatcher, COMPLETION_MESSAGE_TYPE, type CompletionDetails, type CompletionDetailsRun, type CompletionDetailsTask } from "./notifications.js";
import { describeCatalog, discoverAgents, type AgentDefinition } from "./agents.js";
import { createSubagentsOverlay, FooterStatusModel, type SubagentAdapter } from "./ui.js";
import { WorktreeManager } from "./worktree.js";
import { eligibleModelCandidates, formatJevRoutingPrompt, toToolCandidates } from "./routing-policy.js";
import { JevRouter } from "./jev-router.js";
import { routePreparedTasks, type RoutingCatalog } from "./dispatch-routing.js";
import { runLocalPreflights } from "./dispatch-preflight.js";
import { rankedMaxAttempts } from "./model-failover.js";
import type { RoutingReceipt } from "./routing-types.js";
import { buildRoutingEvent, foldRoutingReceipts, MAX_ROUTING_DELIVERY_IDS, ROUTING_ENTRY_TYPE, type PersistedRoutingEvent } from "./persistence.js";

interface SessionRuntime {
  key: string;
  ctx: ExtensionContext;
  config: SubagentConfig;
  registry: SessionScopedRunRegistry;
  output: OutputManager;
  semaphore: Semaphore;
  worktrees: WorktreeManager;
  locks: ProcessLockManager;
  getPiCommand: ReturnType<typeof createGetPiCommand>;
  /** Live per-run child runners, for mid-run steering. runId → task index → runner. */
  liveRunners: Map<string, Map<number, ChildRunner>>;
  /** Run ids started with async:true — the only runs that notify on completion. */
  asyncRuns: Set<string>;
  completions?: CompletionBatcher;
  widgetTimer?: NodeJS.Timeout;
  /** Named agent catalog (project/shared/global .md files). Refreshed lazily. */
  agents: Map<string, AgentDefinition>;
  agentsLoadedAt: number;
  footer?: FooterStatusModel;
  unsubscribe?: () => void;
  unsubscribeLedger?: () => void;
  pendingRootMessages: import("@earendil-works/pi-ai").Message[];
  /** Memoized usage ledger; recomputed only after usage-affecting events. */
  ledgerValue?: UsageLedger;
  ledgerDirty: boolean;
  closed: boolean;
  depth: number;
  routingGeneration: number;
  routingPaused: boolean;
  pendingRoutes: Map<AbortController, Promise<void>>;
  pendingRoutingEvents: Map<string, PersistedRoutingEvent>;
  reconcileRouting?: () => void;
}

function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() || ctx.sessionManager.getSessionId() || `ephemeral:${ctx.cwd}`;
}

function activeEntries(runtime: SessionRuntime): readonly unknown[] {
  return runtime.ctx.sessionManager.getBranch();
}

/**
 * Ledger computation folds the whole active branch, so it is memoized and
 * invalidated by registry events / new root messages instead of being rebuilt
 * on every footer refresh or live-text tick.
 */
function ledger(runtime: SessionRuntime): UsageLedger {
  runtime.reconcileRouting?.();
  if (!runtime.ledgerDirty && runtime.ledgerValue) return runtime.ledgerValue;
  const entries = activeEntries(runtime);
  runtime.ledgerValue = buildUsageLedger(
    entries,
    [
      ...runtime.registry.getLiveRuns(runtime.key).map(snapshotFromLiveRun),
      ...runtime.registry.getSnapshots(runtime.key),
    ],
    runtime.pendingRootMessages,
    [...runtime.pendingRoutingEvents.values()],
  );
  runtime.ledgerDirty = false;
  return runtime.ledgerValue;
}

function makeAdapter(runtime: SessionRuntime): SubagentAdapter {
  return {
    getActiveRuns: () => runtime.registry.getLiveRuns(runtime.key).map(snapshotFromLiveRun),
    getCompletedRuns: () => runtime.registry.getSnapshots(runtime.key),
    getRunById(id) {
      const found = runtime.registry.lookup(id, runtime.key);
      if (found.status !== "found" || !found.run) return null;
      return "controller" in found.run ? snapshotFromLiveRun(found.run) : found.run;
    },
    cancelRun(id) {
      const found = runtime.registry.lookup(id, runtime.key);
      if (found.status === "found" && found.run && "controller" in found.run) found.run.controller.abort();
    },
    dismissRun: (id) => { runtime.registry.markDismissed(id, runtime.key); },
    async resumeRun(id) {
      const run = this.getRunById(id);
      const session = run?.results.find((result) => result.sessionId)?.sessionId;
      if (!session) {
        runtime.ctx.ui.notify("No resumable child session is available", "warning");
        return;
      }
      runtime.ctx.ui.setEditorText(`Continue the subagent session ${session}. Ask me for the follow-up task, then use the subagent tool with resume: "${session}".`);
      runtime.ctx.ui.notify("Prepared a resume request in the editor", "info");
    },
    showOutput(id) {
      const run = this.getRunById(id);
      const pointers = run?.results.flatMap((result) => [result.outputFile, result.worktree?.cwd, result.sessionId]).filter(Boolean) as string[] | undefined;
      if (!pointers?.length) runtime.ctx.ui.notify("No output artifact, worktree, or session pointer", "warning");
      else {
        runtime.ctx.ui.setEditorText(pointers.join("\n"));
        runtime.ctx.ui.notify("Output pointers copied to the editor", "info");
      }
    },
    getReadyCount: () => runtime.registry.getSnapshots(runtime.key).filter((run) => !run.delivered).length,
    getUsageSummary: () => formatLedger(ledger(runtime)),
    async steerRun(id) {
      const runners = runtime.liveRunners.get(id) ?? [...runtime.liveRunners.entries()].find(([key]) => key.startsWith(id))?.[1];
      if (!runners?.size) return runtime.ctx.ui.notify("Run has no steerable child (still queued or already finished)", "warning");
      const message = await runtime.ctx.ui.input("Steering message", "guidance for the running child…");
      if (!message?.trim()) return;
      let sent = 0;
      for (const runner of runners.values()) if (runner.steer(message)) sent++;
      runtime.ctx.ui.notify(sent ? `Steering queued for ${sent} task(s); delivered after the current turn` : "Child is no longer accepting input", sent ? "info" : "warning");
    },
    async applyWorktree(id) {
      const run = this.getRunById(id);
      const changed = run?.results.filter((result) => result.worktree?.changed) ?? [];
      if (!changed.length) return runtime.ctx.ui.notify("No changed worktree on this run", "warning");
      if (changed.length > 1) {
        runtime.ctx.ui.setEditorText(`Apply one of the worktrees from run ${id} with the subagent tool: { action: "apply", id: "${id}", index: <task index> }`);
        return runtime.ctx.ui.notify("Multiple changed worktrees; pick one via the tool (prompt prepared)", "info");
      }
      const tree = changed[0]!.worktree!;
      const ok = await runtime.ctx.ui.confirm("Apply worktree changes?", `Applies branch ${tree.branch} onto ${runtime.ctx.cwd} as uncommitted changes.`);
      if (!ok) return;
      try {
        const applied = await runtime.worktrees.apply({ cwd: tree.cwd, baseCommit: tree.baseCommit }, runtime.ctx.cwd);
        runtime.ctx.ui.notify(applied.applied ? `Applied: ${applied.stat.split("\n").pop() ?? "changes staged in working tree"}` : "No changes to apply", "info");
      } catch (error: any) {
        runtime.ctx.ui.notify(`Apply failed: ${error?.message ?? error}`, "error");
      }
    },
    async discardWorktree(id) {
      const run = this.getRunById(id);
      const changed = run?.results.filter((result) => result.worktree?.changed) ?? [];
      if (!changed.length) return runtime.ctx.ui.notify("No changed worktree on this run", "warning");
      const ok = await runtime.ctx.ui.confirm(
        "Discard worktree(s)?",
        `Permanently deletes ${changed.length} worktree(s) and branch(es): ${changed.map((result) => result.worktree!.branch).join(", ")}`,
      );
      if (!ok) return;
      for (const result of changed) {
        const tree = result.worktree!;
        await runtime.worktrees.forceRemove({ cwd: tree.cwd, branch: tree.branch, baseCwd: runtime.ctx.cwd, baseCommit: tree.baseCommit, changed: true }).catch(() => {});
      }
      runtime.ctx.ui.notify(`Discarded ${changed.length} worktree(s)`, "info");
    },
    subscribe: (listener) => runtime.registry.subscribe((event) => {
      if (event.sessionKey === runtime.key) listener();
    }),
    notify(message, level = "info") {
      runtime.ctx.ui.notify(message, level === "warn" ? "warning" : level);
    },
    getSessionFilePath(id) {
      const run = this.getRunById(id);
      const result = run?.results.find((entry) => entry.sessionId);
      const sessionId = result?.sessionId;
      if (!sessionId) return undefined;
      // Non-pi backends keep transcripts in their own vendor locations, so the
      // live view resolves per backend instead of assuming pi's session dir.
      const backend = result?.backend ?? "pi";
      if (backend !== "pi") {
        return resolveBackendSessionFilePath(backend, sessionId, { cwd: runtime.ctx.cwd });
      }
      return resolveSessionFilePath(runtime.config.sessionDir, sessionId);
    },
  };
}

function refreshFooter(runtime: SessionRuntime): void {
  if (runtime.closed || !runtime.footer) return;
  const active = runtime.registry.getLiveRuns(runtime.key).length;
  runtime.footer.update(active);
  // Terse and actionable only: Pi's native footer already reports session cost.
  const text = runtime.footer.render(runtime.ctx.ui.theme);
  runtime.ctx.ui.setStatus("subagent", text || undefined);
  refreshWidget(runtime);
}

/**
 * Ambient widget above the editor for BACKGROUND runs only — foreground runs
 * already render inline as the tool result, so showing them here would
 * double-render. Cleared when no background runs are live.
 */
function refreshWidget(runtime: SessionRuntime): void {
  if (runtime.closed || !runtime.ctx.hasUI) return;
  if (runtime.config.widget === "off") {
    runtime.ctx.ui.setWidget("subagent", undefined);
    if (runtime.widgetTimer) {
      clearInterval(runtime.widgetTimer);
      runtime.widgetTimer = undefined;
    }
    return;
  }
  const theme = runtime.ctx.ui.theme;
  const live = runtime.registry.getLiveRuns(runtime.key).filter((run) => runtime.asyncRuns.has(run.id));
  if (!live.length) {
    runtime.ctx.ui.setWidget("subagent", undefined);
    if (runtime.widgetTimer) {
      clearInterval(runtime.widgetTimer);
      runtime.widgetTimer = undefined;
    }
    return;
  }
  // Animate spinner/elapsed even when the child is between events.
  if (!runtime.widgetTimer) {
    runtime.widgetTimer = setInterval(() => refreshWidget(runtime), 250);
    runtime.widgetTimer.unref?.();
  }
  const now = Date.now();
  const frame = Math.floor(now / 120) % SPINNERS.length;
  const lines: string[] = [theme.fg("accent", "●") + " " + theme.bold("Subagents")];
  const shown = live.slice(0, 4);
  shown.forEach((run, index) => {
    const last = index === shown.length - 1 && live.length <= 4;
    const joint = last ? "└─" : "├─";
    for (const result of run.results.slice(0, 2)) {
      const active = isActiveState(result.state);
      const glyph = active ? theme.fg("accent", SPINNERS[frame]!) : stateGlyph(result.state, theme);
      const stats = [
        result.usage.turns ? `↻${result.usage.turns}` : "",
        result.usage.input + result.usage.output ? `${formatTokens(result.usage.input + result.usage.output)} tok` : "",
        formatDuration(now - run.startedAt),
      ].filter(Boolean).join(" · ");
      const activity = result.liveText?.split("\n").reverse().find((line) => line.trim());
      const modelText = result.model ?? "model unknown";
      lines.push(`${theme.fg("dim", joint)} ${glyph} ${theme.fg("dim", modelText)} · ${theme.fg("text", result.label)} ${theme.fg("dim", stats)}`);
      if (activity) lines.push(`${theme.fg("dim", last ? "    " : "│   ")}${theme.fg("dim", "⎿ ")}${theme.fg("muted", oneLine(activity, 80))}`);
    }
  });
  if (live.length > 4) lines.push(theme.fg("dim", `└─ +${live.length - 4} more · /subagents`));
  runtime.ctx.ui.setWidget("subagent", lines);
}

function utf8Preview(value: unknown, maxBytes: number): string {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

interface RunMeta {
  state?: RunSnapshot["state"];
  startedAt?: number;
  endedAt?: number;
}

function compactDetails(
  mode: "single" | "parallel",
  results: Array<TaskResult | RunSnapshot["results"][number]>,
  maxDetailsTextBytes = defaultConfig.maxDetailsTextBytes,
  run?: RunMeta,
) {
  const perResultText = Math.max(256, Math.floor(maxDetailsTextBytes / Math.max(1, results.length) / 2));
  return {
    mode,
    routingCurrency: results.some((result) => result.routing) ? "unreported" : undefined,
    state: run?.state,
    startedAt: run?.startedAt,
    endedAt: run?.endedAt,
    results: results.map((result: any) => ({
      label: result.label,
      task: String(result.task ?? "").slice(0, 500),
      state: result.state,
      exitCode: result.exitCode,
      stopReason: result.stopReason,
      timeoutPhase: result.timeoutPhase,
      errorMessage: result.errorMessage?.slice(0, 1_000),
      usage: result.usage ?? emptyUsage(),
      model: result.model,
      routing: projectRoutingForDisplay(result.routing),
      thinking: result.thinking,
      profile: result.profile,
      canWrite: result.canWrite,
      outputFile: result.outputFile,
      outputMode: result.outputMode,
      worktree: result.worktree,
      sessionId: result.sessionId,
      process: result.process,
      finalOutput: utf8Preview(result.finalOutput ?? result.liveText, perResultText),
      transcript: utf8Preview(result.transcript, perResultText),
      wrappedUp: result.wrappedUp,
      stalledSince: result.stalledSince,
      attempts: result.attempts,
      ...projectAttemptsForDisplay(result, Math.min(4_096, perResultText)),
      toolActivity: result.toolActivity,
      structuredOutput: result.structuredOutput,
      structuredError: result.structuredError,
    })),
  };
}

/** Minimal component for message renderers (fresh per render; no reuse contract). */
function lineComponentForMessage(render: (width: number) => string[]): Component {
  return { render, invalidate() {} };
}

/** Reusable one-shot component: stable identity across renders, content swapped in place. */
class LineBlock implements Component {
  private fn: (width: number) => string[] = () => [];
  set(fn: (width: number) => string[]): void { this.fn = fn; }
  render(width: number): string[] { return this.fn(width); }
  invalidate(): void {}
}

/**
 * Wall-clock spinner frame. While a foreground run streams, Pi's working
 * indicator keeps the TUI repainting, so deriving the frame from time inside
 * the render closure animates smoothly without owning any timer.
 */
function liveSpinnerFrame(): number {
  return Math.floor(Date.now() / 100) % SPINNERS.length;
}

// keyHint lives in the coding-agent runtime; load it lazily on first render so
// headless children never pay for Pi's provider/network stack at startup.
let keyHintFn: ((id: string, description: string) => string) | null | undefined;
function expandHint(): string {
  if (keyHintFn === undefined) {
    keyHintFn = null;
    void import("@earendil-works/pi-coding-agent")
      .then((m: any) => { keyHintFn = typeof m.keyHint === "function" ? m.keyHint : null; })
      .catch(() => { keyHintFn = null; });
  }
  try {
    return keyHintFn ? keyHintFn("app.tools.expand", "to expand") : "ctrl+o to expand";
  } catch {
    return "ctrl+o to expand";
  }
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Terminal delivery payload for the subagent tool. On Pi ≥ #6671 the extra
 * `usage` field is persisted on the tool-result session entry and folded into
 * the native footer, /session, and RPC session totals; older Pi copies only
 * content/details and silently ignores it. Callers attach it exactly once per
 * run by gating on the markDelivered result, mirroring the ledger's dedup.
 */
function deliveredResult<TDetails>(
  text: string,
  details: TDetails,
  results: ReadonlyArray<{ usage: UsageStats }>,
  selectorUsage: UsageStats = emptyUsage(),
): { content: Array<{ type: "text"; text: string }>; details: TDetails; usage?: Usage } {
  const total = addUsage(selectorUsage, ...results.map((result) => result.usage));
  return {
    content: [{ type: "text", text }],
    details,
    ...(hasBilledUsage(total) ? { usage: toPiUsage(total) } : {}),
  };
}

/** Status lines advertising resumable child session ids under a finished run. */
function resumableSessionLines(
  snapshot: { state?: RunSnapshot["state"]; results: Array<{ sessionId?: string }> },
  full: boolean,
): string[] {
  if (snapshot.state && isActiveState(snapshot.state)) return [];
  const lines: string[] = [];
  for (const result of snapshot.results) {
    if (!result.sessionId) continue;
    lines.push(full ? `  session ${result.sessionId}` : `  session ${result.sessionId.slice(0, 8)} (resumable)`);
  }
  return lines;
}

async function runPlanPreflights(
  runtime: SessionRuntime,
  tasks: PreparedTask[],
  parentCwd: string,
  scope: { controller: AbortController; assertOwner(): void },
): Promise<void> {
  await runLocalPreflights(tasks, parentCwd, {
    signal: scope.controller.signal, assertOwner: scope.assertOwner,
    checkResumeAvailability: (items) => runtime.registry.checkResumeAvailability(items, runtime.key),
    isGitRepo: (cwd, signal) => runtime.worktrees.isGitRepo(cwd, signal),
  });
}

function formatPlanEntry(task: ResolvedTask, index: number, maxRetriesDefault: number) {
  const agentNote = task.resolutionNotes.find((note) => note.startsWith("agent="));
  const agent = agentNote?.slice("agent=".length);
  return {
    index,
    label: task.label,
    agent,
    model: task.model,
    // The ranked route replaces legacy fallback semantics for this path: show
    // the bounded ranked preview and the effective extension attempt budget.
    rankedPreview: formatRankedPreview(task.routing?.rankedModels),
    rankedTotal: task.routing?.rankedModels?.length,
    maxAttempts: rankedMaxAttempts(task.maxRetries ?? maxRetriesDefault),
    thinking: task.thinking,
    profile: task.profile,
    access: task.canWrite ? "RW" : "RO" as const,
    tools: task.effectiveTools,
    routing: projectRoutingForDisplay(task.routing),
    budgets: {
      timeoutMs: task.timeoutMs,
      maxTurns: task.maxTurns,
      maxCost: task.maxCost,
      graceTurns: task.graceTurns,
    },
    isolation: task.isolation ?? "shared",
    resolutionNotes: task.resolutionNotes,
  };
}

function formatPlanText(mode: "single" | "parallel", plan: ReturnType<typeof formatPlanEntry>[]): string {
  const header = `Plan (Jev selection billed; no child spawned) — ${mode}, ${plan.length} task${plan.length === 1 ? "" : "s"}:`;
  const body = plan.map((entry) => {
    const budgets = [
      `timeout_ms=${entry.budgets.timeoutMs}`,
      entry.budgets.maxTurns !== undefined ? `max_turns=${entry.budgets.maxTurns}` : undefined,
      entry.budgets.maxCost !== undefined ? `max_cost=${entry.budgets.maxCost}` : undefined,
      entry.budgets.graceTurns !== undefined ? `grace_turns=${entry.budgets.graceTurns}` : undefined,
    ].filter(Boolean).join(" ");
    return [
      `${entry.index + 1}. ${entry.label}${entry.agent ? ` [agent:${entry.agent}]` : ""} (${entry.profile}/${entry.access})`,
      `   model=${entry.model ?? "(none)"} thinking=${entry.thinking ?? "(default)"} isolation=${entry.isolation}`,
      `   ranked_models=[${entry.rankedPreview ?? entry.model ?? "(none)"}]${entry.rankedTotal && entry.rankedTotal > 5 ? ` (total ${entry.rankedTotal})` : ""}`,
      `   attempt_budget=${entry.maxAttempts} (max_retries limits EXTRA extension-level attempts; pre-tool availability failure advances the ranking, never wraps)`,
      `   shared_tools=[${entry.tools.join(",")}]`,
      `   ${budgets}`,
      `   notes: ${entry.resolutionNotes.join(", ")}`,
    ].join("\n");
  });
  return [header, ...body].join("\n");
}

/** Re-read agent files at most every few seconds; they can change mid-session. */
function agentCatalog(runtime: SessionRuntime): Map<string, AgentDefinition> {
  const now = Date.now();
  if (now - runtime.agentsLoadedAt > 5_000) {
    runtime.agents = discoverAgents(runtime.ctx.cwd);
    runtime.agentsLoadedAt = now;
  }
  return runtime.agents;
}

function guidelines(catalog?: Map<string, AgentDefinition>): string[] {
  const agentLines = catalog?.size
    ? [
        "Named agents available via agent:'<name>' (persona prompt + defaults; explicit params still override):",
        ...describeCatalog(catalog).map((line) => `  - ${line}`),
      ]
    : [];
  return [
    ...agentLines,
    "Omit model and fallback_models on all new work. Jev selects the execution model from the user-maintained dedicated candidate list and selects individual locally permitted tools. Explicit legacy model/fallback fields are rejected.",
    "action:plan calls Jev and may incur selector fees, but starts no child. Later dispatch selects again. Jev failure stops new dispatch; existing-run management requires no routing config or key.",
    "Delegate independent, read-heavy exploration or clean-context review; keep tightly coupled work in the parent.",
    "Prefer agent:'<name>' when a named agent matches the task — its persona prompt is usually better than an improvised one. Compose fields manually only when no agent fits.",
    "Give every task a short description label (3-5 words) so runs are scannable in UIs and result indexes.",
    "Profiles: explore/review are strictly read-only (safe for fanout); general offers the full available locally permitted catalog to Jev and may write. Explicit tools are a ceiling; agent tool defaults do not narrow candidates. Single tasks default to general, parallel tasks to explore.",
    "Parallel writers need isolation:'worktree' (each gets an isolated checkout; changed work lands on a branch). After a worktree run finishes, use action:'diff' to inspect, then 'apply' to bring changes into the main checkout or 'discard' to drop them.",
    "Set budgets: at max_turns/max_cost the child is steered to wrap up and given grace turns for a final answer (grace_turns tunes this); results end as 'partial' with wrappedUp:true when the child concluded. timeout_ms includes Jev selection, setup, queue and retries; max_cost excludes unreported TypeSafe currency; timeout results report the phase.",
    "Transient child failures may retry within the same invocation: ranked Jev routes advance to the next probability-ranked candidate only for a recognized model-availability failure that settles before any tool execution, sharing one task-based tool set and the total max_retries attempt budget (0 = first attempt only; never wraps back). A tool that started, uncertain evidence, or auth/quota/context/schema failures stop without switching. No selector retries or emergency models are used. Task-quality failures never retry.",
    "context:'fork' starts a single child from a branched copy of this conversation — use it when the task depends on discussion context instead of re-explaining. Single-task only.",
    "Use async:true only when you have independent work meanwhile; then use action:'wait' with the run id (interruptible, does not cancel). action:'steer' injects mid-run guidance into a running child instead of cancel + retry.",
    "For parallel research, add synthesis:'<instruction>' to have one read-only child fold all outputs into a single brief, delivered first.",
    "Use output_schema (JSON Schema) when you need a machine-readable result: the child must end with a validated json:result block, invalid output gets one automatic repair round, and delivery is the clean JSON. Compose downstream steps from details.results[].structuredOutput.",
    "Use output_mode:'file-only' for large reports; the parent gets a pointer instead of inline text.",
    "Discover finished child session ids from action:'status' (listed as session <id8> (resumable)), then continue with resume: \"<session id>\"; fork_resume:true branches it instead.",
  ];
}

/**
 * Fan-in step for parallel runs: one read-only child folds the per-task
 * outputs into a single brief. Best effort — returns undefined on any failure
 * so the raw results still deliver.
 */
async function runSynthesis(
  runtime: SessionRuntime,
  instruction: string,
  results: TaskResult[],
  options: { runId: string; signal: AbortSignal; select(): Promise<ResolvedTask>; assertOwner(): void },
): Promise<{ result?: TaskResult; diagnostic?: string }> {
  const sections = results.map((result, index) => {
    // Typed handoff: validated structured results feed the synthesis child
    // clean JSON instead of prose tails.
    if (result.structuredOutput !== undefined) {
      const json = JSON.stringify(result.structuredOutput, null, 2).slice(0, 12_000);
      return `## Task ${index + 1}: ${result.label} [${result.state}] (validated structured result)\n\n\`\`\`json\n${json}\n\`\`\``;
    }
    const raw = result.liveText ?? result.errorMessage ?? "(no output)";
    const capped = raw.length > 12_000;
    const body = capped
      ? `${raw.slice(0, 12_000)}\n[… truncated ${raw.length - 12_000} chars; ${result.outputFile ? `full output: ${result.outputFile}` : "full output in the child session"}]`
      : raw;
    const invalid = result.structuredError ? `\n[structured output FAILED validation: ${result.structuredError}]` : "";
    const pointer = result.outputFile ? `\nFull output file: ${result.outputFile}` : "";
    return `## Task ${index + 1}: ${result.label} [${result.state}]${pointer}${invalid}\n\n${body}`;
  });
  const anyTruncated = results.some((result) => result.structuredOutput === undefined && (result.liveText ?? result.errorMessage ?? "").length > 12_000);
  const task = [
    "You are a synthesis agent. Fold the following subagent task outputs into one coherent brief.",
    `Instruction: ${instruction}`,
    "Report conflicts between tasks explicitly. Do not invent findings that no task produced.",
    anyTruncated
      ? "Some task outputs below are TRUNCATED samples — read the referenced full output files before drawing conclusions that depend on completeness, and flag any conclusion based on a truncated section."
      : "",
    "",
    ...sections,
  ].filter(Boolean).join("\n\n");
  try {
    const selected = await options.select();
    options.assertOwner();
    const run = await runTasks([{ ...selected, task, label: "synthesis" }], {
      semaphore: runtime.semaphore,
      getPiCommand: runtime.getPiCommand,
      sessionDir: runtime.config.sessionDir,
      killGraceMs: runtime.config.killGraceMs,
      locks: runtime.locks,
      runId: `${options.runId}:synthesis`,
      parentSessionKey: runtime.key,
      signal: options.signal,
      graceTurns: runtime.config.graceTurns,
      maxRetries: runtime.config.maxRetries,
      stallAfterMs: runtime.config.stallAfterMs,
      stallKillAfterMs: runtime.config.stallKillAfterMs,
    });
    const synth = run.results[0]!;
    // Even a failed paid synthesis is returned so its reported usage is never lost.
    synth.label = "synthesis";
    return { result: synth };
  } catch (error) {
    return { diagnostic: `Optional synthesis blocked: ${oneLine(error instanceof Error ? error.message : "routing or startup failed", 800)}` };
  }
}

function synthesisDiagnostic(summary?: string): string | undefined {
  return summary?.startsWith("Optional synthesis blocked:") ? summary.split("\n", 1)[0] : undefined;
}

/** Compact completion payload for notification messages (LLM + renderer facing). */
function buildCompletionDetails(runtime: SessionRuntime, runIds: string[]): CompletionDetails {
  const runs: CompletionDetailsRun[] = [];
  for (const id of runIds) {
    const found = runtime.registry.lookup(id, runtime.key);
    if (found.status !== "found" || !found.run || "controller" in found.run) continue;
    const snapshot = found.run;
    let turns = 0, tokens = 0, cost = 0;
    const pointers: string[] = [];
    const tasks: CompletionDetailsTask[] = snapshot.results.map((result, index) => {
      const taskPointers: string[] = [];
      if (result.outputFile) {
        taskPointers.push(result.outputFile);
        pointers.push(result.outputFile);
      }
      if (result.worktree?.changed) {
        taskPointers.push(`branch ${result.worktree.branch}`);
        pointers.push(`branch ${result.worktree.branch}`);
      }
      const taskPreview = oneLine(
        (result.finalOutput ?? result.errorMessage ?? "").split("\n").find((line) => line.trim()) ?? "",
        100,
      );
      turns += result.usage?.turns ?? 0;
      tokens += (result.usage?.input ?? 0) + (result.usage?.output ?? 0);
      cost += result.usage?.cost ?? 0;
      return {
        label: result.label ?? snapshot.taskPreviews[index] ?? `task-${index + 1}`,
        state: result.state,
        preview: taskPreview,
        turns: result.usage?.turns ?? 0,
        tokens: (result.usage?.input ?? 0) + (result.usage?.output ?? 0),
        cost: result.usage?.cost ?? 0,
        model: result.model,
        attempts: result.attempts,
        attemptedModels: projectAttemptsForDisplay({ attemptedModels: result.attemptedModels }).attemptedModels,
        pointers: taskPointers,
      };
    });
    const first = tasks[0];
    const runPreview = oneLine(snapshot.summary ?? first?.preview ?? "", 100);
    runs.push({
      id: snapshot.id,
      label: first?.label ?? snapshot.taskPreviews[0] ?? "task",
      state: snapshot.state,
      preview: runPreview,
      turns,
      tokens,
      cost,
      durationMs: (snapshot.endedAt ?? Date.now()) - snapshot.startedAt,
      // Preserve the old top-level fields only for single-task consumers. The
      // complete per-task model/attempt data lives in tasks[].
      model: tasks.length === 1 ? first?.model : undefined,
      attempts: tasks.length === 1 ? first?.attempts : undefined,
      attemptedModels: tasks.length === 1 ? first?.attemptedModels : undefined,
      pointers,
      tasks,
    });
  }
  return { runs };
}

/**
 * Fire-and-forget startup GC + orphan reclaim.
 * Only top-level parents may run maintenance — nested children would race each
 * other and could operate on worktrees still owned by a concurrent parent.
 */
function scheduleMaintenance(runtime: SessionRuntime): void {
  if (runtime.depth > 0) return;
  void (async () => {
    // Reconcile orphans first so "lost" is an honest fact before any resume.
    const reaped = await runtime.locks.reconcileOrphans({
      killGraceMs: runtime.config.killGraceMs,
      parentSessionKey: runtime.key,
      skipRunIds: new Set(runtime.registry.getLiveRuns(runtime.key).map((run) => run.id)),
    });
    for (const id of [...reaped.reaped, ...reaped.alreadyDead]) {
      runtime.registry.clearResumeBlock(id, runtime.key);
    }
    runtime.locks.sweep((runtime.config.lockRetentionDays ?? 7) * 24 * 60 * 60_000);

    // Lifecycle distillation: sessions whose runs are over are reduced to a
    // digest (task, outcome, usage) and the transcript is deleted. "Over" is
    // decided by references and machine-wide run records, not wall-clock age.
    const keep = new Set(runtime.registry.planSessionRetention().keep);
    const busy = new Set<string>();
    for (const record of runtime.locks.listRunRecords()) {
      if (record.state === "running") for (const id of runRecordSessionIds(record)) busy.add(id);
    }
    for (const run of runtime.registry.getLiveRuns(runtime.key)) {
      for (const id of run.childSessionIds) busy.add(id);
    }
    await sweepSessionsLifecycle(runtime.config.sessionDir, { keep, busy });
    // Machine-wide worktree GC: this session's live worktrees plus every
    // worktree recorded by a running run record (other concurrent Pi parents)
    // are shielded; all containers under the global root are swept, not just
    // this repo's, so repos the user stops visiting still get reclaimed.
    const liveWorktrees = runtime.registry.getLiveWorktreeCwds(runtime.key);
    for (const record of runtime.locks.listRunRecords()) {
      if (record.state === "running" && record.worktreeCwd) liveWorktrees.add(record.worktreeCwd);
    }
    await runtime.worktrees.sweepAll(runtime.ctx.cwd, liveWorktrees);
  })().catch(() => { /* maintenance is best effort */ });
}

export default function registerSubagent(pi: ExtensionAPI): void {
  let current: SessionRuntime | undefined;

  // Fail-closed depth parse (malformed env) walks past any plausible ceiling so we
  // skip registering the tool entirely in scrubbed/forged-depth child processes.
  // Normal nested children still register; execute-time validation + the runtime
  // config maxDepth are the real limit (file-configured caps need session_start).
  const bootDepth = parseDepth();
  if (bootDepth >= 100) return;
  // Parent set spawns:false (or a malformed PI_SUBAGENT_SPAWNS) — no tool surface
  // for further nesting. Accidental-recursion guard only; not a security boundary.
  if (parseSpawnPolicy(process.env[SPAWNS_ENV_VAR]).kind === "disabled") return;

  function ownsRouting(runtime: SessionRuntime, generation: number): boolean {
    return current === runtime && !runtime.closed && runtime.routingGeneration === generation
      && sessionKey(runtime.ctx) === runtime.key;
  }

  const MAX_PENDING_ROUTING_RECEIPTS = 1024;

  function reconcileRouting(runtime: SessionRuntime): void {
    const visible = foldRoutingReceipts(activeEntries(runtime), [], runtime.key);
    for (const [id, pending] of runtime.pendingRoutingEvents) {
      const entry = visible.get(id);
      if (entry && entry.timestamp >= pending.timestamp
        && (pending.runId === undefined || entry.runId === pending.runId)
        && (!pending.delivered || entry.delivered)
        && JSON.stringify(entry.receipt) === JSON.stringify(pending.receipt)) {
        runtime.pendingRoutingEvents.delete(id);
      }
    }
  }

  async function flushRouting(runtime: SessionRuntime): Promise<boolean> {
    const generation = runtime.routingGeneration;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!ownsRouting(runtime, generation)) return runtime.pendingRoutingEvents.size === 0;
      reconcileRouting(runtime);
      if (!runtime.pendingRoutingEvents.size) return true;
      for (const event of runtime.pendingRoutingEvents.values()) {
        try { pi.appendEntry(ROUTING_ENTRY_TYPE, event); }
        catch { /* A bounded persistence retry, never a repeated selector request. */ }
      }
      reconcileRouting(runtime);
      if (!runtime.pendingRoutingEvents.size) return true;
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 20); timer.unref?.(); });
    }
    return false;
  }

  async function requireRoutingPersistence(runtime: SessionRuntime): Promise<void> {
    if (!(await flushRouting(runtime))) fail("Routing receipts could not be durably confirmed on the current branch. No new child was started. Restore session persistence and retry; selector usage may already have been incurred.");
  }

  function recordRouting(runtime: SessionRuntime, generation: number, receipt: RoutingReceipt, runId?: string, delivered?: boolean): void {
    if (!ownsRouting(runtime, generation)) fail("Routing owner changed; stale receipts cannot be appended into another session.");
    const event = buildRoutingEvent(runtime.key, receipt, runId, delivered);
    runtime.pendingRoutingEvents.set(receipt.requestId, event);
    runtime.ledgerDirty = true;
    try { pi.appendEntry(ROUTING_ENTRY_TYPE, event); }
    catch { /* Keep the staged receipt; the bounded flush owns persistence retries. */ }
    reconcileRouting(runtime);
  }

  async function claimRoutingUsage(runtime: SessionRuntime, options: { ids?: ReadonlySet<string>; runId?: string }): Promise<UsageStats> {
    const generation = runtime.routingGeneration;
    await requireRoutingPersistence(runtime);
    if (!ownsRouting(runtime, generation)) fail("Routing delivery belongs to a previous session/branch.");
    const folded = foldRoutingReceipts(activeEntries(runtime), [...runtime.pendingRoutingEvents.values()], runtime.key);
    const selected = [...folded.values()].filter((entry) => !entry.delivered
      && (!options.ids || options.ids.has(entry.requestId)) && (!options.runId || entry.runId === options.runId));
    if (!options.runId && selected.length > MAX_ROUTING_DELIVERY_IDS) fail(`Native routing delivery exceeds ${MAX_ROUTING_DELIVERY_IDS} selector receipts. Split this plan/background request into smaller invocations; selector usage is retained in the ledger.`);
    if (!options.runId && selected.length) {
      // Plan and async-start have no run-delivery transaction. Commit the entire
      // native attachment as one event, so a throwing append cannot consume a prefix.
      const event = { schemaVersion: 1, kind: "native-delivery", sessionKey: runtime.key,
        timestamp: Date.now(), requestIds: selected.map((entry) => entry.requestId) };
      let persisted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!ownsRouting(runtime, generation)) fail("Routing delivery belongs to a previous session/branch.");
        try { pi.appendEntry(ROUTING_ENTRY_TYPE, event); persisted = true; break; }
        catch { if (attempt < 2) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 20); timer.unref?.(); }); }
      }
      if (!persisted) fail("Routing usage delivery could not be persisted; run results remain collectable and selector requests were not retried.");
      // Cover delayed getBranch visibility after a successful append. Reconciliation
      // removes these overlays once the single batch delivery event is exposed.
      for (const entry of selected) runtime.pendingRoutingEvents.set(entry.requestId,
        { ...buildRoutingEvent(runtime.key, entry.receipt, entry.runId, true), timestamp: entry.timestamp });
      runtime.ledgerDirty = true;
      reconcileRouting(runtime);
    }
    // Linked run receipts are consumed by registry.markDelivered's single event.
    // The caller performs that synchronous commit only after this await succeeds.
    return routingUsage(selected.map((entry) => entry.receipt));
  }

  function beginRouting(runtime: SessionRuntime, signal?: AbortSignal, runId?: string) {
    const generation = runtime.routingGeneration;
    const controller = new AbortController();
    const receipts = new Map<string, RoutingReceipt>();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let done!: () => void;
    const settled = new Promise<void>((resolve) => { done = resolve; });
    runtime.pendingRoutes.set(controller, settled);
    let finished = false;
    return {
      controller, generation, receipts,
      assertOwner() {
        if (!ownsRouting(runtime, generation) || runtime.routingPaused || controller.signal.aborted) {
          fail("Subagent routing cancelled or its session/branch changed; no child was started.");
        }
      },
      record(receipt: RoutingReceipt) {
        receipts.set(receipt.requestId, receipt);
        try { recordRouting(runtime, generation, receipt, runId); }
        finally {
          if (runtime.pendingRoutingEvents.size > MAX_PENDING_ROUTING_RECEIPTS) {
            controller.abort();
            fail("Routing receipt persistence backlog reached its local bound; further selector requests were cancelled.");
          }
        }
      },
      finish() {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        runtime.pendingRoutes.delete(controller);
        done();
      },
    };
  }

  async function stopPendingRouting(runtime: SessionRuntime): Promise<void> {
    runtime.routingPaused = true;
    const pending = [...runtime.pendingRoutes];
    for (const [controller] of pending) controller.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending.map(([, done]) => done)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 8_000); timer.unref?.(); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function teardown(runtime: SessionRuntime): Promise<void> {
    if (runtime.closed) return;
    await stopPendingRouting(runtime);
    await runtime.registry.shutdown(runtime.key, 8_000);
    if (!(await flushRouting(runtime))) runtime.ctx.ui.notify("Subagent routing receipts could not be persisted before shutdown; selector usage may be missing from durable history.", "error");
    runtime.routingGeneration++;
    runtime.closed = true;
    runtime.unsubscribe?.();
    runtime.unsubscribeLedger?.();
    runtime.completions?.dispose();
    runtime.footer?.dispose();
    runtime.locks.dispose();
    if (runtime.widgetTimer) clearInterval(runtime.widgetTimer);
    runtime.ctx.ui.setStatus("subagent", undefined);
    runtime.ctx.ui.setWidget("subagent", undefined);
  }

  pi.on("before_agent_start", async (event) => {
    const config = loadConfig(await readConfigFile());
    return { systemPrompt: `${event.systemPrompt}\n\n${formatJevRoutingPrompt(config.jevRouting, config.jevRoutingError)}` };
  });

  pi.on("session_start", async (_event, ctx) => {
    if (current && !current.closed) await teardown(current);
    const runtime = {} as SessionRuntime;
    runtime.key = sessionKey(ctx);
    runtime.ctx = ctx;
    runtime.config = loadConfig(await readConfigFile());
    runtime.depth = parseDepth();
    runtime.output = new OutputManager(runtime.config);
    runtime.semaphore = new Semaphore(runtime.config.maxActiveProcesses, runtime.config.maxQueuedTasks);
    runtime.worktrees = new WorktreeManager(undefined, runtime.config.worktreeDir);
    runtime.locks = new ProcessLockManager({
      rootDir: runtime.config.lockDir,
      maxGlobalActive: runtime.config.maxGlobalActive,
    });
    runtime.getPiCommand = createGetPiCommand(getLaunchResolution());
    runtime.liveRunners = new Map();
    runtime.asyncRuns = new Set();
    runtime.agents = discoverAgents(ctx.cwd);
    runtime.agentsLoadedAt = Date.now();
    runtime.pendingRootMessages = [];
    runtime.routingGeneration = 0;
    runtime.routingPaused = false;
    runtime.pendingRoutes = new Map();
    runtime.pendingRoutingEvents = new Map();
    runtime.reconcileRouting = () => reconcileRouting(runtime);
    runtime.ledgerDirty = true;
    runtime.closed = false;
    runtime.registry = new SessionScopedRunRegistry(runtime.config, {
      getEntries: () => ctx.sessionManager.getBranch() as any[],
      appendEntry: (type, data) => {
        // Captured runtime ownership prevents an old async callback from appending to a new session.
        if (current !== runtime || runtime.closed || sessionKey(ctx) !== runtime.key) return;
        pi.appendEntry(type, data);
      },
    }, runtime.locks);
    runtime.unsubscribeLedger = runtime.registry.subscribe((event) => {
      if (event.sessionKey === runtime.key) runtime.ledgerDirty = true;
    });
    // Background-run completion notifications: batched steer messages so
    // the parent LLM reacts without polling. Foreground runs deliver inline.
    // `notifications: "off"` skips construction; subscribe still uses optional chain.
    if (runtime.config.notifications !== "off") {
      runtime.completions = new CompletionBatcher((runIds) => {
        if (current !== runtime || runtime.closed) return;
        // Delivered-state is re-checked at flush time: a wait that consumed the
        // run during the batching window suppresses the redundant notification.
        const undelivered = runIds.filter((id) => {
          const found = runtime.registry.lookup(id, runtime.key);
          return found.status === "found" && !!found.run && !found.run.delivered;
        });
        const details = buildCompletionDetails(runtime, undelivered);
        if (!details.runs.length) return;
        const lines = details.runs.flatMap((run) => {
          const tasks = run.tasks?.length ? run.tasks : [{
            label: run.label,
            state: run.state,
            preview: run.preview,
            model: run.model,
            attempts: run.attempts,
            attemptedModels: run.attemptedModels,
            pointers: run.pointers,
            turns: run.turns,
            tokens: run.tokens,
            cost: run.cost,
          }];
          return tasks.map((task) => {
            const attemptText = task.attemptedModels && task.attemptedModels.length > 1
              ? `; attempts${task.attempts ? ` (${task.attempts} total)` : ""}: ${task.attemptedModels.join(" → ")}`
              : "";
            const label = tasks.length > 1 ? `${run.label}/${task.label}` : task.label;
            return `- [${run.id.slice(0, 8)}] ${label}: ${task.state}${task.model ? ` on ${task.model}` : ""}${attemptText}${task.preview ? ` — ${task.preview}` : ""}${task.pointers.length ? ` (${task.pointers.join(", ")})` : ""}`;
          });
        });
        pi.sendMessage({
          customType: COMPLETION_MESSAGE_TYPE,
          content: [
            `${details.runs.length === 1 ? "A background subagent run" : `${details.runs.length} background subagent runs`} finished:`,
            ...lines,
            `Use { action: "wait", id } to collect full output, or dismiss with status if not needed.`,
          ].join("\n"),
          display: true,
          details,
        }, { deliverAs: "steer", triggerTurn: true });
      });
    }

    runtime.unsubscribe = runtime.registry.subscribe((event) => {
      if (event.sessionKey !== runtime.key) return;
      if (event.type === "terminal" && runtime.asyncRuns.has(event.runId)) {
        runtime.asyncRuns.delete(event.runId);
        // Delivered-state is checked again at flush time (wait may consume the
        // run during the batching window).
        runtime.completions?.add(event.runId, !["completed", "partial"].includes(event.state));
      }
      if (ctx.hasUI && event.type === "terminal") {
        runtime.footer?.notifyTerminal(
          event.runId,
          `Subagent ${event.runId.slice(0, 8)} ${event.state}`,
          event.state === "completed" ? "info" : "warn",
        );
      }
      refreshFooter(runtime);
    });
    if (ctx.hasUI) {
      runtime.footer = new FooterStatusModel(makeAdapter(runtime));
      runtime.footer.setOnUpdate(() => refreshFooter(runtime));
    }
    current = runtime;
    refreshFooter(runtime);
    scheduleMaintenance(runtime);
  });

  pi.on("message_end", async (event) => {
    const runtime = current;
    if (!runtime || runtime.closed || event.message.role !== "assistant") return;
    // Supplement immediately; ledger deduplicates when SessionManager exposes it.
    runtime.pendingRootMessages.push(event.message);
    if (runtime.pendingRootMessages.length > 20) runtime.pendingRootMessages.shift();
    runtime.ledgerDirty = true;
    refreshFooter(runtime);
  });

  pi.on("session_before_tree", async () => {
    const runtime = current;
    if (!runtime || runtime.closed) return;
    // Finish persistence on the originating leaf before Pi moves the branch pointer.
    await stopPendingRouting(runtime);
    await runtime.registry.shutdown(runtime.key, 8_000);
    if (!(await flushRouting(runtime))) {
      runtime.routingPaused = false;
      runtime.ctx.ui.notify("Branch change cancelled: routing receipts are not durably confirmed. Restore session persistence before changing branches.", "error");
      return { cancel: true };
    }
    runtime.routingGeneration++;
  });

  pi.on("session_tree", async () => {
    const runtime = current;
    if (!runtime || runtime.closed) return;
    runtime.routingPaused = false;
    if (runtime.pendingRoutingEvents.size) runtime.ctx.ui.notify("Unconfirmed routing receipts remained during an unexpected branch move; they cannot be appended to the new branch. Durable selector usage may be incomplete.", "error");
    runtime.pendingRoutingEvents.clear();
    runtime.pendingRootMessages = [];
    runtime.ledgerDirty = true;
    runtime.registry.refreshSnapshots(runtime.key);
    refreshFooter(runtime);
  });

  pi.on("session_shutdown", async () => {
    const runtime = current;
    if (!runtime) return;
    // Keep ownership valid until cancellation, process close, and final persistence finish.
    await teardown(runtime);
    if (current === runtime) current = undefined;
  });

  // Themed completion box for background-run notifications; the LLM sees the
  // plain content, the human sees this.
  pi.registerMessageRenderer(COMPLETION_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as CompletionDetails | undefined;
    if (!details?.runs.length) return undefined;
    return lineComponentForMessage((width) => {
      const lines: string[] = [];
      for (const run of details.runs) {
        const tasks = run.tasks?.length ? run.tasks : [{
          label: run.label,
          state: run.state,
          preview: run.preview,
          turns: run.turns,
          tokens: run.tokens,
          cost: run.cost,
          model: run.model,
          attempts: run.attempts,
          attemptedModels: run.attemptedModels,
          pointers: run.pointers,
        }];
        tasks.forEach((task) => {
          const glyph = stateGlyph(task.state as any, theme);
          const stats = [
            task.turns ? `↻${task.turns}` : "",
            task.tokens ? `${formatTokens(task.tokens)} tok` : "",
            task.cost > 0.00005 ? `$${task.cost.toFixed(3)}` : "",
            tasks.length === 1 ? formatDuration(run.durationMs) : "",
            task.model ?? "",
          ].filter(Boolean).join(" · ");
          const label = tasks.length > 1 ? `${run.label}/${task.label}` : task.label;
          lines.push(truncateToWidth(`${glyph} ${theme.fg("dim", task.model ?? "model unknown")} · ${theme.bold(theme.fg("toolTitle", label))} ${theme.fg("dim", `[${run.id.slice(0, 8)}] ${stats}`)}`, width));
          if (task.preview) lines.push(truncateToWidth(`  ${theme.fg("dim", "⎿")} ${theme.fg("toolOutput", task.preview)}`, width));
          if (task.attemptedModels && task.attemptedModels.length > 1) {
            lines.push(truncateToWidth(`  ${theme.fg("warning", `models: ${task.attemptedModels.join(" → ")}${task.attempts && task.attempts > task.attemptedModels.length ? ` (last ${task.attemptedModels.length} of ${task.attempts})` : ""}`)}`, width));
          }
          if ((expanded || tasks.length === 1) && task.pointers.length) {
            lines.push(truncateToWidth(theme.fg("dim", `  ${task.pointers.join(" · ")}`), width));
          }
        });
      }
      lines.push(theme.fg("dim", truncateToWidth(`wait { id } collects full output`, width)));
      return lines;
    });
  });

  pi.registerCommand("subagent-cost", {
    description: "Show parent / subagent / combined usage for this branch",
    handler: async (_args, ctx) => {
      const runtime = current;
      if (!runtime || runtime.key !== sessionKey(ctx)) return ctx.ui.notify("Subagent runtime is not ready", "error");
      ctx.ui.notify(formatLedger(ledger(runtime)), "info");
    },
  });

  pi.registerCommand("subagents", {
    description: "Inspect subagent runs, artifacts, sessions, and combined usage",
    handler: async (_args, ctx) => {
      const runtime = current;
      if (!runtime || runtime.key !== sessionKey(ctx)) return ctx.ui.notify("Subagent runtime is not ready", "error");
      await ctx.ui.custom(
        (tui: TUI, theme: Theme, _keybindings, done) => createSubagentsOverlay(tui, theme, makeAdapter(runtime), () => done(undefined)),
        { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
      );
    },
  });

  const subagentTool = {
    name: "subagent",
    label: "Subagent",
    description: "Run isolated Pi subagents in foreground, parallel, or cancellable background mode.",
    // Guidelines are baked into the system prompt at registration (extension
    // load runs per-session in the project cwd). Agents added mid-session are
    // usable immediately via agent:'name' (execute-time refresh); only the
    // system-prompt advertisement waits for the next session.
    promptGuidelines: guidelines(discoverAgents(process.cwd())),
    parameters: ProviderSubagentParamsSchema,
    async execute(_id, params: SubagentParams, signal, onUpdate, ctx) {
      // `subagent_wait` delegates here with a synthesized action:"wait" params
      // object, carrying its timeout through this non-schema field so the two
      // tools share exactly one collect/deliver path.
      let waitTimeoutMs: number | undefined;
      if ("__waitTimeoutMs" in (params as object)) {
        const smuggled = params as SubagentParams & { __waitTimeoutMs?: number };
        waitTimeoutMs = smuggled.__waitTimeoutMs;
        // Strip before validation: the schema is additionalProperties:false.
        delete smuggled.__waitTimeoutMs;
      }
      const runtime = current;
      if (!runtime || runtime.closed || runtime.key !== sessionKey(ctx)) {
        fail("Subagent runtime is not initialized for this session.");
      }
      if (!Value.Check(SubagentParamsSchema, params)) {
        const errors = [...Value.Errors(SubagentParamsSchema, params)].slice(0, 5).map((error: any) => error.message).join("; ");
        fail(`Invalid parameters: ${errors}`);
      }

      const requestGeneration = runtime.routingGeneration;
      const invocationStartedAt = Date.now();
      const management = params.action !== undefined && params.action !== "plan";
      const routingScope = management ? undefined : beginRouting(runtime, signal);
      try {
      routingScope?.assertOwner();
      if (routingScope) { await requireRoutingPersistence(runtime); routingScope.assertOwner(); }
      // Management does not read a config file, credential or model/tool catalog.
      const dispatchConfig = management ? runtime.config : loadConfig(await readConfigFile());
      routingScope?.assertOwner();
      const parentTools = management ? [] : pi.getAllTools()
        .filter((tool) => tool.sourceInfo?.source !== "sdk" && !tool.sourceInfo?.path?.startsWith("<sdk:"));
      const parent: ParentContext = {
        cwd: ctx.cwd,
        thinking: management ? undefined : pi.getThinkingLevel() as TaskSpec["thinking"],
        availableTools: parentTools.map((tool) => tool.name),
        depth: runtime.depth,
        sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      };
      const preparation: PreparationOptions = {
        maxDepth: runtime.config.maxDepth,
        maxTasks: runtime.config.maxTasksPerRun,
        defaultTimeoutMs: runtime.config.defaultTimeoutMs,
        taskDefaults: dispatchConfig.taskDefaults,
        agents: management ? undefined : agentCatalog(runtime),
        jevRouting: dispatchConfig.jevRouting,
        jevRoutingError: dispatchConfig.jevRoutingError,
      };
      const validated = validateSubagentRequest(params, parent, preparation);
      if (!validated.ok) fail(validated.error);

      const details = (mode: "single" | "parallel", results: Array<TaskResult | RunSnapshot["results"][number]>, run?: RunMeta) =>
        compactDetails(mode, results, runtime.config.maxDetailsTextBytes, run);

      if (["status", "wait", "cancel", "steer", "diff", "apply", "discard"].includes(validated.mode)) {
        if (validated.mode === "status" && !validated.id) {
          const runs = [
            ...runtime.registry.getLiveRuns(runtime.key).map(snapshotFromLiveRun),
            ...runtime.registry.getSnapshots(runtime.key),
          ];
          const catalog = agentCatalog(runtime);
          const agentSection = catalog.size
            ? `Named agents (use agent:'<name>'):\n${describeCatalog(catalog).map((line) => `- ${line}`).join("\n")}`
            : "";
          const text = [
            runs.length
              ? runs.map((run) => [formatStatusPreview(run), ...resumableSessionLines(run, false)].join("\n")).join("\n")
              : "No subagent runs.",
            agentSection,
            formatLedger(ledger(runtime)),
          ].filter(Boolean).join("\n\n");
          return { content: [{ type: "text", text }], details: details("single", []) };
        }
        const found = runtime.registry.lookup(validated.id!, runtime.key);
        if (found.status === "ambiguous") fail(`Ambiguous id. Matches: ${found.matches!.join(", ")}`);
        if (found.status !== "found" || !found.run) fail(`Run ${validated.id} was not found in this session.`);
        const snapshot = "controller" in found.run ? snapshotFromLiveRun(found.run) : found.run;
        if (validated.mode === "status") {
          const text = [
            formatStatusPreview(snapshot),
            ...resumableSessionLines(snapshot, true),
            formatLedger(ledger(runtime)),
          ].filter(Boolean).join("\n");
          return { content: [{ type: "text", text }], details: details(snapshot.mode, snapshot.results, snapshot) };
        }
        if (validated.mode === "cancel") {
          if ("controller" in found.run) found.run.controller.abort();
          return { content: [{ type: "text", text: `Cancellation requested for ${snapshot.id}` }], details: details(snapshot.mode, snapshot.results, snapshot) };
        }
        if (validated.mode === "steer") {
          if (!("controller" in found.run)) fail(`Run ${snapshot.id} is not running; steer only applies to live runs. Use resume to continue a finished child.`);
          const runners = runtime.liveRunners.get(snapshot.id);
          if (!runners?.size) fail(`Run ${snapshot.id} has no steerable child yet (still queued or starting). Retry in a moment.`);
          const eligible = validated.index !== undefined
            ? runners.get(validated.index) ? [[validated.index, runners.get(validated.index)!] as const] : []
            : [...runners.entries()];
          if (!eligible.length) fail(`No live task at index ${validated.index} in run ${snapshot.id}. Live indexes: ${[...runners.keys()].join(", ")}`);
          if (validated.index === undefined && eligible.length > 1) {
            fail(`Run ${snapshot.id} has ${eligible.length} live tasks; pass index to pick one (live indexes: ${[...runners.keys()].join(", ")}).`);
          }
          const [index, runner] = eligible[0]!;
          if (!runner.steer(validated.message!)) fail(`Task ${index} in run ${snapshot.id} is no longer accepting input.`);
          return {
            content: [{ type: "text", text: `Steering message queued for run ${snapshot.id} task ${index}. It is delivered after the current assistant turn; watch status/wait for the response.` }],
            details: details(snapshot.mode, snapshot.results, snapshot),
          };
        }
        if (["diff", "apply", "discard"].includes(validated.mode)) {
          if ("controller" in found.run) fail(`Run ${snapshot.id} is still running; worktree actions apply to finished runs.`);
          const withTrees = snapshot.results
            .map((result, index) => ({ result, index }))
            .filter((entry) => entry.result.worktree?.changed);
          if (!withTrees.length) fail(`Run ${snapshot.id} has no changed worktrees.`);
          const chosen = validated.index !== undefined
            ? withTrees.find((entry) => entry.index === validated.index)
            : withTrees.length === 1 ? withTrees[0] : undefined;
          if (!chosen) {
            fail(`Run ${snapshot.id} has ${withTrees.length} changed worktrees; pass index to pick one (indexes: ${withTrees.map((entry) => entry.index).join(", ")}).`);
          }
          const tree = chosen.result.worktree!;
          // The worktree directory may already be reclaimed by lifecycle GC; its
          // unique work then lives in an archived patch. diff/apply degrade to
          // that patch; discard removes it.
          const treeGone = await fs.access(tree.cwd).then(() => false, () => true);
          const archivedPatch = runtime.worktrees.archivedPatchPathFor(tree.cwd);
          const archiveExists = treeGone && await fs.access(archivedPatch).then(() => true, () => false);
          if (treeGone && !archiveExists) {
            fail(`Worktree ${tree.cwd} is gone and no archived patch exists. Committed work may still be on branch ${tree.branch}.`);
          }
          if (validated.mode === "diff" && archiveExists) {
            const patch = await fs.readFile(archivedPatch, "utf8");
            const capped = runtime.output.capOutputForDelivery([{ ...chosen.result, finalOutput: `Worktree was reclaimed; archived patch for run ${snapshot.id} task ${chosen.index} (branch ${tree.branch}):\n\n${patch}`, outputMode: "inline" }] as any);
            return { content: [{ type: "text", text: capped.text }], details: details(snapshot.mode, snapshot.results, snapshot) };
          }
          if (validated.mode === "apply" && archiveExists) {
            const applied = await runtime.worktrees.applyArchivedPatch(archivedPatch, ctx.cwd);
            return { content: [{ type: "text", text: `Applied archived patch from run ${snapshot.id} task ${chosen.index} into ${ctx.cwd} as uncommitted working-tree changes:\n${applied.stat}\nReview and commit them. The archive ${archivedPatch} is preserved; use action:'discard' to clean up.` }], details: details(snapshot.mode, snapshot.results, snapshot) };
          }
          if (validated.mode === "discard" && archiveExists) {
            await fs.rm(archivedPatch, { force: true });
            await runtime.worktrees.forceRemove({ cwd: tree.cwd, branch: tree.branch, baseCwd: ctx.cwd, baseCommit: tree.baseCommit, changed: tree.changed });
            return { content: [{ type: "text", text: `Discarded archived patch and branch ${tree.branch} from run ${snapshot.id} task ${chosen.index}.` }], details: details(snapshot.mode, snapshot.results, snapshot) };
          }
          if (validated.mode === "diff") {
            const diff = await runtime.worktrees.diff({ cwd: tree.cwd, baseCommit: tree.baseCommit });
            const text = [
              `Worktree diff for run ${snapshot.id} task ${chosen.index} (branch ${tree.branch}):`,
              diff.stat || "(no stat)",
              "",
              diff.patch || "(no patch)",
              diff.truncated ? `\n[patch truncated; full diff: git -C ${tree.cwd} diff ${tree.baseCommit}]` : "",
            ].filter(Boolean).join("\n");
            const capped = runtime.output.capOutputForDelivery([{ ...chosen.result, finalOutput: text, outputMode: "inline" }] as any);
            return { content: [{ type: "text", text: capped.text }], details: details(snapshot.mode, snapshot.results, snapshot) };
          }
          if (validated.mode === "apply") {
            const applied = await runtime.worktrees.apply({ cwd: tree.cwd, baseCommit: tree.baseCommit }, ctx.cwd);
            const text = applied.applied
              ? `Applied worktree changes from run ${snapshot.id} task ${chosen.index} into ${ctx.cwd} as uncommitted working-tree changes:\n${applied.stat}\nReview and commit them. The worktree and branch ${tree.branch} are preserved; use action:'discard' to clean up.`
              : `Worktree for run ${snapshot.id} task ${chosen.index} had no changes to apply.`;
            return { content: [{ type: "text", text }], details: details(snapshot.mode, snapshot.results, snapshot) };
          }
          // discard
          await runtime.worktrees.forceRemove({ cwd: tree.cwd, branch: tree.branch, baseCwd: ctx.cwd, baseCommit: tree.baseCommit, changed: tree.changed });
          return { content: [{ type: "text", text: `Discarded worktree and branch ${tree.branch} from run ${snapshot.id} task ${chosen.index}.` }], details: details(snapshot.mode, snapshot.results, snapshot) };
        }
        if ("promise" in found.run) {
          // Wait must stay interruptible: aborting the wait returns promptly
          // WITHOUT cancelling the background run (that is cancel's job).
          const settled = found.run.promise.then(() => "done" as const, () => "done" as const);
          const races: Array<Promise<"done" | "aborted" | "timeout">> = [settled];
          const abortRace = abortAsPromise(signal);
          if (abortRace) races.push(abortRace as Promise<"aborted">);
          let timer: NodeJS.Timeout | undefined;
          if (waitTimeoutMs !== undefined) {
            races.push(new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => resolve("timeout"), waitTimeoutMs);
              timer.unref?.();
            }));
          }
          let raced: "done" | "aborted" | "timeout";
          try {
            raced = await Promise.race(races);
          } finally {
            if (timer) clearTimeout(timer);
          }
          if (raced === "aborted") {
            return {
              content: [{ type: "text", text: `Wait aborted. Run ${snapshot.id} continues in the background; use status/wait/cancel later or open /subagents.` }],
              details: details(snapshot.mode, snapshot.results, snapshot),
            };
          }
          if (raced === "timeout") {
            // Timing out must not consume the result: the run keeps going and
            // stays collectable, so we deliberately skip markDelivered here.
            return {
              content: [{ type: "text", text: `Wait timed out after ${waitTimeoutMs}ms. Run ${snapshot.id} is still running and was NOT cancelled; collect it with subagent_wait again (or action:'status'), or stop it with action:'cancel'.` }],
              details: details(snapshot.mode, snapshot.results, snapshot),
            };
          }
        }
        if (!ownsRouting(runtime, requestGeneration)) fail("Wait belonged to a previous session/branch; collect the run from its originating branch.");
        const refreshed = runtime.registry.lookup(snapshot.id, runtime.key);
        const terminal = refreshed.status === "found" && refreshed.run
          ? "controller" in refreshed.run ? snapshotFromLiveRun(refreshed.run) : refreshed.run
          : snapshot;
        const selectorUsage = await claimRoutingUsage(runtime, { runId: terminal.id });
        if (!ownsRouting(runtime, requestGeneration)) fail("Wait belonged to a previous session/branch.");
        if (!runtime.registry.markDelivered(terminal.id, runtime.key)) {
          return { content: [{ type: "text", text: `Run ${terminal.id} was already delivered. Artifacts and sessions remain available in /subagents.` }], details: details(terminal.mode, terminal.results, terminal) };
        }
        const delivered = runtime.output.capOutputForDelivery(terminal.results);
        const text = [synthesisDiagnostic(terminal.summary), delivered.text || terminal.summary || "(no output)"].filter(Boolean).join("\n\n");
        // Locate runs and partial/timeout deliveries still return content; hard
        // failures and “lost with resume blocked” raise so the agent notices.
        // (Thrown deliveries cannot carry native usage; the extension ledger
        // still counts them from persisted entries.)
        if (terminal.state === "failed" || terminal.state === "lost") fail(text);
        return deliveredResult(text, details(terminal.mode, delivered.cappedResults as any, terminal), terminal.results, selectorUsage);
      }

      if (!routingScope) fail("Internal routing scope is missing.");
      routingScope.assertOwner();
      const catalog: RoutingCatalog = {
        models: eligibleModelCandidates(dispatchConfig.jevRouting!, ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`)),
        tools: toToolCandidates(parentTools),
      };
      if (!catalog.models.length) fail("No configured Jev candidate is locally available. Check exact model IDs and configured provider authentication.");
      const router = new JevRouter({ config: dispatchConfig.jevRouting!, onReceipt: routingScope.record });
      const prepared = validated.tasks.map((task) => ({ ...task, deadline: invocationStartedAt + task.timeoutMs }));
      await runPlanPreflights(runtime, prepared, ctx.cwd, routingScope);
      routingScope.assertOwner();
      const resolved = await routePreparedTasks(prepared, catalog, router, {
        purpose: validated.planOnly ? "plan" : "dispatch",
        signal: routingScope.controller.signal, assertOwner: routingScope.assertOwner,
      });
      routingScope.assertOwner();
      const prepareSynthesis = () => {
        const normalized = validateSubagentRequest({
          task: `Synthesize completed worker outputs into one read-only brief. Instruction: ${validated.synthesis}`,
          description: "synthesis", profile: "review", max_turns: 8,
          timeout_ms: Math.min(runtime.config.defaultTimeoutMs, 5 * 60_000),
        }, parent, preparation);
        if (!normalized.ok) fail(normalized.error);
        return normalized.tasks.map((task) => ({ ...task, deadline: Date.now() + task.timeoutMs }));
      };
      if (validated.planOnly) {
        let synthesis: { state: "resolved"; plan: ReturnType<typeof formatPlanEntry> } | { state: "blocked"; error: string } | undefined;
        if (validated.synthesis && prepared.length > 1) {
          try {
            const synthetic = prepareSynthesis();
            await runPlanPreflights(runtime, synthetic, ctx.cwd, routingScope);
            const planned = await routePreparedTasks(synthetic, catalog, router, {
              purpose: "plan", signal: routingScope.controller.signal, assertOwner: routingScope.assertOwner,
            });
            synthesis = { state: "resolved", plan: formatPlanEntry(planned[0]!, 0, runtime.config.maxRetries) };
          } catch (error) {
            routingScope.assertOwner();
            synthesis = { state: "blocked", error: error instanceof Error ? error.message : "Optional synthesis routing failed." };
          }
        }
        routingScope.assertOwner();
        await requireRoutingPersistence(runtime);
        routingScope.assertOwner();
        const plan = resolved.map((task, index) => formatPlanEntry(task, index, runtime.config.maxRetries));
        const mode = validated.mode as "single" | "parallel";
        const receipts = [...routingScope.receipts.values()];
        const selectorUsage = await claimRoutingUsage(runtime, { ids: new Set(receipts.map((receipt) => receipt.requestId)) });
        const text = [formatPlanText(mode, plan), synthesis ? `Optional synthesis: ${synthesis.state}${synthesis.state === "blocked" ? ` — ${synthesis.error}` : ` (${synthesis.plan.model})`}` : "", "Selector tokens are reported separately; TypeSafe currency is unreported. A later dispatch selects again."].filter(Boolean).join("\n");
        return deliveredResult(text, { mode, plan, synthesis, routingReceipts: receipts, routingCurrency: "unreported" }, [], selectorUsage);
      }

      const specs: TaskSpec[] = resolved.map(({ effectiveTools, resolutionNotes: _notes, ...task }) => ({
        ...task, tools: effectiveTools, fallbackModels: [],
      }));
      await requireRoutingPersistence(runtime);
      routingScope.assertOwner();
      if (validated.async && routingScope.receipts.size > MAX_ROUTING_DELIVERY_IDS) fail(`Background routing exceeds ${MAX_ROUTING_DELIVERY_IDS} selector receipts. No child was started; split this request into smaller invocations. Selector usage is retained in the ledger.`);
      const executionGeneration = routingScope.generation;
      const runId = runtime.registry.allocateRunId();
      const workerReceiptIds = new Set(routingScope.receipts.keys());
      for (const receipt of routingScope.receipts.values()) recordRouting(runtime, executionGeneration, receipt, runId);
      await requireRoutingPersistence(runtime);
      routingScope.assertOwner();
      const directResumes = resolved.filter((task) => task.resume && !task.forkResume).map((task) => task.resume!);
      const lock = runtime.registry.acquireResumeLocks(directResumes, runId, runtime.key);
      if (!lock.ok) fail(`Child session ${lock.conflict!.sessionId} is already active in run ${lock.conflict!.runId}. Use fork_resume:true for an independent continuation.`);

      const controller = new AbortController();
      const parentAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", parentAbort, { once: true });
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      try {
        runtime.registry.start(runtime.key, validated.mode as "single" | "parallel", specs, controller, done, resolved.map((task) => task.label), runId);
      } catch (error) {
        signal?.removeEventListener("abort", parentAbort);
        for (const session of directResumes) runtime.registry.releaseResumeLock(session, runtime.key, runId);
        throw error;
      }

      routingScope.finish(); // Ownership transfers to the registered run/controller.

      // Throttle streamed tool updates with a trailing-edge flush: structural
      // changes (state transition, new session id, billed turn) emit
      // immediately; live-text ticks coalesce into at most one deferred emit
      // per window, so the final state of a burst always renders. Runner
      // checkpoints spread the full result, so "structural" is detected by
      // diffing against the last seen values per task index.
      let lastStreamedUpdate = 0;
      let pendingFlush: NodeJS.Timeout | undefined;
      const lastSeen = new Map<number, { state?: string; sessionId?: string; turns: number }>();
      const emitUpdate = () => {
        if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = undefined; }
        lastStreamedUpdate = Date.now();
        const live = runtime.registry.lookup(runId, runtime.key);
        if (live.status !== "found" || !live.run) return;
        const snap = "controller" in live.run ? snapshotFromLiveRun(live.run) : live.run;
        // content stays compact and stable (LLM-facing); details carries the
        // frequently-updated render data (state, usage, live-text tail).
        onUpdate?.({ content: [{ type: "text", text: formatStatusPreview(snap) }], details: details(snap.mode, snap.results, snap) });
      };
      const streamUpdate = (index: number, partial: Partial<TaskResult>) => {
        const seen = lastSeen.get(index) ?? { turns: 0 };
        const structural =
          (partial.state !== undefined && partial.state !== seen.state) ||
          (partial.sessionId !== undefined && partial.sessionId !== seen.sessionId) ||
          (partial.usage !== undefined && partial.usage.turns > seen.turns);
        lastSeen.set(index, {
          state: partial.state ?? seen.state,
          sessionId: partial.sessionId ?? seen.sessionId,
          turns: Math.max(seen.turns, partial.usage?.turns ?? 0),
        });
        const now = Date.now();
        if (structural || now - lastStreamedUpdate >= 250) {
          emitUpdate();
          return;
        }
        if (!pendingFlush) {
          pendingFlush = setTimeout(emitUpdate, 250 - (now - lastStreamedUpdate));
          pendingFlush.unref?.();
        }
      };

      const work = (async () => {
        try {
          const result = await runTasks(specs, {
            semaphore: runtime.semaphore,
            getPiCommand: runtime.getPiCommand,
            sessionDir: runtime.config.sessionDir,
            worktrees: runtime.worktrees,
            killGraceMs: runtime.config.killGraceMs,
            locks: runtime.locks,
            runId,
            parentSessionKey: runtime.key,
            signal: controller.signal,
            graceTurns: runtime.config.graceTurns,
            stallAfterMs: runtime.config.stallAfterMs,
            stallKillAfterMs: runtime.config.stallKillAfterMs,
            maxRetries: runtime.config.maxRetries,
            onRunnerCreated: (index, runner) => {
              let runners = runtime.liveRunners.get(runId);
              if (!runners) runtime.liveRunners.set(runId, (runners = new Map()));
              runners.set(index, runner);
            },
            onTaskProgress: (index, partial) => {
              if (!ownsRouting(runtime, executionGeneration)) return;
              // Keep the durable run record's childSessionId in sync the first
              // time we learn it (also used by orphan reclaim).
              if (partial.sessionId && partial.process) {
                const taskRunId = specs.length > 1 ? `${runId}:${index}` : runId;
                runtime.locks.writeRunRecord({
                  runId: taskRunId,
                  parentSessionKey: runtime.key,
                  childSessionId: partial.sessionId,
                  // Read-then-write is safe: all writes for one taskRunId come
                  // from this parent's single-threaded event loop.
                  worktreeCwd: partial.worktree?.cwd ?? runtime.locks.readRunRecord(taskRunId)?.worktreeCwd,
                  process: {
                    pid: partial.process.pid,
                    startTime: partial.process.startTime,
                    pgid: partial.process.pgid,
                    hostname: partial.process.hostname ?? "unknown",
                  },
                  startedAt: Date.now(),
                  state: "running",
                  updatedAt: Date.now(),
                });
              }
              runtime.registry.checkpoint(runId, runtime.key, {
                resultIndex: index,
                resultUpdate: partial,
                childSessionId: partial.sessionId,
                progress: partial.liveText?.slice(0, 200),
                turn: partial.usage?.turns,
                state: partial.state,
              });
              streamUpdate(index, partial);
            },
          });
          // Optional fan-in: one read-only child folds parallel outputs into a
          // single brief, delivered first. Failures degrade to raw results.
          if (validated.synthesis && result.results.length > 1 && !controller.signal.aborted) {
            const synthesized = await runSynthesis(runtime, validated.synthesis, result.results, {
              runId, signal: controller.signal,
              assertOwner() {
                if (!ownsRouting(runtime, executionGeneration) || runtime.routingPaused || controller.signal.aborted) fail("Synthesis cancelled or its session changed.");
              },
              async select() {
                const scope = beginRouting(runtime, controller.signal, runId);
                try {
                  scope.assertOwner();
                  const preparedSynthesis = prepareSynthesis();
                  await runPlanPreflights(runtime, preparedSynthesis, ctx.cwd, scope);
                  scope.assertOwner();
                  const selected = await routePreparedTasks(preparedSynthesis, catalog,
                    new JevRouter({ config: dispatchConfig.jevRouting!, onReceipt: scope.record }),
                    { purpose: "synthesis", signal: scope.controller.signal, assertOwner: scope.assertOwner });
                  await requireRoutingPersistence(runtime);
                  scope.assertOwner();
                  return selected[0]!;
                } finally { scope.finish(); }
              },
            });
            if (synthesized.result) result.results = [synthesized.result, ...result.results];
            if (synthesized.diagnostic) result.summary = `${synthesized.diagnostic}\n\n${result.summary}`;
          }
          if (ownsRouting(runtime, executionGeneration)) runtime.registry.complete(runId, runtime.key, result.state, result.summary, result.results);
          return result;
        } catch (error: unknown) {
          controller.abort();
          const message = error instanceof Error ? error.message : String(error);
          const live = runtime.registry.getLiveRuns(runtime.key).find((run) => run.id === runId);
          // Preserve every routed task and any usage already checkpointed. Never collapse
          // a failed fanout to a synthetic, unbilled task-1 result.
          const results = specs.map<TaskResult>((spec, index) => {
            const previous = live?.results[index];
            return {
              ...previous,
              index, label: spec.label || `task-${index + 1}`, task: spec.task,
              model: previous?.model ?? spec.model, routing: spec.routing,
              thinking: spec.thinking, profile: spec.profile, backend: spec.backend ?? "pi",
              canWrite: spec.canWrite, outputFile: previous?.outputFile ?? spec.output, outputMode: spec.outputMode,
              state: previous && !isActiveState(previous.state) ? previous.state : "failed",
              exitCode: previous && !isActiveState(previous.state) ? previous.exitCode : 1,
              messages: previous?.messages ?? [], stderr: previous?.stderr ?? "",
              usage: previous?.usage ?? emptyUsage(), stopReason: previous?.stopReason ?? "error",
              errorMessage: [previous?.errorMessage, message].filter(Boolean).join("; "),
              protocol: previous?.protocol ?? { headerSeen: false, assistantEndSeen: false, agentEndSeen: false, agentSettledSeen: false, validEvents: 0, parseErrors: 0 },
            };
          });
          const state = results.some((result) => result.state === "completed" || result.state === "partial") ? "partial" as const : "failed" as const;
          if (ownsRouting(runtime, executionGeneration)) runtime.registry.complete(runId, runtime.key, state, message, results);
          return { mode: validated.mode as "single" | "parallel", results, state, summary: message };
        } finally {
          if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = undefined; }
          runtime.liveRunners.delete(runId);
          signal?.removeEventListener("abort", parentAbort);
          for (const session of directResumes) runtime.registry.releaseResumeLock(session, runtime.key, runId);
          resolveDone();
        }
      })();

      if (validated.async) {
        runtime.asyncRuns.add(runId);
        const selectorUsage = await claimRoutingUsage(runtime, { ids: workerReceiptIds });
        return deliveredResult(`Started run ${runId}. You will be notified on completion; use status/wait/cancel with this full id, or open /subagents. Selector currency is unreported.`,
          { ...details(validated.mode as "single" | "parallel", []), routingReceipts: [...routingScope.receipts.values()], routingCurrency: "unreported" }, [], selectorUsage);
      }
      const result = await work;
      if (!ownsRouting(runtime, executionGeneration)) fail("Subagent execution belonged to a previous session/branch; its final state remains on the originating branch.");
      // First delivery wins the native usage attachment: a rare concurrent
      // wait/dismiss that already consumed this run must not double-bill.
      const selectorUsage = await claimRoutingUsage(runtime, { runId });
      if (!ownsRouting(runtime, executionGeneration)) fail("Delivery belonged to a previous session/branch.");
      const firstDelivery = runtime.registry.markDelivered(runId, runtime.key);
      const delivered = runtime.output.capOutputForDelivery(result.results);
      const text = [synthesisDiagnostic(result.summary), delivered.text || result.summary].filter(Boolean).join("\n\n");
      const finished = runtime.registry.lookup(runId, runtime.key);
      const meta: RunMeta | undefined = finished.status === "found" && finished.run && !("controller" in finished.run)
        ? finished.run
        : { state: result.state };
      // timeout is reportable content (with timeoutPhase for retry policy), not a hard throw.
      if (result.state === "failed") fail(text);
      const resultDetails = details(result.mode, delivered.cappedResults as any, meta);
      return firstDelivery
        ? deliveredResult(text, resultDetails, result.results, selectorUsage)
        : { content: [{ type: "text", text }], details: resultDetails };
      } finally {
        routingScope?.finish();
      }
    },
    renderCall(args, theme, context) {
      // Stable component identity: reuse the previous block and swap content.
      const block = (context.lastComponent instanceof LineBlock ? context.lastComponent : new LineBlock()) as LineBlock;
      block.set((width) => [renderCallLine(args, theme, width)]);
      return block;
    },
    renderResult(result, options: ToolRenderResultOptions, theme, context) {
      const block = (context.lastComponent instanceof LineBlock ? context.lastComponent : new LineBlock()) as LineBlock;
      const detailsValue = result.details as ReturnType<typeof compactDetails> | undefined;
      if (!detailsValue?.results?.length) {
        const text = result.content.find((item) => item.type === "text")?.text ?? "(no output)";
        block.set((width) => String(text).split("\n").map((line) => truncateToWidth(theme.fg("toolOutput", line), width)));
        return block;
      }
      const run: InlineRunView = {
        mode: detailsValue.mode,
        state: detailsValue.state,
        startedAt: detailsValue.startedAt,
        endedAt: detailsValue.endedAt,
        results: detailsValue.results.map((task: any) => ({
          label: task.label,
          state: task.state,
          usage: task.usage,
          model: task.model,
          routing: task.routing,
          stopReason: task.stopReason,
          timeoutPhase: task.timeoutPhase,
          errorMessage: task.errorMessage,
          finalOutput: task.finalOutput,
          outputFile: task.outputFile,
          sessionId: task.sessionId,
          worktree: task.worktree,
          wrappedUp: task.wrappedUp,
          stalledSince: task.stalledSince,
          attempts: task.attempts,
          attemptedModels: task.attemptedModels,
          toolActivity: task.toolActivity,
          modelAttempts: task.modelAttempts,
          structuredOutput: task.structuredOutput,
          structuredError: task.structuredError,
        })),
      };
      const active = options.isPartial && (isActiveState(detailsValue.state) || run.results.some((task) => isActiveState(task.state)) || detailsValue.state === undefined);
      block.set((width) => {
        const lines = renderRunLines(run, {
          theme,
          width,
          expanded: options.expanded,
          isPartial: active,
          spinnerFrame: liveSpinnerFrame(),
        });
        if (!options.expanded && !active && run.results.some((task) => task.finalOutput || task.errorMessage)) {
          // keyHint output is already themed; only add color to the raw fallback.
          const hint = expandHint();
          lines.push(truncateToWidth(hint.includes("\u001b[") ? hint : theme.fg("dim", hint), width));
        }
        return lines;
      });
      return block;
    },
  } satisfies Parameters<typeof pi.registerTool>[0];

  pi.registerTool(subagentTool);

  // `/btw` — user-originated side question. The run is a normal subagent run
  // (full policy/budget/lock machinery) but its result is delivered to the
  // TUI via appendEntry, which by design does NOT participate in LLM context.
  // So the parent agent keeps working, unaware, while the user gets an answer.
  // `/btw` results are custom entries: rendered for the human, invisible to the
  // model. Keep it compact; expand shows the full answer.
  pi.registerEntryRenderer(BTW_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data as BtwEntry | undefined;
    if (!data) return undefined;
    return lineComponentForMessage((width) => {
      const glyph = data.state === "done" ? theme.fg("success", "✓")
        : data.state === "failed" ? theme.fg("error", "✗")
        : theme.fg("dim", "…");
      const lines = [truncateToWidth(`${glyph} ${theme.bold(theme.fg("toolTitle", "by the way"))} ${theme.fg("dim", data.label)}`, width)];
      const body = data.answer;
      if (body) {
        const rendered = expanded ? body.split("\n") : [body.split("\n").find((line) => line.trim()) ?? ""];
        for (const line of rendered) lines.push(truncateToWidth(`  ${theme.fg("toolOutput", line)}`, width));
        if (!expanded && body.split("\n").length > 1) {
          lines.push(truncateToWidth(theme.fg("dim", "  (expand for full answer)"), width));
        }
      }
      return lines;
    });
  });

  pi.registerCommand("btw", {
    description: "Ask a one-off side question in a subagent, hidden from the main agent's context",
    handler: async (args, ctx) => {
      const runtime = current;
      if (!runtime || runtime.closed || runtime.key !== sessionKey(ctx)) {
        return ctx.ui.notify("Subagent runtime is not ready", "error");
      }
      let question = (args ?? "").trim();
      if (!question) {
        // The interactive prompt needs dialog-capable UI (TUI/RPC). In print
        // mode there is nothing to prompt with, so require an inline question
        // rather than silently doing nothing.
        if (!ctx.hasUI) {
          return ctx.ui.notify("/btw needs a question: /btw <your question>", "error");
        }
        question = (await ctx.ui.input("by the way", "Ask a one-off side question…"))?.trim() ?? "";
        if (!question) return;
      }

      const label = btwLabel(question);
      pi.appendEntry(BTW_ENTRY_TYPE, { state: "running", question, label } satisfies BtwEntry);
      ctx.ui.notify(`by the way: ${label} — running in the background`, "info");

      try {
        // Reuse the tool's own execute so /btw inherits validation, profiles,
        // budgets, semaphore + process locks, and output capping unchanged.
        const result = await subagentTool.execute(
          `btw-${Date.now()}`,
          {
            task: question,
            profile: "explore",
            description: label,
          } as SubagentParams,
          undefined,
          undefined,
          ctx as never,
        );
        // The tool signals failure by throwing (fail()), so reaching here is success.
        const text = result.content.find((item) => item.type === "text")?.text ?? "(no output)";
        pi.appendEntry(BTW_ENTRY_TYPE, { state: "done", question, label, answer: String(text) } satisfies BtwEntry);
        ctx.ui.notify(`by the way: ${label} — answered`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pi.appendEntry(BTW_ENTRY_TYPE, { state: "failed", question, label, answer: message } satisfies BtwEntry);
        ctx.ui.notify(`by the way failed: ${message}`, "error");
      }
    },
  });


  // Dedicated blocking-collect tool. Thin front-end: it rewrites its args into
  // the equivalent `action:"wait"` request and reuses the main tool's execute,
  // so delivery/markDelivered/cap semantics cannot drift between the two.
  pi.registerTool({
    name: "subagent_wait",
    label: "Subagent wait",
    description:
      "Block until a background subagent run (async:true) settles, then deliver its output. Equivalent to subagent { action: 'wait', id }. Aborting or timing out leaves the run alive and collectable; use subagent { action: 'cancel' } to stop it.",
    parameters: ProviderSubagentWaitParamsSchema,
    async execute(id, params: SubagentWaitParams, signal, onUpdate, ctx) {
      return subagentTool.execute(
        id,
        {
          action: "wait",
          id: params.id,
          ...(params.timeout_ms !== undefined ? { __waitTimeoutMs: params.timeout_ms } : {}),
        } as SubagentParams,
        signal,
        onUpdate as never,
        ctx,
      );
    },
    renderCall: subagentTool.renderCall as never,
    renderResult: subagentTool.renderResult as never,
  });
}
