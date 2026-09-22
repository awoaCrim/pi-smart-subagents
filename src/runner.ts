import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ChildProcessIdentity,
  TaskResult,
  TaskSpec,
  TimeoutPhase,
  UsageStats,
} from "./types.js";
import { emptyUsage } from "./types.js";
import { addUsage } from "./usage.js";
import { ProtocolParser, type ProtocolUpdate } from "./protocol.js";
import { Semaphore } from "./semaphore.js";
import { defaultConfig } from "./config.js";
import { DEPTH_ENV_VAR, SPAWNS_ENV_VAR, parseDepth } from "./policy.js";
import {
  processStartTime,
  type ProcessLockManager,
  type SlotToken,
} from "./process-lock.js";
import { createGetPiCommand } from "./launch.js";
import {
  checkAgainstSchema,
  extractStructuredResult,
  repairMessage,
} from "./structured.js";
import type { BackendAdapter, BackendParser } from "./backend.js";
import { resolveBackend } from "./backends/index.js";
import {
  PREFLIGHT_FAILURE_STOP_REASON,
  PREFLIGHT_MANIFEST_ENV,
  STARTUP_FAILURE_RESULT_PREFIX,
  ownExtensionEntryCandidates,
  ownPreflightExtensionPath,
  parsePreflightAckContent,
  parsePreflightManifest,
  preflightCommandBase,
  readStartupFailure,
  resolvePreflightCommand,
  startupFailure,
  startupTimeoutDetail,
  summarizeCommandResolution,
  summarizePreflightProblems,
  verifyPreflightAck,
  type PreflightExpectation,
} from "./startup-check.js";

export type GetPiCommand = (args: string[]) => {
  command: string;
  args: string[];
};

export interface RunnerOptions {
  semaphore?: Semaphore;
  getPiCommand?: GetPiCommand;
  sessionDir?: string;
  onCheckpoint?: (result: Partial<TaskResult>) => void;
  killGraceMs?: number;
  /**
   * Optional durable coordinator for global slots + run process records.
   *
   * **Library consumers:** without `locks` + `runId`, no durable run record is
   * written and the child is invisible to orphan reclaim on parent restart.
   * There is intentionally **no** implicit default lock manager (opt in when
   * you need durability; magic global state is worse).
   */
  locks?: ProcessLockManager;
  /** Run id for durable identity (orphan reconcile). Required with `locks` for reclaim. */
  runId?: string;
  /** Parent session key for durable identity. */
  parentSessionKey?: string;
  /** Max task stdin bytes (Guard against runaway prompt buffering). */
  maxTaskBytes?: number;
  /** Wrap-up grace turns after a budget breach (spec.graceTurns overrides). */
  graceTurns?: number;
  /** Protocol-silence window before flagging a running child as stalled. 0 disables. */
  stallAfterMs?: number;
  /** Additional silence after the stall flag before the child is killed. 0 disables kill. */
  stallKillAfterMs?: number;
  /**
   * Bounded startup-verification budget for routed tasks (model/tool handshake before
   * the real prompt). Defaults to 30s and is always clamped by the remaining task time.
   */
  startupTimeoutMs?: number;
  /** Backend adapter override (defaults to the spec's backend, then pi). */
  backend?: BackendAdapter;
  /**
   * Usage already billed by prior ranked attempts of the same task. Affects
   * in-attempt budget COMPARISONS only (so `max_cost`/`max_turns` never reset
   * per model); the runner still reports only this attempt's own usage. The
   * orchestrator alone produces the cumulative figure for checkpoints/results.
   */
  priorUsage?: UsageStats;
  /** Internal ranked-task ownership: orchestrator terminalizes after all attempts/cleanup. */
  deferRunTerminal?: boolean;
}

type StopReason =
  "cancelled" | "timeout" | "max_turns" | "max_cost" | "fatal" | "stalled";

/** Budget stops preserve completed work: they end as "partial", not "failed". */
const BUDGET_STOPS = new Set<StopReason>(["max_turns", "max_cost"]);

const DEFAULT_MAX_TASK_BYTES = 512 * 1024;

/** Startup handshake budget; a routed child that cannot confirm model+tools fails fast. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/** Poll interval while waiting for the private preflight command to load. */
const STARTUP_COMMAND_POLL_MS = 200;

/** Bound on get_commands polls so an unhealthy child cannot flood its stdin. */
const MAX_STARTUP_COMMAND_POLLS = 250;

const WRAP_UP_MESSAGE =
  "You have reached your budget for this task. Stop all tool use and provide your final answer NOW, " +
  "summarizing what you completed, what remains, and any key findings. This is your last chance to respond.";

/** Bounded timer that never keeps the parent process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

/** Order-insensitive equality for the finalized/expected tool name sets. */
function sameNameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const observed = new Set(left);
  if (observed.size !== left.length) return false;
  return right.every((name) => observed.has(name));
}

/**
 * Convert a run result into a non-transient startup-capability failure.
 *
 * Uses `PREFLIGHT_FAILURE_STOP_REASON` (never in the transient-retry classification) so a
 * routed child that could not be verified is refused rather than retried into an
 * unverified launch.
 */
function markStartupFailure(result: TaskResult, code: string, detail: string): TaskResult {
  result.state = "failed";
  result.stopReason = PREFLIGHT_FAILURE_STOP_REASON;
  result.errorMessage = `${STARTUP_FAILURE_RESULT_PREFIX} (${code}): ${detail}`;
  result.exitCode ??= 1;
  result.endedAt = Date.now();
  return result;
}

/** Owns exactly one child Pi process and its process tree. */
export class ChildRunner {
  /** Live stdin command channel; set while the child process is running. */
  private sendCommand?: (command: unknown) => boolean;
  private readonly graceTurns: number;
  private readonly stallAfterMs: number;
  private readonly stallKillAfterMs: number;
  private readonly startupTimeoutMs: number;
  private readonly backendOverride?: BackendAdapter;
  /** Prior-attempt usage included in budget comparisons (never in returned usage). */
  private readonly budgetOffset?: UsageStats;
  private readonly deferRunTerminal: boolean;
  /** Backend for the in-flight run; set at spawn so steer() uses the right dialect. */
  private backend: BackendAdapter = resolveBackend("pi");

  constructor(
    private readonly semaphore = new Semaphore(
      defaultConfig.maxActiveProcesses,
      defaultConfig.maxQueuedTasks,
    ),
    private readonly getPiCommand: GetPiCommand = createGetPiCommand(),
    private readonly sessionDir = defaultConfig.sessionDir,
    private readonly onCheckpoint?: (result: Partial<TaskResult>) => void,
    private readonly killGraceMs = defaultConfig.killGraceMs,
    private readonly locks?: ProcessLockManager,
    private readonly runId?: string,
    private readonly parentSessionKey?: string,
    private readonly maxTaskBytes = DEFAULT_MAX_TASK_BYTES,
    options: Pick<
      RunnerOptions,
      "graceTurns" | "stallAfterMs" | "stallKillAfterMs" | "startupTimeoutMs" | "backend" | "priorUsage" | "deferRunTerminal"
    > = {},
  ) {
    this.backendOverride = options.backend;
    this.budgetOffset = options.priorUsage;
    this.deferRunTerminal = options.deferRunTerminal === true;
    this.graceTurns = options.graceTurns ?? defaultConfig.graceTurns;
    this.stallAfterMs = options.stallAfterMs ?? defaultConfig.stallAfterMs;
    this.stallKillAfterMs =
      options.stallKillAfterMs ?? defaultConfig.stallKillAfterMs;
    this.startupTimeoutMs = Math.max(
      0,
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
  }

  /**
   * Queue a steering message into the running child (delivered after the
   * current assistant turn, before the next LLM call). Returns false when the
   * child is not running or its stdin is closed.
   */
  steer(message: string): boolean {
    const command = this.backend.steerCommand?.(message);
    if (command === undefined) return false;
    return this.sendCommand?.(command) === true;
  }

  async run(spec: TaskSpec, abortSignal?: AbortSignal): Promise<TaskResult> {
    const startedAt = Date.now();
    const result: TaskResult = {
      label: spec.label ?? "subagent",
      task: spec.task,
      model: spec.model,
      routing: spec.routing,
      state: "queued",
      exitCode: null,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      outputFile: spec.output,
      outputMode: spec.outputMode,
      thinking: spec.thinking,
      profile: spec.profile,
      backend: spec.backend ?? "pi",
      canWrite: spec.canWrite,
      startedAt,
      protocol: {
        headerSeen: false,
        assistantEndSeen: false,
        agentEndSeen: false,
        agentSettledSeen: false,
        validEvents: 0,
        parseErrors: 0,
      },
    };

    let processHandle: ChildProcess | undefined;
    const failedBeforeSpawn = (error: unknown): boolean => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return !processHandle?.pid && (code === "ENOENT" || code === "EPERM" || code === "EACCES");
    };
    let slotHeld = false;
    let globalSlot: SlotToken | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const tempDirs: string[] = [];
    let requestedStop: StopReason | undefined;
    let fatalError: string | undefined;
    let timeoutPhase: TimeoutPhase | undefined;
    let abortHandler: (() => void) | undefined;
    let stderr = "";
    // Backend resolution happens before anything else so parser dialect,
    // capability checks and stdin command shapes all agree.
    const backend =
      this.backendOverride ?? resolveBackend(spec.backend ?? "pi");
    this.backend = backend;
    const parser: BackendParser = backend.createParser();
    let spawned = false;
    let acquiredAt: number | undefined;
    let childStartTime = 0;
    // Graceful budget stop state: after a breach the child is steered to wrap
    // up and allowed `graceTurns` more turns before SIGTERM.
    let pendingBudgetStop:
      { reason: "max_turns" | "max_cost"; deadlineTurns: number } | undefined;
    let wrappedUp = false;
    // Structured-output repair state: one steer-based retry after failed validation.
    let schemaRepairAttempted = false;
    // Stall watchdog state.
    let lastEventAt = Date.now();
    let stallTimer: NodeJS.Timeout | undefined;
    let stalledAt: number | undefined;

    // ---- Routed-task startup verification state --------------------------------
    // `spec.routing` is added by the extension only for Jev-routed dispatches; the
    // trusted low-level SDK never sets it, so unrouted runs keep the old lifecycle.
    const routed = spec.routing !== undefined;
    // Ranked extension runs carry a locally finalized probability plan. They get
    // the stricter structured-output contract (no repair prompt and no final
    // structuredOutput publication after a terminal provider error/abort or a
    // failed/cancelled/timed-out settle). Trusted unranked SDK semantics stay
    // exactly as before.
    const ranked = routed && Array.isArray(spec.modelAttemptPlan) && spec.modelAttemptPlan.length > 0;
    let taskPromptSent = false;
    const absoluteDeadline =
      typeof spec.deadline === "number" && Number.isFinite(spec.deadline) ? spec.deadline : undefined;
    const deadlineRemainingMs =
      absoluteDeadline === undefined
        ? undefined
        : Math.max(0, absoluteDeadline - Date.now());
    // The absolute task deadline is honored from the first line of the run and is never
    // reset by a retry, restart or a later phase.
    const effectiveTimeoutMs =
      deadlineRemainingMs === undefined
        ? spec.timeoutMs
        : Math.min(spec.timeoutMs, deadlineRemainingMs);
    type StartupWaiter = {
      test: (update: ProtocolUpdate) => boolean;
      resolve: (update: ProtocolUpdate | null) => void;
    };
    const startupWaiters = new Set<StartupWaiter>();
    const settleStartupWaiters = () => {
      for (const waiter of [...startupWaiters]) {
        startupWaiters.delete(waiter);
        waiter.resolve(null);
      }
    };
    const waitForUpdate = (
      test: StartupWaiter["test"],
    ): Promise<ProtocolUpdate | null> =>
      new Promise((resolve) => {
        startupWaiters.add({ test, resolve });
      });
    let startupTimer: NodeJS.Timeout | undefined;
    let startupTimedOut = false;
    let startupBudgetMs = 0;
    let childExited:
      { code: number | null; signal: NodeJS.Signals | null; error?: Error } | undefined;

    // Internal signal combines the caller's abort with the run timeout so both
    // interrupt semaphore queue waits. Queue time counts against timeoutMs.
    const internal = new AbortController();
    const onExternalAbort = () => internal.abort();
    const onInternalAbort = () => settleStartupWaiters();
    internal.signal.addEventListener("abort", onInternalAbort, { once: true });
    if (abortSignal?.aborted) internal.abort();
    else
      abortSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = setTimeout(() => {
      // Record which phase timed out before nightfall.
      timeoutPhase = !slotHeld ? "queued" : !spawned || (routed && !taskPromptSent) ? "starting" : "running";
      requestStop("timeout");
      internal.abort();
    }, effectiveTimeoutMs);
    timeout.unref?.();

    const release = () => {
      if (slotHeld) {
        slotHeld = false;
        this.semaphore.release();
      }
      if (globalSlot) {
        this.locks?.releaseGlobalSlot(globalSlot);
        globalSlot = undefined;
      }
    };

    /**
     * Group-kill only when the PID still belongs to our child (start-time
     * identity check guards against PID reuse racing a delayed kill). When
     * identity is unverifiable, fall back to the direct child handle, which
     * Node ties to the real process regardless of PID recycling.
     */
    const pidStillOurs = (pid: number): boolean => {
      if (childStartTime <= 0) return false;
      const live = processStartTime(pid);
      return live > 0 && live === childStartTime;
    };

    const forceKillTree = () => {
      const pid = processHandle?.pid;
      if (!pid) return;
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            shell: false,
            stdio: "ignore",
          });
          killer.unref();
        } else if (
          processHandle &&
          processHandle.exitCode === null &&
          processHandle.signalCode === null
        ) {
          // Child object still live: group id is safe to use.
          process.kill(-pid, "SIGKILL");
        } else if (pidStillOurs(pid)) {
          process.kill(-pid, "SIGKILL");
        }
        // Child exited and identity is unverifiable: skip the group kill (a
        // recycled PID must never be killed); descendants are covered by the
        // exit-path reap that runs while the handle is still authoritative.
      } catch (error: any) {
        if (error?.code !== "ESRCH") {
          try {
            processHandle?.kill("SIGKILL");
          } catch {
            /* best effort */
          }
        }
      }
    };

    const requestStop = (reason: StopReason) => {
      if (!requestedStop) requestedStop = reason;
      // Cancellation may arrive before spawn. In that case remember the reason,
      // then a second call immediately after spawn performs the actual signal.
      if (forceKillTimer) return;
      const pid = processHandle?.pid;
      if (!pid) return;
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(pid), "/T"], {
            shell: false,
            stdio: "ignore",
          });
          killer.unref();
        } else {
          process.kill(-pid, "SIGTERM");
        }
      } catch (error: any) {
        if (error?.code !== "ESRCH") {
          try {
            processHandle?.kill("SIGTERM");
          } catch {
            /* best effort */
          }
        }
      }
      forceKillTimer = setTimeout(forceKillTree, this.killGraceMs);
      forceKillTimer.unref?.();
    };

    const stopStallWatchdog = () => {
      if (stallTimer) clearInterval(stallTimer);
      stallTimer = undefined;
    };

    /**
     * Activity-based stall detection: protocol silence for `stallAfterMs`
     * flags the task as stalled (visible in checkpoints/status); continued
     * silence for `stallKillAfterMs` more kills the child so retry can take
     * over. Any protocol event clears the flag.
     */
    const startStallWatchdog = () => {
      if (this.stallAfterMs <= 0 || stallTimer) return;
      const tick = Math.max(
        1_000,
        Math.min(10_000, Math.floor(this.stallAfterMs / 3)),
      );
      stallTimer = setInterval(() => {
        if (requestedStop) return stopStallWatchdog();
        const silence = Date.now() - lastEventAt;
        if (silence < this.stallAfterMs) {
          if (stalledAt !== undefined) {
            stalledAt = undefined;
            result.stalledSince = undefined;
            progress({ stalledSince: undefined });
          }
          return;
        }
        if (stalledAt === undefined) {
          stalledAt = lastEventAt + this.stallAfterMs;
          result.stalledSince = stalledAt;
          progress({ stalledSince: stalledAt });
          // Cheap liveness probe: a healthy-but-quiet child answers get_state,
          // which itself counts as protocol activity and clears the flag.
          this.sendCommand?.({ type: "get_state" });
          return;
        }
        if (
          this.stallKillAfterMs > 0 &&
          silence >= this.stallAfterMs + this.stallKillAfterMs
        ) {
          stopStallWatchdog();
          requestStop("stalled");
        }
      }, tick);
      stallTimer.unref?.();
    };

    const cleanup = async () => {
      this.sendCommand = undefined;
      clearTimeout(timeout);
      stopStallWatchdog();
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = undefined;
      // Pending startup waiters must never keep the run (or a stale session) alive.
      settleStartupWaiters();
      internal.signal.removeEventListener("abort", onInternalAbort);
      abortSignal?.removeEventListener("abort", onExternalAbort);
      if (abortSignal && abortHandler)
        abortSignal.removeEventListener("abort", abortHandler);
      processHandle?.stdout?.removeAllListeners();
      processHandle?.stderr?.removeAllListeners();
      processHandle?.removeAllListeners();
      for (const dir of tempDirs)
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      release();
    };

    // Transcript joins are O(transcript) — only attach them on structural
    // updates (message boundaries), not per-chunk live-text ticks.
    const progress = (partial: Partial<TaskResult>, withTranscript = false) => {
      Object.assign(result, partial);
      const checkpoint: Partial<TaskResult> = {
        ...result,
        liveText: parser.getLiveText(),
      };
      // Live sticky tool activity when the parser observes it (Pi adapter).
      const liveActivity = parser.getToolActivity?.();
      if (liveActivity !== undefined) checkpoint.toolActivity = liveActivity;
      if (withTranscript) checkpoint.transcript = parser.getTranscript();
      else delete checkpoint.transcript;
      this.onCheckpoint?.(checkpoint);
    };

    /**
     * Budget breach → graceful wrap-up: steer the child to answer NOW and
     * allow `graceTurns` more turns. SIGTERM fires only when grace is
     * exhausted (or configured to 0, or steering is impossible).
     */
    const handleBudgetBreach = (
      reason: "max_turns" | "max_cost",
      turns: number,
    ) => {
      if (requestedStop || pendingBudgetStop) {
        if (pendingBudgetStop && turns >= pendingBudgetStop.deadlineTurns)
          requestStop(pendingBudgetStop.reason);
        return;
      }
      const grace = spec.graceTurns ?? this.graceTurns;
      if (
        grace <= 0 ||
        !this.sendCommand?.({ type: "steer", message: WRAP_UP_MESSAGE })
      ) {
        requestStop(reason);
        return;
      }
      pendingBudgetStop = { reason, deadlineTurns: turns + grace };
    };

    const handleUpdates = (updates: ProtocolUpdate[]) => {
      if (updates.length) {
        lastEventAt = Date.now();
        if (stalledAt !== undefined) {
          stalledAt = undefined;
          result.stalledSince = undefined;
        }
      }
      for (const update of updates) {
        // Startup verification waiters are registered before the command is written,
        // so a fast acknowledgement cannot race past its waiter.
        if (startupWaiters.size) {
          for (const waiter of [...startupWaiters]) {
            if (!waiter.test(update)) continue;
            startupWaiters.delete(waiter);
            waiter.resolve(update);
          }
        }
        if (update.type === "session")
          progress({ sessionId: update.sessionId });
        if (update.type === "live-text")
          progress({ liveText: update.liveText });
        if (update.type === "message") {
          result.messages = parser.getMessages();
          result.usage = update.usage;
          progress(
            {
              messages: result.messages,
              usage: result.usage,
              liveText: parser.getLiveText(),
            },
            true,
          );
          if (pendingBudgetStop) {
            if (update.usage.turns >= pendingBudgetStop.deadlineTurns)
              requestStop(pendingBudgetStop.reason);
          } else {
            const budget = this.checkBudgets(spec, result.usage);
            if (budget) handleBudgetBreach(budget, update.usage.turns);
          }
        }
        // Headless children cannot answer extension UI dialogs; cancel so the child never hangs.
        if (update.type === "ui-request")
          this.sendCommand?.({
            type: "extension_ui_response",
            id: update.id,
            cancelled: true,
          });
        if (update.type === "fatal") {
          fatalError = update.error;
          requestStop("fatal");
        }
        // RPC children stay alive until stdin closes; end it once the run settles.
        if (update.type === "agent-settled") {
          // A settle during the wrap-up window means the child finished its
          // final answer in time.
          if (pendingBudgetStop && !requestedStop) wrappedUp = true;
          // Structured-output gate: validate before letting the child exit.
          // Invalid → one steer-based repair round (a fresh prompt keeps the
          // RPC child alive and produces a new settle when it finishes).
          // Ranked exception: a settled assistant provider error/abort must NOT
          // receive an extra same-model repair prompt — that prompt would add
          // unintended work ahead of the ranked failover decision. A ranked
          // parser without this observation capability is also not proof of a
          // clean settle (fail closed); the unranked path is untouched.
          const settledAssistantStop = parser.getAssistantStopReason?.();
          const providerTerminated = settledAssistantStop === "error" || settledAssistantStop === "aborted"
            || (ranked && settledAssistantStop === undefined);
          if (spec.outputSchema && !requestedStop && !pendingBudgetStop && !(ranked && providerTerminated)) {
            const extracted = extractStructuredResult(ranked ? parser.getAssistantText?.() : parser.getLiveText());
            const check =
              extracted.value !== undefined
                ? checkAgainstSchema(extracted.value, spec.outputSchema)
                : {
                    ok: false,
                    errors: [
                      extracted.raw
                        ? "json:result block did not parse as JSON"
                        : "no json:result block found in the final message",
                    ],
                  };
            if (!check.ok && !schemaRepairAttempted) {
              schemaRepairAttempted = true;
              if (
                this.sendCommand?.({
                  type: "prompt",
                  message: repairMessage(check.errors),
                })
              ) {
                lastEventAt = Date.now();
                continue; // repair round in flight: do not close stdin yet
              }
            }
          }
          try {
            processHandle?.stdin?.end();
          } catch {
            /* already closed */
          }
        }
      }
    };

    const applyTimeoutSemantics = (base: TaskResult): TaskResult => {
      if (requestedStop !== "timeout") return base;
      // Queue timeouts never start work: model them as a clean timeout with phase,
      // not a mysterious execution "failed".
      const phase = timeoutPhase ?? "running";
      return {
        ...base,
        state: "timeout",
        stopReason: "timeout",
        timeoutPhase: phase,
        // A "queued" phase is runner-owned proof the slot was never held, so no
        // child could have begun work; other phases are not pre-work conclusive.
        preWorkInfraFailure: phase === "queued" ? true : base.preWorkInfraFailure,
        errorMessage:
          phase === "queued"
            ? "Timed out waiting for a process slot (never started)"
            : phase === "starting"
              ? "Timed out while starting the child process"
              : base.errorMessage || "Timed out while the child was running",
      };
    };

    try {
      if (internal.signal.aborted) {
        result.state = requestedStop === "timeout" ? "timeout" : "cancelled";
        result.stopReason = requestedStop ?? "cancelled";
        result.timeoutPhase =
          requestedStop === "timeout" ? (timeoutPhase ?? "queued") : undefined;
        result.preWorkInfraFailure = result.timeoutPhase === "queued" ? true : undefined;
        result.exitCode = 1;
        result.endedAt = Date.now();
        if (result.state === "timeout" && !result.errorMessage) {
          result.errorMessage =
            "Timed out waiting for a process slot (never started)";
        }
        return result;
      }

      // A routed spec must carry the finalized model + explicit tool ceiling before
      // anything is spawned; otherwise the child's active set could not be verified.
      if (routed) {
        if (!spec.model?.trim()) {
          return markStartupFailure(
            result,
            "model_missing",
            "A routed subagent task must carry the Jev-selected execution model.",
          );
        }
        if (!Array.isArray(spec.tools)) {
          return markStartupFailure(
            result,
            "tools_missing",
            "A routed subagent task must carry the finalized tool allowlist so the child's active set can be verified.",
          );
        }
        // The absolute task deadline is shared across attempts and is honored here,
        // before a slot is taken or a child is spawned. It is never reset later.
        if (deadlineRemainingMs !== undefined && deadlineRemainingMs <= 0) {
          timeoutPhase = "queued";
          requestStop("timeout");
          internal.abort();
          throw new Error("The task deadline expired before the child could start.");
        }
      }

      // Global cap (if configured) is checked before the per-session semaphore so
      // a saturated machine rejects early with a clear message. Depth is the
      // parent process nest level (PI_SUBAGENT_DEPTH via parseDepth): shallow tiers
      // reserve capacity so nested spawns cannot deadlock on a full pool.
      if (this.locks) {
        try {
          globalSlot = this.locks.tryAcquireGlobalSlot(
            this.runId ?? "anonymous",
            parseDepth(),
          );
        } catch (error: any) {
          result.state = "failed";
          result.stopReason = "global_limit";
          result.errorMessage = error?.message ?? String(error);
          result.exitCode = 1;
          result.endedAt = Date.now();
          // Admission rejection happens before any process exists: conclusive
          // runner-owned proof that no child/task work began.
          result.preWorkInfraFailure = true;
          result.toolActivity = "none";
          return result;
        }
      }

      await this.semaphore.acquire(internal.signal);
      slotHeld = true;
      acquiredAt = Date.now();
      result.acquiredAt = acquiredAt;
      if (internal.signal.aborted)
        throw new Error("Subagent cancelled before spawn");
      if (abortSignal) {
        abortHandler = () => requestStop("cancelled");
        abortSignal.addEventListener("abort", abortHandler, { once: true });
      }
      result.state = "running";
      progress({ state: "running", acquiredAt });

      await fs.mkdir(this.sessionDir, { recursive: true });
      if (internal.signal.aborted)
        throw new Error("Subagent cancelled before spawn");

      const taskBytes = Buffer.byteLength(spec.task, "utf8");
      if (taskBytes > this.maxTaskBytes) {
        throw new Error(
          `Task exceeds maxTaskBytes (${taskBytes} > ${this.maxTaskBytes}). Pass a shorter objective or raise the limit.`,
        );
      }

      const invocation = await backend.buildInvocation(spec, {
        sessionDir: this.sessionDir,
        getPiCommand: this.getPiCommand,
      });
      if (invocation.cleanupDirs?.length)
        tempDirs.push(...invocation.cleanupDirs);
      // Invocation construction performs filesystem awaits. Cancellation/deadline must be
      // rechecked before spawning, otherwise an earlier stop had no process to terminate.
      if (internal.signal.aborted) throw new Error("Subagent cancelled before spawn");
      if (absoluteDeadline !== undefined && Date.now() >= absoluteDeadline) {
        timeoutPhase = "starting";
        requestStop("timeout");
        internal.abort();
        throw new Error("Subagent deadline expired before spawn");
      }

      const depth = Number.parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10) || 0;
      // Pin the launch identity + depth in env. Children re-register only when
      // depth leaves remaining headroom (enforced in extension + policy too).
      // Encode the child's own spawn allowlist so grandchildren validate against it.
      const spawnEnv =
        spec.spawns === false
          ? ""
          : Array.isArray(spec.spawns)
            ? spec.spawns.join(",")
            : spec.spawns === "*"
              ? "*"
              : undefined;
      // Trusted backend env (e.g. the temporary preflight manifest path) is merged
      // over the inherited environment, but the depth/spawn controls stay authoritative:
      // they are stripped from the backend env and re-applied last.
      const trustedEnv: Record<string, string> = { ...(invocation.env ?? {}) };
      delete trustedEnv[DEPTH_ENV_VAR];
      delete trustedEnv[SPAWNS_ENV_VAR];
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...trustedEnv,
        [DEPTH_ENV_VAR]: String(depth + 1),
        ...(spawnEnv !== undefined ? { [SPAWNS_ENV_VAR]: spawnEnv } : {}),
      };

      processHandle = spawn(invocation.command, invocation.args, {
        cwd: spec.cwd || process.cwd(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });
      spawned = true;

      const pid = processHandle.pid;
      if (pid) {
        childStartTime = processStartTime(pid);
        const identity: ChildProcessIdentity = {
          pid,
          startTime: childStartTime,
          // On POSIX the child is a new process group leader (detached).
          pgid: process.platform === "win32" ? undefined : pid,
          hostname: os.hostname(),
        };
        result.process = identity;
        progress({ process: identity });
        if (this.locks && this.runId) {
          this.locks.writeRunRecord({
            runId: this.runId,
            parentSessionKey: this.parentSessionKey ?? "",
            childSessionId: result.sessionId,
            ...(this.deferRunTerminal ? { childSessionIds: [] } : {}),
            // Worktree-isolated runs record their checkout so concurrent Pi
            // processes' machine-wide GC sweeps can shield it while we live.
            worktreeCwd: spec.isolation === "worktree" ? spec.cwd : undefined,
            process: {
              pid: identity.pid,
              startTime: identity.startTime,
              pgid: identity.pgid,
              hostname: identity.hostname ?? os.hostname(),
            },
            startedAt: Date.now(),
            state: "running",
            updatedAt: Date.now(),
          });
        }
      }

      if (requestedStop) requestStop(requestedStop);
      else if (internal.signal.aborted) requestStop("cancelled");

      // Attach readers BEFORE writing stdin so a chatty child cannot fill the
      // OS pipe buffer and deadlock waiting for us to drain.
      processHandle.stdout?.on("data", (chunk: Buffer) =>
        handleUpdates(parser.feed(chunk)),
      );
      processHandle.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-50 * 1024);
        result.stderr = stderr;
      });
      processHandle.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        // EPIPE is expected when a child fails before consuming stdin.
        if (error.code !== "EPIPE")
          result.errorMessage = `stdin error: ${error.message}`;
      });
      const send = (command: unknown): boolean => {
        const stdin = processHandle?.stdin;
        if (!stdin || !stdin.writable || stdin.destroyed) return false;
        try {
          stdin.write(JSON.stringify(command) + "\n"); // JSONL: LF-delimited, JSON escapes embedded newlines
          return true;
        } catch {
          return false;
        }
      };
      if (!routed) this.sendCommand = send;

      // The close promise is created before any startup traffic so the handshake, the
      // real task and the final await all observe exactly one exit event.
      const closedPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        error?: Error;
      }>((resolve) => {
        let settled = false;
        const finish = (value: {
          code: number | null;
          signal: NodeJS.Signals | null;
          error?: Error;
        }) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        processHandle!.once("close", (code, signal) =>
          finish({ code, signal }),
        );
        processHandle!.once("error", (error) =>
          finish({ code: 1, signal: null, error }),
        );
      });
      closedPromise.then((value) => {
        childExited = value;
        // A dead child will never answer; unblock startup waiters immediately.
        settleStartupWaiters();
      });

      type StartupOutcome =
        | { kind: "ok" }
        | { kind: "cancelled" }
        | { kind: "failed"; code: string; detail: string };

      const describeChildExit = (): string => {
        if (!childExited) return "exit status not observed";
        if (childExited.signal) return `signal ${childExited.signal}`;
        return `exit code ${childExited.code ?? "unknown"}`;
      };

      /** Stop a child that failed startup verification, bounded by the kill grace. */
      const stopChildForStartupFailure = async () => {
        if (!processHandle) return;
        requestStop("fatal");
        await Promise.race([
          closedPromise,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.max(0, this.killGraceMs));
            timer.unref?.();
          }),
        ]);
        forceKillTree();
      };

      /**
       * Provider-free startup handshake. Returns `ok` only after the child's active
       * model and tool set were both proven to match the finalized route.
       * Never submits an unverified slash command: an unknown command would be treated
       * as an ordinary model prompt.
       */
      const runStartupPreflight = async (
        manifestPath: string | undefined,
      ): Promise<StartupOutcome> => {
        const interruption = (): StartupOutcome | undefined => {
          if (abortSignal?.aborted || requestedStop === "cancelled") return { kind: "cancelled" };
          if (startupTimedOut || requestedStop === "timeout")
            return { kind: "failed", code: "startup_timeout", detail: startupTimeoutDetail(startupBudgetMs) };
          if (childExited)
            return {
              kind: "failed",
              code: "child_exit",
              detail: `The child process exited during startup verification (${describeChildExit()}).`,
            };
          return undefined;
        };

        // 1. Read the expectation the backend handed to the child and cross-check it
        //    against the spec we are about to enforce (defence in depth).
        let expectation: PreflightExpectation;
        try {
          if (!manifestPath) {
            throw startupFailure(
              "preflight_manifest_missing",
              "The Pi backend did not provide a startup expectation manifest for this routed task.",
            );
          }
          const raw = await fs.readFile(manifestPath, "utf8");
          const parsed = parsePreflightManifest(raw);
          if (!parsed.ok) throw startupFailure(parsed.code, parsed.message);
          if (parsed.manifest.model !== spec.model) {
            throw startupFailure(
              "preflight_manifest_mismatch",
              "The child's startup manifest model did not match the finalized route model.",
            );
          }
          if (!sameNameSet(parsed.manifest.tools, spec.tools ?? [])) {
            throw startupFailure(
              "preflight_manifest_mismatch",
              "The child's startup manifest tool allowlist did not match the finalized route tools.",
            );
          }
          expectation = {
            nonce: parsed.manifest.nonce,
            model: parsed.manifest.model,
            tools: parsed.manifest.tools,
            nestedTools: parsed.manifest.nestedTools,
            ownEntryPaths: ownExtensionEntryCandidates(),
            preflightCommandPath: ownPreflightExtensionPath(),
          };
        } catch (error) {
          const failure = readStartupFailure(error);
          if (failure) return { kind: "failed", ...failure };
          if (error instanceof Error && /cancel|abort/i.test(error.message)) return { kind: "cancelled" };
          return {
            kind: "failed",
            code: "preflight_manifest_unreadable",
            detail: "The startup expectation manifest could not be read.",
          };
        }

        // 2. Correlated get_commands polling: extensions may still be loading, so an
        //    early empty answer is not yet a failure.
        const baseName = preflightCommandBase(expectation.nonce);
        const pollDeadline = Date.now() + Math.max(0, startupBudgetMs);
        let verified: { invocableName: string } | undefined;
        let lastResolution: string | undefined;
        for (let attempt = 1; attempt <= MAX_STARTUP_COMMAND_POLLS; attempt += 1) {
          // Cancellation and child death end the loop immediately; an expired budget
          // falls through to the post-loop diagnosis so the remedy stays specific.
          const stop = interruption();
          if (stop && stop.kind === "cancelled") return stop;
          if (stop && stop.code === "child_exit") return stop;
          if (stop) break;
          const requestId = `pi-subagent-preflight-cmd-${attempt}`;
          const responseWait = waitForUpdate(
            (update) => update.type === "rpc-response" && update.id === requestId,
          );
          if (!send({ type: "get_commands", id: requestId })) {
            return {
              kind: "failed",
              code: "child_stdin_closed",
              detail: "The child's command channel closed before startup verification could run.",
            };
          }
          const update = await responseWait;
          const stopAfterResponse = interruption();
          if (stopAfterResponse && stopAfterResponse.kind === "cancelled") return stopAfterResponse;
          if (stopAfterResponse && stopAfterResponse.code === "child_exit") return stopAfterResponse;
          if (stopAfterResponse) break;
          if (update && update.type === "rpc-response") {
            if (!update.success) {
              return {
                kind: "failed",
                code: "get_commands_rejected",
                detail: "The child host rejected the capability probe required for startup verification.",
              };
            }
            const commands = (update.data as { commands?: unknown } | undefined)?.commands;
            const expectedCommandPaths = expectation.preflightCommandPath
              ? [expectation.preflightCommandPath]
              : [];
            const resolution = resolvePreflightCommand(commands, baseName, expectedCommandPaths);
            if (resolution.ok) {
              verified = { invocableName: resolution.invocableName };
              break;
            }
            lastResolution = summarizeCommandResolution(resolution);
          }
          if (Date.now() >= pollDeadline) break;
          await sleep(STARTUP_COMMAND_POLL_MS);
        }
        if (!verified) {
          const stop = interruption();
          // A definite observation (we saw get_commands answers) gives a better remedy
          // than the generic budget message, but never mask a cancellation or a death.
          if (stop && stop.kind === "cancelled") return stop;
          if (stop && stop.code === "child_exit") return stop;
          if (lastResolution !== undefined) {
            return {
              kind: "failed",
              code: "preflight_command_unavailable",
              detail: `The private startup command was not available from the expected package source (${lastResolution}).`,
            };
          }
          if (stop) return stop;
          return {
            kind: "failed",
            code: "preflight_command_unavailable",
            detail: "The private startup command was not available from the expected package source.",
          };
        }

        // 3. Invoke only the verified command and require BOTH a successful correlated
        //    response and a nonce-matching typed acknowledgement.
        const promptId = "pi-subagent-preflight-prompt";
        // Any typed acknowledgement is accepted here and validated below, so a wrong-nonce
        // or malformed answer fails fast with a precise reason instead of a generic budget
        // timeout. There is exactly one child, so no stale acknowledgement can arrive.
        const ackWait = waitForUpdate((update) => update.type === "preflight-ack");
        const promptResponseWait = waitForUpdate(
          (update) => update.type === "rpc-response" && update.id === promptId,
        );
        if (!send({ type: "prompt", message: `/${verified.invocableName}`, id: promptId })) {
          return {
            kind: "failed",
            code: "child_stdin_closed",
            detail: "The child's command channel closed before the startup command could be invoked.",
          };
        }
        const promptResponse = await promptResponseWait;
        const stopAfterPrompt = interruption();
        if (stopAfterPrompt) return stopAfterPrompt;
        if (!promptResponse || promptResponse.type !== "rpc-response" || !promptResponse.success) {
          return {
            kind: "failed",
            code: "preflight_prompt_rejected",
            detail: "The child rejected its verified startup command.",
          };
        }
        const ackUpdate = await ackWait;
        const stopAfterAck = interruption();
        if (!ackUpdate || ackUpdate.type !== "preflight-ack") {
          if (stopAfterAck && stopAfterAck.kind === "cancelled") return stopAfterAck;
          if (stopAfterAck && stopAfterAck.code === "child_exit") return stopAfterAck;
          return {
            kind: "failed",
            code: "preflight_ack_missing",
            detail: startupTimeoutDetail(startupBudgetMs),
          };
        }
        if (stopAfterAck) return stopAfterAck;
        const ack = parsePreflightAckContent(ackUpdate.content);
        if (ack === null) {
          return {
            kind: "failed",
            code: "preflight_ack_malformed",
            detail: "The child's startup acknowledgement was not bounded, valid JSON.",
          };
        }
        if (ack.nonce !== expectation.nonce) {
          return {
            kind: "failed",
            code: "preflight_ack_nonce_mismatch",
            detail: "The child's startup acknowledgement did not carry this invocation's correlation nonce.",
          };
        }
        const problems = verifyPreflightAck(ack, expectation);
        if (problems.length > 0) {
          return { kind: "failed", code: "preflight_ack_rejected", detail: summarizePreflightProblems(problems) };
        }
        return { kind: "ok" };
      };

      let startupOutcome: StartupOutcome = { kind: "ok" };
      if (routed) {
        // Bounded by both the local startup budget and the remaining absolute task time.
        startupBudgetMs = Math.min(
          this.startupTimeoutMs,
          Math.max(0, effectiveTimeoutMs - (Date.now() - startedAt)),
        );
        startupTimer = setTimeout(() => {
          startupTimedOut = true;
          settleStartupWaiters();
        }, startupBudgetMs);
        startupTimer.unref?.();
        startupOutcome = await runStartupPreflight(invocation.env?.[PREFLIGHT_MANIFEST_ENV]);
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = undefined;
        }
      }

      // Keep public steering unavailable until verification, and recheck cancellation
      // even when the final acknowledgement was delivered in the same microtask turn.
      if (startupOutcome.kind === "ok" && (internal.signal.aborted || abortSignal?.aborted)) {
        startupOutcome = { kind: "cancelled" };
      }
      if (startupOutcome.kind === "failed") {
        // Capability mismatch is not transient: never compensate by broadening tools,
        // choosing another model or retrying into an unverified launch.
        await stopChildForStartupFailure();
        // If the OS never created a process, no capability check could run.
        // Preserve this positive pre-work spawn proof for the same-model retry
        // path; an actually launched child's mismatch still refuses outright.
        if (!(ranked && failedBeforeSpawn(childExited?.error))) {
          throw startupFailure(startupOutcome.code, startupOutcome.detail);
        }
      }
      if (startupOutcome.kind === "cancelled") {
        // Cancelled/timed out during startup: never send the real task prompt.
        if (!requestedStop) requestStop("cancelled");
      } else if (startupOutcome.kind === "ok") {
        this.sendCommand = send;
        taskPromptSent = send({ type: "prompt", message: spec.task });
        // RPC mode has no session header line; get_state supplies the session id.
        send({ type: "get_state" });
      }
      lastEventAt = Date.now();
      startStallWatchdog();

      const closed = await closedPromise;

      handleUpdates(parser.flush());
      // The child owns a dedicated process group. Reap descendants even when the
      // direct Pi process exits normally after a tool backgrounds work — unless
      // the task explicitly opted into keeping backgrounded processes alive.
      if (!spec.keepBackground || requestedStop) forceKillTree();
      const finalized = parser.finalize(
        closed.code,
        closed.signal ?? undefined,
        stderr,
      );
      Object.assign(result, finalized, {
        label: result.label,
        task: spec.task,
        outputFile: spec.output,
        outputMode: spec.outputMode,
        thinking: spec.thinking,
        profile: spec.profile,
        backend: spec.backend ?? "pi",
        // Routed children were startup-verified against the exact `provider/model`
        // identity; provider message payloads may echo a bare ID, which must never
        // become the recorded actual model of an attempt.
        model: routed && spec.model ? spec.model : (finalized.model ?? result.model ?? spec.model),
        liveText: ranked ? parser.getAssistantText?.() || undefined : finalized.liveText,
        canWrite: spec.canWrite,
        process: result.process,
        startedAt,
        acquiredAt,
        endedAt: Date.now(),
      });

      if (closed.error) {
        result.state = "failed";
        result.stopReason = "spawn_error";
        result.errorMessage = closed.error.message;
        // Only spawn-stage failures where the OS never produced a process are
        // conclusive pre-work proof. Any other child error leaves uncertainty:
        // a ranked attempt must not restart on it, so the activity latch rises
        // to `unknown` instead of staying `none`.
        const neverStarted = failedBeforeSpawn(closed.error);
        result.preWorkInfraFailure = neverStarted;
        if (!neverStarted && ranked && result.toolActivity !== "started") {
          result.toolActivity = "unknown";
        }
      } else if (requestedStop) {
        if (requestedStop === "timeout") {
          Object.assign(result, applyTimeoutSemantics(result));
        } else if (requestedStop === "cancelled") {
          result.state = "cancelled";
          result.stopReason = "cancelled";
          result.exitCode = closed.code;
        } else if (requestedStop === "stalled") {
          // Stall kill is a transient infrastructure failure (retryable), but
          // completed turns still carry useful output.
          result.state = result.usage.turns > 0 ? "partial" : "failed";
          result.stopReason = "stalled";
          result.exitCode = closed.code ?? 1;
          result.stalledSince = stalledAt;
          result.errorMessage = `Child produced no protocol activity for ${Math.round((this.stallAfterMs + this.stallKillAfterMs) / 1000)}s and was stopped`;
        } else if (BUDGET_STOPS.has(requestedStop) && result.usage.turns > 0) {
          result.state = "partial";
          result.stopReason = requestedStop;
          result.exitCode = closed.code;
          result.errorMessage = `Stopped by ${requestedStop.replace("_", " ")} budget after the wrap-up grace period; partial output preserved`;
        } else if (requestedStop === "fatal") {
          // A fatal RPC rejection supersedes any earlier assistant error: the
          // final settled outcome is a protocol failure, not provider evidence.
          // Stale evidence must never authorize cross-model advancement.
          result.providerError = undefined;
          result.state = "failed";
          result.stopReason = "error";
          result.exitCode = closed.code ?? 1;
          if (fatalError) result.errorMessage = fatalError;
        } else {
          result.state = "failed";
          result.stopReason = requestedStop;
          result.exitCode = closed.code ?? 1;
        }
      } else if (
        pendingBudgetStop &&
        (result.state as TaskResult["state"]) === "completed"
      ) {
        // Budget breached, but the child wrapped up its final answer within the
        // grace turns: a concluded (if budget-limited) result, not a truncation.
        result.state = "partial";
        result.stopReason = pendingBudgetStop.reason;
        result.wrappedUp = true;
        result.errorMessage = `Reached ${pendingBudgetStop.reason.replace("_", " ")} budget and wrapped up gracefully`;
      }

      // Structured-output verdict: validate the final text once, after any
      // repair round. Failure downgrades completed → partial (paid work is
      // still delivered; the parent sees why it is not machine-readable).
      // Ranked exception: a failed/cancelled/timed-out terminal attempt, or one
      // whose latest completed assistant message ended in a provider
      // error/abort, must never publish structuredOutput even when its text
      // contains a valid, schema-matching json:result block — that text stays
      // ordinary failed-attempt output/preview. Successful and legitimate
      // budget-limited "partial" attempts keep the existing validation.
      const settledAssistantStop = parser.getAssistantStopReason?.();
      const rankedAssistantTerminated = ranked && (settledAssistantStop === "error"
        || settledAssistantStop === "aborted"
        || settledAssistantStop === undefined);
      if (spec.outputSchema && !(ranked && (["failed", "cancelled", "timeout", "lost"].includes(result.state as TaskResult["state"]) || rankedAssistantTerminated))) {
        const extracted = extractStructuredResult(result.liveText);
        const check =
          extracted.value !== undefined
            ? checkAgainstSchema(extracted.value, spec.outputSchema)
            : {
                ok: false,
                errors: [
                  extracted.raw
                    ? "json:result block did not parse as JSON"
                    : "no json:result block found in the final message",
                ],
              };
        if (check.ok) {
          result.structuredOutput = extracted.value;
        } else {
          result.structuredError = check.errors.slice(0, 10).join("; ");
          if ((result.state as TaskResult["state"]) === "completed") {
            result.state = "partial";
            result.stopReason = "schema_mismatch";
            result.errorMessage = `Structured output failed validation${schemaRepairAttempted ? " (after one repair round)" : ""}: ${result.structuredError}`;
          }
        }
      }

      if (!this.deferRunTerminal && this.locks && this.runId) {
        this.locks.markRunTerminal(this.runId, result.state);
      }
      return result;
    } catch (error: any) {
      // A routed child that could not be verified is a non-transient capability refusal:
      // plain Error + owned code, never a custom subclass or a transient retry.
      const startupFailureInfo = readStartupFailure(error);
      if (startupFailureInfo && requestedStop !== "timeout" && !abortSignal?.aborted) {
        markStartupFailure(result, startupFailureInfo.code, startupFailureInfo.detail);
        if (!this.deferRunTerminal && this.locks && this.runId)
          this.locks.markRunTerminal(this.runId, result.state);
        return result;
      }
      const cancelled =
        (abortSignal?.aborted && requestedStop !== "timeout") ||
        /cancel/i.test(String(error?.message));
      if (requestedStop === "timeout") {
        result.state = "timeout";
        result.stopReason = "timeout";
        result.timeoutPhase =
          timeoutPhase ?? (!slotHeld ? "queued" : "running");
        result.preWorkInfraFailure = result.timeoutPhase === "queued" ? true : undefined;
        result.errorMessage =
          result.timeoutPhase === "queued"
            ? "Timed out waiting for a process slot (never started)"
            : (error?.message ?? "Timed out");
      } else {
        result.state = cancelled ? "cancelled" : "failed";
        result.stopReason =
          requestedStop ??
          (result.state === "cancelled" ? "cancelled" : "error");
        result.errorMessage = error?.message ?? String(error);
      }
      result.exitCode ??= 1;
      result.endedAt = Date.now();
      if (!this.deferRunTerminal && this.locks && this.runId)
        this.locks.markRunTerminal(this.runId, result.state);
      return result;
    } finally {
      await cleanup();
    }
  }

  private checkBudgets(
    spec: TaskSpec,
    usage: UsageStats,
  ): "max_turns" | "max_cost" | undefined {
    // Stop only after a completed turn has pushed usage beyond the configured ceiling.
    // Prior-attempt usage is included in this comparison so a replacement model does
    // not reset max_cost/max_turns, while returned usage stays attempt-local.
    const compared = this.budgetOffset ? addUsage(this.budgetOffset, usage) : usage;
    if (spec.maxTurns !== undefined && compared.turns > spec.maxTurns)
      return "max_turns";
    if (spec.maxCost !== undefined && compared.cost > spec.maxCost)
      return "max_cost";
    return undefined;
  }
}

/**
 * Run a single subagent child process.
 *
 * **Orphan reclaim:** without `options.locks` **and** `options.runId`, no durable
 * run record is written under the lock root, so children are invisible to
 * startup orphan reclaim. Pass both when embedding the runner as a library if you
 * need crash recovery. No implicit default lock manager is created (opt-in only).
 */
export function runSubagent(
  spec: TaskSpec,
  options: RunnerOptions & { signal?: AbortSignal } = {},
): Promise<TaskResult> {
  return new ChildRunner(
    options.semaphore,
    options.getPiCommand,
    options.sessionDir,
    options.onCheckpoint,
    options.killGraceMs,
    options.locks,
    options.runId,
    options.parentSessionKey,
    options.maxTaskBytes,
    {
      graceTurns: options.graceTurns,
      stallAfterMs: options.stallAfterMs,
      stallKillAfterMs: options.stallKillAfterMs,
      startupTimeoutMs: options.startupTimeoutMs,
      backend: options.backend,
      priorUsage: options.priorUsage,
      deferRunTerminal: options.deferRunTerminal,
    },
  ).run(spec, options.signal);
}
