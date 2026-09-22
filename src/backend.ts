/**
 * Backend adapter seam.
 *
 * `ChildRunner` owns everything that is *not* agent-specific: semaphore and
 * global slot acquisition, worktree-prepared cwd, timeouts, budget wrap-up,
 * the stall watchdog, group-kill/PID-identity safety, structured-output
 * validation and repair, checkpointing and persistence.
 *
 * Only four things actually vary per agent CLI, and they live here:
 *
 *  1. `buildInvocation` — how to turn a TaskSpec into command + argv (+ any
 *     temp files that must be cleaned up afterwards).
 *  2. `createParser`    — how to turn that process's stdout into our
 *     normalized `ProtocolUpdate` stream and a final `TaskResult`.
 *  3. `steerCommand` / `stopCommand` — what to write on stdin to inject a
 *     message or ask for a graceful stop (undefined = unsupported).
 *  4. `capabilities`    — which features the backend can actually honor, so
 *     unsupported requests are *refused* rather than silently ignored.
 *
 * Capability honesty is the important part. A backend that cannot report
 * per-turn cost cannot enforce `max_cost`; pretending otherwise would let a
 * runaway child spend without a ceiling. Policy validation rejects such
 * combinations up front (see `assertCapabilities`).
 */

import type { ProtocolUpdate } from "./protocol.js";
import type { TaskResult, TaskSpec, ToolActivity } from "./types.js";

/** Normalized event-stream parser contract, implemented per backend. */
export interface BackendParser {
  /** Consume a stdout chunk, yielding zero or more normalized updates. */
  feed(data: Buffer | string): ProtocolUpdate[];
  /** Flush any buffered partial line at stream end. */
  flush(): ProtocolUpdate[];
  /** Build the terminal TaskResult from exit status. */
  finalize(exitCode: number | null, signal?: NodeJS.Signals, stderr?: string): TaskResult;
  /** Transcript for checkpointing, if the backend can produce one. */
  getTranscript(): string | undefined;
  /** Text of the in-flight assistant message. */
  getLiveText(): string;
  /** Completed messages so far. */
  getMessages(): import("@earendil-works/pi-ai").Message[];
  /**
   * Optional sticky current-invocation tool-activity observation used by the
   * ranked failover gate. Parsers that do not implement it provide no
   * conclusive evidence (callers must treat activity as unknown on the ranked
   * path); the legacy unranked path is unaffected.
   */
  getToolActivity?(): ToolActivity | undefined;
  /**
   * Optional stop reason of the latest completed assistant message, used to
   * suppress the ranked structured-output repair prompt and final publication
   * after a settled provider error/abort. Absent means "not observable".
   */
  getAssistantStopReason?(): string | undefined;
  /** Latest completed assistant text; empty must not fall back to earlier turns. */
  getAssistantText?(): string | undefined;
}

export interface BackendInvocation {
  command: string;
  args: string[];
  /** Extra env for the child, merged over the inherited environment. */
  env?: Record<string, string>;
  /** Directories to remove once the child exits (temp prompt files, etc.). */
  cleanupDirs?: string[];
}

/**
 * What a backend can actually do. Anything false is refused at validation
 * time with an explanatory error rather than silently degraded.
 */
export interface BackendCapabilities {
  /** Mid-run steering via a stdin command channel. */
  steer: boolean;
  /** Graceful budget wrap-up (needs steering to ask for a summary). */
  gracefulWrapUp: boolean;
  /** Per-turn provider usage/cost reporting — required for max_cost. */
  costReporting: boolean;
  /** Resuming a previous child session. */
  resume: boolean;
  /** Forking a session (context:'fork' / fork_resume). */
  fork: boolean;
  /** Restricting the child's tool set (profiles: explore/review). */
  toolRestriction: boolean;
  /** Reasoning-effort control. */
  thinking: boolean;
  /** Structured output via an appended schema contract. */
  outputSchema: boolean;
}

export interface BackendAdapter {
  readonly name: BackendName;
  readonly capabilities: BackendCapabilities;
  /**
   * Build the child invocation. May write temp files; return their parent
   * directories in `cleanupDirs` so the runner removes them on exit.
   */
  buildInvocation(spec: TaskSpec, context: BackendLaunchContext): Promise<BackendInvocation>;
  createParser(): BackendParser;
  /** stdin payload that injects a message mid-run, or undefined if unsupported. */
  steerCommand?(message: string): unknown;
  /** stdin payload requesting a graceful stop, or undefined if unsupported. */
  stopCommand?(): unknown;
  /** stdin payload answering an interactive UI request (headless auto-cancel). */
  uiCancelCommand?(id: string): unknown;
  /** stdin payload asking for session state (used to learn the session id). */
  stateCommand?(): unknown;
}

export interface BackendLaunchContext {
  /** Directory child sessions are written to. */
  sessionDir: string;
  /** Resolves the pi command/argv (pi backend only). */
  getPiCommand: (args: string[]) => { command: string; args: string[] };
}

export type BackendName = "pi" | "codex" | "claude";

export const BACKEND_NAMES: readonly BackendName[] = ["pi", "codex", "claude"];

/**
 * Reject requests a backend cannot honor. Returns a list of human-readable
 * problems; empty means the spec is satisfiable.
 *
 * This is deliberately strict: silently dropping `max_cost` or a read-only
 * profile would turn a safety feature into a no-op.
 */
export function checkCapabilities(
  spec: Partial<
    Pick<
      TaskSpec,
      "maxCost" | "resume" | "forkResume" | "contextFork" | "tools" | "thinking" | "outputSchema" | "profile" | "canWrite"
    >
  >,
  capabilities: BackendCapabilities,
  backend: BackendName,
): string[] {
  const problems: string[] = [];
  if (spec.maxCost !== undefined && !capabilities.costReporting) {
    problems.push(
      `backend '${backend}' does not report per-turn cost, so max_cost cannot be enforced; drop max_cost or use max_turns/timeout_ms instead`,
    );
  }
  if (spec.resume && !capabilities.resume) {
    problems.push(`backend '${backend}' cannot resume child sessions; drop resume`);
  }
  if ((spec.forkResume || spec.contextFork) && !capabilities.fork) {
    problems.push(`backend '${backend}' cannot fork sessions; drop fork_resume / context:'fork'`);
  }
  // A read-only profile that cannot be enforced is a write-safety hole.
  if (spec.tools !== undefined && !capabilities.toolRestriction) {
    problems.push(
      `backend '${backend}' cannot restrict the child's tools, so profile '${spec.profile ?? "explore"}' cannot be enforced; use profile:'general' with an explicitly writable backend, or the pi backend`,
    );
  }
  if (spec.thinking !== undefined && !capabilities.thinking) {
    problems.push(`backend '${backend}' does not support thinking level '${spec.thinking}'; omit thinking or use the pi backend`);
  }
  if (spec.outputSchema && !capabilities.outputSchema) {
    problems.push(`backend '${backend}' does not support output_schema; drop it`);
  }
  return problems;
}
