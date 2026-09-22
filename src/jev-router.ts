import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Semaphore } from "./semaphore.js";
import { isThinkingLevel } from "./thinking.js";
import { normalizeRoutingApiKey } from "./routing-policy.js";
import { choiceIsMaximal, orderRankedModels } from "./model-failover.js";
import {
  DEFAULT_ROUTING_CONCURRENCY,
  MAX_ROUTING_MODEL_ID_LENGTH,
  MAX_ROUTING_MODELS,
  MAX_ROUTING_REQUEST_BYTES,
  MAX_ROUTING_RESPONSE_BYTES,
  MAX_ROUTING_TOOL_QUESTIONS,
  MAX_SELECTOR_VERSION_LENGTH,
  PROBABILITY_SUM_TOLERANCE,
  TYPESAFE_SYSTEMONE_ENDPOINT,
  type JevRoutingConfig,
  type RoutingDecision,
  type RoutingFailureCode,
  type RoutingModelCandidate,
  type RoutingProfile,
  type RoutingPurpose,
  type RoutingReceipt,
  type RoutingReceiptOutcome,
  type RoutingResult,
  type RoutingSelectInput,
  type RoutingSelectOptions,
  type RoutingToolCandidate,
  type RankedModelOption,
} from "./routing-types.js";

// Re-exported so integration can import the selector contract from the router module.
export type {
  JevRoutingConfig,
  RoutingConstraints,
  RoutingDecision,
  RoutingFailureCode,
  RoutingModelCandidate,
  RoutingProfile,
  RoutingPurpose,
  RoutingReceipt,
  RoutingResult,
  RoutingSelectInput,
  RoutingSelectOptions,
  RoutingToolCandidate,
} from "./routing-types.js";

/**
 * Injectable asynchronous Jev (TypeSafe `/v1/systemone`) selector.
 *
 * One `JevRouter` holds one frozen per-invocation config snapshot. Call `select(input,
 * options)` once per worker task / synthesis stage / plan stage. `input` is the minimal,
 * disclosure-bounded routing DTO (task text, eligible model IDs/descriptions, eligible
 * non-mandatory tool names/descriptions, necessary constraints). `options` carries metadata
 * and lifecycle only (purpose, task index, abort signal, absolute deadline) and is never
 * serialized.
 *
 * Guarantees:
 * - One model Choice first, then one binary include/exclude Choice per eligible tool, packed
 *   into bounded requests. Every eligible tool is asked; nothing is truncated or ranked.
 * - The model Choice's full validated probability distribution is retained as the
 *   deterministic `rankedModels` ordering (descending probability, returned choice first
 *   among a tied maximum, then configured order). The returned `choice` must be a
 *   maximum-probability option; a contradictory answer is an invalid decision, never a
 *   silently substituted model. Zero/low probabilities remain valid candidates.
 * - Tool questions are task-based and model-independent: the selection state never
 *   conditions on the chosen execution model, so one shared subset serves every ranked
 *   attempt and fallback issues no further selector requests.
 * - A single logical deadline = min(config.timeoutMs, caller absolute deadline) spans every
 *   request and all limiter waiting. Concurrent HTTP requests are bounded to two by default.
 * - Only `https://api.typesafe.ai/v1/systemone` with `redirect:"error"`; the Bearer key comes
 *   from the private config snapshot and is never copied into request bodies, results or messages.
 * - Responses are untrusted data: shape, answer type, question set, allowed options, finite
 *   probabilities, probability sum tolerance, confidence, usage counts and selector version
 *   are validated. Valid low-confidence choices are accepted (no threshold, no substitution).
 * - One receipt per actual HTTP attempt, published to the optional sink as soon as that HTTP
 *   attempt completes and re-published by the same `requestId` when decision validation
 *   changes its outcome. Reported tokens are retained on rejected decisions, and
 *   `currency` is always `"unknown"`.
 * - A moving selector alias may resolve to different actual versions between requests; every
 *   distinct version is recorded in the receipt and in `decision.selectorVersions`. That is
 *   never treated as a decision error.
 * - Failures return a discriminated result that includes every available receipt; there is no
 *   automatic selector retry, fallback or emergency model.
 *
 * Collaborators (`fetchImpl`, `now`, `idFactory`, `limiter`, `onReceipt`) are all
 * injectable so the whole surface is testable offline with zero provider calls.
 */

export interface RoutingLimiter {
  acquire(signal?: AbortSignal): Promise<void>;
  release(): void;
}

export interface JevRouterOptions {
  /** Frozen per-invocation config snapshot containing a private credential. Never log it. */
  config: JevRoutingConfig;
  /** Injected transport; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected clock; defaults to `Date.now`. */
  now?: () => number;
  /** Injected unique-ID factory; defaults to `randomUUID`. */
  idFactory?: () => string;
  /** Injected concurrency limiter; defaults to a shared two-slot `Semaphore`. */
  limiter?: RoutingLimiter;
  /**
   * Optional receipt sink. Called once when an actual HTTP attempt completes, and again with
   * the same `requestId` if later decision validation changes that receipt's outcome. The
   * caller can therefore persist incrementally and deduplicate by `requestId`.
   *
   * A throwing sink does not change routing, but it is **not** silently ignored: its
   * request ID is surfaced in the result's `persistenceErrors` while the receipt (and its
   * reported tokens) is still returned.
   */
  onReceipt?: (receipt: RoutingReceipt) => void;
}

interface QuestionSpec {
  readonly id: string;
  readonly options: readonly string[];
  readonly question: Record<string, unknown>;
  /** Set for tool questions so the chosen `include` maps back to a tool name. */
  readonly toolName?: string;
}

interface ReceiptDraft {
  requestId: string;
  purpose: RoutingPurpose;
  taskIndex?: number;
  selectorModel: string;
  selectorVersion?: string;
  outcome: RoutingReceiptOutcome;
  code?: RoutingFailureCode;
  httpStatus?: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  usageStatus: "reported" | "unknown";
  currency: "unknown";
  /** Internal ordering so receipts stay in issue order across concurrent batches. */
  sequence: number;
}

interface CallState {
  drafts: ReceiptDraft[];
  /** Safe, non-secret diagnostics for failed receipt-sink calls. */
  sinkErrors: string[];
}

interface IssueMeta {
  readonly purpose: RoutingPurpose;
  readonly taskIndex?: number;
  readonly sequence: number;
}

interface CallContext {
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly deadlineMs: number;
  readonly apiKey: string;
  timedOut: boolean;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onExternalAbort?: () => void;
  externalSignal?: AbortSignal;
}

interface BatchIssue {
  issued: boolean;
  receipt?: ReceiptDraft;
  body?: unknown;
  failure?: { code: RoutingFailureCode; message: string };
}

interface AnswerValidation {
  ok: true;
  selectorVersion: string;
  choices: ReadonlyMap<string, string>;
  confidences: ReadonlyMap<string, number>;
  /** Per-question option probabilities exactly as validated (full option coverage). */
  probabilities: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

interface AnswerInvalid {
  ok: false;
  code: RoutingFailureCode;
  message: string;
}

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; code: "response_too_large" | "transport_error" | "abort"; message: string };

const MODEL_INSTRUCTIONS =
  "Select exactly one candidate execution model for the delegated task described in state. "
  + "Match the task text and constraints against each candidate's user-provided characteristics. "
  + "Criteria keys are correlation IDs only. Candidate order carries no ranking; choose on fit, "
  + "not on position, model name, cost or quality assumptions.";

const TOOL_INSTRUCTIONS =
  "Decide whether this single tool should be enabled for the delegated task described in state. "
  + "Choose 'include' only when this tool is relevant to completing that task; otherwise choose "
  + "'exclude'. This decision is about the task alone and must not depend on which model "
  + "executes it. The tool name and description are in the criteria; option keys are "
  + "correlation IDs. Each question is independent.";

const ROUTING_PROFILES = new Set<RoutingProfile>(["explore", "review", "general"]);
const ROUTING_PURPOSES = new Set<RoutingPurpose>(["plan", "dispatch", "synthesis"]);

/** Shared default limiter: bounds concurrent selector HTTP requests across router instances. */
const sharedLimiter = new Semaphore(DEFAULT_ROUTING_CONCURRENCY, 256);
const ABORTED = Symbol("jev-routing-aborted");

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Fire-and-forget stream cancellation: never awaited during deadline/cancel cleanup. */
function cancelReader(reader: { cancel(reason?: unknown): Promise<void> }): void {
  try {
    Promise.resolve(reader.cancel()).catch(() => { /* best effort */ });
  } catch { /* best effort */ }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readBodyBounded(response: Response, signal: AbortSignal, maxBytes: number): Promise<BodyRead> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    if (typeof response.text !== "function") return { ok: true, text: "" };
    let text: string;
    try {
      text = await abortable(response.text(), signal);
    } catch {
      return signal.aborted
        ? { ok: false, code: "abort", message: "The routing response body read was interrupted." }
        : { ok: false, code: "transport_error", message: "The TypeSafe routing response body could not be read." };
    }
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      return { ok: false, code: "response_too_large", message: `The TypeSafe routing response exceeded the ${maxBytes}-byte response limit.` };
    }
    return { ok: true, text };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await abortable(reader.read(), signal);
      if (step.done) break;
      const value = step.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        cancelReader(reader);
        return { ok: false, code: "response_too_large", message: `The TypeSafe routing response exceeded the ${maxBytes}-byte response limit.` };
      }
      chunks.push(value);
    }
  } catch {
    cancelReader(reader);
    return signal.aborted
      ? { ok: false, code: "abort", message: "The routing response body read was interrupted." }
      : { ok: false, code: "transport_error", message: "The TypeSafe routing response body could not be read." };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function readSelectorVersion(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).model;
  if (typeof value !== "string") return undefined;
  const version = value.trim();
  if (!version || version.length > MAX_SELECTOR_VERSION_LENGTH || /[\u0000-\u001f\u007f]/.test(version)) return undefined;
  return version;
}

interface UsageExtraction {
  inputTokens?: number;
  outputTokens?: number;
  usageStatus: "reported" | "unknown";
  invalid: boolean;
}

function extractUsage(body: unknown): UsageExtraction {
  const usage = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).usage
    : undefined;
  if (usage === undefined) return { usageStatus: "unknown", invalid: false };
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return { usageStatus: "unknown", invalid: true };

  const record = usage as Record<string, unknown>;
  const readToken = (value: unknown): { value?: number; invalid: boolean } => {
    if (value === undefined || value === null) return { invalid: false };
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return { invalid: true };
    return { value, invalid: false };
  };
  const input = readToken(record.input_tokens);
  const output = readToken(record.output_tokens);
  const usageStatus = !input.invalid && !output.invalid && input.value !== undefined && output.value !== undefined ? "reported" : "unknown";
  return {
    usageStatus,
    ...(input.value === undefined ? {} : { inputTokens: input.value }),
    ...(output.value === undefined ? {} : { outputTokens: output.value }),
    invalid: input.invalid || output.invalid,
  };
}

function normalizeAnswers(raw: unknown): Map<string, unknown> | undefined {
  const map = new Map<string, unknown>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const id = (entry as Record<string, unknown>).question_id;
      if (typeof id !== "string" || !id || map.has(id)) return undefined;
      map.set(id, entry);
    }
    return map;
  }
  if (raw && typeof raw === "object") {
    for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (!id || map.has(id)) return undefined;
      map.set(id, entry);
    }
    return map;
  }
  return undefined;
}

function validateAnswers(body: unknown, questions: readonly QuestionSpec[]): AnswerValidation | AnswerInvalid {
  const invalid = (code: RoutingFailureCode, message: string): AnswerInvalid => ({ ok: false, code, message });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalid("malformed_response", "The TypeSafe routing response was not a JSON object.");
  }
  const selectorVersion = readSelectorVersion(body);
  if (selectorVersion === undefined) {
    return invalid("malformed_response", "The TypeSafe routing response did not report a usable selector model version.");
  }
  const answers = normalizeAnswers((body as Record<string, unknown>).answers);
  if (!answers) {
    return invalid("malformed_response", "The TypeSafe routing response did not contain a usable answers collection.");
  }
  if (answers.size !== questions.length) {
    return invalid("malformed_response", "The TypeSafe routing response did not answer exactly the questions that were asked.");
  }

  const choices = new Map<string, string>();
  const confidences = new Map<string, number>();
  const probabilitySets = new Map<string, ReadonlyMap<string, number>>();
  for (const question of questions) {
    const answer = answers.get(question.id);
    if (answer === undefined) {
      return invalid("malformed_response", "The TypeSafe routing response omitted an answer for a requested question.");
    }
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      return invalid("malformed_response", "A TypeSafe routing answer was not an object.");
    }
    const record = answer as Record<string, unknown>;

    if (record.type !== "choice") {
      return invalid("malformed_response", "A TypeSafe routing answer was not tagged as a choice answer.");
    }

    const choice = record.choice;
    if (typeof choice !== "string" || !question.options.includes(choice)) {
      return invalid("invalid_decision", "The TypeSafe routing response chose an option that was not offered for one of the questions.");
    }

    const rawProbabilities = record.probabilities;
    if (!rawProbabilities || typeof rawProbabilities !== "object" || Array.isArray(rawProbabilities)) {
      return invalid("malformed_response", "A TypeSafe routing answer did not include an option probability set.");
    }
    const probRecord = rawProbabilities as Record<string, unknown>;
    const keys = Object.keys(probRecord);
    if (keys.length !== question.options.length || question.options.some((option) => !keys.includes(option))) {
      return invalid("malformed_response", "A TypeSafe routing answer probability set did not match the offered options.");
    }
    let sum = 0;
    const optionProbabilities = new Map<string, number>();
    for (const option of question.options) {
      const value = probRecord[option];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        return invalid("malformed_response", "A TypeSafe routing answer reported a probability outside the finite range 0..1.");
      }
      sum += value;
      optionProbabilities.set(option, value);
    }
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
      return invalid("malformed_response", `A TypeSafe routing answer probability set did not sum to 1 within the documented tolerance (${PROBABILITY_SUM_TOLERANCE}).`);
    }

    const confidence = record.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return invalid("malformed_response", "A TypeSafe routing answer did not report a finite confidence in 0..1.");
    }

    choices.set(question.id, choice);
    confidences.set(question.id, confidence);
    probabilitySets.set(question.id, optionProbabilities);
  }
  return { ok: true, selectorVersion, choices, confidences, probabilities: probabilitySets };
}

function selectorStatusFailure(status: number): { code: RoutingFailureCode; message: string } {
  if (status === 401 || status === 403) {
    return { code: "unauthorized", message: "TypeSafe rejected the routing credential (HTTP 401/403). Check jevRouting.apiKey in your private ~/.pi/subagent.json configuration." };
  }
  if (status === 422) {
    return { code: "invalid_request", message: "TypeSafe rejected the routing request as invalid (HTTP 422). Check selectorModel and the configured candidate/tool descriptions." };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "TypeSafe rate-limited the routing request (HTTP 429). Retry the dispatch later." };
  }
  if (status === 529) {
    return { code: "overloaded", message: "TypeSafe is overloaded (HTTP 529). Retry the dispatch later." };
  }
  return { code: "http_error", message: `TypeSafe returned an unexpected HTTP status (${status}) for the routing request.` };
}

function buildState(input: RoutingSelectInput): Record<string, unknown> {
  const state: Record<string, unknown> = { task: input.task };
  const constraints = input.constraints;
  if (constraints) {
    state.constraints = {
      profile: constraints.profile,
      ...(constraints.requestedThinking === undefined ? {} : { requested_thinking: constraints.requestedThinking }),
      ...(constraints.structuredOutput === undefined ? {} : { structured_output: constraints.structuredOutput }),
    };
  }
  // Tool selection is deliberately model-independent: no selected_model is ever
  // added, so one task-based tool subset is shared by every ranked execution attempt.
  return state;
}

function serializeRequest(
  selectorModel: string,
  state: Record<string, unknown>,
  questions: readonly QuestionSpec[],
): string {
  const map: Record<string, unknown> = {};
  for (const question of questions) map[question.id] = question.question;
  return JSON.stringify({ state, model: selectorModel, questions: map });
}

function withinRequestLimit(text: string): boolean {
  return Buffer.byteLength(text, "utf8") <= MAX_ROUTING_REQUEST_BYTES;
}

function buildModelQuestion(models: readonly RoutingModelCandidate[]): QuestionSpec {
  const criteria: Record<string, string> = {};
  const options: string[] = [];
  models.forEach((candidate, index) => {
    const key = `m${index}`;
    options.push(key);
    criteria[key] = `Model: ${candidate.model}\nUser-provided characteristics: ${candidate.description}`;
  });
  return Object.freeze({
    id: "model",
    options: Object.freeze(options),
    question: Object.freeze({ type: "choice", criteria, instructions: MODEL_INSTRUCTIONS }),
  });
}

function buildToolQuestion(tool: RoutingToolCandidate, index: number): QuestionSpec {
  const description = tool.description && tool.description.trim() ? tool.description : "(no description provided)";
  return Object.freeze({
    id: `tool-${index}`,
    options: Object.freeze(["include", "exclude"]),
    toolName: tool.name,
    question: Object.freeze({
      type: "choice",
      criteria: {
        include: `Include tool "${tool.name}": ${description}`,
        exclude: `Exclude tool "${tool.name}"`,
      },
      instructions: TOOL_INSTRUCTIONS,
    }),
  });
}

interface PackedToolBatch {
  readonly text: string;
  readonly questions: readonly QuestionSpec[];
}

interface ToolBatches {
  batches: PackedToolBatch[];
}

function packToolBatches(
  tools: readonly RoutingToolCandidate[],
  state: Record<string, unknown>,
  selectorModel: string,
): ToolBatches | { error: { code: RoutingFailureCode; message: string } } {
  const oversized = (): { error: { code: RoutingFailureCode; message: string } } => ({
    error: {
      code: "request_too_large",
      message: `A single tool routing question exceeds the ${MAX_ROUTING_REQUEST_BYTES}-byte request limit; shorten that tool description or exclude it from the eligible candidates.`,
    },
  });

  const batches: PackedToolBatch[] = [];
  let current: QuestionSpec[] = [];
  for (let index = 0; index < tools.length; index++) {
    const question = buildToolQuestion(tools[index], index);
    current.push(question);
    if (withinRequestLimit(serializeRequest(selectorModel, state, current))) continue;

    current.pop();
    if (current.length === 0) return oversized();
    batches.push({ text: serializeRequest(selectorModel, state, current), questions: Object.freeze([...current]) });
    current = [question];
    if (!withinRequestLimit(serializeRequest(selectorModel, state, current))) return oversized();
  }
  if (current.length) {
    batches.push({ text: serializeRequest(selectorModel, state, current), questions: Object.freeze([...current]) });
  }
  return { batches };
}

function validateOptions(options: RoutingSelectOptions | undefined): string | undefined {
  if (!options || typeof options !== "object") return "Routing options are required.";
  if (!ROUTING_PURPOSES.has(options.purpose)) return "Routing purpose must be plan, dispatch or synthesis.";
  if (options.taskIndex !== undefined && (!Number.isInteger(options.taskIndex) || options.taskIndex < 0)) {
    return "Routing taskIndex must be a non-negative integer.";
  }
  if (options.deadline !== undefined && (typeof options.deadline !== "number" || !Number.isFinite(options.deadline))) {
    return "Routing deadline must be a finite absolute epoch-millisecond number.";
  }
  if (options.signal !== undefined && typeof (options.signal as AbortSignal)?.aborted !== "boolean") {
    return "Routing signal must be an AbortSignal.";
  }
  return undefined;
}

function validateInput(input: RoutingSelectInput | undefined): string | undefined {
  if (!input || typeof input !== "object") return "Routing input is required.";
  if (typeof input.task !== "string" || !input.task.trim()) return "The current delegated task text is required for routing.";
  if (!Array.isArray(input.models)) return "Routing input must include an array of eligible candidate models.";
  const seenModels = new Set<string>();
  for (let index = 0; index < input.models.length; index++) {
    const candidate = input.models[index];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return `Candidate model #${index + 1} is not an object.`;
    if (typeof candidate.model !== "string" || !candidate.model.trim() || candidate.model.length > MAX_ROUTING_MODEL_ID_LENGTH) {
      return `Candidate model #${index + 1} has an invalid model ID.`;
    }
    if (typeof candidate.description !== "string" || !candidate.description.trim()) {
      return `Candidate model #${index + 1} is missing a user-written characteristics description.`;
    }
    if (candidate.thinking !== undefined && !isThinkingLevel(candidate.thinking)) {
      return `Candidate model #${index + 1} has an invalid thinking default.`;
    }
    if (seenModels.has(candidate.model)) return `Candidate models contain duplicate ID ${JSON.stringify(candidate.model)}.`;
    seenModels.add(candidate.model);
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) return "Eligible tool candidates must be an array.";
    const seenTools = new Set<string>();
    for (let index = 0; index < input.tools.length; index++) {
      const tool = input.tools[index];
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return `Tool candidate #${index + 1} is not an object.`;
      if (typeof tool.name !== "string" || !tool.name.trim()) return `Tool candidate #${index + 1} has an invalid tool name.`;
      if (tool.description !== undefined && typeof tool.description !== "string") return `Tool candidate #${index + 1} has an invalid description.`;
      if (seenTools.has(tool.name)) return `Tool candidates contain duplicate name ${JSON.stringify(tool.name)}.`;
      seenTools.add(tool.name);
    }
  }
  if (input.constraints !== undefined) {
    const constraints = input.constraints;
    if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) return "Routing constraints must be an object.";
    if (!ROUTING_PROFILES.has(constraints.profile)) return "Routing constraints require a profile of explore, review or general.";
    if (constraints.requestedThinking !== undefined && !isThinkingLevel(constraints.requestedThinking)) {
      return "Routing constraints requested thinking must be a valid opaque Pi thinking level.";
    }
    if (constraints.structuredOutput !== undefined && typeof constraints.structuredOutput !== "boolean") {
      return "Routing constraints structuredOutput must be a boolean.";
    }
  }
  return undefined;
}

function freezeReceipt(draft: ReceiptDraft): RoutingReceipt {
  return Object.freeze({
    requestId: draft.requestId,
    purpose: draft.purpose,
    ...(draft.taskIndex === undefined ? {} : { taskIndex: draft.taskIndex }),
    selectorModel: draft.selectorModel,
    ...(draft.selectorVersion === undefined ? {} : { selectorVersion: draft.selectorVersion }),
    outcome: draft.outcome,
    ...(draft.code === undefined ? {} : { code: draft.code }),
    ...(draft.httpStatus === undefined ? {} : { httpStatus: draft.httpStatus }),
    durationMs: draft.durationMs,
    ...(draft.inputTokens === undefined ? {} : { inputTokens: draft.inputTokens }),
    ...(draft.outputTokens === undefined ? {} : { outputTokens: draft.outputTokens }),
    usageStatus: draft.usageStatus,
    currency: "unknown",
  });
}

export class JevRouter {
  private readonly config: JevRoutingConfig;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly limiter: RoutingLimiter;
  private readonly onReceipt: ((receipt: RoutingReceipt) => void) | undefined;

  constructor(options: JevRouterOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === "function" ? globalThis.fetch : undefined);
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.limiter = options.limiter ?? sharedLimiter;
    this.onReceipt = options.onReceipt;
  }

  /** Run one logical selection. Never throws for expected I/O/validation failures. */
  async select(input: RoutingSelectInput, options: RoutingSelectOptions): Promise<RoutingResult> {
    const call: CallState = { drafts: [], sinkErrors: [] };
    const startedAt = this.now();
    const decisionId = this.idFactory();

    const optionsProblem = validateOptions(options);
    if (optionsProblem) return this.fail("invalid_input", optionsProblem, call);

    const inputProblem = validateInput(input);
    if (inputProblem) return this.fail("invalid_input", inputProblem, call);

    const models = input.models;
    const tools = input.tools ?? [];
    if (models.length === 0) {
      return this.fail("no_candidate_models", "No locally eligible candidate model was provided; check the dedicated jevRouting candidate list against local model availability.", call);
    }
    if (models.length > MAX_ROUTING_MODELS) {
      return this.fail("too_many_models", `The selector accepts at most ${MAX_ROUTING_MODELS} candidate models per question.`, call);
    }
    if (tools.length > MAX_ROUTING_TOOL_QUESTIONS) {
      return this.fail("too_many_tools", `At most ${MAX_ROUTING_TOOL_QUESTIONS} eligible tools can be considered in one selection.`, call);
    }

    const apiKey = normalizeRoutingApiKey(this.config.apiKey);
    if (!apiKey) {
      return this.fail(
        "missing_api_key",
        "The TypeSafe routing credential is missing or invalid: set jevRouting.apiKey in your private ~/.pi/subagent.json to a non-blank key without embedded whitespace or control characters, then retry the dispatch.",
        call,
      );
    }
    if (typeof this.fetchImpl !== "function") {
      return this.fail("transport_error", "No fetch implementation is available for TypeSafe routing.", call);
    }

    // Preflight grossly oversized single tool questions before paying for the model
    // request. Tool state is task-only and model-independent, so the probe state equals
    // the real request state and the residual size case is fully preflighted here.
    if (tools.length > 0) {
      const probe = packToolBatches(tools, buildState(input), this.config.selectorModel);
      if ("error" in probe) return this.fail(probe.error.code, probe.error.message, call);
    }

    const configuredEnd = startedAt + this.config.timeoutMs;
    const callerEnd = typeof options.deadline === "number" && Number.isFinite(options.deadline) ? options.deadline : undefined;
    const deadlineAt = callerEnd === undefined ? configuredEnd : Math.min(configuredEnd, callerEnd);
    if (deadlineAt <= startedAt) {
      return this.fail("timeout", "The routing selection deadline had already passed before any selector request could be sent.", call);
    }

    const ctx = this.createContext(startedAt, deadlineAt, options.signal, apiKey);
    try {
      if (ctx.controller.signal.aborted) {
        return this.fail(this.abortCode(ctx), this.abortMessage(ctx), call);
      }

      // ---- 1. Model Choice ------------------------------------------------------------
      const modelQuestion = buildModelQuestion(models);
      const modelRequest = serializeRequest(this.config.selectorModel, buildState(input), [modelQuestion]);
      if (!withinRequestLimit(modelRequest)) {
        return this.fail(
          "request_too_large",
          `The model routing request exceeds the ${MAX_ROUTING_REQUEST_BYTES}-byte limit; shorten the task text or candidate descriptions.`,
          call,
        );
      }

      const modelIssue = await this.issue(ctx, modelRequest, {
        purpose: options.purpose,
        ...(options.taskIndex === undefined ? {} : { taskIndex: options.taskIndex }),
        sequence: 0,
      }, call);
      if (modelIssue.body === undefined) {
        const failure = modelIssue.failure ?? { code: "transport_error" as const, message: "The model routing request did not produce a usable response." };
        return this.fail(failure.code, failure.message, call);
      }
      const modelValidation = validateAnswers(modelIssue.body, [modelQuestion]);
      if (!modelValidation.ok) {
        if (modelIssue.receipt) this.markReceiptFailed(modelIssue.receipt, modelValidation.code, call);
        return this.fail(modelValidation.code, modelValidation.message, call);
      }
      const modelChoice = modelValidation.choices.get("model");
      const modelIndex = modelChoice === undefined ? -1 : modelQuestion.options.indexOf(modelChoice);
      if (modelIndex < 0 || typeof modelChoice !== "string") {
        if (modelIssue.receipt) this.markReceiptFailed(modelIssue.receipt, "invalid_decision", call);
        return this.fail("invalid_decision", "The TypeSafe routing response did not select a valid candidate model.", call);
      }
      const selectedModel = models[modelIndex].model;
      const modelConfidence = modelValidation.confidences.get("model");
      const primaryVersion = modelValidation.selectorVersion;
      const versions: string[] = [primaryVersion];

      // ---- 1b. Probability ranking (retained distribution) ---------------------------
      // Official Choice contract: `choice` is a highest-probability option. A response
      // that contradicts its own distribution is rejected, never substituted.
      const modelProbabilities = modelValidation.probabilities.get("model");
      if (!modelProbabilities) {
        if (modelIssue.receipt) this.markReceiptFailed(modelIssue.receipt, "malformed_response", call);
        return this.fail("malformed_response", "The TypeSafe routing answer did not include the validated option probability set.", call);
      }
      const choiceProblem = choiceIsMaximal(modelProbabilities, modelChoice, selectedModel);
      if (choiceProblem) {
        if (modelIssue.receipt) this.markReceiptFailed(modelIssue.receipt, "invalid_decision", call);
        return this.fail("invalid_decision", `The TypeSafe routing answer contradicts its own probability distribution: ${choiceProblem}.`, call);
      }
      const rankedModels: readonly RankedModelOption[] = Object.freeze(orderRankedModels(
        models.map((candidate, index) => ({
          model: candidate.model,
          probability: modelProbabilities.get(modelQuestion.options[index]!) ?? 0,
        })),
        selectedModel,
      ));

      // ---- 2. One binary Choice per eligible tool (task-based, model-independent) ----
      const selectedTools: string[] = [];
      if (tools.length > 0) {
        const packed = packToolBatches(tools, buildState(input), this.config.selectorModel);
        if ("error" in packed) return this.fail(packed.error.code, packed.error.message, call);

        const settled = await Promise.all(packed.batches.map(async (batch, index) => {
          const outcome = await this.issue(ctx, batch.text, {
            purpose: options.purpose,
            ...(options.taskIndex === undefined ? {} : { taskIndex: options.taskIndex }),
            sequence: index + 1,
          }, call);

          if (outcome.body === undefined) {
            const failure = outcome.failure ?? { code: "transport_error" as const, message: "A tool routing request did not produce a usable response." };
            if (!ctx.controller.signal.aborted) ctx.controller.abort();
            return { index, batch, choices: undefined as ReadonlyMap<string, string> | undefined, version: undefined as string | undefined, failure };
          }

          const validation = validateAnswers(outcome.body, batch.questions);
          if (!validation.ok) {
            if (outcome.receipt) this.markReceiptFailed(outcome.receipt, validation.code, call);
            if (!ctx.controller.signal.aborted) ctx.controller.abort();
            return { index, batch, choices: undefined, version: undefined, failure: { code: validation.code, message: validation.message } };
          }
          return { index, batch, choices: validation.choices, version: validation.selectorVersion, failure: undefined };
        }));

        const failures = settled.filter((entry) => entry.failure !== undefined).sort((a, b) => a.index - b.index);
        if (failures.length > 0) {
          const primary = failures.find((entry) => entry.failure!.code !== "aborted") ?? failures[0];
          return this.fail(primary.failure!.code, primary.failure!.message, call);
        }

        for (const entry of settled.sort((a, b) => a.index - b.index)) {
          if (entry.version !== undefined && !versions.includes(entry.version)) versions.push(entry.version);
          for (const question of entry.batch.questions) {
            if (entry.choices?.get(question.id) === "include" && question.toolName) selectedTools.push(question.toolName);
          }
        }
      }

      const decision: RoutingDecision = Object.freeze({
        decisionId,
        purpose: options.purpose,
        ...(options.taskIndex === undefined ? {} : { taskIndex: options.taskIndex }),
        selectedModel,
        selectedTools: Object.freeze(selectedTools),
        rankedModels,
        ...(modelConfidence === undefined ? {} : { confidence: modelConfidence }),
        selectorModel: this.config.selectorModel,
        selectorVersion: primaryVersion,
        selectorVersions: Object.freeze(versions),
        latencyMs: Math.max(0, this.now() - startedAt),
        receiptIds: Object.freeze([...call.drafts].sort((a, b) => a.sequence - b.sequence).map((draft) => draft.requestId)),
      });
      return {
        ok: true,
        decision,
        receipts: this.settle(call),
        ...(call.sinkErrors.length ? { persistenceErrors: Object.freeze([...call.sinkErrors]) } : {}),
      };
    } catch {
      // Unexpected internal failures stay inside the discriminated result and never echo
      // provider bodies, headers or credentials.
      return this.fail("transport_error", "The routing selection failed unexpectedly before a decision was available.", call);
    } finally {
      this.releaseContext(ctx);
    }
  }

  private createContext(startedAt: number, deadlineAt: number, external: AbortSignal | undefined, apiKey: string): CallContext {
    const controller = new AbortController();
    const ctx: CallContext = {
      controller,
      startedAt,
      deadlineMs: Math.max(0, deadlineAt - startedAt),
      apiKey,
      timedOut: false,
      cancelled: false,
    };
    const timer = setTimeout(() => {
      ctx.timedOut = true;
      controller.abort();
    }, Math.max(0, deadlineAt - startedAt));
    timer.unref?.();
    ctx.timer = timer;

    if (external) {
      if (external.aborted) {
        ctx.cancelled = true;
        controller.abort();
      } else {
        const onExternalAbort = () => {
          ctx.cancelled = true;
          controller.abort();
        };
        external.addEventListener("abort", onExternalAbort, { once: true });
        ctx.onExternalAbort = onExternalAbort;
        ctx.externalSignal = external;
      }
    }
    return ctx;
  }

  private releaseContext(ctx: CallContext): void {
    if (ctx.timer) clearTimeout(ctx.timer);
    if (ctx.externalSignal && ctx.onExternalAbort) {
      ctx.externalSignal.removeEventListener("abort", ctx.onExternalAbort);
    }
  }

  private abortCode(ctx: CallContext): RoutingFailureCode {
    return ctx.timedOut ? "timeout" : "aborted";
  }

  private abortOutcome(ctx: CallContext): RoutingReceiptOutcome {
    return ctx.timedOut ? "timeout" : "aborted";
  }

  private abortMessage(ctx: CallContext): string {
    return ctx.timedOut
      ? `The routing selection exceeded its ${ctx.deadlineMs} ms logical deadline and no decision was available.`
      : "The routing selection was cancelled before a decision was available.";
  }

  private publishReceipt(draft: ReceiptDraft, call: CallState): void {
    if (!this.onReceipt) return;
    try {
      this.onReceipt(freezeReceipt(draft));
    } catch {
      call.sinkErrors.push(`Receipt persistence failed for request ${draft.requestId}; the receipt was still retained in the routing result.`);
    }
  }

  private markReceiptFailed(receipt: ReceiptDraft, code: RoutingFailureCode, call: CallState): void {
    receipt.outcome = "error";
    receipt.code = code;
    this.publishReceipt(receipt, call);
  }

  private async issue(ctx: CallContext, text: string, meta: IssueMeta, call: CallState): Promise<BatchIssue> {
    const signal = ctx.controller.signal;
    if (signal.aborted) {
      return { issued: false, failure: { code: this.abortCode(ctx), message: this.abortMessage(ctx) } };
    }

    try {
      await this.limiter.acquire(signal);
    } catch {
      if (signal.aborted) {
        return { issued: false, failure: { code: this.abortCode(ctx), message: this.abortMessage(ctx) } };
      }
      return {
        issued: false,
        failure: {
          code: "transport_error",
          message: "Too many concurrent routing requests are already queued; retry with fewer eligible tools or a later dispatch.",
        },
      };
    }

    const startedAt = this.now();
    const draft = (overrides: Partial<ReceiptDraft>): ReceiptDraft => {
      const entry: ReceiptDraft = {
        requestId: this.idFactory(),
        purpose: meta.purpose,
        ...(meta.taskIndex === undefined ? {} : { taskIndex: meta.taskIndex }),
        selectorModel: this.config.selectorModel,
        outcome: "error",
        durationMs: Math.max(0, this.now() - startedAt),
        usageStatus: "unknown",
        currency: "unknown",
        sequence: meta.sequence,
        ...overrides,
      };
      call.drafts.push(entry);
      return entry;
    };

    try {
      // Recheck after queuing: the deadline or caller cancellation may have fired while waiting.
      if (signal.aborted) {
        return { issued: false, failure: { code: this.abortCode(ctx), message: this.abortMessage(ctx) } };
      }

      let response: Response;
      try {
        // `abortable` protects the logical deadline even when an injected transport ignores
        // its AbortSignal and never settles on its own.
        response = await abortable(Promise.resolve(this.fetchImpl!(TYPESAFE_SYSTEMONE_ENDPOINT, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${ctx.apiKey}`,
          },
          body: text,
          signal,
        })), signal);
      } catch {
        if (signal.aborted) {
          const code = this.abortCode(ctx);
          const receipt = draft({ outcome: this.abortOutcome(ctx), code });
          this.publishReceipt(receipt, call);
          return { issued: true, receipt, failure: { code, message: this.abortMessage(ctx) } };
        }
        const receipt = draft({ outcome: "error", code: "transport_error" });
        this.publishReceipt(receipt, call);
        return {
          issued: true,
          receipt,
          failure: { code: "transport_error", message: "The TypeSafe routing request did not complete (network or transport failure)." },
        };
      }

      if (!response.ok) {
        // Parse the bounded error body only to salvage reported usage/version; never echo it.
        const failure = selectorStatusFailure(response.status);
        const read = await readBodyBounded(response, signal, MAX_ROUTING_RESPONSE_BYTES);
        if (!read.ok && read.code === "abort") {
          const code = this.abortCode(ctx);
          const receipt = draft({ outcome: this.abortOutcome(ctx), code, httpStatus: response.status });
          this.publishReceipt(receipt, call);
          return { issued: true, receipt, failure: { code, message: this.abortMessage(ctx) } };
        }
        const parsed = read.ok ? tryParseJson(read.text) : undefined;
        const usage = parsed === undefined ? { usageStatus: "unknown" as const, invalid: false } : extractUsage(parsed);
        const selectorVersion = parsed === undefined ? undefined : readSelectorVersion(parsed);
        const receipt = draft({
          outcome: "error",
          code: failure.code,
          httpStatus: response.status,
          ...(selectorVersion === undefined ? {} : { selectorVersion }),
          ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
          ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
          usageStatus: usage.usageStatus,
        });
        this.publishReceipt(receipt, call);
        return { issued: true, receipt, failure };
      }

      const read = await readBodyBounded(response, signal, MAX_ROUTING_RESPONSE_BYTES);
      if (!read.ok) {
        if (read.code === "abort") {
          const code = this.abortCode(ctx);
          const receipt = draft({ outcome: this.abortOutcome(ctx), code });
          this.publishReceipt(receipt, call);
          return { issued: true, receipt, failure: { code, message: this.abortMessage(ctx) } };
        }
        const code: RoutingFailureCode = read.code === "response_too_large" ? "response_too_large" : "transport_error";
        const receipt = draft({ outcome: "error", code });
        this.publishReceipt(receipt, call);
        return { issued: true, receipt, failure: { code, message: read.message } };
      }

      const parsed = tryParseJson(read.text);
      if (parsed === undefined || parsed === null) {
        const receipt = draft({ outcome: "error", code: "malformed_response" });
        this.publishReceipt(receipt, call);
        return {
          issued: true,
          receipt,
          failure: { code: "malformed_response", message: "The TypeSafe routing response was not valid JSON." },
        };
      }

      const selectorVersion = readSelectorVersion(parsed);
      const usage = extractUsage(parsed);
      const usageFields = {
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        usageStatus: usage.usageStatus,
      };

      if (selectorVersion === undefined) {
        const receipt = draft({ outcome: "error", code: "malformed_response", ...usageFields });
        this.publishReceipt(receipt, call);
        return {
          issued: true,
          receipt,
          failure: { code: "malformed_response", message: "The TypeSafe routing response did not report a usable selector model version." },
        };
      }
      if (usage.invalid) {
        const receipt = draft({ outcome: "error", code: "malformed_response", selectorVersion, ...usageFields });
        this.publishReceipt(receipt, call);
        return {
          issued: true,
          receipt,
          failure: { code: "malformed_response", message: "The TypeSafe routing response reported invalid token usage." },
        };
      }

      const receipt = draft({ outcome: "success", selectorVersion, ...usageFields });
      this.publishReceipt(receipt, call);
      return { issued: true, receipt, body: parsed };
    } finally {
      this.limiter.release();
    }
  }

  private settle(call: CallState): readonly RoutingReceipt[] {
    const ordered = [...call.drafts].sort((a, b) => a.sequence - b.sequence);
    return Object.freeze(ordered.map(freezeReceipt));
  }

  private fail(code: RoutingFailureCode, message: string, call: CallState): RoutingResult {
    return {
      ok: false,
      code,
      message,
      receipts: this.settle(call),
      ...(call.sinkErrors.length ? { persistenceErrors: Object.freeze([...call.sinkErrors]) } : {}),
    };
  }
}
