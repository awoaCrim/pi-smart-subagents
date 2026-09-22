import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskProfile } from "./types.js";
import { JEV_ROUTING_CONFIG_FILE, parseJevRouting, type JevRoutingConfig } from "./routing-policy.js";
import { isThinkingLevel, type ThinkingLevel } from "./thinking.js";

export type { ThinkingLevel } from "./thinking.js";

const WIDGET_MODES = ["background", "off"] as const;
export type WidgetMode = (typeof WIDGET_MODES)[number];
const NOTIFICATION_MODES = ["batched", "off"] as const;
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];

/**
 * Per-profile defaults applied when a task omits the field. Explicit request
 * values always win; profile defaults beat parent-session inheritance for
 * thinking and budgets. Legacy model/fallback defaults do not select routes.
 */
export interface TaskDefaults {
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  maxCost?: number;
  timeoutMs?: number;
  /** Ordered backup models tried on transient provider failures. */
  fallbackModels?: string[];
  /** Extra attempts on transient failures. */
  maxRetries?: number;
}

export type TaskDefaultsByProfile = Partial<Record<TaskProfile, TaskDefaults>>;

export interface SubagentConfig {
  maxTasksPerRun: number;
  maxActiveProcesses: number;
  maxQueuedTasks: number;
  defaultTimeoutMs: number;
  maxResultBytes: number;
  maxResultLines: number;
  maxDetailsTextBytes: number;
  maxCompletedInMemory: number;
  maxDepth: number;
  /** Grace period between SIGTERM and SIGKILL for child process trees. */
  killGraceMs: number;
  sessionDir: string;
  /** Durable root for subagent git worktrees (never a purgeable tmpdir). */
  worktreeDir: string;
  /** Durable root for machine-wide locks, slots, and run process records. */
  lockDir: string;
  /**
   * Machine-wide concurrent child process cap across every Pi parent process.
   * 0 disables the global limiter (per-session maxActiveProcesses still applies).
   */
  maxGlobalActive: number;
  /** Days after which unchanged, orphaned worktrees are swept. 0 disables. */
  worktreeRetentionDays: number;
  /** Days after which unreferenced child session files are swept. Unset/0 disables. */
  sessionRetentionDays?: number;
  /** Days after which terminal run process records / dead locks are swept. */
  lockRetentionDays: number;
  /** Legacy per-profile defaults. Model/fallback fields are retained for config compatibility but ignored by Jev routing. */
  taskDefaults?: TaskDefaultsByProfile;
  /** Private Jev configuration including apiKey. Never log or serialize the whole config. */
  jevRouting?: JevRoutingConfig;
  /** Safe migration or parse failure; existing-run management remains available. */
  jevRoutingError?: string;
  /**
   * Wrap-up grace turns after a max_turns/max_cost breach: the child is steered
   * to produce a final answer and given this many extra turns before SIGTERM.
   * 0 restores the old immediate-stop behavior.
   */
  graceTurns: number;
  /** Milliseconds of protocol silence before a running child is flagged as stalled. 0 disables. */
  stallAfterMs: number;
  /** Additional silence after the stall flag before the child is killed (feeds retry). 0 disables kill. */
  stallKillAfterMs: number;
  /** Default extra attempts on transient failures (queued timeout, stall, provider error). */
  maxRetries: number;
  /**
   * Ambient background-run widget above the editor. `"off"` clears any existing
   * widget and skips refreshes.
   */
  widget: WidgetMode;
  /**
   * Batched completion messages for async runs. `"off"` disables the
   * CompletionBatcher so the parent is not notified on finish.
   */
  notifications: NotificationMode;
}

export const defaultConfig: SubagentConfig = {
  maxTasksPerRun: 8,
  maxActiveProcesses: 4,
  maxQueuedTasks: 32,
  defaultTimeoutMs: 15 * 60_000,
  maxResultBytes: 50 * 1024,
  maxResultLines: 2_000,
  maxDetailsTextBytes: 10 * 1024,
  maxCompletedInMemory: 20,
  maxDepth: 2,
  killGraceMs: 3_000,
  sessionDir: path.join(os.homedir(), ".pi", "subagent-sessions"),
  worktreeDir: path.join(os.homedir(), ".pi", "subagent-worktrees"),
  lockDir: path.join(os.homedir(), ".pi", "subagent-locks"),
  maxGlobalActive: 16,
  worktreeRetentionDays: 7,
  lockRetentionDays: 7,
  graceTurns: 2,
  stallAfterMs: 90_000,
  stallKillAfterMs: 90_000,
  maxRetries: 1,
  widget: "background",
  notifications: "batched",
};

/** User-facing config file. Env vars override file values; both override defaults. */
export const CONFIG_FILE = path.join(os.homedir(), ".pi", "subagent.json");

function positiveNumber(value: unknown, min = 1): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= min ? parsed : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oneOf<T extends readonly string[]>(allowed: T, value: unknown): T[number] | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : undefined;
}

function prune<T extends object>(value: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function sanitizeTaskDefaults(raw: unknown): TaskDefaults | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const thinking = isThinkingLevel(value.thinking) ? value.thinking : undefined;
  const fallbackModels = Array.isArray(value.fallbackModels)
    ? value.fallbackModels.map(nonEmptyString).filter((model): model is string => !!model)
    : undefined;
  const defaults = prune<TaskDefaults>({
    model: nonEmptyString(value.model),
    thinking,
    maxTurns: positiveNumber(value.maxTurns),
    maxCost: positiveNumber(value.maxCost, 0),
    timeoutMs: positiveNumber(value.timeoutMs),
    fallbackModels: fallbackModels?.length ? fallbackModels : undefined,
    maxRetries: positiveNumber(value.maxRetries, 0),
  });
  return Object.keys(defaults).length ? defaults : undefined;
}

function sanitizeTaskDefaultsByProfile(raw: unknown): TaskDefaultsByProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const result: TaskDefaultsByProfile = {};
  for (const profile of ["explore", "review", "general"] as const) {
    const defaults = sanitizeTaskDefaults(value[profile]);
    if (defaults) result[profile] = defaults;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Validate untrusted JSON overrides field-by-field; unknown keys are dropped. */
export function sanitizeConfigOverrides(raw: unknown, source = JEV_ROUTING_CONFIG_FILE): Partial<SubagentConfig> {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  let jevRouting: JevRoutingConfig | undefined;
  let jevRoutingError: string | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "modelPolicy")) {
    jevRoutingError = `Remove legacy modelPolicy from ${source} and configure jevRouting.models with exact IDs and user-written descriptions. Fixed routing is no longer supported; management remains available.`;
  } else if (Object.prototype.hasOwnProperty.call(value, "jevRouting")) {
    try {
      jevRouting = parseJevRouting(value.jevRouting, source);
    } catch (error) {
      jevRoutingError = error instanceof Error ? error.message : "Invalid jevRouting configuration.";
    }
  }
  return prune<SubagentConfig>({
    jevRouting,
    jevRoutingError,
    taskDefaults: sanitizeTaskDefaultsByProfile(value.taskDefaults),
    maxTasksPerRun: positiveNumber(value.maxTasksPerRun),
    maxActiveProcesses: positiveNumber(value.maxActiveProcesses),
    maxQueuedTasks: positiveNumber(value.maxQueuedTasks, 0),
    defaultTimeoutMs: positiveNumber(value.defaultTimeoutMs),
    maxResultBytes: positiveNumber(value.maxResultBytes, 1024),
    maxResultLines: positiveNumber(value.maxResultLines, 10),
    maxDetailsTextBytes: positiveNumber(value.maxDetailsTextBytes, 256),
    maxCompletedInMemory: positiveNumber(value.maxCompletedInMemory),
    maxDepth: positiveNumber(value.maxDepth, 0),
    killGraceMs: positiveNumber(value.killGraceMs, 100),
    sessionDir: nonEmptyString(value.sessionDir),
    worktreeDir: nonEmptyString(value.worktreeDir),
    lockDir: nonEmptyString(value.lockDir),
    maxGlobalActive: positiveNumber(value.maxGlobalActive, 0),
    worktreeRetentionDays: positiveNumber(value.worktreeRetentionDays, 0),
    sessionRetentionDays: positiveNumber(value.sessionRetentionDays, 0),
    lockRetentionDays: positiveNumber(value.lockRetentionDays, 0),
    graceTurns: positiveNumber(value.graceTurns, 0),
    stallAfterMs: positiveNumber(value.stallAfterMs, 0),
    stallKillAfterMs: positiveNumber(value.stallKillAfterMs, 0),
    maxRetries: positiveNumber(value.maxRetries, 0),
    widget: oneOf(WIDGET_MODES, value.widget),
    notifications: oneOf(NOTIFICATION_MODES, value.notifications),
  });
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<SubagentConfig> {
  return prune<SubagentConfig>({
    maxTasksPerRun: positiveNumber(env.PI_SUBAGENT_MAX_TASKS),
    maxActiveProcesses: positiveNumber(env.PI_SUBAGENT_MAX_ACTIVE),
    maxQueuedTasks: positiveNumber(env.PI_SUBAGENT_MAX_QUEUED, 0),
    defaultTimeoutMs: positiveNumber(env.PI_SUBAGENT_TIMEOUT_MS),
    maxDepth: positiveNumber(env.PI_SUBAGENT_MAX_DEPTH, 0),
    killGraceMs: positiveNumber(env.PI_SUBAGENT_KILL_GRACE_MS, 100),
    sessionDir: nonEmptyString(env.PI_SUBAGENT_SESSION_DIR),
    worktreeDir: nonEmptyString(env.PI_SUBAGENT_WORKTREE_DIR),
    lockDir: nonEmptyString(env.PI_SUBAGENT_LOCK_DIR),
    maxGlobalActive: positiveNumber(env.PI_SUBAGENT_MAX_GLOBAL_ACTIVE, 0),
    worktreeRetentionDays: positiveNumber(env.PI_SUBAGENT_WORKTREE_RETENTION_DAYS, 0),
    sessionRetentionDays: positiveNumber(env.PI_SUBAGENT_SESSION_RETENTION_DAYS, 0),
    lockRetentionDays: positiveNumber(env.PI_SUBAGENT_LOCK_RETENTION_DAYS, 0),
    graceTurns: positiveNumber(env.PI_SUBAGENT_GRACE_TURNS, 0),
    stallAfterMs: positiveNumber(env.PI_SUBAGENT_STALL_AFTER_MS, 0),
    stallKillAfterMs: positiveNumber(env.PI_SUBAGENT_STALL_KILL_AFTER_MS, 0),
    maxRetries: positiveNumber(env.PI_SUBAGENT_MAX_RETRIES, 0),
    widget: oneOf(WIDGET_MODES, env.PI_SUBAGENT_WIDGET),
    notifications: oneOf(NOTIFICATION_MODES, env.PI_SUBAGENT_NOTIFICATIONS),
  });
}

/** defaults ← file overrides ← env overrides. Pure; suitable for tests. */
export function loadConfig(
  fileOverrides: Partial<SubagentConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): SubagentConfig {
  return { ...defaultConfig, ...prune(fileOverrides), ...configFromEnv(env) };
}

/** Read + sanitize the optional user config file. Missing or invalid files yield {}. */
export async function readConfigFile(file = CONFIG_FILE): Promise<Partial<SubagentConfig>> {
  try {
    return sanitizeConfigOverrides(JSON.parse(await fs.readFile(file, "utf8")), file);
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    return { jevRoutingError: `Could not read ${file} as JSON; Jev routing was not loaded. Existing-run management remains available.` };
  }
}
