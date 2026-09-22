import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultConfig } from "./config.js";
import { createGetPiCommand } from "./launch.js";
import {
  attemptOutputPreview,
  classifyProviderError,
  decideRankedAttempt,
  earlierAttemptOutputNote,
  mergeToolActivity,
  rankedMaxAttempts,
  resolveAttemptActivity,
  trimAttemptPreviews,
  validateAttemptPlan,
} from "./model-failover.js";
import type { ProcessLockManager } from "./process-lock.js";
import { ChildRunner, type GetPiCommand } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import type {
  ModelAttemptRecord,
  ModelAttemptSpec,
  RunMode,
  RunState,
  TaskResult,
  TaskSpec,
  ToolActivity,
  UsageStats,
} from "./types.js";
import { emptyUsage } from "./types.js";
import { addUsage } from "./usage.js";
import { WorktreeManager, type WorktreeHandle } from "./worktree.js";

export interface OrchestratorDeps {
  semaphore?: Semaphore;
  getPiCommand?: GetPiCommand;
  sessionDir?: string;
  worktrees?: WorktreeManager;
  killGraceMs?: number;
  locks?: ProcessLockManager;
  runId?: string;
  parentSessionKey?: string;
  onTaskProgress?: (index: number, partial: Partial<TaskResult>) => void;
  /** Exposes each task's live runner (for mid-run steering). Re-fires per retry attempt. */
  onRunnerCreated?: (index: number, runner: ChildRunner) => void;
  /** Wrap-up grace turns after budget breach (per-spec graceTurns overrides). */
  graceTurns?: number;
  /** Stall watchdog windows (0 disables). */
  stallAfterMs?: number;
  stallKillAfterMs?: number;
  /** Default extra attempts on transient failures (per-spec maxRetries overrides). */
  maxRetries?: number;
}

/**
 * Transient failures are infrastructure problems, not task problems: the same
 * spec is safe to retry without duplicating side effects because no meaningful
 * work happened (queued timeout) or the child died from environment causes
 * (stall, provider error, protocol truncation).
 *
 * Never retried: real task failures (nonzero exit with complete protocol),
 * cancellations, budget stops, and running timeouts (work may be half-done).
 *
 * This is the LEGACY unranked SDK predicate. Ranked extension tasks never use
 * it: their availability advancement is decided exclusively by
 * `model-failover.decideRankedAttempt` from settled provider-error evidence.
 */
export function isTransientFailure(result: TaskResult): boolean {
  if (result.state === "timeout" && result.timeoutPhase === "queued") return true;
  if (result.stopReason === "stalled") return true;
  if (result.stopReason === "spawn_error") return true;
  // Provider/stream errors: stopReason "error" comes from provider-reported
  // failure or the fatal RPC path; both are retry-with-fallback candidates.
  if (result.state === "failed" && ["error", "protocol_error", "unexpected_signal"].includes(result.stopReason ?? "")) return true;
  return false;
}

export interface OrchestratedRun {
  mode: RunMode;
  results: TaskResult[];
  state: RunState;
  summary: string;
}

function aggregateState(results: TaskResult[]): RunState {
  if (results.every((r) => r.state === "completed")) return "completed";
  // Budget-stopped / truncated tasks ("partial") carry useful output.
  if (results.some((r) => r.state === "completed" || r.state === "partial")) return "partial";
  if (results.every((r) => r.state === "cancelled")) return "cancelled";
  if (results.every((r) => r.state === "timeout" || r.state === "cancelled")) return "timeout";
  if (results.some((r) => r.state === "timeout") && results.every((r) => ["timeout", "cancelled", "failed"].includes(r.state))) {
    return results.every((r) => r.state === "timeout") ? "timeout" : "failed";
  }
  return "failed";
}

/** Terminal-failure body with the attributed earlier-attempt preview when the
 * final attempt produced no text of its own (ranked failover retention). */
function deliveryBody(result: Partial<TaskResult> & { finalOutput?: string }): string {
  const primary = result.liveText || result.finalOutput;
  if (primary) return primary;
  const failure = result.errorMessage || result.stderr || "(no output)";
  const note = earlierAttemptOutputNote(result as Parameters<typeof earlierAttemptOutputNote>[0]);
  return note ? `${failure}\n\n${note}` : failure;
}

function summarize(results: TaskResult[]): string {
  return results.map((r) => {
    const body = r.outputMode === "file-only"
      ? r.outputFile ? `Output written to ${r.outputFile}` : "No output artifact"
      : deliveryBody(r);
    return `[${r.label}] ${r.state}\n${body}`;
  }).join("\n\n");
}

async function writeArtifact(spec: TaskSpec, result: TaskResult): Promise<void> {
  if (!spec.output) return;
  const text = deliveryBody(result);
  await fs.mkdir(path.dirname(spec.output), { recursive: true });
  await fs.writeFile(spec.output, text, "utf8");
  result.outputFile = spec.output;
  result.outputMode = spec.outputMode;
}

export async function runTasks(
  specs: TaskSpec[],
  options: OrchestratorDeps & { signal?: AbortSignal } = {},
): Promise<OrchestratedRun> {
  const semaphore = options.semaphore ?? new Semaphore(defaultConfig.maxActiveProcesses, defaultConfig.maxQueuedTasks);
  const worktrees = options.worktrees ?? new WorktreeManager();
  const handles: Array<WorktreeHandle | undefined> = new Array(specs.length);
  const prepared: TaskSpec[] = [];
  let setupTimedOut = false;
  const progress: Partial<TaskResult>[] = [];
  const checkpoint = (index: number, partial: Partial<TaskResult>) => {
    progress[index] = { ...progress[index], ...partial };
    options.onTaskProgress?.(index, partial);
  };

  try {
    for (let index = 0; index < specs.length; index++) {
      if (options.signal?.aborted) throw new Error("Subagent run cancelled before worktree setup");
      const spec = { ...specs[index]! };
      const setupController = new AbortController();
      const setupSignal = options.signal ? AbortSignal.any([options.signal, setupController.signal]) : setupController.signal;
      let setupTimer: NodeJS.Timeout | undefined;
      if (spec.deadline !== undefined) {
        const remaining = spec.deadline - Date.now();
        if (remaining <= 0) {
          setupTimedOut = true;
          throw new Error("Subagent deadline expired before setup");
        }
        setupTimer = setTimeout(() => { setupTimedOut = true; setupController.abort(); }, remaining);
        setupTimer.unref?.();
      }
      try {
      if (spec.isolation === "worktree") {
        const handle = await worktrees.create(spec.cwd || process.cwd(), spec.task.slice(0, 20), setupSignal, {
          includeWip: spec.includeWip === true,
        });
        handles[index] = handle;
        spec.cwd = handle.cwd;
        // Announce the worktree immediately so live runs can shield it from GC sweeps.
        checkpoint(index, {
          worktree: { cwd: handle.cwd, branch: handle.branch, baseCommit: handle.baseCommit, changed: false },
        });
      }
      if (setupSignal.aborted) throw new Error("Subagent setup was cancelled or exceeded its task deadline");
      prepared.push(spec);
      } finally { if (setupTimer) clearTimeout(setupTimer); }
    }
  } catch (error) {
    // Keep retained worktree pointers and report cleanup failures per task.
    const setupErrors: Array<string | undefined> = [];
    for (let index = 0; index < handles.length; index++) {
      const handle = handles[index];
      if (!handle) continue;
      try {
        const final = await worktrees.finalize(handle);
        progress[index] = { ...progress[index], worktree: final.changed
          ? { cwd: final.cwd, branch: final.branch, baseCommit: final.baseCommit, changed: true, diffSummary: final.diffSummary }
          : undefined };
      } catch (error) {
        setupErrors[index] = `Worktree finalization failed: ${error instanceof Error ? error.message : String(error)}`;
        // Its state is uncertain; preserve the handle for inspection/recovery.
        progress[index] = { ...progress[index], worktree: { cwd: handle.cwd, branch: handle.branch, baseCommit: handle.baseCommit, changed: true } };
      }
    }
    {
      const setupState: RunState = setupTimedOut ? "timeout" : options.signal?.aborted ? "cancelled" : "failed";
      const results = specs.map<TaskResult>((spec, index) => ({
        ...progress[index],
        index,
        label: spec.label || `task-${index + 1}`,
        task: spec.task,
        model: spec.model,
        routing: spec.routing,
        state: setupState,
        exitCode: 1,
        messages: progress[index]?.messages ?? [],
        stderr: progress[index]?.stderr ?? "",
        usage: progress[index]?.usage ?? emptyUsage(),
        stopReason: setupTimedOut ? "timeout" : options.signal?.aborted ? "cancelled" : "setup_error",
        timeoutPhase: setupTimedOut ? "starting" : undefined,
        errorMessage: [error instanceof Error ? error.message : String(error), setupErrors[index]].filter(Boolean).join("; "),
        thinking: spec.thinking,
        profile: spec.profile,
        backend: spec.backend ?? "pi",
        canWrite: spec.canWrite,
        outputFile: spec.output,
        outputMode: spec.outputMode,
        protocol: { headerSeen: false, assistantEndSeen: false, agentEndSeen: false, agentSettledSeen: false, validEvents: 0, parseErrors: 0 },
      }));
      return { mode: specs.length > 1 ? "parallel" : "single", results, state: setupState, summary: summarize(results) };
    }
  }

  /**
   * A present-but-malformed attempt plan is a fail-closed refusal: no child may
   * launch and the spec is never silently reinterpreted as an unranked legacy
   * task (which would drop the pre-tool evidence guards).
   */
  const malformedPlanResult = (spec: TaskSpec, index: number): TaskResult => ({
    label: spec.label || `task-${index + 1}`,
    task: spec.task,
    index,
    state: "failed",
    exitCode: 1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: spec.model,
    routing: spec.routing,
    thinking: spec.thinking,
    profile: spec.profile,
    backend: spec.backend ?? "pi",
    canWrite: spec.canWrite,
    outputFile: spec.output,
    outputMode: spec.outputMode,
    stopReason: "invalid_attempt_plan",
    errorMessage: "The ranked model attempt plan is malformed or was not locally finalized; refusing to launch (fail closed). No child was started.",
    toolActivity: "unknown",
    protocol: { headerSeen: false, assistantEndSeen: false, agentEndSeen: false, agentSettledSeen: false, validEvents: 0, parseErrors: 0 },
  });

  /** One settled ranked attempt → the next pre-tool failover action. */
  const runRankedAttempts = async (
    index: number,
    spec: TaskSpec,
    plan: readonly ModelAttemptSpec[],
    taskRunId: string | undefined,
  ): Promise<TaskResult> => {
    const maxRetries = spec.maxRetries ?? options.maxRetries ?? defaultConfig.maxRetries;
    const maxAttempts = rankedMaxAttempts(maxRetries);
    let candidateIndex = 0;
    let attempt = 0;
    let prior = emptyUsage();
    let stickyActivity: ToolActivity = "none";
    const records: ModelAttemptRecord[] = [];
    let settled: TaskResult | undefined;

    for (;;) {
      const candidate = plan[candidateIndex]!;
      const attemptSpec: TaskSpec = { ...spec, model: candidate.model, thinking: candidate.thinking, fallbackModels: [] };
      attempt++;
      const beforeAttempt = prior;
      const runner = new ChildRunner(
        semaphore,
        options.getPiCommand ?? createGetPiCommand(),
        options.sessionDir,
        (partial) => checkpoint(index, {
          ...partial,
          attempts: attempt > 1 ? attempt : undefined,
          usage: partial.usage ? addUsage(beforeAttempt, partial.usage) : partial.usage,
        }),
        options.killGraceMs,
        options.locks,
        taskRunId,
        options.parentSessionKey,
        undefined,
        {
          graceTurns: options.graceTurns,
          stallAfterMs: options.stallAfterMs,
          stallKillAfterMs: options.stallKillAfterMs,
          priorUsage: attempt > 1 ? beforeAttempt : undefined,
          deferRunTerminal: true,
        },
      );
      options.onRunnerCreated?.(index, runner);
      // Await the complete child result AND its cleanup: no replacement
      // process may overlap a prior one, and ownership is never released early.
      const result = await runner.run(attemptSpec, options.signal);
      settled = result;

      const activity = resolveAttemptActivity(result);
      stickyActivity = mergeToolActivity(stickyActivity, activity);
      const category = result.state === "failed" && result.stopReason === "error"
        ? classifyProviderError(result.providerError)
        : null;
      // Sum each attempt's reported usage exactly once. The runner returns only
      // its own attempt usage; this loop alone owns the cumulative figure.
      prior = addUsage(prior, result.usage);
      result.usage = prior;

      records.push({
        attempt,
        rank: candidateIndex,
        model: result.model ?? candidate.model,
        probability: candidate.probability,
        outcome: result.state,
        ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
        ...(category === null || category === "unknown" ? {} : { failureCategory: category }),
        toolActivity: activity,
        ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        outputPreview: attemptOutputPreview(result.liveText),
      });
      trimAttemptPreviews(records);

      const costCeilingReached = spec.maxCost !== undefined && prior.cost >= spec.maxCost;
      const turnCeilingReached = spec.maxTurns !== undefined && prior.turns >= spec.maxTurns;
      const decision = decideRankedAttempt({
        attempt,
        maxAttempts,
        candidateIndex,
        candidateCount: plan.length,
        activity,
        category,
        state: result.state,
        cancelled: options.signal?.aborted === true,
        deadlineExceeded: spec.deadline !== undefined && Date.now() >= spec.deadline,
        infraPreWork: result.preWorkInfraFailure === true,
        costCeilingReached,
        turnCeilingReached,
      });
      if (decision.action === "finish") {
        // A met cumulative ceiling that would otherwise have allowed another
        // launch is reported as the corresponding budget stop while the true
        // terminal failure state/model/session stay preserved.
        if (result.state === "failed" && attempt < maxAttempts && activity === "none" && (costCeilingReached || turnCeilingReached)) {
          const ceiling = costCeilingReached ? "max_cost" : "max_turns";
          result.errorMessage = `${result.errorMessage ?? "Attempt failed"} (further attempts refused: cumulative reported usage reached the ${ceiling} ceiling)`;
        }
        break;
      }
      // Advance the ranking (availability) or keep the candidate (conclusive
      // pre-work infrastructure failure). Both consume the same total budget
      // under the same absolute deadline; cancel/deadline were just rechecked
      // inside the decision, and they gate this replacement launch.
      if (decision.action === "advance") candidateIndex++;
      checkpoint(index, {
        state: "queued",
        model: plan[candidateIndex]!.model,
        attempts: attempt + 1,
        toolActivity: stickyActivity,
        attemptedModels: records.map((record) => record.model),
        modelAttempts: [...records],
      });
    }

    const result = settled ?? malformedPlanResult(spec, index);
    result.toolActivity = stickyActivity;
    result.modelAttempts = records;
    if (records.length > 1) {
      result.attempts = records.length;
      result.attemptedModels = records.map((record) => record.model);
      if (result.errorMessage && (result.state === "failed" || result.state === "timeout")) {
        result.errorMessage += ` (after ${records.length} attempts: ${records.map((record) => record.model).join(" → ")})`;
      }
    }
    return result;
  };

  /** Trusted unranked SDK path: original loop, unchanged semantics. */
  const runUnrankedLoop = async (
    index: number,
    spec: TaskSpec,
    taskRunId: string | undefined,
  ): Promise<TaskResult> => {
    // Retry with model fallback on transient failures. Attempt N uses the
    // N-1th fallback model (attempt 1 = primary). Usage accumulates across
    // attempts so the cost ledger reflects everything billed.
    const fallbacks = spec.fallbackModels ?? [];
    const maxRetries = spec.maxRetries ?? options.maxRetries ?? defaultConfig.maxRetries;
    // Providing fallback models implies wanting them all tried; otherwise
    // maxRetries bounds same-model retries.
    const maxAttempts = 1 + Math.max(maxRetries, fallbacks.length);
    const attemptedModels: string[] = [];
    let priorUsage: UsageStats | undefined;
    let result!: TaskResult;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const model = attempt === 1 ? spec.model : (fallbacks[attempt - 2] ?? spec.model);
      if (model) attemptedModels.push(model);
      const attemptSpec: TaskSpec = { ...spec, model };
      const runner = new ChildRunner(
        semaphore,
        options.getPiCommand ?? createGetPiCommand(),
        options.sessionDir,
        (partial) => checkpoint(index, {
          ...partial,
          attempts: attempt > 1 ? attempt : undefined,
          usage: partial.usage && priorUsage ? addUsage(priorUsage, partial.usage) : partial.usage,
        }),
        options.killGraceMs,
        options.locks,
        taskRunId,
        options.parentSessionKey,
        undefined,
        { graceTurns: options.graceTurns, stallAfterMs: options.stallAfterMs, stallKillAfterMs: options.stallKillAfterMs },
      );
      options.onRunnerCreated?.(index, runner);
      result = await runner.run(attemptSpec, options.signal);
      if (priorUsage) result.usage = addUsage(priorUsage, result.usage);

      const canRetry = attempt < maxAttempts && !options.signal?.aborted && (spec.deadline === undefined || Date.now() < spec.deadline) && isTransientFailure(result);
      if (!canRetry) break;
      priorUsage = result.usage;
      const nextModel = fallbacks[attempt - 1];
      checkpoint(index, {
        state: "queued",
        model: nextModel ?? spec.model,
        attempts: attempt + 1,
        liveText: `Attempt ${attempt} ${result.stopReason ?? result.state}; retrying${nextModel ? ` on ${nextModel}` : ""}…`,
      });
    }

    if (attemptedModels.length > 1) {
      result.attempts = attemptedModels.length;
      result.attemptedModels = attemptedModels;
      if (result.errorMessage && (result.state === "failed" || result.state === "timeout")) {
        result.errorMessage += ` (after ${attemptedModels.length} attempts: ${attemptedModels.join(" → ")})`;
      }
    }
    return result;
  };

  const runOne = async (index: number): Promise<TaskResult> => {
    const spec = prepared[index]!;
    // Per-task durable id stays unique under a multi-task run by appending index.
    const taskRunId = options.runId
      ? (specs.length > 1 ? `${options.runId}:${index}` : options.runId)
      : undefined;

    let finalState: RunState = "failed";
    try {
      let result: TaskResult;
      if (spec.modelAttemptPlan !== undefined) {
        // Ranked extension path. A malformed present plan fails closed; it never
        // falls through to the legacy loop.
        result = validateAttemptPlan(spec.modelAttemptPlan, spec.model)
          ? await runRankedAttempts(index, spec, spec.modelAttemptPlan, taskRunId)
          : malformedPlanResult(spec, index);
      } else {
        result = await runUnrankedLoop(index, spec, taskRunId);
      }

      result.routing = spec.routing;
      result.index = index;
      result.label = spec.label || `task-${index + 1}`;
      result.outputMode = spec.outputMode;

      try {
        await writeArtifact(spec, result);
      } catch (error: any) {
        result.errorMessage = `${result.errorMessage ? `${result.errorMessage}; ` : ""}Artifact write failed: ${error?.message ?? error}`;
        if (result.state === "completed") result.state = "partial";
      }

      const handle = handles[index];
      if (handle) {
        try {
          // Finalize even on cancellation: it either preserves changed work or
          // removes an unchanged worktree, and both are quick local git calls.
          const final = await worktrees.finalize(handle);
          if (final.changed) {
            result.worktree = {
              cwd: final.cwd,
              branch: final.branch,
              baseCommit: final.baseCommit,
              changed: true,
              diffSummary: final.diffSummary,
            };
          }
        } catch (error: any) {
          result.errorMessage = `${result.errorMessage ? `${result.errorMessage}; ` : ""}Worktree finalization failed: ${error?.message ?? error}`;
          if (result.state === "completed") result.state = "partial";
        }
      }
      finalState = result.state;
      return result;
    } finally {
      // Process slots belong to each child; durable task ownership spans the
      // entire ranked chain, artifact writes and worktree finalization.
      if (spec.modelAttemptPlan !== undefined && options.locks && taskRunId) {
        options.locks.markRunTerminal(taskRunId, finalState);
      }
    }
  };

  // One unexpected task failure must not release run ownership while siblings still
  // execute, or discard their results. Each task settles before the aggregate does.
  const results = await Promise.all(prepared.map(async (spec, index): Promise<TaskResult> => {
    try { return await runOne(index); }
    catch (error) {
      const partial = progress[index];
      return {
        ...partial, index, label: spec.label || `task-${index + 1}`, task: spec.task,
        model: partial?.model ?? spec.model, routing: spec.routing, thinking: spec.thinking,
        profile: spec.profile, backend: spec.backend ?? "pi", canWrite: spec.canWrite,
        outputFile: spec.output, outputMode: spec.outputMode,
        state: "failed", exitCode: 1, messages: partial?.messages ?? [], stderr: partial?.stderr ?? "",
        usage: partial?.usage ?? emptyUsage(), stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error),
        protocol: partial?.protocol ?? { headerSeen: false, assistantEndSeen: false, agentEndSeen: false, agentSettledSeen: false, validEvents: 0, parseErrors: 0 },
      };
    }
  }));
  return {
    mode: results.length > 1 ? "parallel" : "single",
    results,
    state: aggregateState(results),
    summary: summarize(results),
  };
}
