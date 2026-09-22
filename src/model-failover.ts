/**
 * Ranked Jev model failover: internal pure decision rules.
 *
 * No I/O, no process, no HTTP. Owners: `jev-router` (ranking construction),
 * `policy` (attempt-plan finalization), `protocol` (evidence latches),
 * `runner`/`orchestrator` (attempt decisions), `persistence` (shared caps).
 *
 * Execution contract: cross-model advance requires a recognized
 * settled provider-availability error, conclusively `none` tool activity for
 * the current invocation, remaining candidate + retry budget. Missing or
 * malformed evidence is never a green light. `max_retries` is the total
 * extension-level extra-attempt budget; availability failures advance directly
 * (no extra same-model attempt, no wrap). The host's broad transient regex is
 * deliberately not reused: recognition is negative-before-positive over
 * explicit bounded forms; unknown text never switches.
 */

import { Buffer } from "node:buffer";
import { MAX_ROUTING_MODELS, MAX_ROUTING_MODEL_ID_LENGTH, PROBABILITY_SUM_TOLERANCE, type RankedModelOption } from "./routing-types.js";
import { isThinkingLevel } from "./thinking.js";
import type { ModelAttemptRecord, ModelAttemptSpec, ModelFailureCategory, ToolActivity } from "./types.js";

// ---- Shared resource bounds ----------------------------------------------------

/** Attempt records and `attemptedModels` share this producer/decoder cap. */
export const MAX_MODEL_ATTEMPT_RECORDS = MAX_ROUTING_MODELS;
/** Per-record and per-task retained preview caps (UTF-8 bytes). */
export const MAX_ATTEMPT_PREVIEW_BYTES = 1_024;
export const MAX_ATTEMPT_PREVIEW_TOTAL_BYTES = 16 * 1_024;
/** Bounded provider error evidence copied out of the protocol parser. */
export const MAX_PROVIDER_ERROR_EVIDENCE_BYTES = 2_048;

/** Ranked launch bound: min(cap, 1 + floor(maxRetries)); fractional values floor. */
export function rankedMaxAttempts(maxRetries: number | undefined): number {
  const extra = typeof maxRetries === "number" && Number.isFinite(maxRetries) && maxRetries > 0
    ? Math.floor(maxRetries)
    : 0;
  return Math.max(1, Math.min(MAX_MODEL_ATTEMPT_RECORDS, 1 + extra));
}

// ---- Tool activity latch -------------------------------------------------------

/** Lattice order for the sticky activity latch: none < unknown < started. */
function activityRank(value: ToolActivity | undefined): number {
  return value === "started" ? 2 : value === "unknown" ? 1 : 0;
}

/** Sticky merge: a later complete event never erases started/unknown. */
export function mergeToolActivity(
  left: ToolActivity | undefined,
  right: ToolActivity | undefined,
): ToolActivity {
  if (activityRank(left) >= activityRank(right)) return left ?? right ?? "none";
  return right ?? "none";
}

/** Absent evidence (legacy/foreign parser) is NOT permission to retry. */
export function resolveAttemptActivity(result: { toolActivity?: ToolActivity }): ToolActivity {
  return result.toolActivity ?? "unknown";
}

// ---- Provider error classification ---------------------------------------------

/** Only documented primitive diagnostic codes; never retain bodies/headers/details. */
export function extractProviderError(errorMessage: unknown, diagnostics: unknown): string | undefined {
  if (errorMessage !== undefined && typeof errorMessage !== "string") return undefined;
  const message = typeof errorMessage === "string" ? errorMessage : "";
  // Incomplete evidence cannot drop a negative message tail and trust a code.
  if (Buffer.byteLength(message, "utf8") > MAX_PROVIDER_ERROR_EVIDENCE_BYTES) return undefined;
  const diagnostic = diagnostics && typeof diagnostics === "object" ? diagnostics as Record<string, unknown> : undefined;
  const error = diagnostic?.error && typeof diagnostic.error === "object" ? diagnostic.error as Record<string, unknown> : undefined;
  const rawCode = error?.code;
  let code = "";
  if (rawCode !== undefined) {
    if (typeof rawCode === "number" && Number.isInteger(rawCode) && rawCode >= 100 && rawCode <= 599) code = `status code ${rawCode}`;
    else if (typeof rawCode === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(rawCode)) {
      code = /^[1-5][0-9]{2}$/.test(rawCode) ? `status code ${rawCode}` : rawCode;
    } else return undefined;
  }
  const evidence = [message, code].filter(Boolean).join("\n");
  return evidence.trim() && Buffer.byteLength(evidence, "utf8") <= MAX_PROVIDER_ERROR_EVIDENCE_BYTES ? evidence : undefined;
}

const AVAILABILITY_CATEGORIES: ReadonlySet<ModelFailureCategory> = new Set<ModelFailureCategory>([
  "model_unavailable",
  "rate_limited",
  "service_overload",
  "transport",
]);

export function isAvailabilityCategory(category: ModelFailureCategory): boolean {
  return AVAILABILITY_CATEGORIES.has(category);
}

/**
 * Contextualized HTTP status forms only: a bare number in unrelated text must
 * not classify. `http 503`, `status 503`, `status code: 503` and `error code 503`
 * qualify; a lone "500 tokens" or bare "404" does not.
 */
function statusSource(codes: string): string {
  return String.raw`\b(?:status(?:\s+code)?|https?\s*(?:status|error|code)?|error\s+code|err\s+code|response\s+code)\D{0,10}\b(?:${codes})\b`;
}

interface Rule { readonly category: ModelFailureCategory; readonly pattern: RegExp }

function rule(category: ModelFailureCategory, sources: readonly string[]): Rule {
  return { category, pattern: new RegExp(`(?:${sources.join("|")})`, "i") };
}

/** Matched before every other rule: these always stop the ranked path. */
const STOP_RULES: readonly Rule[] = [
  rule("auth", [
    String.raw`\b(?:invalid|incorrect|missing|expired|revoked|unauthorized|bad)[\s_]*(?:api[\s_-]?key|credentials?|auth(?:entication)?|access[\s_-]?token|token)\b`,
    String.raw`\b(?:authentication|auth)[\s_]*(?:failed|error)\b`,
    String.raw`\bpermission denied\b`,
    String.raw`\baccess\b[^.\n]{0,40}\b(?:denied|forbidden|not granted|disabled|revoked)\b`,
    String.raw`\b(?:do|does) not have\b[^.\n]{0,60}\b(?:access|permission)\b`,
    String.raw`\baccess (?:to )?(?:this|the) model\b[^.\n]{0,24}\b(?:denied|forbidden|not granted|is not granted)\b`,
    statusSource("40[13]"),
  ]),
  rule("quota", [
    String.raw`\binsufficient[_\s-]?quota\b`,
    String.raw`\b(?:out of|exceeded|hit|reached)[\s_-]*(?:your[\s_-]*)?(?:current[\s_-]*)?quota\b`,
    String.raw`\bquota\b[^.\n]{0,20}\b(?:exceeded|exhausted|reached|limit|too low)\b`,
    String.raw`\bbilling\b`,
    String.raw`\b(?:out of|exceeded|hit|reached)\b[^.\n]{0,20}\b(?:budget|credit|funds|allowance)\b`,
    String.raw`\b(?:insufficient|negative|zero)\b[^.\n]{0,12}\b(?:balance|credit)\b`,
    String.raw`\b(?:credit|balance|budget|allowance)[\s_-]*(?:exhausted|depleted|reached|limit)\b`,
    String.raw`\b(?:monthly|weekly|rolling|free[-\s]?tier|usage|spend)[^a-z0-9]{0,3}limit[^.\n]{0,24}\b(?:reached|exceeded|exhausted)\b`,
    String.raw`\b(?:go|free)[_\s-]?usagelimiterror\b`,
    String.raw`\bavailable[\s_]*balance\b`,
    String.raw`\blimit[^.\n]{0,40}\b(?:upgrade|purchase|buy|subscribe|plan)\b`,
    String.raw`\bRESOURCE_EXHAUSTED\b`,
  ]),
  rule("context_overflow", [
    String.raw`\bcontext[_\s-]?length[_\s-]?exceeded\b`,
    String.raw`\b(?:context|prompt|input|request|conversation)[\s_-]*(?:length|window|size)?[^a-z0-9]{0,4}\b(?:overflow|too long|exceeded|exceeds|maximum)\b`,
    String.raw`\btoo many (?:tokens|messages|characters|words)\b`,
    String.raw`\breduce (?:the )?(?:length|size|input|context)\b`,
    String.raw`\bcontext window\b`,
    statusSource("413"),
  ]),
  rule("invalid_request", [
    String.raw`\binvalid[_\s-]?request(?:\s*error)?\b`,
    String.raw`\binvalid[\s_-]*(?:parameter|argument|schema|payload|body|tool|function|messages?[\s_]*format|enum|value|type)\b`,
    String.raw`\b(?:unknown|unsupported)[\s_-]*(?:tool|function|parameter|argument|format)\b`,
    String.raw`\b(?:required|missing)[\s_-]*(?:parameter|argument|field)\b`,
    String.raw`\bextra inputs are not permitted\b`,
    statusSource("400|406|409|415|422|451"),
  ]),
  rule("refusal", [
    String.raw`\bcontent[\s_]*policy\b`,
    String.raw`\b(?:request|response|the model)[\s_]*refus(?:ed|al)\b`,
  ]),
];

/**
 * Positive availability forms. Explicit model-unavailable evidence can disambiguate
 * HTTP 404; all other negative evidence has priority. Unknown text stops.
 */
const AVAILABILITY_RULES: readonly Rule[] = [
  rule("model_unavailable", [
    String.raw`\bmodel[_\s-]?not[_\s-]?(?:found|exist|available|deployed|provisioned)\b`,
    String.raw`\bmodel[_\s-]?unavailable\b`,
    String.raw`\bno such model\b`,
    String.raw`\bthe model\b[^.\n]{0,80}\b(?:does not exist|is not available|was not found|cannot be found|is not deployed)\b`,
    String.raw`\b(?:selected|requested|chosen)[\s_]+model\b[^.\n]{0,60}\b(?:not found|unavailable|does not exist|is not available|cannot be found|is not deployed)\b`,
    String.raw`\bmodelnotfoundexception\b`,
  ]),
  rule("rate_limited", [
    String.raw`\brate[\s_-]?limit\w*\b`,
    String.raw`\btoo many requests\b`,
    String.raw`\bthrottl(?:ed|ing|e)\w*\b`,
    statusSource("429"),
  ]),
  rule("service_overload", [
    String.raw`\b(?:is|are|currently|experienc\w+)[^.\n]{0,40}\boverloaded\b`,
    String.raw`\boverloaded[_\s-]?(?:error|exception)\b`,
    String.raw`\bhigh demand\b`,
    String.raw`\bservice[^a-z0-9]{0,3}(?:is )?unavailable\b`,
    String.raw`\b(?:internal|server)[\s_]*error\b`,
    String.raw`\bbad gateway\b`,
    String.raw`\bgateway time(?:d|out)\b`,
    statusSource("500|502|503|504|520|524|529"),
  ]),
  rule("transport", [
    String.raw`\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|HOSTUNREACH|NETUNREACH|NETDOWN|SHUTDOWN|TIMEDOUT)\b`,
    String.raw`\bEAI_AGAIN\b`,
    String.raw`\bgetaddrinfo\b`,
    String.raw`\bsocket hang up\b`,
    String.raw`\bsocket connection was closed\b`,
    String.raw`\b(?:upstream|origin)[\s_]*connect(?:ion)?[\s_]*(?:error|refused|failure)\b`,
    String.raw`\breset before headers\b`,
    String.raw`\bother side closed\b`,
    String.raw`\bconnection (?:error|lost|closed|reset|refused|failure)\b`,
    String.raw`\bconnect(?:ion)? (?:timed out|timeout)\b`,
    String.raw`\b(?:socket|tls|tcp) (?:error|failure|reset|closed|timed out)\b`,
    String.raw`\bfetch failed\b`,
    String.raw`\bunable to connect\b`,
  ]),
];

/**
 * Classify bounded evidence from the latest completed assistant provider error
 * only. `null` means "no usable settled provider error" (never availability);
 * `"unknown"` means unrecognized text (never availability). Inputs other than
 * parser-extracted assistant error strings must not be passed here.
 *
 * Rule order is part of the contract:
 *  1. auth/quota/context/schema/refusal negatives always win;
 *  2. explicit model-unavailable evidence can disambiguate HTTP 404;
 *  3. an unexplained HTTP 404 stops, then other availability rules apply.
 * Oversized evidence is refused entirely (`null`) rather than truncated: a
 * dropped tail could contain a quota/billing statement the prefix test would
 * never see.
 */
export function classifyProviderError(evidence: string | undefined): ModelFailureCategory | null {
  if (typeof evidence !== "string") return null;
  if (!evidence.trim()) return null;
  if (Buffer.byteLength(evidence, "utf8") > MAX_PROVIDER_ERROR_EVIDENCE_BYTES) return null;
  for (const candidate of STOP_RULES) if (candidate.pattern.test(evidence)) return candidate.category;
  const modelUnavailable = AVAILABILITY_RULES[0]!;
  if (modelUnavailable.pattern.test(evidence)) return modelUnavailable.category;
  if (new RegExp(statusSource("404"), "i").test(evidence)) return "invalid_request";
  for (const candidate of AVAILABILITY_RULES.slice(1)) if (candidate.pattern.test(evidence)) return candidate.category;
  return "unknown";
}

// ---- Ranking and attempt-plan validation ----------------------------------------

/**
 * Order by descending probability. The returned choice leads a tied maximum;
 * remaining ties keep the configured candidate order (stable sort). Never
 * sorts by name, cost or quality assumptions; zero probabilities stay valid.
 */
export function orderRankedModels(
  candidates: ReadonlyArray<{ model: string; probability: number }>,
  choice: string,
): readonly RankedModelOption[] {
  const tieLead = (model: string): number => (model === choice ? 0 : 1);
  return Object.freeze(candidates
    .map((entry) => Object.freeze({ model: entry.model, probability: entry.probability }))
    .sort((a, b) => b.probability - a.probability || tieLead(a.model) - tieLead(b.model)));
}

/**
 * Official Choice contract: `choice` is the (exact) maximum-probability option.
 * A contradictory answer is an invalid decision; never substitute a model.
 */
export function choiceIsMaximal(
  probabilities: ReadonlyMap<string, number>,
  choiceKey: string,
  modelName: string,
): string | undefined {
  const choiceProbability = probabilities.get(choiceKey);
  if (choiceProbability === undefined) return `the selected model ${JSON.stringify(modelName)} has no reported probability`;
  for (const value of probabilities.values()) {
    if (value > choiceProbability) {
      return `the returned choice ${JSON.stringify(modelName)} (probability ${choiceProbability}) is not a maximum-probability option (${value})`;
    }
  }
  return undefined;
}

/**
 * Validate a ranking before it can become an executable attempt plan.
 * `allowedModels` is the original configured eligibility order. Returns a
 * bounded error string, or undefined when acceptable: unique entries, exact
 * membership without duplicates or omissions (every eligible candidate stays a
 * candidate, including zero probability), finite 0..1 probabilities in
 * non-increasing order, and the first entry equals the selected model.
 */
export function validateModelRanking(
  ranked: readonly unknown[] | undefined,
  allowedModels: readonly string[],
  selectedModel: string,
): string | undefined {
  if (!Array.isArray(ranked) || ranked.length === 0) return "the probability ranking is missing or empty";
  if (ranked.length > MAX_MODEL_ATTEMPT_RECORDS) return `the probability ranking exceeds ${MAX_MODEL_ATTEMPT_RECORDS} entries`;
  const allowed = new Set(allowedModels);
  if (allowed.size !== allowedModels.length) return "the candidate catalog contains duplicate model IDs";
  const seen = new Set<string>();
  const configuredOrder = new Map(allowedModels.map((model, index) => [model, index]));
  let sum = 0;
  let previous: number | undefined;
  let previousModel: string | undefined;
  for (let index = 0; index < ranked.length; index++) {
    const entry = ranked[index] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `ranking entry ${index + 1} is not an object`;
    const model = entry.model;
    if (typeof model !== "string" || !model.trim() || model.length > MAX_ROUTING_MODEL_ID_LENGTH) return `ranking entry ${index + 1} has an invalid model ID`;
    if (!allowed.has(model)) return `ranking entry ${index + 1} selects a model outside the eligible candidates`;
    if (seen.has(model)) return `ranking entry ${index + 1} repeats model ${JSON.stringify(model)}`;
    seen.add(model);
    const probability = entry.probability;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return `ranking entry ${index + 1} has a probability outside the finite range 0..1`;
    }
    if (previous !== undefined && probability > previous) return `ranking entry ${index + 1} is out of probability order`;
    if (previous === probability && previousModel !== selectedModel && configuredOrder.get(previousModel!)! > configuredOrder.get(model)!) {
      return `ranking entry ${index + 1} breaks the configured tie order`;
    }
    previous = probability;
    previousModel = model;
    sum += probability;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return "the model probabilities do not sum to 1 within the routing tolerance";
  if (seen.size !== allowed.size) return "the probability ranking does not cover every eligible candidate";
  if ((ranked[0] as { model?: unknown }).model !== selectedModel) return "the ranking does not start with the selected model";
  return undefined;
}

/**
 * Validate an attempt plan already present on a spec (SDK boundary defense).
 * A PRESENT-but-malformed plan must never launch and must never be reinterpreted
 * as "unranked": callers reject it fail closed. Only absence selects the legacy
 * unranked path.
 */
export function validateAttemptPlan(plan: unknown, initialModel: string | undefined): plan is readonly ModelAttemptSpec[] {
  if (!Array.isArray(plan) || plan.length === 0) return false;
  if (typeof initialModel !== "string" || !initialModel) return false;
  for (const entry of plan) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    if (typeof record.model !== "string" || !record.model.trim()) return false;
    if (typeof record.probability !== "number" || !Number.isFinite(record.probability) || record.probability < 0 || record.probability > 1) return false;
    if (record.thinking !== undefined && !isThinkingLevel(record.thinking)) return false;
  }
  return validateModelRanking(
    plan as readonly unknown[],
    plan.map((entry) => (entry as ModelAttemptSpec).model),
    initialModel,
  ) === undefined;
}

// ---- The ranked attempt decision -------------------------------------------------

export interface RankedAttemptFacts {
  /** 1-based launches performed, counting the attempt that just settled. */
  attempt: number;
  maxAttempts: number;
  /** 0-based ranking position used by the attempt that just settled. */
  candidateIndex: number;
  candidateCount: number;
  /** Settled activity for this invocation; absent evidence resolves to unknown. */
  activity: ToolActivity;
  /** Classification of the settled assistant provider error, if any. */
  category: ModelFailureCategory | null;
  /** Settled state of the attempt that just finished. */
  state: ModelAttemptRecord["outcome"];
  cancelled: boolean;
  deadlineExceeded: boolean;
  /** Runner-owned positive proof no child/task work began (queue/admission/spawn). */
  infraPreWork: boolean;
  /** Cumulative reported cost has met or exceeded spec.maxCost. */
  costCeilingReached: boolean;
  /** Cumulative reported turns have met or exceeded spec.maxTurns. */
  turnCeilingReached: boolean;
}

export type RankedAttemptDecision =
  | { action: "finish" }
  | { action: "advance"; reason: string }
  | { action: "retry_same_model"; reason: string };

/**
 * Pure ranked-attempt decision for one settled ranked attempt (called only after the
 * child fully settled and cleaned up). Availability failures advance directly
 * and never retry the same model or wrap; infrastructure retries happen only
 * with conclusive pre-work proof and share the same total budget.
 */
export function decideRankedAttempt(facts: RankedAttemptFacts): RankedAttemptDecision {
  if (facts.cancelled || facts.deadlineExceeded) return { action: "finish" };
  if (facts.state !== "failed") return { action: "finish" };
  if (facts.activity !== "none") return { action: "finish" };
  const attemptsRemain = facts.attempt < facts.maxAttempts;
  if (facts.costCeilingReached || facts.turnCeilingReached) return { action: "finish" };
  if (facts.category && isAvailabilityCategory(facts.category)) {
    if (attemptsRemain && facts.candidateIndex + 1 < facts.candidateCount) {
      return { action: "advance", reason: `${facts.category} before any tool execution; advancing to the next ranked candidate` };
    }
    return { action: "finish" };
  }
  if (facts.infraPreWork && attemptsRemain) {
    return { action: "retry_same_model", reason: "conclusive pre-work infrastructure failure; retrying the same candidate" };
  }
  return { action: "finish" };
}

// ---- Bounded text and preview helpers --------------------------------------------

/** Truncate to at most maxBytes of UTF-8 without splitting a code point. */
export function utf8SafePrefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/** Cap one preview to the per-record bound. */
export function attemptOutputPreview(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  return utf8SafePrefix(text, MAX_ATTEMPT_PREVIEW_BYTES) || undefined;
}

/**
 * Enforce the 16 KiB task total: discard OLDEST preview text first while
 * keeping every record's metadata and session pointer. Mutates in place.
 */
export function trimAttemptPreviews(records: readonly ModelAttemptRecord[]): void {
  let total = records.reduce((sum, record) => sum + Buffer.byteLength(record.outputPreview ?? "", "utf8"), 0);
  for (const record of records) {
    if (total <= MAX_ATTEMPT_PREVIEW_TOTAL_BYTES) break;
    if (!record.outputPreview) continue;
    total -= Buffer.byteLength(record.outputPreview, "utf8");
    const kept = utf8SafePrefix(record.outputPreview, Math.max(0, MAX_ATTEMPT_PREVIEW_TOTAL_BYTES - total));
    record.outputPreview = kept || undefined;
    total += Buffer.byteLength(kept, "utf8");
  }
}

/**
 * Attributed earlier-output projection for terminal failure delivery. The
 * preview never becomes the final answer/state/model/session; it is only shown
 * when the terminal attempt produced no text of its own.
 */
export function earlierAttemptOutputNote(result: {
  state?: ModelAttemptRecord["outcome"];
  liveText?: string;
  modelAttempts?: readonly ModelAttemptRecord[];
}): string | undefined {
  if (!["failed", "cancelled", "timeout", "lost"].includes(String(result.state))) return undefined;
  if (result.liveText && result.liveText.trim()) return undefined;
  const records = result.modelAttempts;
  if (!Array.isArray(records) || records.length < 2) return undefined;
  for (let index = records.length - 2; index >= 0; index--) {
    const record = records[index]!;
    if (!record.outputPreview?.trim()) continue;
    const session = record.sessionId ? `; session ${record.sessionId}` : "";
    return `[Earlier output preview — attempt ${record.attempt} on ${record.model}${session}; not the final attempt's answer, kept because this attempt failed]\n${record.outputPreview}`;
  }
  return undefined;
}
