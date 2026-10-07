import { Type, type Static } from "typebox";
import type { ToolMode } from "./config.js";

/** Rebuild provider schemas without TypeBox compositor metadata; never mutate validators. */
export function sanitizeProviderSchema<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderSchema(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith("~"))
        .map(([key, entry]) => [key, sanitizeProviderSchema(entry)] as const),
    ) as T;
  }
  return value;
}

const OutputMode = Type.Union([Type.Literal("inline"), Type.Literal("file-only")]);
const Profile = Type.Union([Type.Literal("explore"), Type.Literal("review"), Type.Literal("general")]);
const Difficulty = Type.Union([Type.Literal("simple"), Type.Literal("moderate"), Type.Literal("complex")]);
const Isolation = Type.Union([Type.Literal("shared"), Type.Literal("worktree")]);
const MANAGEMENT_ACTIONS = ["status", "wait", "cancel", "steer", "diff", "apply", "discard"] as const;
const FULL_ACTIONS = [...MANAGEMENT_ACTIONS, "plan"] as const;
const actionSchema = <const T extends readonly string[]>(actions: T) => Type.Optional(Type.Union(actions.map((action) => Type.Literal(action as T[number])), {
  description: actions.includes("plan") ? "Manage a run; plan previews a route without a child (selector fees apply)." : "Inspect, collect, stop, steer, or manage worktree results.",
}));

/** Canonical task fields, including legacy fields solely for actionable local rejection. */
export const TaskFields = {
  agent: Type.Optional(Type.String({ minLength: 1, description: "Named persona and trusted defaults from .pi/agents/<name>.md." })),
  description: Type.Optional(Type.String({ description: "Short task label (3-5 words)." })),
  system_prompt: Type.Optional(Type.String({ description: "Append instructions to the persona system prompt." })),
  model: Type.Optional(Type.String({ description: "Rejected legacy field; Jev selects the model." })),
  // Thinking is trusted configuration, never caller input.
  tools: Type.Optional(Type.Array(Type.String({ description: "Ordinary direct tool name." }), { description: "Ordinary-tool ceiling and required child capabilities; native tools stay host-managed." })),
  profile: Type.Optional({ ...Profile, description: "explore/review restrict ordinary writes; general may write. Not an OS sandbox." }),
  difficulty: Type.Optional({ ...Difficulty, description: "Lowest truthful scope: simple (bounded check), moderate (multi-file work), complex (architecture/debugging)." }),
  cwd: Type.Optional(Type.String({ description: "Child working directory." })),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 24 * 60 * 60_000, description: "Total milliseconds, including preflight, routing, queue and retries." })),
  max_turns: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Turn budget; wrap-up grace preserves partial output." })),
  max_cost: Type.Optional(Type.Number({ minimum: 0, description: "Soft execution USD ceiling checked after each turn; excludes unreported selector currency." })),
  grace_turns: Type.Optional(Type.Number({ minimum: 0, maximum: 20, description: "Extra wrap-up turns after budget breach; 0 stops immediately." })),
  fallback_models: Type.Optional(Type.Array(Type.String(), { maxItems: 5, description: "Rejected legacy field; alternatives come from Jev." })),
  max_retries: Type.Optional(Type.Number({ minimum: 0, maximum: 5, description: "Extra child attempts; ranked availability failover only before tools start. No selector retry." })),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], { description: "fresh (default), or fork persisted parent history; single-task only." })),
  output: Type.Optional(Type.String({ description: "Final-output file path." })),
  output_schema: Type.Optional(Type.Unsafe<Record<string, unknown>>(Type.Object({}, {
    additionalProperties: true, description: "JSON Schema for fenced json:result output; one repair, then partial with raw output retained.",
  }))),
  output_mode: Type.Optional({ ...OutputMode, description: "file-only returns an output-file pointer." }),
  resume: Type.Optional(Type.String({ description: "Child session id to continue." })),
  fork_resume: Type.Optional(Type.Boolean({ description: "Fork instead of directly resuming the session." })),
  isolation: Type.Optional({ ...Isolation, description: "worktree isolates changes on a branch; inspect diff before apply/discard." }),
  include_wip: Type.Optional(Type.Boolean({ description: "Seed isolation:worktree with parent staged, unstaged and untracked changes." })),
  allow_shared_writes: Type.Optional(Type.Boolean({ description: "Unsafe explicit opt-in for parallel writers in one checkout." })),
  keep_background: Type.Optional(Type.Boolean({ description: "Keep child-started background processes after clean exit only." })),
} as const;

const COMPACT_TASK_KEYS = ["agent", "description", "profile", "difficulty", "cwd", "timeout_ms", "max_turns", "max_cost", "isolation"] as const;
const LEGACY_KEYS = ["model", "fallback_models"] as const;
const { model: _model, fallback_models: _fallback, ...FullTaskFields } = TaskFields;
const CompactTaskFields = Object.fromEntries(COMPACT_TASK_KEYS.map((key) => [key, TaskFields[key]]));

export const ParallelTaskItem = Type.Object({ task: Type.String({ minLength: 1, description: "Worker task." }), ...TaskFields }, { additionalProperties: false });
const requestFields = {
  action: actionSchema(FULL_ACTIONS),
  id: Type.Optional(Type.String({ minLength: 1, description: "Run id or unique prefix." })),
  message: Type.Optional(Type.String({ minLength: 1, description: "Guidance for action:steer." })),
  index: Type.Optional(Type.Number({ minimum: 0, description: "Task index for steer/diff/apply/discard when ambiguous." })),
  task: Type.Optional(Type.String({ minLength: 1, description: "Single task to delegate." })),
  ...TaskFields,
  async: Type.Optional(Type.Boolean({ description: "Return a background handle; collect with subagent_wait." })),
  tasks: Type.Optional(Type.Array(ParallelTaskItem, { minItems: 1, maxItems: 8, description: "Independent tasks; defaults to explore. Writers need worktrees or distinct cwd." })),
  synthesis: Type.Optional(Type.String({ minLength: 1, description: "Additional read-only child combines parallel results; incurs selection/execution cost." })),
};
const envelope = { additionalProperties: false, description: "Subagent request: delegate or manage a run." } as const;
// Keep a top-level object: mode exclusivity belongs to policy, not anyOf envelopes.
export const SubagentParamsSchema = Type.Object(requestFields, envelope);
export type SubagentParams = Static<typeof SubagentParamsSchema>;
export type ParallelTaskInput = Static<typeof ParallelTaskItem>;

function buildSurface(mode: ToolMode) {
  const taskFields = mode === "full" ? FullTaskFields : CompactTaskFields;
  const item = Type.Object({ task: ParallelTaskItem.properties.task, ...taskFields }, { additionalProperties: false });
  return Type.Object({
    action: actionSchema(mode === "full" ? FULL_ACTIONS : MANAGEMENT_ACTIONS),
    id: requestFields.id, message: requestFields.message, index: requestFields.index,
    task: requestFields.task, ...taskFields, async: requestFields.async,
    tasks: Type.Optional(Type.Array(item, { minItems: 1, maxItems: 8, description: requestFields.tasks.description })),
    ...(mode === "full" ? { synthesis: requestFields.synthesis } : {}),
  }, envelope);
}
const surfaces = { compact: buildSurface("compact"), full: buildSurface("full") };
const providerSurfaces = { compact: sanitizeProviderSchema(surfaces.compact), full: sanitizeProviderSchema(surfaces.full) };
export const subagentSurfaceSchema = (mode: ToolMode) => surfaces[mode];
export const providerSubagentSchema = (mode: ToolMode) => providerSurfaces[mode];

/** Same property/action selection as advertised; run before any dispatch side effect.
 * Canonical Value validation still owns unknown fields and all value constraints.
 * Deliberately inspect envelopes only, never user output_schema property names.
 */
export function subagentSurfaceError(params: unknown, mode: ToolMode): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const root = params as Record<string, unknown>;
  const surface = surfaces[mode];
  const check = (value: Record<string, unknown>, advertised: Record<string, unknown>, canonical: Record<string, unknown>, prefix: string) => {
    for (const key of Object.keys(value)) {
      if ((LEGACY_KEYS as readonly string[]).includes(key)) return `${prefix}${key}: omit model and fallback_models (including empty lists). Jev selects from jevRouting.models; manual routing is unsupported.`;
      if (Object.hasOwn(canonical, key) && !Object.hasOwn(advertised, key)) return `${prefix}${key} requires toolMode: "full" in ~/.pi/subagent.json and reload/restart after active work finishes.`;
    }
  };
  const rootError = check(root, surface.properties, SubagentParamsSchema.properties, "");
  if (rootError) return rootError;
  const actions = mode === "full" ? FULL_ACTIONS : MANAGEMENT_ACTIONS;
  if (typeof root.action === "string" && (FULL_ACTIONS as readonly string[]).includes(root.action)
    && !(actions as readonly string[]).includes(root.action)) return `action: "${root.action}" requires toolMode: "full" and reload/restart after active work finishes.`;
  if (Array.isArray(root.tasks)) {
    const itemProperties = surface.properties.tasks.items.properties;
    for (let i = 0; i < root.tasks.length; i++) {
      const item = root.tasks[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const error = check(item, itemProperties, ParallelTaskItem.properties, `tasks[${i}].`);
      if (error) return error;
    }
  }
}

/** Thin alias into the same private management/delivery handler. */
export const SubagentWaitParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, description: "Run id (or unique prefix) of the background run to collect." }),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 24 * 60 * 60_000,
    description: "Give up waiting after this long and return a still-running notice. The run is NOT cancelled; collect it later with subagent_wait or action:'status'. Omit to wait until the run settles.",
  })),
}, { additionalProperties: false, description: "Block until a background subagent run settles, then deliver its output." });
export const ProviderSubagentWaitParamsSchema = sanitizeProviderSchema(SubagentWaitParamsSchema);
export type SubagentWaitParams = Static<typeof SubagentWaitParamsSchema>;

export function assertObjectToolSchema(schema: unknown): asserts schema is { type: "object" } {
  if (!schema || typeof schema !== "object" || (schema as { type?: unknown }).type !== "object") {
    const type = schema && typeof schema === "object" ? (schema as { type?: unknown }).type : typeof schema;
    throw new Error(`Tool parameters must be JSON Schema type "object", got ${JSON.stringify(type ?? "None")}`);
  }
}
