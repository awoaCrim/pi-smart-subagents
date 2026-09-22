import { Buffer } from "node:buffer";
import type { SubagentConfig } from "./config.js";
import {
  MAX_ATTEMPT_PREVIEW_BYTES,
  MAX_MODEL_ATTEMPT_RECORDS,
  trimAttemptPreviews,
  utf8SafePrefix,
  validateModelRanking,
} from "./model-failover.js";
import { MAX_ROUTING_MODEL_ID_LENGTH, MAX_ROUTING_TOOL_QUESTIONS, type RankedModelOption, type RoutingReceipt } from "./routing-types.js";
import type { ChildProcessIdentity, ModelAttemptRecord, ModelFailureCategory, RunMode, RunSnapshot, RunState, TaskProfile, TaskRouting, TaskSpec, TimeoutPhase, ToolActivity, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";
import { isThinkingLevel } from "./thinking.js";

export const RUN_ENTRY_TYPE = "subagent-run-v1";
/** Versioned persistence record for one selector HTTP receipt (upserted by full request ID). */
export const ROUTING_ENTRY_TYPE = "subagent-routing-v1";
/** Shared producer/replay bound for one atomic native delivery attachment. */
export const MAX_ROUTING_DELIVERY_IDS = 1024;

// ---- Bounded routing decode -------------------------------------------------
//
// Routing events and route metadata cross the persistence boundary as untrusted
// data (old snapshots, user-edited session files, concurrent writers). Decode
// field-by-field, cap every string/array, and never surface a value we could not
// validate. Unknown currency is always forced to the honest `"unknown"`.

const ROUTING_PURPOSES = ["plan", "dispatch", "synthesis"] as const;
const ROUTING_OUTCOMES = ["success", "error", "timeout", "aborted"] as const;
const ROUTING_USAGE_STATUSES = ["reported", "unknown"] as const;
const ROUTING_FAILURE_CODES = [
  "invalid_input",
  "missing_api_key",
  "no_candidate_models",
  "too_many_models",
  "too_many_tools",
  "request_too_large",
  "response_too_large",
  "transport_error",
  "timeout",
  "aborted",
  "unauthorized",
  "invalid_request",
  "rate_limited",
  "overloaded",
  "http_error",
  "malformed_response",
  "invalid_decision",
] as const;

const MAX_ROUTING_ID_LENGTH = 256;
const MAX_ROUTING_VERSION_LENGTH = 128;
const MAX_ROUTING_MODEL_LENGTH = 256;
const MAX_ROUTING_LIST = 256;

const TOOL_ACTIVITY_STATES = ["none", "started", "unknown"] as const;
const MODEL_FAILURE_CATEGORIES: readonly ModelFailureCategory[] = [
  "model_unavailable",
  "rate_limited",
  "service_overload",
  "transport",
  "auth",
  "quota",
  "invalid_request",
  "context_overflow",
  "refusal",
  "unknown",
];

function routingString(value: unknown, max = MAX_ROUTING_ID_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function routingNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function routingNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function routingOneOf<T extends readonly string[]>(allowed: T, value: unknown): T[number] | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T[number]) : undefined;
}

function routingStringArray(value: unknown, max = MAX_ROUTING_LIST): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: string[] = [];
  for (const item of value.slice(0, max)) {
    const name = routingString(item, MAX_ROUTING_MODEL_LENGTH);
    if (!name) return undefined;
    out.push(name);
  }
  return Object.freeze(out);
}

/** Bounded decode of one receipt. Returns undefined for malformed untrusted input. */
export function normalizeRoutingReceipt(value: unknown): RoutingReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;

  const requestId = routingString(r.requestId);
  const purpose = routingOneOf(ROUTING_PURPOSES, r.purpose);
  const selectorModel = routingString(r.selectorModel, MAX_ROUTING_VERSION_LENGTH);
  const outcome = routingOneOf(ROUTING_OUTCOMES, r.outcome);
  const usageStatus = routingOneOf(ROUTING_USAGE_STATUSES, r.usageStatus);
  const durationMs = routingNonNegativeNumber(r.durationMs);
  if (!requestId || !purpose || !selectorModel || !outcome || !usageStatus || durationMs === undefined) return undefined;

  const code = routingOneOf(ROUTING_FAILURE_CODES, r.code);
  const httpStatus = routingNonNegativeInt(r.httpStatus);
  const taskIndex = routingNonNegativeInt(r.taskIndex);
  const selectorVersion = routingString(r.selectorVersion, MAX_ROUTING_VERSION_LENGTH);
  const inputTokens = routingNonNegativeInt(r.inputTokens);
  const outputTokens = routingNonNegativeInt(r.outputTokens);

  return Object.freeze({
    requestId,
    purpose,
    ...(taskIndex === undefined ? {} : { taskIndex }),
    selectorModel,
    ...(selectorVersion === undefined ? {} : { selectorVersion }),
    outcome,
    ...(code === undefined ? {} : { code }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    durationMs,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    usageStatus: usageStatus === "reported" && inputTokens !== undefined && outputTokens !== undefined ? "reported" : "unknown",
    currency: "unknown" as const,
  });
}

/**
 * Bounded decode of the routing metadata attached to a task result. Requires the full
 * `RoutingDecision` core (`decisionId`/`purpose`/`selectedModel`/`selectorModel`/
 * `selectedTools`) plus the locally added `mandatoryTools` list. Anything malformed,
 * partial or oversized returns `undefined` so old/legacy snapshots stay readable.
 */
export function normalizeTaskRouting(value: unknown): TaskRouting | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;

  const decisionId = routingString(r.decisionId);
  const purpose = routingOneOf(ROUTING_PURPOSES, r.purpose);
  const selectedModel = routingString(r.selectedModel, MAX_ROUTING_MODEL_LENGTH);
  const selectorModel = routingString(r.selectorModel, MAX_ROUTING_VERSION_LENGTH);
  const selectedTools = routingStringArray(r.selectedTools);
  const mandatoryTools = routingStringArray(r.mandatoryTools);
  if (!decisionId || !purpose || !selectedModel || !selectorModel || !selectedTools || !mandatoryTools) return undefined;

  const taskIndex = routingNonNegativeInt(r.taskIndex);
  const confidence = routingNonNegativeNumber(r.confidence);
  if (r.confidence !== undefined && (confidence === undefined || confidence > 1)) return undefined;
  const selectorVersion = routingString(r.selectorVersion, MAX_ROUTING_VERSION_LENGTH);
  const selectorVersions = routingStringArray(r.selectorVersions, MAX_ROUTING_TOOL_QUESTIONS + 1);
  const receiptIds = routingStringArray(r.receiptIds, MAX_ROUTING_TOOL_QUESTIONS + 1);
  const latencyMs = routingNonNegativeNumber(r.latencyMs);
  // Probability ranking is display/history metadata on reload. Any malformed or
  // oversized entry drops the WHOLE field: a partially decoded ranking must
  // never exist downstream, and persisted rankings are never re-finalized into
  // an executable attempt plan regardless.
  let rankedModels: readonly RankedModelOption[] | undefined;
  if (Array.isArray(r.rankedModels) && r.rankedModels.length > 0 && r.rankedModels.length <= MAX_MODEL_ATTEMPT_RECORDS) {
    const entries: RankedModelOption[] = [];
    let valid = true;
    for (const raw of r.rankedModels) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { valid = false; break; }
      const entry = raw as Record<string, unknown>;
      const model = routingString(entry.model, MAX_ROUTING_MODEL_ID_LENGTH);
      const probability = entry.probability;
      if (!model || typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) { valid = false; break; }
      entries.push(Object.freeze({ model, probability }));
    }
    if (valid && (r.rankedTotal === undefined || r.rankedTotal === entries.length)
      && validateModelRanking(entries, entries.map((entry) => entry.model), selectedModel) === undefined) {
      rankedModels = Object.freeze(entries);
    }
  }

  return Object.freeze({
    decisionId,
    purpose,
    ...(taskIndex === undefined ? {} : { taskIndex }),
    selectedModel,
    selectedTools,
    ...(confidence === undefined ? {} : { confidence }),
    ...(rankedModels === undefined ? {} : { rankedModels }),
    selectorModel,
    ...(selectorVersion === undefined ? {} : { selectorVersion }),
    selectorVersions: selectorVersions ?? (selectorVersion ? Object.freeze([selectorVersion]) : Object.freeze([])),
    latencyMs: latencyMs ?? 0,
    receiptIds: receiptIds ?? Object.freeze([]),
    mandatoryTools,
    outcome: "success" as const,
  });
}

/**
 * One persisted routing receipt. `schemaVersion:1` mirrors the run-event contract; the
 * receipt keeps its full unique `requestId` so replay/upsert deduplicates by identity.
 */
export interface PersistedRoutingEvent {
  schemaVersion: 1;
  sessionKey: string;
  timestamp: number;
  receipt: RoutingReceipt;
  runId?: string;
  delivered?: boolean;
}

/** Build a persistable routing event; the caller appends it through its adapter. */
export function buildRoutingEvent(
  sessionKey: string,
  receipt: RoutingReceipt,
  runId?: string,
  delivered?: boolean,
): PersistedRoutingEvent {
  return {
    schemaVersion: 1,
    sessionKey,
    timestamp: Date.now(),
    receipt,
    ...(runId === undefined ? {} : { runId }),
    ...(delivered === undefined ? {} : { delivered }),
  };
}

/**
 * Bounded decode of a persisted routing event. Accepts either the raw payload or an
 * adapter-style custom entry wrapper (`{ customType/type, data }`) so callers can pass
 * `getEntries()` output and in-memory pending payloads through the same fold.
 */
export function normalizeRoutingEvent(value: unknown): PersistedRoutingEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const wrapper = value as { customType?: unknown; type?: unknown; data?: unknown };
  let raw: unknown = value;
  if (wrapper.customType === ROUTING_ENTRY_TYPE || (wrapper.data !== undefined && wrapper.type === ROUTING_ENTRY_TYPE)) {
    raw = wrapper.data;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const event = raw as Record<string, unknown>;
  if (event.schemaVersion !== 1) return undefined;
  const sessionKey = routingString(event.sessionKey);
  const timestamp = routingNonNegativeNumber(event.timestamp);
  const receipt = normalizeRoutingReceipt(event.receipt);
  if (!sessionKey || timestamp === undefined || !receipt) return undefined;
  const runId = routingString(event.runId);
  const delivered = event.delivered === true ? true : undefined;
  return Object.freeze({
    schemaVersion: 1 as const,
    sessionKey,
    timestamp,
    receipt,
    ...(runId === undefined ? {} : { runId }),
    ...(delivered === undefined ? {} : { delivered }),
  });
}

/** A receipt folded across the active branch plus pending in-memory upserts. */
export interface FoldedRoutingReceipt {
  requestId: string;
  sessionKey: string;
  timestamp: number;
  receipt: RoutingReceipt;
  runId?: string;
  delivered: boolean;
}

/**
 * Fold routing events in branch order (persisted entries first, then newer in-memory
 * pending upserts), keeping the latest receipt per full unique `requestId`. A later
 * upsert may refresh outcome/runId; `delivered:true` is sticky and never reset.
 * When `sessionKey` is given, only that branch's events participate.
 */
export function foldRoutingReceipts(
  entries: readonly unknown[],
  pending: readonly unknown[] = [],
  sessionKey?: string,
): Map<string, FoldedRoutingReceipt> {
  const folded = new Map<string, FoldedRoutingReceipt>();
  const deliveredIds = new Set<string>();
  const deliveredRuns = new Set<string>();
  // A whole native delivery is one append: run delivery covers linked receipts;
  // plan/async-start use one bounded request-ID batch, never per-receipt partial commits.
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const wrapper = entry as { customType?: unknown; type?: unknown; data?: unknown };
    const raw = wrapper.data;
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !routingString(value.sessionKey)
      || (sessionKey !== undefined && value.sessionKey !== sessionKey)) continue;
    if (wrapper.customType === RUN_ENTRY_TYPE && value.type === "delivered") {
      const id = routingString(value.id);
      if (id) deliveredRuns.add(id);
    }
    if (wrapper.customType === ROUTING_ENTRY_TYPE && value.kind === "native-delivery"
      && Array.isArray(value.requestIds) && value.requestIds.length <= MAX_ROUTING_DELIVERY_IDS
      && value.requestIds.every((id) => routingString(id) !== undefined)) {
      for (const id of value.requestIds) deliveredIds.add(id as string);
    }
  }

  const apply = (event: PersistedRoutingEvent): void => {
    if (sessionKey !== undefined && event.sessionKey !== sessionKey) return;
    const previous = folded.get(event.receipt.requestId);
    const runId = event.runId !== undefined ? event.runId : previous?.runId;
    folded.set(event.receipt.requestId, Object.freeze({
      requestId: event.receipt.requestId,
      sessionKey: event.sessionKey,
      timestamp: event.timestamp,
      receipt: event.receipt,
      ...(runId === undefined ? {} : { runId }),
      delivered: (previous?.delivered ?? false) || event.delivered === true,
    }));
  };
  for (const entry of entries) {
    const event = normalizeRoutingEvent(entry);
    if (event) apply(event);
  }
  for (const entry of pending) {
    const event = normalizeRoutingEvent(entry);
    if (event) apply(event);
  }
  for (const [id, entry] of folded) {
    if (!entry.delivered && (deliveredIds.has(id) || (entry.runId !== undefined && deliveredRuns.has(entry.runId)))) {
      folded.set(id, Object.freeze({ ...entry, delivered: true }));
    }
  }
  return folded;
}

/** Undelivered receipts, optionally restricted to one run, in timestamp order. */
export function undeliveredRoutingReceipts(
  folded: ReadonlyMap<string, FoldedRoutingReceipt>,
  runId?: string,
): FoldedRoutingReceipt[] {
  const out: FoldedRoutingReceipt[] = [];
  for (const entry of folded.values()) {
    if (entry.delivered) continue;
    if (runId !== undefined && entry.runId !== runId) continue;
    out.push(entry);
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

export interface PersistenceAdapter {
  /** Append to the currently-owned parent session. Implementations must reject stale ownership. */
  appendEntry(type: string, payload: unknown): void;
  /** Active-branch entries only, in branch order. */
  getEntries(): Array<{ type?: string; customType?: string; data?: unknown; timestamp?: number }>;
}

export interface PersistedResult {
  backend?: import("./types.js").BackendName;
  label: string;
  task: string;
  state: RunState;
  exitCode: number | null;
  stopReason?: string;
  timeoutPhase?: TimeoutPhase;
  errorMessage?: string;
  usage: UsageStats;
  model?: string;
  thinking?: TaskSpec["thinking"];
  profile?: TaskProfile;
  canWrite?: boolean;
  outputFile?: string;
  outputMode?: "inline" | "file-only";
  worktree?: { cwd: string; branch: string; baseCommit: string; changed: boolean; diffSummary?: string };
  sessionId?: string;
  process?: ChildProcessIdentity;
  finalOutput?: string;
  transcript?: string;
  /** Bounded Jev route metadata; absent on legacy snapshots. */
  routing?: TaskRouting;
  /** Budget-stopped child that wrapped up gracefully within its grace turns. */
  wrappedUp?: boolean;
  /** Set while no protocol activity has been seen for the stall window. */
  stalledSince?: number;
  /** Total attempts including retries (present when > 1). */
  attempts?: number;
  /** Models tried across attempts, in order. */
  attemptedModels?: string[];
  /** Sticky tool-activity boundary state across the task's attempts. */
  toolActivity?: ToolActivity;
  /** Bounded ranked attempt history; previews capped, never executable. */
  modelAttempts?: ModelAttemptRecord[];
  /** Parsed structured result when output_schema validated. */
  structuredOutput?: unknown;
  /** Validation errors when output_schema was requested but failed. */
  structuredError?: string;
}

export interface PersistenceEventData {
  mode?: RunMode;
  state?: RunState;
  startedAt?: number;
  endedAt?: number;
  taskPreviews?: string[];
  summary?: string;
  delivered?: boolean;
  resumeBlocked?: boolean;
  results?: PersistedResult[];
  resultIndex?: number;
  childSessionId?: string;
  progress?: string;
  turn?: number;
}

export interface PersistenceEvent {
  schemaVersion: 1;
  id: string;
  sessionKey: string;
  timestamp: number;
  sequence: number;
  type: "start" | "checkpoint" | "terminal" | "delivered" | "dismissed";
  data: PersistenceEventData;
}

function isRunState(value: unknown): value is RunState {
  return ["queued", "running", "completed", "partial", "failed", "cancelled", "lost", "timeout"].includes(
    String(value),
  );
}

function isTimeoutPhase(value: unknown): value is TimeoutPhase {
  return ["queued", "starting", "running", "cancelling"].includes(String(value));
}

function normalizeProcess(value: unknown): ChildProcessIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Partial<ChildProcessIdentity>;
  if (typeof p.pid !== "number" || !Number.isFinite(p.pid) || p.pid <= 0) return undefined;
  return {
    pid: p.pid,
    startTime: typeof p.startTime === "number" && Number.isFinite(p.startTime) ? p.startTime : 0,
    pgid: typeof p.pgid === "number" && Number.isFinite(p.pgid) ? p.pgid : undefined,
    hostname: typeof p.hostname === "string" ? p.hostname : undefined,
  };
}

function isRunMode(value: unknown): value is RunMode {
  return value === "single" || value === "parallel";
}

function normalizeUsage(value: unknown): UsageStats {
  if (!value || typeof value !== "object") return emptyUsage();
  const input = value as Partial<UsageStats>;
  const finite = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
  return {
    input: finite(input.input),
    output: finite(input.output),
    cacheRead: finite(input.cacheRead),
    cacheWrite: finite(input.cacheWrite),
    reasoning: finite(input.reasoning),
    cost: finite(input.cost),
    costInput: finite(input.costInput),
    costOutput: finite(input.costOutput),
    costCacheRead: finite(input.costCacheRead),
    costCacheWrite: finite(input.costCacheWrite),
    contextTokens: finite(input.contextTokens),
    turns: finite(input.turns),
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Bounded decode of the ranked attempt history. Any structurally invalid or
 * over-cap record drops the whole optional field (never a partial ranking),
 * and retained previews beyond the task total lose OLDEST text first while
 * keeping metadata/session pointers. Decoded records are descriptive only:
 * they never authorize execution.
 */
export function normalizeModelAttempts(value: unknown): ModelAttemptRecord[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODEL_ATTEMPT_RECORDS) return undefined;
  const records: ModelAttemptRecord[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entry = raw as Record<string, unknown>;
    const attempt = routingNonNegativeInt(entry.attempt);
    const rank = routingNonNegativeInt(entry.rank);
    const model = routingString(entry.model, MAX_ROUTING_MODEL_ID_LENGTH);
    const probability = entry.probability;
    const outcome = isRunState(entry.outcome) ? entry.outcome : undefined;
    if (attempt === undefined || attempt !== records.length + 1 || attempt > MAX_MODEL_ATTEMPT_RECORDS
      || rank === undefined || rank >= MAX_MODEL_ATTEMPT_RECORDS || !model
      || typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1
      || outcome === undefined) return undefined;
    const stopReason = entry.stopReason === undefined ? undefined : routingString(entry.stopReason, 128);
    if (entry.stopReason !== undefined && stopReason === undefined) return undefined;
    const failureCategory = entry.failureCategory === undefined
      ? undefined
      : (MODEL_FAILURE_CATEGORIES as readonly string[]).includes(String(entry.failureCategory))
        ? (entry.failureCategory as ModelFailureCategory)
        : undefined;
    const toolActivity = (TOOL_ACTIVITY_STATES as readonly string[]).includes(String(entry.toolActivity))
      ? (entry.toolActivity as ToolActivity)
      : undefined;
    const sessionId = entry.sessionId === undefined ? undefined : routingString(entry.sessionId, MAX_ROUTING_ID_LENGTH);
    if (entry.sessionId !== undefined && sessionId === undefined) return undefined;
    const outputPreview = typeof entry.outputPreview === "string"
      ? utf8SafePrefix(entry.outputPreview, MAX_ATTEMPT_PREVIEW_BYTES) || undefined
      : undefined;
    records.push({
      attempt,
      rank,
      model,
      probability,
      outcome,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(failureCategory === undefined ? {} : { failureCategory }),
      ...(toolActivity === undefined ? {} : { toolActivity }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(outputPreview === undefined ? {} : { outputPreview }),
    });
  }
  trimAttemptPreviews(records);
  return records;
}

/** Bounded compatibility model chain; repeated IDs are valid for infrastructure retries. */
export function normalizeAttemptedModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODEL_ATTEMPT_RECORDS) return undefined;
  const models: string[] = [];
  for (const entry of value) {
    const model = routingString(entry, MAX_ROUTING_MODEL_ID_LENGTH);
    if (!model) return undefined;
    models.push(model);
  }
  return models;
}

function normalizeResult(value: unknown): PersistedResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Partial<PersistedResult>;
  if (typeof r.label !== "string" || typeof r.task !== "string") return undefined;
  const routing = normalizeTaskRouting((r as { routing?: unknown }).routing);
  return {
    label: r.label,
    task: r.task,
    state: isRunState(r.state) ? r.state : "running",
    exitCode: typeof r.exitCode === "number" || r.exitCode === null ? r.exitCode : null,
    stopReason: typeof r.stopReason === "string" ? r.stopReason : undefined,
    timeoutPhase: isTimeoutPhase(r.timeoutPhase) ? r.timeoutPhase : undefined,
    errorMessage: typeof r.errorMessage === "string" ? utf8Prefix(r.errorMessage, 2_000) : undefined,
    usage: normalizeUsage(r.usage),
    model: typeof r.model === "string" ? r.model : undefined,
    thinking: isThinkingLevel(r.thinking) ? r.thinking : undefined,
    profile: ["explore", "review", "general"].includes(String(r.profile)) ? r.profile : undefined,
    canWrite: typeof r.canWrite === "boolean" ? r.canWrite : undefined,
    outputFile: typeof r.outputFile === "string" ? r.outputFile : undefined,
    outputMode: r.outputMode === "file-only" ? "file-only" : r.outputMode === "inline" ? "inline" : undefined,
    worktree:
      r.worktree &&
      typeof r.worktree.cwd === "string" &&
      typeof r.worktree.branch === "string" &&
      typeof r.worktree.baseCommit === "string"
        ? { ...r.worktree, changed: r.worktree.changed === true }
        : undefined,
    sessionId: typeof r.sessionId === "string" ? r.sessionId : undefined,
    process: normalizeProcess(r.process),
    ...(routing === undefined ? {} : { routing }),
    finalOutput: typeof r.finalOutput === "string" ? utf8Prefix(r.finalOutput, 16_384) : undefined,
    transcript: typeof r.transcript === "string" ? utf8Prefix(r.transcript, 32_768) : undefined,
    wrappedUp: r.wrappedUp === true ? true : undefined,
    stalledSince: typeof r.stalledSince === "number" && Number.isFinite(r.stalledSince) ? r.stalledSince : undefined,
    attempts: typeof r.attempts === "number" && Number.isInteger(r.attempts) && r.attempts > 1 ? r.attempts : undefined,
    attemptedModels: normalizeAttemptedModels(r.attemptedModels),
    toolActivity: (TOOL_ACTIVITY_STATES as readonly string[]).includes(String((r as { toolActivity?: unknown }).toolActivity))
      ? (r as { toolActivity?: ToolActivity }).toolActivity
      : undefined,
    modelAttempts: normalizeModelAttempts((r as { modelAttempts?: unknown }).modelAttempts),
    structuredOutput: r.structuredOutput !== undefined && Buffer.byteLength(JSON.stringify(r.structuredOutput) ?? "", "utf8") <= 32_768
      ? r.structuredOutput
      : undefined,
    structuredError: typeof r.structuredError === "string" ? utf8Prefix(r.structuredError, 1_000) : undefined,
  };
}

function unwrapEvent(entry: { type?: string; customType?: string; data?: unknown }): PersistenceEvent | undefined {
  if (entry.customType !== RUN_ENTRY_TYPE && entry.type !== RUN_ENTRY_TYPE) return undefined;
  const raw = entry.data as Partial<PersistenceEvent> | undefined;
  if (!raw || raw.schemaVersion !== 1 || typeof raw.id !== "string" || typeof raw.sessionKey !== "string") {
    return undefined;
  }
  if (!["start", "checkpoint", "terminal", "delivered", "dismissed"].includes(String(raw.type))) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    id: raw.id,
    sessionKey: raw.sessionKey,
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : 0,
    sequence: typeof raw.sequence === "number" ? raw.sequence : 0,
    type: raw.type as PersistenceEvent["type"],
    data: raw.data && typeof raw.data === "object" ? raw.data : {},
  };
}

/**
 * Versioned event persistence. Restoration folds every event on the active branch,
 * rather than treating the latest delta as a complete snapshot.
 */
export class PersistenceLayer {
  private sequence = 0;

  constructor(
    private readonly adapter: PersistenceAdapter,
    private readonly config: SubagentConfig,
  ) {
    for (const entry of adapter.getEntries()) {
      const event = unwrapEvent(entry);
      if (event) this.sequence = Math.max(this.sequence, event.sequence);
    }
  }

  persist(
    id: string,
    sessionKey: string,
    type: PersistenceEvent["type"],
    data: PersistenceEventData,
    _terminalHint?: boolean,
  ): void {
    if (!id || !sessionKey) return;
    const event: PersistenceEvent = {
      schemaVersion: 1,
      id,
      sessionKey,
      timestamp: Date.now(),
      sequence: ++this.sequence,
      type,
      data,
    };
    this.adapter.appendEntry(RUN_ENTRY_TYPE, event);
  }

  /** Fold active-branch events in their session order. */
  rebuild(sessionKey: string): Map<string, RunSnapshot> {
    const snapshots = new Map<string, RunSnapshot>();

    for (const entry of this.adapter.getEntries()) {
      const event = unwrapEvent(entry);
      if (!event || event.sessionKey !== sessionKey) continue;

      let snapshot = snapshots.get(event.id);
      if (!snapshot) {
        snapshot = {
          schemaVersion: 1,
          id: event.id,
          sessionKey,
          mode: "single",
          state: "running",
          startedAt: event.timestamp || Date.now(),
          taskPreviews: [],
          delivered: false,
          resumeBlocked: false,
          results: [],
        };
      }

      const d = event.data;
      if (typeof d.resumeBlocked === "boolean") snapshot.resumeBlocked = d.resumeBlocked;
      if (isRunMode(d.mode)) snapshot.mode = d.mode;
      if (isRunState(d.state)) snapshot.state = d.state;
      if (typeof d.startedAt === "number") snapshot.startedAt = d.startedAt;
      if (typeof d.endedAt === "number") snapshot.endedAt = d.endedAt;
      if (Array.isArray(d.taskPreviews) && d.taskPreviews.every((x) => typeof x === "string")) {
        snapshot.taskPreviews = [...d.taskPreviews];
      }
      if (typeof d.summary === "string") snapshot.summary = d.summary;
      if (typeof d.delivered === "boolean") snapshot.delivered = d.delivered;
      if (Array.isArray(d.results)) {
        snapshot.results = d.results.map(normalizeResult).filter((r): r is PersistedResult => !!r);
      }

      if (event.type === "checkpoint" && typeof d.childSessionId === "string") {
        const index = typeof d.resultIndex === "number" ? d.resultIndex : 0;
        const result = snapshot.results[index];
        if (result) result.sessionId = d.childSessionId;
      }
      if (event.type === "delivered" || event.type === "dismissed") snapshot.delivered = true;

      snapshots.set(event.id, snapshot);
    }

    for (const [id, snapshot] of snapshots) {
      if (snapshot.state === "running" || snapshot.state === "queued") {
        // "lost" means ownership cannot be proven after a parent disruption.
        // Orphan reconcile (ProcessLockManager) must have run before callers
        // consider the session safe to resume; rebuild keeps resumeBlocked set
        // until a later reconciler clears it.
        snapshots.set(id, {
          ...snapshot,
          state: "lost",
          endedAt: Date.now(),
          resumeBlocked: true,
          summary:
            snapshot.summary ||
            "Run ownership was lost (parent interrupted). Resume is blocked until orphan reconciliation confirms the child is dead.",
        });
      }
    }

    return snapshots;
  }

  markDelivered(id: string, sessionKey: string): void {
    this.persist(id, sessionKey, "delivered", { delivered: true });
  }

  /** Fold routing receipts across this session's active branch plus pending upserts. */
  foldRouting(sessionKey: string, pending: readonly unknown[] = []): Map<string, FoldedRoutingReceipt> {
    return foldRoutingReceipts(this.adapter.getEntries(), pending, sessionKey);
  }

  /** All child session ids referenced by any run event on the active branch. */
  referencedSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.adapter.getEntries()) {
      const event = unwrapEvent(entry);
      if (!event) continue;
      if (typeof event.data.childSessionId === "string") ids.add(event.data.childSessionId);
      if (Array.isArray(event.data.results)) {
        for (const result of event.data.results) {
          const partial = result as Partial<PersistedResult>;
          const sessionId = partial?.sessionId;
          if (typeof sessionId === "string" && sessionId) ids.add(sessionId);
          // Earlier ranked attempts stay referenced while their result record
          // survives on the active branch, so lifecycle distillation cannot
          // delete still-discoverable paid partial output.
          for (const record of normalizeModelAttempts(partial?.modelAttempts) ?? []) {
            if (record.sessionId) ids.add(record.sessionId);
          }
        }
      }
    }
    return ids;
  }

  /**
   * Non-destructive planner. Filesystem scanning/deletion is intentionally
   * outside persistence (see maintenance.ts). "keep" is the union of caller
   * references and every child session referenced on the active branch.
   */
  planRetention(referencedSessionIds: Set<string>): { keep: string[]; candidates: string[] } {
    const keep = new Set([...referencedSessionIds, ...this.referencedSessionIds()]);
    if (!this.config.sessionRetentionDays || this.config.sessionRetentionDays <= 0) {
      return { keep: [...keep], candidates: [] };
    }
    // Candidates are resolved by the filesystem sweep; the planner only fixes the keep set.
    return { keep: [...keep], candidates: [] };
  }
}
