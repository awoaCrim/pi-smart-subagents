import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { SubagentConfig } from "./config.js";
import type { PersistenceAdapter, PersistedResult } from "./persistence.js";
import { normalizeAttemptedModels, normalizeModelAttempts, normalizeTaskRouting, PersistenceLayer } from "./persistence.js";
import type { ProcessLockManager } from "./process-lock.js";
import type { RunMode, RunSnapshot, RunState, TaskResult, TaskSpec } from "./types.js";
import { emptyUsage } from "./types.js";

export interface LiveRun {
  id: string;
  sessionKey: string;
  mode: RunMode;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  taskPreviews: string[];
  taskSpecs: TaskSpec[];
  results: TaskResult[];
  summary?: string;
  delivered: boolean;
  promise: Promise<unknown>;
  controller: AbortController;
  childSessionIds: Set<string>;
  lastProgressCheckpoint: number;
}

export interface RunLookupResult {
  status: "found" | "not-found" | "ambiguous";
  run?: LiveRun | RunSnapshot;
  matches?: string[];
}

export interface SessionRuntime {
  sessionKey: string;
  runs: Map<string, LiveRun>;
  snapshots: Map<string, RunSnapshot>;
  activeResumes: Map<string, string>;
  shuttingDown: boolean;
}

export type RegistryEvent =
  | { type: "changed"; sessionKey: string; runId: string }
  | { type: "terminal"; sessionKey: string; runId: string; state: RunState };

const terminalStates = new Set<RunState>(["completed", "partial", "failed", "cancelled", "lost", "timeout"]);

/** Trailing coalesce window for high-frequency "changed" events. */
const EMIT_COALESCE_MS = 100;

function finalText(messages: Message[], fallback?: string, latestOnly = false): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    if (!Array.isArray(message.content)) { if (latestOnly) return undefined; continue; }
    const text = message.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
    if (text || latestOnly) return text || undefined;
  }
  return fallback;
}

function utf8Prefix(value: string | undefined, maxBytes: number): string | undefined {
  if (!value) return undefined;
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Full result projection: capped transcripts included. Used for terminal
 * persistence and UI snapshots — the single converter for both paths.
 */
export function toPersistedResult(result: TaskResult): PersistedResult {
  const routing = normalizeTaskRouting((result as { routing?: unknown }).routing);
  return {
    label: result.label,
    task: result.task.slice(0, 1_000),
    state: result.state,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    timeoutPhase: result.timeoutPhase,
    errorMessage: result.errorMessage,
    usage: result.usage,
    model: result.model,
    thinking: result.thinking,
    profile: result.profile,
    backend: result.backend,
    canWrite: result.canWrite,
    outputFile: result.outputFile,
    outputMode: result.outputMode,
    sessionId: result.sessionId,
    process: result.process,
    ...(routing === undefined ? {} : { routing }),
    finalOutput: utf8Prefix(finalText(result.messages, result.liveText, !!routing?.rankedModels), 16_384),
    transcript: utf8Prefix(result.transcript, 32_768),
    worktree: result.worktree,
    wrappedUp: result.wrappedUp,
    stalledSince: result.stalledSince,
    attempts: result.attempts,
    attemptedModels: normalizeAttemptedModels(result.attemptedModels),
    toolActivity: result.toolActivity,
    // Clone/validate at the projection boundary as well as reload, preserving
    // immutable snapshots and the same producer/decoder preview limits.
    modelAttempts: normalizeModelAttempts(result.modelAttempts),
    structuredOutput: result.structuredOutput,
    structuredError: result.structuredError,
  };
}

/**
 * Memoized per-result projection for live snapshots. High-frequency emitters
 * (footer refresh, streamed tool updates) re-snapshot the whole run on every
 * event; only the task that actually changed should pay the projection cost
 * (message scan + capped-string allocation).
 */
const projectionCache = new WeakMap<TaskResult, { fingerprint: string; projected: PersistedResult }>();

function resultFingerprint(result: TaskResult): string {
  return [
    result.state,
    result.usage.turns,
    result.usage.cost,
    result.sessionId ?? "",
    result.messages.length,
    result.liveText?.length ?? 0,
    result.transcript?.length ?? 0,
    result.errorMessage?.length ?? 0,
    result.stalledSince ?? 0,
    result.attempts ?? 0,
    result.worktree ? 1 : 0,
    result.structuredOutput !== undefined ? 1 : 0,
    result.structuredError?.length ?? 0,
    (result as { routing?: { decisionId?: unknown } }).routing?.decisionId ?? "",
    // Model/attempt revision: a stable decision ID with same-length text must
    // not keep stale UI state when the actual model, activity latch or attempt
    // history changed between attempts.
    result.model ?? "",
    result.toolActivity ?? "",
    JSON.stringify(normalizeModelAttempts(result.modelAttempts)) ?? "",
    JSON.stringify(normalizeAttemptedModels(result.attemptedModels)) ?? "",
  ].join("|");
}

function toPersistedResultCached(result: TaskResult): PersistedResult {
  const fingerprint = resultFingerprint(result);
  const cached = projectionCache.get(result);
  if (cached && cached.fingerprint === fingerprint) return cached.projected;
  const projected = toPersistedResult(result);
  projectionCache.set(result, { fingerprint, projected });
  return projected;
}

/**
 * Lightweight result projection for checkpoint events: state + usage +
 * pointers only. Keeps checkpoint entries small so the parent session file
 * does not bloat during long runs. Transcripts are persisted once, at terminal.
 */
export function toCheckpointResult(result: TaskResult): PersistedResult {
  const routing = normalizeTaskRouting((result as { routing?: unknown }).routing);
  return {
    label: result.label,
    task: result.task.slice(0, 200),
    state: result.state,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    timeoutPhase: result.timeoutPhase,
    errorMessage: utf8Prefix(result.errorMessage, 1_000),
    usage: result.usage,
    model: result.model,
    thinking: result.thinking,
    profile: result.profile,
    backend: result.backend,
    canWrite: result.canWrite,
    outputFile: result.outputFile,
    outputMode: result.outputMode,
    sessionId: result.sessionId,
    process: result.process,
    worktree: result.worktree,
    wrappedUp: result.wrappedUp,
    stalledSince: result.stalledSince,
    attempts: result.attempts,
    attemptedModels: normalizeAttemptedModels(result.attemptedModels),
    toolActivity: result.toolActivity,
    // Checkpoints carry attempt metadata/pointers only — preview TEXT is
    // persisted exactly once at terminal, so repeated checkpoints stay small.
    modelAttempts: normalizeModelAttempts(result.modelAttempts)?.map((record) => ({
      attempt: record.attempt,
      rank: record.rank,
      model: record.model,
      probability: record.probability,
      outcome: record.outcome,
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
      ...(record.failureCategory === undefined ? {} : { failureCategory: record.failureCategory }),
      ...(record.toolActivity === undefined ? {} : { toolActivity: record.toolActivity }),
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    })),
    ...(routing === undefined ? {} : { routing }),
  };
}

/**
 * One shared LiveRun → RunSnapshot projection with capped transcripts.
 * Unchanged task results reuse their cached projection (see toPersistedResultCached).
 */
export function snapshotFromLiveRun(run: LiveRun): RunSnapshot {
  return {
    schemaVersion: 1,
    id: run.id,
    sessionKey: run.sessionKey,
    mode: run.mode,
    state: run.state,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    taskPreviews: run.taskPreviews,
    summary: run.summary,
    delivered: run.delivered,
    results: run.results.map(toPersistedResultCached),
  };
}

export interface ResumeAvailabilityConflict {
  sessionId: string;
  runId: string;
  /** Which read-only source rejected: in-process holder, persisted block, or durable lock. */
  reason: "active" | "blocked" | "durable";
}

/** Result of the side-effect-free direct-resume preflight (mirrors acquireResumeLocks). */
export interface ResumeAvailabilityResult {
  ok: boolean;
  conflict?: ResumeAvailabilityConflict;
  /** Session ids whose durable lock is provably stale (reclaimable) but left untouched. */
  reclaimable?: string[];
}

/** Minimal task shape the read-only resume check reads; never acquires anything. */
export interface DirectResumeTask {
  resume?: string;
  forkResume?: boolean;
}

/** Session-owned live state plus immutable, bounded terminal snapshots. */
export class SessionScopedRunRegistry {
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly persistence: PersistenceLayer;
  private readonly listeners = new Set<(event: RegistryEvent) => void>();
  private readonly pendingEmits = new Map<string, NodeJS.Timeout>();
  private readonly locks?: ProcessLockManager;

  constructor(
    private readonly config: SubagentConfig,
    persistenceAdapter: PersistenceAdapter,
    locks?: ProcessLockManager,
  ) {
    this.persistence = new PersistenceLayer(persistenceAdapter, config);
    this.locks = locks;
  }

  allocateRunId(): string {
    return randomUUID();
  }

  subscribe(listener: (event: RegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RegistryEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /**
   * Coalesce per-run "changed" bursts (live-text ticks can arrive per stdout
   * chunk) into at most one listener notification per window. Terminal and
   * structural events always flush immediately.
   */
  private emitChanged(sessionKey: string, runId: string, immediate = false): void {
    const key = `${sessionKey}\u0000${runId}`;
    if (immediate) {
      const pending = this.pendingEmits.get(key);
      if (pending) {
        clearTimeout(pending);
        this.pendingEmits.delete(key);
      }
      this.emit({ type: "changed", sessionKey, runId });
      return;
    }
    if (this.pendingEmits.has(key)) return;
    const timer = setTimeout(() => {
      this.pendingEmits.delete(key);
      this.emit({ type: "changed", sessionKey, runId });
    }, EMIT_COALESCE_MS);
    timer.unref?.();
    this.pendingEmits.set(key, timer);
  }

  private clearPendingEmits(sessionKey?: string): void {
    for (const [key, timer] of this.pendingEmits) {
      if (sessionKey && !key.startsWith(`${sessionKey}\u0000`)) continue;
      clearTimeout(timer);
      this.pendingEmits.delete(key);
    }
  }

  private getOrCreateRuntime(sessionKey: string): SessionRuntime {
    let runtime = this.runtimes.get(sessionKey);
    if (!runtime) {
      runtime = {
        sessionKey,
        runs: new Map(),
        snapshots: this.persistence.rebuild(sessionKey),
        activeResumes: new Map(),
        shuttingDown: false,
      };
      this.runtimes.set(sessionKey, runtime);
    }
    return runtime;
  }

  getSessionRuntime(sessionKey: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionKey);
  }

  getLiveRuns(sessionKey: string): LiveRun[] {
    return [...this.getOrCreateRuntime(sessionKey).runs.values()];
  }

  getSnapshots(sessionKey: string): RunSnapshot[] {
    return [...this.getOrCreateRuntime(sessionKey).snapshots.values()];
  }

  /** Live cwds of worktree-isolated tasks; used to protect them from sweeps. */
  getLiveWorktreeCwds(sessionKey: string): Set<string> {
    const cwds = new Set<string>();
    for (const run of this.getOrCreateRuntime(sessionKey).runs.values()) {
      for (const result of run.results) if (result.worktree?.cwd) cwds.add(result.worktree.cwd);
      for (const spec of run.taskSpecs) if (spec.isolation === "worktree" && spec.cwd) cwds.add(spec.cwd);
    }
    return cwds;
  }

  /** Rebuild terminal history after active-branch navigation. Live runs stay session-owned. */
  refreshSnapshots(sessionKey: string): void {
    const runtime = this.getOrCreateRuntime(sessionKey);
    runtime.snapshots = this.persistence.rebuild(sessionKey);
    this.capSnapshots(runtime);
    this.emitChanged(sessionKey, "branch", true);
  }

  lookup(idOrPrefix: string, sessionKey: string): RunLookupResult {
    if (!idOrPrefix) return { status: "not-found" };
    const runtime = this.getOrCreateRuntime(sessionKey);
    const exact = runtime.runs.get(idOrPrefix) ?? runtime.snapshots.get(idOrPrefix);
    if (exact) return { status: "found", run: exact };

    const matches = new Map<string, LiveRun | RunSnapshot>();
    for (const [id, run] of runtime.runs) if (id.startsWith(idOrPrefix)) matches.set(id, run);
    for (const [id, run] of runtime.snapshots) if (id.startsWith(idOrPrefix)) matches.set(id, run);
    if (matches.size === 0) return { status: "not-found" };
    if (matches.size > 1) return { status: "ambiguous", matches: [...matches.keys()].sort() };
    return { status: "found", run: [...matches.values()][0] };
  }

  start(
    sessionKey: string,
    mode: RunMode,
    specs: TaskSpec[],
    controller: AbortController,
    promise: Promise<unknown>,
    labels: string[] = [],
    id = this.allocateRunId(),
  ): string {
    const runtime = this.getOrCreateRuntime(sessionKey);
    if (runtime.shuttingDown) throw new Error("Cannot start a subagent while the parent session is shutting down");
    if (runtime.runs.has(id) || runtime.snapshots.has(id)) throw new Error(`Duplicate run id ${id}`);

    const startedAt = Date.now();
    const taskPreviews = specs.map((spec, i) => `${labels[i] || `task-${i + 1}`}: ${spec.task.slice(0, 120)}`);
    const results: TaskResult[] = specs.map((spec, i) => ({
      label: labels[i] || `task-${i + 1}`,
      task: spec.task,
      state: "queued",
      exitCode: null,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      outputFile: spec.output,
      outputMode: spec.outputMode,
      model: spec.model,
      routing: spec.routing,
      thinking: spec.thinking,
      profile: spec.profile,
      backend: spec.backend,
      canWrite: spec.canWrite,
      protocol: {
        headerSeen: false,
        assistantEndSeen: false,
        agentEndSeen: false,
        agentSettledSeen: false,
        validEvents: 0,
        parseErrors: 0,
      },
    }));

    runtime.runs.set(id, {
      id,
      sessionKey,
      mode,
      state: "queued",
      startedAt,
      taskPreviews,
      taskSpecs: [...specs],
      results,
      delivered: false,
      promise,
      controller,
      childSessionIds: new Set(),
      lastProgressCheckpoint: 0,
    });
    this.persistence.persist(id, sessionKey, "start", {
      mode,
      state: "queued",
      startedAt,
      taskPreviews,
      results: results.map(toCheckpointResult),
    });
    this.emitChanged(sessionKey, id, true);
    return id;
  }

  checkpoint(
    id: string,
    sessionKey: string,
    updates: {
      childSessionId?: string;
      progress?: string;
      turn?: number;
      resultIndex?: number;
      resultUpdate?: Partial<TaskResult>;
      state?: RunState;
    },
  ): boolean {
    const runtime = this.runtimes.get(sessionKey);
    const run = runtime?.runs.get(id);
    if (!runtime || !run || run.sessionKey !== sessionKey || runtime.shuttingDown) return false;

    const index = updates.resultIndex ?? 0;
    const result = run.results[index];
    const previousTurns = result?.usage.turns ?? 0;
    const previousCost = result?.usage.cost ?? 0;
    const previousRunState = run.state;
    if (result && updates.resultUpdate) Object.assign(result, updates.resultUpdate);
    const usageAdvanced = !!result && (result.usage.turns > previousTurns || result.usage.cost > previousCost);
    if (updates.state) run.state = updates.state;
    else if (run.state === "queued") run.state = "running";
    const stateChanged = run.state !== previousRunState;

    const childSessionId = updates.childSessionId ?? updates.resultUpdate?.sessionId;
    let newChildSession = false;
    if (childSessionId) {
      newChildSession = !run.childSessionIds.has(childSessionId);
      run.childSessionIds.add(childSessionId);
      if (result) result.sessionId = childSessionId;
      // Crash recovery requirement: session ids are never throttled.
      if (newChildSession) {
        this.persistence.persist(id, sessionKey, "checkpoint", {
          state: run.state,
          resultIndex: index,
          childSessionId,
          results: run.results.map(toCheckpointResult),
        });
      }
    }

    // Persist lightweight checkpoints (state + usage + pointers, never
    // transcripts) only when billed usage advanced, or on a throttled progress
    // beat. Full transcripts are written exactly once, in the terminal event.
    const now = Date.now();
    if (usageAdvanced || ((updates.progress || updates.turn !== undefined) && now - run.lastProgressCheckpoint >= 500)) {
      run.lastProgressCheckpoint = now;
      this.persistence.persist(id, sessionKey, "checkpoint", {
        state: run.state,
        resultIndex: index,
        progress: utf8Prefix(updates.progress, 200),
        turn: updates.turn,
        results: run.results.map(toCheckpointResult),
      });
    }
    // Structural changes flush immediately; live-text ticks coalesce.
    this.emitChanged(sessionKey, id, usageAdvanced || stateChanged || newChildSession);
    return true;
  }

  complete(
    id: string,
    sessionKey: string,
    finalState: RunState,
    summary?: string,
    finalResults?: TaskResult[],
  ): boolean {
    const runtime = this.runtimes.get(sessionKey);
    const run = runtime?.runs.get(id);
    if (!runtime || !run || run.sessionKey !== sessionKey) return false;

    const endedAt = Date.now();
    const results = finalResults ?? run.results;
    const snapshot: RunSnapshot = {
      schemaVersion: 1,
      id,
      sessionKey,
      mode: run.mode,
      state: terminalStates.has(finalState) ? finalState : "failed",
      startedAt: run.startedAt,
      endedAt,
      taskPreviews: run.taskPreviews,
      summary,
      delivered: run.delivered,
      results: results.map(toPersistedResult),
    };
    runtime.snapshots.set(id, snapshot);
    runtime.runs.delete(id);
    this.releaseLocksForRun(runtime, id);
    this.persistence.persist(id, sessionKey, "terminal", {
      mode: snapshot.mode,
      state: snapshot.state,
      startedAt: snapshot.startedAt,
      endedAt,
      taskPreviews: snapshot.taskPreviews,
      summary,
      delivered: snapshot.delivered,
      results: snapshot.results,
    });
    this.capSnapshots(runtime);
    this.clearPendingEmitsForRun(sessionKey, id);
    this.emit({ type: "terminal", sessionKey, runId: id, state: snapshot.state });
    return true;
  }

  private clearPendingEmitsForRun(sessionKey: string, runId: string): void {
    const key = `${sessionKey}\u0000${runId}`;
    const pending = this.pendingEmits.get(key);
    if (pending) {
      clearTimeout(pending);
      this.pendingEmits.delete(key);
    }
  }

  /** Returns false when this result was already delivered. */
  markDelivered(id: string, sessionKey: string): boolean {
    const runtime = this.getOrCreateRuntime(sessionKey);
    const run = runtime.runs.get(id) ?? runtime.snapshots.get(id);
    if (!run || run.delivered) return false;
    // A failed append must leave the result claimable by a later wait.
    this.persistence.markDelivered(id, sessionKey);
    run.delivered = true;
    this.emitChanged(sessionKey, id, true);
    return true;
  }

  markDismissed(id: string, sessionKey: string): boolean {
    return this.markDelivered(id, sessionKey);
  }

  /** UI history eviction must never evict unresolved ownership safety state. */
  private resumeSafetySnapshots(sessionKey: string): Map<string, RunSnapshot> {
    const snapshots = this.persistence.rebuild(sessionKey);
    const runtime = this.runtimes.get(sessionKey);
    if (runtime) {
      // Persisted checkpoints of runs we still own are not lost/orphaned runs.
      for (const id of runtime.runs.keys()) snapshots.delete(id);
      for (const [id, snapshot] of runtime.snapshots) snapshots.set(id, snapshot);
    }
    return snapshots;
  }

  acquireResumeLocks(childSessionIds: string[], runId: string, sessionKey: string): {
    ok: boolean;
    conflict?: { sessionId: string; runId: string };
  } {
    const runtime = this.getOrCreateRuntime(sessionKey);
    const unique = [...new Set(childSessionIds.filter(Boolean))];
    // Block resume of runs whose ownership is not yet proven dead.
    for (const snapshot of this.resumeSafetySnapshots(sessionKey).values()) {
      if (!snapshot.resumeBlocked) continue;
      for (const result of snapshot.results) {
        if (result.sessionId && unique.includes(result.sessionId)) {
          return {
            ok: false,
            conflict: {
              sessionId: result.sessionId,
              runId: snapshot.id,
            },
          };
        }
      }
    }
    // In-memory lock first (fast path within one process).
    for (const sessionId of unique) {
      const holder = runtime.activeResumes.get(sessionId);
      if (holder && holder !== runId) return { ok: false, conflict: { sessionId, runId: holder } };
    }
    // Durable, machine-wide lock — survival across parent crashes and cross-process contention.
    const durableHeld: string[] = [];
    if (this.locks) {
      try {
      for (const sessionId of unique) {
        const acquired = this.locks.acquireSessionLock(sessionId, {
          ownerId: `${sessionKey}:${runId}`,
          runId,
          parentSessionKey: sessionKey,
        });
        if (!acquired.ok) {
          for (const held of durableHeld) this.locks.releaseSessionLock(held, runId);
          return {
            ok: false,
            conflict: { sessionId: acquired.conflict.childSessionId, runId: acquired.conflict.runId },
          };
        }
        durableHeld.push(sessionId);
      }
      } catch (error) {
        for (const held of durableHeld) this.locks.releaseSessionLock(held, runId);
        throw error;
      }
    }
    for (const sessionId of unique) runtime.activeResumes.set(sessionId, runId);
    return { ok: true };
  }

  acquireResumeLock(childSessionId: string, runId: string, sessionKey: string, isFork = false): boolean {
    if (isFork) return true;
    return this.acquireResumeLocks([childSessionId], runId, sessionKey).ok;
  }

  /**
   * Side-effect-free counterpart to `acquireResumeLocks` for the pre-inference preflight.
   *
   * Checks, in the same order as the authoritative acquire path, in-memory active resume
   * holders, persisted `resumeBlocked` snapshots and durable machine-wide locks. It never
   * creates/renews/reaps a lock, never registers a runtime entry and never mutates state,
   * so a successful check is an observation, not a reservation. `forkResume:true` tasks are
   * skipped (they never take the exclusive direct-resume lock). Provably stale durable locks
   * are surfaced as `reclaimable` and left in place for the atomic acquire at launch.
   */
  checkResumeAvailability(tasks: readonly DirectResumeTask[], sessionKey: string): ResumeAvailabilityResult {
    const runtime = this.runtimes.get(sessionKey);
    const unique = [...new Set(tasks
      .filter((task) => !!task && typeof task.resume === "string" && task.resume.length > 0 && task.forkResume !== true)
      .map((task) => task.resume as string))];
    if (unique.length === 0) return { ok: true };

    // Rebuild safety state independently of the bounded UI history.
    const snapshots = this.resumeSafetySnapshots(sessionKey);
    // Block resume of runs whose ownership is not yet proven dead.
    for (const snapshot of snapshots.values()) {
      if (!snapshot.resumeBlocked) continue;
      for (const result of snapshot.results) {
        if (result.sessionId && unique.includes(result.sessionId)) {
          return { ok: false, conflict: { sessionId: result.sessionId, runId: snapshot.id, reason: "blocked" } };
        }
      }
    }
    // In-memory lock holders in this process (only known once the runtime exists).
    if (runtime) {
      for (const sessionId of unique) {
        const holder = runtime.activeResumes.get(sessionId);
        if (holder) return { ok: false, conflict: { sessionId, runId: holder, reason: "active" } };
      }
    }

    const reclaimable: string[] = [];
    if (this.locks) {
      for (const sessionId of unique) {
        const availability = this.locks.checkResumeAvailability(sessionId);
        if (availability.status === "held") {
          return {
            ok: false,
            conflict: { sessionId, runId: availability.owner?.runId ?? "unknown", reason: "durable" },
          };
        }
        if (availability.status === "reclaimable") reclaimable.push(sessionId);
      }
    }
    return reclaimable.length ? { ok: true, reclaimable } : { ok: true };
  }

  releaseResumeLock(childSessionId: string, sessionKey: string, runId?: string): void {
    const runtime = this.runtimes.get(sessionKey);
    if (!runtime) return;
    if (!runId || runtime.activeResumes.get(childSessionId) === runId) runtime.activeResumes.delete(childSessionId);
    if (this.locks) this.locks.releaseSessionLock(childSessionId, runId);
  }

  private releaseLocksForRun(runtime: SessionRuntime, runId: string): void {
    for (const [sessionId, holder] of [...runtime.activeResumes]) {
      if (holder === runId) {
        runtime.activeResumes.delete(sessionId);
        this.locks?.releaseSessionLock(sessionId, runId);
      }
    }
  }

  /** Clear the resume-blocked flag after orphan reconcile has proven the child dead. */
  clearResumeBlock(id: string, sessionKey: string): void {
    const runtime = this.getOrCreateRuntime(sessionKey);
    const snapshot = runtime.snapshots.get(id) ?? this.resumeSafetySnapshots(sessionKey).get(id);
    if (!snapshot || !snapshot.resumeBlocked) return;
    snapshot.resumeBlocked = false;
    this.persistence.persist(id, sessionKey, "checkpoint", { resumeBlocked: false, state: snapshot.state });
    this.emitChanged(sessionKey, id, true);
  }

  async shutdown(sessionKey: string, graceMs = 8_000): Promise<void> {
    const runtime = this.runtimes.get(sessionKey);
    if (!runtime) return;
    runtime.shuttingDown = true;
    const live = [...runtime.runs.values()];
    for (const run of live) run.controller.abort();

    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(live.map((run) => run.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);

    // Any orchestration promise that did not call complete is snapshotted as cancelled.
    for (const run of [...runtime.runs.values()]) {
      this.complete(run.id, sessionKey, "cancelled", "Cancelled when the parent session shut down", run.results);
    }
    runtime.activeResumes.clear();
    runtime.shuttingDown = false;
    this.clearPendingEmits(sessionKey);
  }

  planSessionRetention(referencedSessionIds = new Set<string>()): { keep: string[]; candidates: string[] } {
    return this.persistence.planRetention(referencedSessionIds);
  }

  private capSnapshots(runtime: SessionRuntime): void {
    while (runtime.snapshots.size > this.config.maxCompletedInMemory) {
      const oldest = [...runtime.snapshots.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!oldest) break;
      runtime.snapshots.delete(oldest.id);
    }
  }
}
