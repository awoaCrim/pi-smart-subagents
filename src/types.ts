import type { Message } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./thinking.js";
import type { RoutingDecision } from "./routing-types.js";

/** Validated selector decision plus mandatory local control-plane tools. */
export type TaskRouting = RoutingDecision & { readonly mandatoryTools: readonly string[]; readonly outcome: "success" };

export type RunMode = "single" | "parallel";
export type RunState = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled" | "lost" | "timeout";
/** Distinct timeout phases so agents can retry queue pressure without "fixing" unfinished work. */
export type TimeoutPhase = "queued" | "starting" | "running" | "cancelling";
export type TaskProfile = "explore" | "review" | "general";
export type OutputMode = "inline" | "file-only";

/** Durable identity of a spawned child process for orphan reconcile. */
export interface ChildProcessIdentity {
  pid: number;
  /** Platform-specific process start identity; 0 when unknown. */
  startTime: number;
  pgid?: number;
  hostname?: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning is a subset of output when providers report it. */
  reasoning?: number;
  /** Provider-reported total cost. */
  cost: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  /** Most recent turn's context size; not additive across turns. */
  contextTokens: number;
  turns: number;
}

export type BackendName = "pi" | "codex" | "claude";

/**
 * Sticky current-invocation tool activity for the pre-tool switch boundary. `started` latches on tool_execution_start, a newly observed
 * completed assistant toolCall or a toolResult; `unknown` marks malformed,
 * truncated or absent evidence. Both are sticky: neither can be erased by a
 * later complete event, and only a conclusive `none` authorizes a new child.
 */
export type ToolActivity = "none" | "started" | "unknown";

/**
 * Conservative classification of the latest completed assistant provider error
 * (see `model-failover.ts`). Only the availability categories advance the
 * ranked path; everything else stops and is reported without switching.
 */
export type ModelFailureCategory =
  | "model_unavailable"
  | "rate_limited"
  | "service_overload"
  | "transport"
  | "auth"
  | "quota"
  | "invalid_request"
  | "context_overflow"
  | "refusal"
  | "unknown";

/**
 * One locally finalized ranked execution candidate. Internal contract built by
 * `policy.ts` from the validated ranking and the original model catalog; never
 * a tool-request/config field and never decoded from a persisted snapshot into
 * an executable plan. Thinking follows explicit > agent > profile > candidate >
 * parent per entry; tools/writer classification are shared across all entries.
 */
export interface ModelAttemptSpec {
  readonly model: string;
  readonly probability: number;
  readonly thinking?: ThinkingLevel;
}

/**
 * Bounded descriptive history for one ranked/legacy attempt. Records are not
 * a second usage ledger (TaskResult.usage stays cumulative) and never become
 * executable: they carry the reason for a switch, the session pointer for
 * discoverable partial work, and a 1 KiB output preview (16 KiB per task).
 */
export interface ModelAttemptRecord {
  /** 1-based launch count for this task. */
  attempt: number;
  /** 0-based ranking position of the candidate that ran. */
  rank: number;
  model: string;
  probability: number;
  outcome: RunState;
  stopReason?: string;
  failureCategory?: ModelFailureCategory;
  toolActivity?: ToolActivity;
  sessionId?: string;
  /** Bounded output preview; metadata/session pointer survive when text is trimmed. */
  outputPreview?: string;
}

export interface TaskSpec {
  /** Agent CLI powering this child. Defaults to "pi". */
  backend?: BackendName;
  task: string;
  /** Short human label shown in UIs and result indexes. */
  label?: string;
  systemPrompt?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  profile: TaskProfile;
  canWrite?: boolean;
  cwd?: string;
  timeoutMs: number;
  /** Absolute extension task deadline; absent for legacy explicit-spec SDK callers. */
  deadline?: number;
  /** Present only after mandatory extension routing and local validation. */
  routing?: TaskRouting;
  maxTurns?: number;
  maxCost?: number;
  output?: string;
  outputMode?: OutputMode;
  resume?: string;
  forkResume?: boolean;
  isolation?: "shared" | "worktree";
  allowSharedWrites?: boolean;
  /** Seed worktree with parent checkout WIP (worktree isolation only). */
  includeWip?: boolean;
  /** Opt out of process-tree reaping after a clean exit (e.g. child-started dev servers). */
  keepBackground?: boolean;
  /** Wrap-up grace turns after a max_turns/max_cost breach before SIGTERM. 0 = immediate stop. */
  graceTurns?: number;
  /** Ordered backup models tried on transient provider failures. */
  fallbackModels?: string[];
  /** Extra launches: ranked pre-tool recovery, or the legacy SDK transient loop. */
  maxRetries?: number;
  /**
   * Locally finalized probability-ranked candidate plan for extension-managed
   * tasks (internal; built only by `policy.finalizeRoutedTasks`). Its presence
   * selects the ranked attempt loop; the legacy `fallbackModels` loop stays
   * untouched for trusted unranked SDK tasks.
   */
  modelAttemptPlan?: readonly ModelAttemptSpec[];
  /** Fork the parent conversation into the child (real branched session). */
  contextFork?: boolean;
  /** Parent session file used for contextFork. */
  parentSessionFile?: string;
  /** What this child may itself spawn; encoded into PI_SUBAGENT_SPAWNS. */
  spawns?: false | "*" | string[];
  /** JSON-Schema subset the child's final fenced json:result block must satisfy. */
  outputSchema?: Record<string, unknown>;
}

export interface TaskResult {
  label: string;
  task: string;
  state: RunState;
  exitCode: number | null;
  signal?: NodeJS.Signals;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  routing?: TaskRouting;
  thinking?: TaskSpec["thinking"];
  profile?: TaskProfile;
  /** Backend that produced this result (pi | codex | claude). */
  backend?: BackendName;
  canWrite?: boolean;
  stopReason?: string;
  /** Present when stopReason is a timeout-like outcome. */
  timeoutPhase?: TimeoutPhase;
  errorMessage?: string;
  index?: number;
  outputFile?: string;
  outputMode?: OutputMode;
  worktree?: { cwd: string; branch: string; baseCommit: string; changed: boolean; diffSummary?: string };
  sessionId?: string;
  /** Child process identity (persisted for orphan reclaim). */
  process?: ChildProcessIdentity;
  startedAt?: number;
  /** When the semaphore slot was acquired (runtime clock starts here). */
  acquiredAt?: number;
  endedAt?: number;
  liveText?: string;
  /** Incrementally-built compact transcript (assistant text, tool calls, tool results). */
  transcript?: string;
  /** True when a budget-stopped child wrapped up gracefully in its grace turns. */
  wrappedUp?: boolean;
  /** Set while no protocol activity has been seen for the stall window. */
  stalledSince?: number;
  /** Total attempts including retries (present when > 1). */
  attempts?: number;
  /** Models tried across attempts, in order. */
  attemptedModels?: string[];
  /** Sticky current-invocation tool activity across this task's attempts. */
  toolActivity?: ToolActivity;
  /**
   * Bounded errorMessage + primitive diagnostics.error.code from the latest
   * completed assistant provider error. Set only for stopReason "error";
   * generic runner/RPC errors and diagnostic bodies never fill it.
   */
  providerError?: string;
  /**
   * Runner-owned positive proof that no child/task work could have begun
   * (queue/admission timeout or a spawn that never produced a process). Only
   * this conclusive evidence permits a same-model infrastructure retry.
   */
  preWorkInfraFailure?: boolean;
  /** Bounded per-attempt history for ranked runs (descriptive, never executable). */
  modelAttempts?: ModelAttemptRecord[];
  /** Parsed structured result when output_schema was requested and validated. */
  structuredOutput?: unknown;
  /** Validation errors when output_schema was requested but the result failed. */
  structuredError?: string;
  protocol: {
    headerSeen: boolean;
    assistantEndSeen: boolean;
    agentEndSeen: boolean;
    agentSettledSeen: boolean;
    validEvents: number;
    parseErrors: number;
  };
}

export interface RunSnapshot {
  schemaVersion: 1;
  id: string;
  sessionKey: string;
  mode: RunMode;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  taskPreviews: string[];
  summary?: string;
  delivered: boolean;
  /** True when a previous owner was killed on reconcile; resume must not auto-reopen. */
  resumeBlocked?: boolean;
  results: Array<{
    label: string;
    task: string;
    state: RunState;
    exitCode: number | null;
    stopReason?: string;
    timeoutPhase?: TimeoutPhase;
    errorMessage?: string;
    usage: UsageStats;
    model?: string;
    routing?: TaskRouting;
    thinking?: TaskSpec["thinking"];
    profile?: TaskProfile;
    canWrite?: boolean;
    outputFile?: string;
    backend?: BackendName;
    outputMode?: OutputMode;
    worktree?: { cwd: string; branch: string; baseCommit: string; changed: boolean; diffSummary?: string };
    sessionId?: string;
    process?: ChildProcessIdentity;
    finalOutput?: string;
    transcript?: string;
    wrappedUp?: boolean;
    stalledSince?: number;
    attempts?: number;
    attemptedModels?: string[];
    /** Sticky tool-activity boundary state across the task's attempts. */
    toolActivity?: ToolActivity;
    /** Bounded ranked attempt history (descriptive; previews capped). */
    modelAttempts?: ModelAttemptRecord[];
    structuredOutput?: unknown;
    structuredError?: string;
  }>;
}

export interface ToolDetails {
  mode: RunMode;
  results: TaskResult[];
}

export const emptyUsage = (): UsageStats => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 0,
  costInput: 0,
  costOutput: 0,
  costCacheRead: 0,
  costCacheWrite: 0,
  contextTokens: 0,
  turns: 0,
});
