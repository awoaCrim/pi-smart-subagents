/**
 * Shared Jev routing contract: DTOs, decisions, receipts and resource limits.
 *
 * This module deliberately has **no engine imports**. It must stay importable from the
 * composition root, from route persistence/usage code, and from isolated offline harnesses
 * without pulling in config, policy, registry or process code. Only Node builtins and the
 * leaf `thinking.ts` helper may be used by dependants.
 *
 * Everything here describes the *selector boundary*. Local permission enforcement, profile
 * filtering and mandatory Pi control-plane tools stay in `src/policy.ts` and the caller.
 */

/**
 * Fixed official TypeSafe endpoint. The first version has no custom base URL, proxy or
 * task-selected endpoint; the transport always uses this constant with `redirect:"error"`.
 */
export const TYPESAFE_SYSTEMONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Stable alias default. An exact supported version may be pinned through config. */
export const DEFAULT_SELECTOR_MODEL = "jev-latest";
/** Default logical selection deadline in milliseconds. */
export const DEFAULT_ROUTING_TIMEOUT_MS = 15_000;
export const ROUTING_TIMEOUT_MIN_MS = 100;
export const ROUTING_TIMEOUT_MAX_MS = 600_000;
/** Dedicated candidate-model allowlist bounds (Choice supports up to 255 options). */
export const MAX_ROUTING_MODELS = 255;
/** Eligible tool questions per logical selection. */
export const MAX_ROUTING_TOOL_QUESTIONS = 256;
/** Serialized request bound (local resource limit, not an advertised provider token limit). */
export const MAX_ROUTING_REQUEST_BYTES = 24 * 1024;
/** Response body bound; larger bodies are rejected, never truncated. */
export const MAX_ROUTING_RESPONSE_BYTES = 1024 * 1024;
/** Concurrent selector HTTP requests across overlapping router calls. */
export const DEFAULT_ROUTING_CONCURRENCY = 2;
/** Documented tolerance for a Choice probability distribution summing to 1. */
export const PROBABILITY_SUM_TOLERANCE = 0.02;
/** Bounds for opaque identifier strings read from untrusted responses/config. */
export const MAX_SELECTOR_VERSION_LENGTH = 128;
export const MAX_ROUTING_MODEL_ID_LENGTH = 256;
export const MAX_ROUTING_SELECTOR_MODEL_LENGTH = 128;

/** Why this logical selection ran. Metadata only; never part of the HTTP DTO. */
export type RoutingPurpose = "plan" | "dispatch" | "synthesis";
/** Local execution profile the caller already enforced. */
export type RoutingProfile = "explore" | "review" | "general";

/**
 * Stable machine-readable failure codes. Messages are safe for models and the TUI and never
 * contain raw provider bodies, headers, credentials, task text or filesystem paths.
 */
export type RoutingFailureCode =
  | "invalid_input"
  | "missing_api_key"
  | "no_candidate_models"
  | "too_many_models"
  | "too_many_tools"
  | "request_too_large"
  | "response_too_large"
  | "transport_error"
  | "timeout"
  | "aborted"
  | "unauthorized"
  | "invalid_request"
  | "rate_limited"
  | "overloaded"
  | "http_error"
  | "malformed_response"
  | "invalid_decision";

/** Outcome of one actual HTTP attempt. */
export type RoutingReceiptOutcome = "success" | "error" | "timeout" | "aborted";
/** `unknown` is the honest state whenever tokens were not validly reported. */
export type RoutingUsageStatus = "reported" | "unknown";

/** One configured candidate model entry, owned by the user's `jevRouting` config. */
export interface JevRoutingModelEntry {
  /** Exact provider/model ID; no globs or Pi fuzzy-match patterns. */
  readonly model: string;
  /** User-written characteristics, including Chinese; the selector's matching criteria. */
  readonly description: string;
  /** Optional opaque Pi thinking default for this model. Local only, never a Jev question. */
  readonly thinking?: string;
}

/**
 * Immutable `jevRouting` snapshot parsed from the user config subtree.
 * Contains a private credential. Never log this snapshot or serialize it into prompts,
 * selector bodies, task specs, receipts or results; use explicit non-secret projections.
 */
export interface JevRoutingConfig {
  readonly selectorModel: string;
  /** User-configured TypeSafe credential; transport Authorization header only. */
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly models: readonly JevRoutingModelEntry[];
}

/** A candidate model that is both configured and locally eligible. */
export interface RoutingModelCandidate {
  readonly model: string;
  readonly description: string;
  readonly thinking?: string;
}

/**
 * One probability-ranked candidate as returned by the model Choice answer.
 * `probability` is the validated per-option value from TypeSafe's full
 * distribution — not the answer-level `confidence` and not a measured
 * availability or quality score. Entries are ordered by descending
 * probability; the returned choice leads a tied maximum and remaining ties
 * keep the configured candidate order. Zero and low probabilities remain
 * valid candidates; no threshold is applied.
 */
export interface RankedModelOption {
  readonly model: string;
  readonly probability: number;
}

/**
 * A tool offered to the selector. The caller must have already removed mandatory local
 * additions (Pi control-plane tools) — those are never Jev questions.
 */
export interface RoutingToolCandidate {
  readonly name: string;
  readonly description: string;
}

/** Necessary typed constraints. Schema examples, paths and session IDs must not be added. */
export interface RoutingConstraints {
  readonly profile: RoutingProfile;
  /** Opaque Pi thinking level requested by the task/agent/profile. */
  readonly requestedThinking?: string;
  readonly structuredOutput?: boolean;
}

/**
 * The only routing input. It intentionally cannot carry a `TaskSpec`, `ParentContext`,
 * agent config, system prompt, persona, tool schema or session identity.
 */
export interface RoutingSelectInput {
  /** Current delegated task text only. */
  readonly task: string;
  /** Locally eligible candidate models, preserving the user's configured order. */
  readonly models: readonly RoutingModelCandidate[];
  /** Eligible non-mandatory tools; an empty/absent list means a model-only question. */
  readonly tools?: readonly RoutingToolCandidate[];
  readonly constraints?: RoutingConstraints;
}

/** Everything that is metadata or lifecycle, kept out of the HTTP DTO. */
export interface RoutingSelectOptions {
  readonly purpose: RoutingPurpose;
  /** Zero-based task index for parallel/plan fanout; metadata only. */
  readonly taskIndex?: number;
  readonly signal?: AbortSignal;
  /** Caller absolute deadline (epoch ms). The logical deadline is the smaller bound. */
  readonly deadline?: number;
}

/**
 * One receipt per **actual** HTTP attempt. `requestId` is always a full unique ID.
 * Tokens are retained even when the decision is later rejected; when no valid usage was
 * reported, `usageStatus` stays `unknown` rather than an invented zero.
 */
export interface RoutingReceipt {
  readonly requestId: string;
  readonly purpose: RoutingPurpose;
  readonly taskIndex?: number;
  /** Selector model requested (alias or pinned version). */
  readonly selectorModel: string;
  /** Actual selector version reported by a parseable response. */
  readonly selectorVersion?: string;
  readonly outcome: RoutingReceiptOutcome;
  readonly code?: RoutingFailureCode;
  readonly httpStatus?: number;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly usageStatus: RoutingUsageStatus;
  /** TypeSafe reports tokens, not billed currency. Never inferred locally. */
  readonly currency: "unknown";
}

/**
 * A validated selection. `selectedTools` is the Jev-chosen subset only; the caller still
 * applies local capability validation, adds mandatory Pi control-plane tools and recomputes
 * writer capability.
 */
export interface RoutingDecision {
  /** Unique logical decision ID, separate from every receipt/request ID. */
  readonly decisionId: string;
  readonly purpose: RoutingPurpose;
  readonly taskIndex?: number;
  readonly selectedModel: string;
  readonly selectedTools: readonly string[];
  /** Confidence of the model Choice. Diagnostic only; never a permission threshold. */
  readonly confidence?: number;
  /**
   * Full probability-ranked candidate list for automatic pre-tool availability
   * failover. New router decisions always carry the complete ordered ranking.
   * Optional only at legacy/persistence boundaries: a decoded decision without
   * a ranking is display metadata and is never re-materialized into an
   * executable attempt plan.
   */
  readonly rankedModels?: readonly RankedModelOption[];
  readonly selectorModel: string;
  /** Primary selector version: the version reported by the model response. */
  readonly selectorVersion?: string;
  /**
   * Every distinct selector version observed across this selection, in first-seen order.
   * A moving alias such as `jev-latest` may resolve differently between the model and tool
   * requests; that is recorded, never treated as an error.
   */
  readonly selectorVersions: readonly string[];
  /** Total logical selection latency, including all requests and waiting. */
  readonly latencyMs: number;
  /** Receipt IDs backing this decision, in issue order. */
  readonly receiptIds: readonly string[];
}

/** Discriminated result: failures never throw and always return available receipts. */
export type RoutingResult =
  | {
      readonly ok: true;
      readonly decision: RoutingDecision;
      readonly receipts: readonly RoutingReceipt[];
      /**
       * Safe, non-secret diagnostics when an injected receipt sink failed. Receipt tokens are
       * still returned; the caller can retry persistence for the listed request IDs.
       */
      readonly persistenceErrors?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: RoutingFailureCode;
      readonly message: string;
      readonly receipts: readonly RoutingReceipt[];
      readonly persistenceErrors?: readonly string[];
    };
