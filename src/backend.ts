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
  /**
   * Consume a stdout chunk, yielding zero or more normalized updates. Buffer
   * inputs may split UTF-8 characters or LF delimiters; implementations must
   * decode incrementally and never treat a chunk boundary as stream end.
   */
  feed(data: Buffer | string): ProtocolUpdate[];
  /**
   * End the incremental decoder and flush one final unterminated line. This is
   * called at most once by the runner, and repeated calls must be harmless.
   */
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
  readonly name: string;
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
  /** Resolves the Pi command/argv. */
  getPiCommand: (args: string[]) => { command: string; args: string[] };
}

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
  adapterName: string,
): string[] {
  const problems: string[] = [];
  if (spec.maxCost !== undefined && !capabilities.costReporting) {
    problems.push(
      `adapter '${adapterName}' does not report per-turn cost, so max_cost cannot be enforced; drop max_cost or use max_turns instead; tool timeout_ms only reminds and does not enforce a budget`,
    );
  }
  if (spec.resume && !capabilities.resume) {
    problems.push(`adapter '${adapterName}' cannot resume child sessions; drop resume`);
  }
  if ((spec.forkResume || spec.contextFork) && !capabilities.fork) {
    problems.push(`adapter '${adapterName}' cannot fork sessions; drop fork_resume / context:'fork'`);
  }
  // A read-only profile that cannot be enforced is a write-safety hole.
  if (spec.tools !== undefined && !capabilities.toolRestriction) {
    problems.push(
      `adapter '${adapterName}' cannot restrict the child's tools, so profile '${spec.profile ?? "explore"}' cannot be enforced; use profile:'general' with an explicitly writable adapter, or the Pi adapter`,
    );
  }
  if (spec.thinking !== undefined && !capabilities.thinking) {
    problems.push(`adapter '${adapterName}' does not support thinking level '${spec.thinking}'; omit thinking or use the Pi adapter`);
  }
  if (spec.outputSchema && !capabilities.outputSchema) {
    problems.push(`adapter '${adapterName}' does not support output_schema; drop it`);
  }
  return problems;
}
