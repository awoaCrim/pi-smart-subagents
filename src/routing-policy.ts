import { isThinkingLevel } from "./thinking.js";
import {
  DEFAULT_ROUTING_TIMEOUT_MS,
  DEFAULT_SELECTOR_MODEL,
  MAX_ROUTING_MODEL_ID_LENGTH,
  MAX_ROUTING_MODELS,
  MAX_ROUTING_SELECTOR_MODEL_LENGTH,
  ROUTING_TIMEOUT_MAX_MS,
  ROUTING_TIMEOUT_MIN_MS,
  type JevRoutingConfig,
  type JevRoutingModelEntry,
  type RoutingModelCandidate,
  type RoutingToolCandidate,
} from "./routing-types.js";

// Re-exported so integration can import routing types from their owning routing module.
export type {
  JevRoutingConfig,
  JevRoutingModelEntry,
  RoutingModelCandidate,
  RoutingToolCandidate,
} from "./routing-types.js";

/**
 * Strict, pure parser/formatter for the mandatory `jevRouting` subtree.
 *
 * This module owns only the user-controlled routing configuration:
 *
 * - `parseJevRouting(raw, source?)` parses the `jevRouting` **subtree** (not the whole
 *   `~/.pi/subagent.json` file) and returns an immutable snapshot. It throws a plain
 *   `Error` with an actionable message on any unknown field, duplicate/blank model ID,
 *   blank description, missing/invalid credential, non-integer/out-of-range timeout
 *   or unsupported candidate count. Callers (`src/config.ts`) expose safe error messages;
 *   the parser never reads the environment or a provider catalog.
 * - `formatJevRoutingPrompt` renders model-facing guidance and works with **no** config, no
 *   credential and no inference, so management actions stay independent of routing setup.
 * - The candidate helpers are pure; they never contact Pi or TypeSafe.
 *
 * The private snapshot contains the credential from `apiKey`. Never serialize it into
 * model-facing guidance or selector input. Credential diagnostics contain no supplied
 * values. Legacy `apiKeyEnv` is rejected with manual migration guidance, without lookup.
 */

/** Default config-file label used in prose (owned by `config.ts` for file reads). */
export const JEV_ROUTING_CONFIG_FILE = "~/.pi/subagent.json";

/** Exact provider/model ID: at least one slash, further ID slashes allowed; no whitespace, control chars or globs. */
const MODEL_ID = /^[^\s\u0000-\u001f\u007f/*?]+(?:\/[^\s\u0000-\u001f\u007f/*?]+)+$/u;
const MAX_GUIDANCE_MODEL_LINES = 50;

function invalid(source: string, message: string): never {
  throw new Error(`Invalid jevRouting in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, pathName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(source, `${pathName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], source: string, pathName: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length) invalid(source, `${pathName} has unknown field(s): ${unknown.join(", ")}`);
}

function parseSelectorModel(value: unknown, source: string): string {
  if (value === undefined) return DEFAULT_SELECTOR_MODEL;
  if (typeof value !== "string") invalid(source, "selectorModel must be a string");
  const model = value.trim();
  if (!model || model.length > MAX_ROUTING_SELECTOR_MODEL_LENGTH || /[\s\u0000-\u001f\u007f]/u.test(model)) {
    invalid(source, `selectorModel must be a non-empty selector alias or version without whitespace or control characters`);
  }
  return model;
}

/** Shared credential normalization for config parsing and defensive transport validation. */
export function normalizeRoutingApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return key && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(key) ? key : undefined;
}

function parseApiKey(value: unknown, source: string): string {
  const key = normalizeRoutingApiKey(value);
  if (key === undefined) {
    invalid(source, "apiKey is required and must be a non-blank key without embedded whitespace or control characters; store it only in your private user config");
  }
  return key;
}

function parseTimeoutMs(value: unknown, source: string): number {
  if (value === undefined) return DEFAULT_ROUTING_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < ROUTING_TIMEOUT_MIN_MS || value > ROUTING_TIMEOUT_MAX_MS) {
    invalid(source, `timeoutMs must be an integer between ${ROUTING_TIMEOUT_MIN_MS} and ${ROUTING_TIMEOUT_MAX_MS}`);
  }
  return value;
}

function parseModelEntry(value: unknown, pathName: string, source: string): JevRoutingModelEntry {
  const record = requireObject(value, source, pathName);
  rejectUnknownKeys(record, ["model", "description", "thinking"], source, pathName);

  const rawModel = record.model;
  const model = typeof rawModel === "string" ? rawModel.trim() : "";
  if (!model || model.length > MAX_ROUTING_MODEL_ID_LENGTH || !MODEL_ID.test(model)) {
    invalid(source, `${pathName}.model must be an exact provider/model-id without whitespace, control characters or glob patterns`);
  }

  const rawDescription = record.description;
  if (typeof rawDescription !== "string" || !rawDescription.trim()) {
    invalid(source, `${pathName}.description must be a non-blank user-written characteristics description`);
  }

  const thinking = record.thinking;
  if (thinking !== undefined && !isThinkingLevel(thinking)) {
    invalid(source, `${pathName}.thinking must be a non-empty Pi thinking-level string without whitespace or control characters`);
  }

  return Object.freeze({
    model,
    description: rawDescription,
    ...(thinking === undefined ? {} : { thinking }),
  });
}

function parseModels(value: unknown, source: string): readonly JevRoutingModelEntry[] {
  if (value === undefined) invalid(source, "models is required and must list at least one candidate model");
  if (!Array.isArray(value)) invalid(source, "models must be an array of candidate model entries");
  if (value.length === 0) invalid(source, `models must list at least 1 candidate model`);
  if (value.length > MAX_ROUTING_MODELS) invalid(source, `models must not list more than ${MAX_ROUTING_MODELS} candidates`);

  const entries: JevRoutingModelEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry = parseModelEntry(value[index], `models[${index}]`, source);
    if (seen.has(entry.model)) invalid(source, `models contains duplicate model ID ${JSON.stringify(entry.model)}`);
    seen.add(entry.model);
    entries.push(entry);
  }
  return Object.freeze(entries);
}

/**
 * Parse and freeze the `jevRouting` subtree.
 *
 * @param raw    the value at `config.jevRouting` (the subtree, not the whole config file)
 * @param source human-readable source label used in error messages
 */
export function parseJevRouting(raw: unknown, source = JEV_ROUTING_CONFIG_FILE): JevRoutingConfig {
  const record = requireObject(raw, source, "jevRouting");
  if (Object.prototype.hasOwnProperty.call(record, "apiKeyEnv")) {
    invalid(source, "apiKeyEnv is no longer supported; remove it and set jevRouting.apiKey to the credential in your private user config. No environment fallback or automatic migration is performed");
  }
  rejectUnknownKeys(record, ["selectorModel", "apiKey", "timeoutMs", "models"], source, "jevRouting");

  const snapshot: JevRoutingConfig = {
    selectorModel: parseSelectorModel(record.selectorModel, source),
    apiKey: parseApiKey(record.apiKey, source),
    timeoutMs: parseTimeoutMs(record.timeoutMs, source),
    models: parseModels(record.models, source),
  };
  return Object.freeze(snapshot);
}

/** A documented manual-migration/template snippet; contains no credential value. */
export function jevRoutingTemplate(): string {
  return JSON.stringify({
    jevRouting: {
      selectorModel: DEFAULT_SELECTOR_MODEL,
      apiKey: "<your-typesafe-api-key>",
      timeoutMs: DEFAULT_ROUTING_TIMEOUT_MS,
      models: [
        {
          model: "<provider/model-id>",
          description: "<user-written characteristics, including Chinese>",
          thinking: "<optional opaque Pi thinking default>",
        },
      ],
    },
  }, null, 2);
}

function freezeCandidate(entry: JevRoutingModelEntry): RoutingModelCandidate {
  return Object.freeze({
    model: entry.model,
    description: entry.description,
    ...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
  });
}

/** Frozen candidate list in configured order; descriptions are preserved unchanged. */
export function modelCandidates(config: JevRoutingConfig): readonly RoutingModelCandidate[] {
  return Object.freeze(config.models.map(freezeCandidate));
}

/**
 * Intersect the dedicated list with locally available exact model IDs, preserving the
 * user's configured order. No ranking, cost or quality preset is applied. An empty result
 * means the caller must reject before any HTTP request.
 */
export function eligibleModelCandidates(
  config: JevRoutingConfig,
  availableModels: readonly string[],
): readonly RoutingModelCandidate[] {
  const available = new Set(availableModels);
  return Object.freeze(config.models.filter((entry) => available.has(entry.model)).map(freezeCandidate));
}

/** The selected candidate's optional Pi thinking default, or `undefined`. */
export function candidateThinking(config: JevRoutingConfig, model: string): string | undefined {
  return config.models.find((entry) => entry.model === model)?.thinking;
}

/**
 * Build frozen tool candidates from local tool metadata. Blank names are dropped and
 * duplicate names keep the first description; no schema, source path or executable
 * definition is retained.
 */
export function toToolCandidates(
  tools: ReadonlyArray<{ name: string; description?: string }>,
): readonly RoutingToolCandidate[] {
  const seen = new Set<string>();
  const candidates: RoutingToolCandidate[] = [];
  for (const tool of tools) {
    const name = typeof tool?.name === "string" ? tool.name.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description = typeof tool.description === "string" ? tool.description : "";
    candidates.push(Object.freeze({ name, description }));
  }
  return Object.freeze(candidates);
}

function routingSummary(config: JevRoutingConfig): string[] {
  const lines = [
    "## Subagent routing (Jev / TypeSafe)",
    "Every new task/tasks[] spawn, action:\"plan\" request, /btw, resume, fork and synthesis is routed by the Jev selector against the user's candidate-model list.",
    "Do not pass model or fallback_models: those fields no longer select a route on new work and are rejected. Management actions (status/wait/cancel/steer/diff/apply/discard) never call the selector and need no credential.",
    `Selector: ${config.selectorModel} (pin an exact version instead of the moving alias to make selection reproducible).`,
    "Credential: jevRouting.apiKey in the private ~/.pi/subagent.json config file. Never read or copy its value into prompts, logs or results; the routing transport uses it only for the Authorization header.",
    `Logical selection deadline: ${config.timeoutMs} ms, covering all selector requests and waiting for one invocation.`,
    "Only Pi-backed new dispatch is supported; native Codex/Claude new dispatches are rejected rather than routed.",
    "Candidate models (exact IDs; the user's per-model characteristics are the matching criteria):",
  ];
  const listed = config.models.slice(0, MAX_GUIDANCE_MODEL_LINES);
  for (const entry of listed) {
    lines.push(`- ${entry.model}: thinking default ${entry.thinking ?? "(unset)"}`);
  }
  if (config.models.length > listed.length) {
    lines.push(`- …and ${config.models.length - listed.length} more configured candidate(s); every configured candidate is eligible.`);
  }
  lines.push(
    "The selector returns probability-ranked model candidates and one task-based, model-independent include/exclude decision per eligible tool. Unknown, unsafe or unavailable choices are rejected locally, and required Pi control-plane tools are added locally. Before any tool starts, a recognized settled model-availability failure can advance through this ranking without another selector request, under the total max_retries extra-attempt budget (0 = initial attempt only; default 1). Started or uncertain tool activity, auth/quota/context/schema failures, cancellation and exhausted task budgets stop switching. Confidence is answer-level; priorities use option probabilities, with no threshold.",
  );
  return lines;
}

/**
 * Model-facing guidance. Pure: renders correctly with no config and never reads the
 * environment or performs inference, so management stays available while routing is
 * missing or broken.
 */
export function formatJevRoutingPrompt(config: JevRoutingConfig | undefined, error?: string): string {
  if (!config) {
    return [
      "## Subagent routing (Jev / TypeSafe)",
      error || `No valid jevRouting configuration was found in ${JEV_ROUTING_CONFIG_FILE}.`,
      "Management actions (status/wait/cancel/steer/diff/apply/discard) remain available, but every new task/tasks[] spawn, plan, /btw, resume, fork and synthesis is rejected until jevRouting is configured.",
      "Add jevRouting with selectorModel, apiKey and 1-255 candidate model entries (exact provider/model IDs plus user-written characteristics, including Chinese). The user must store the credential in the private config file, not in chat or source control. Do not read or display the key. Legacy apiKeyEnv is rejected; there is no environment fallback.",
      "Do not pass model or fallback_models; the selector chooses the execution model and tools.",
      "Use the package routing template; do not invent model IDs or import legacy modelPolicy entries automatically.",
    ].join("\n");
  }
  return routingSummary(config).join("\n");
}
