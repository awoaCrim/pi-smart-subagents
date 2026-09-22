import { Type, type Static } from "typebox";

/**
 * Remove TypeBox's internal compositor metadata before a schema crosses into
 * Pi's provider-facing tool catalog. The original schema is kept intact for
 * local Value.Check/Value.Errors validation.
 */
export function sanitizeProviderSchema<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderSchema(item)) as T;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !key.startsWith("~"))
        .map(([key, entry]) => [key, sanitizeProviderSchema(entry)] as const),
    ) as T;
  }

  return value;
}

const ThinkingLevel = Type.String({
  minLength: 1,
  maxLength: 64,
  description: "Opaque Pi thinking level passed through unchanged. Pi/model-specific values such as max are allowed; the active Pi process decides support.",
});

const OutputMode = Type.Union([Type.Literal("inline"), Type.Literal("file-only")]);
const Profile = Type.Union([Type.Literal("explore"), Type.Literal("review"), Type.Literal("general")]);
const Isolation = Type.Union([Type.Literal("shared"), Type.Literal("worktree")]);
const Backend = Type.Union([Type.Literal("pi"), Type.Literal("codex"), Type.Literal("claude")]);
const Action = Type.Union([
  Type.Literal("status"),
  Type.Literal("wait"),
  Type.Literal("cancel"),
  Type.Literal("steer"),
  Type.Literal("diff"),
  Type.Literal("apply"),
  Type.Literal("discard"),
  Type.Literal("plan"),
]);

/** Shared optional task configuration fields. */
export const TaskFields = {
  backend: Type.Optional({ ...Backend, description: "New Jev-routed work supports pi only. codex/claude are recognized for an actionable rejection; existing-run management stays available." }),
  agent: Type.Optional(Type.String({ minLength: 1, description: "Named agent to use (from .pi/agents/<name>.md). Supplies persona system prompt and defaults; explicit params still override." })),
  description: Type.Optional(Type.String({ description: "Short human label (3-5 words) shown in UIs and result indexes." })),
  system_prompt: Type.Optional(Type.String({ description: "Extra system prompt appended to the child's prompt (does not replace it)." })),
  model: Type.Optional(Type.String({ description: "Legacy field: omit on new work. Jev chooses from the dedicated configured model list; explicit model is rejected rather than bypassing routing." })),
  thinking: Type.Optional({ ...ThinkingLevel, description: "Opaque Pi thinking level for the child. Values such as max are passed through unchanged; Pi/model support decides validity. Defaults to agent thinking, profile taskDefaults.thinking, selected candidate thinking, then the parent's level." }),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Optional candidate ceiling for Jev. Default candidates are all available locally permitted tools. Jev chooses individually; available Pi continuity controls are added locally even with tools:[]." })),
  profile: Type.Optional({ ...Profile, description: "Capability profile: explore/review cannot write project files but retain Pi context-management tools; general permits Jev to choose from the full locally available catalog and may write." }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child process." })),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 24 * 60 * 60_000, description: "Total budget in milliseconds including local preflight, Jev selection, setup, queue and retries. Timed-out runs report which phase timed out." })),
  max_turns: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Budget: at this many turns the child is steered to wrap up and given grace turns for a final answer; ends as 'partial' with output preserved." })),
  max_cost: Type.Optional(Type.Number({ minimum: 0, description: "Soft provider-reported execution cost ceiling in dollars, checked after each turn. TypeSafe routing currency is unreported and NOT capped by max_cost." })),
  grace_turns: Type.Optional(Type.Number({ minimum: 0, maximum: 20, description: "Wrap-up turns allowed after a budget breach before hard stop. 0 = immediate stop. Default from config (2)." })),
  fallback_models: Type.Optional(Type.Array(Type.String(), { maxItems: 5, description: "Legacy field: omit on new work, including an empty list. Ranked alternatives come only from Jev; manual fallback and emergency models are not accepted." })),
  max_retries: Type.Optional(Type.Number({ minimum: 0, maximum: 5, description: "Total extra child attempts (0 = initial attempt only; default 1). Before any tool execution, a recognized availability failure advances to the next Jev probability-ranked model with the same tools and no new selection. Auth/quota/context/task-quality failures never switch." })),
  context: Type.Optional(
    Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
      description: "fork starts the child from a branched copy of the parent conversation (needs a persisted parent session); fresh (default) starts clean. Fork is single-task only.",
    }),
  ),
  output: Type.Optional(Type.String({ description: "File path to write final output." })),
  output_schema: Type.Optional(
    Type.Unsafe<Record<string, unknown>>(
      Type.Object({}, {
        additionalProperties: true,
        description: "JSON Schema the child's final result must satisfy. The child ends with a fenced json:result block; successful but invalid answers get one repair round, then end 'partial' with the errors reported. Provider errors/aborts are not repaired and failed attempts cannot publish structured output.",
      }),
    ),
  ),
  output_mode: Type.Optional({ ...OutputMode, description: "file-only returns a pointer instead of inline text; use for large reports." }),
  resume: Type.Optional(Type.String({ description: "Child session id to continue." })),
  fork_resume: Type.Optional(Type.Boolean({ description: "Fork the resumed session instead of direct resume." })),
  isolation: Type.Optional({ ...Isolation, description: "worktree runs the task in an isolated git worktree; changed work is preserved on a branch." }),
  include_wip: Type.Optional(
    Type.Boolean({ description: "Seed a worktree with the parent checkout's uncommitted changes (staged + unstaged + untracked). Only valid with isolation:'worktree'." }),
  ),
  allow_shared_writes: Type.Optional(
    Type.Boolean({ description: "Unsafe opt-in for parallel writers sharing one checkout." }),
  ),
  keep_background: Type.Optional(
    Type.Boolean({ description: "Keep processes the child backgrounded (e.g. dev servers) alive after a clean exit." }),
  ),
} as const;

export const ParallelTaskItem = Type.Object(
  {
    task: Type.String({ minLength: 1, description: "Task text for one parallel worker." }),
    ...TaskFields,
  },
  { additionalProperties: false },
);

/**
 * Provider-facing tool parameters.
 *
 * IMPORTANT: LLM tool APIs (OpenAI-compatible / OpenRouter / Anthropic via many
 * providers) require the top-level parameters schema to be JSON Schema
 * `type: "object"`. A Type.Union serializes as `anyOf` without `type: "object"`,
 * which surfaces as:
 *   Invalid schema for function 'subagent': schema must be a JSON Schema of
 *   'type: "object"', got 'type: "None"'.
 *
 * Mode exclusivity (action vs task vs tasks) is enforced in policy validation,
 * not at the JSON Schema layer.
 */
export const SubagentParamsSchema = Type.Object(
  {
    // Management actions
    action: Type.Optional({ ...Action, description: "Management action on an existing run: status, wait, cancel, steer (inject guidance into a running child), diff/apply/discard (worktree results). action:\"plan\" calls Jev and local preflights, returning a resolved route without spawning a child. Selector fees apply; later dispatch selects again." }),
    id: Type.Optional(Type.String({ minLength: 1, description: "Run id (or unique prefix) for management actions." })),
    message: Type.Optional(Type.String({ minLength: 1, description: "Steering message injected into the running child (action: steer)." })),
    index: Type.Optional(Type.Number({ minimum: 0, description: "Task index within a parallel run for steer/diff/apply/discard. Defaults to the only eligible task." })),

    // Single-task mode
    task: Type.Optional(Type.String({ minLength: 1, description: "Task to delegate (single mode)." })),
    ...TaskFields,
    async: Type.Optional(Type.Boolean({ description: "Run in the background and return a handle immediately." })),

    // Parallel mode
    tasks: Type.Optional(
      Type.Array(ParallelTaskItem, {
        minItems: 1,
        maxItems: 8,
        description: "Array of independent tasks for parallel mode. Parallel tasks default to the read-only explore profile; parallel writers need isolation:'worktree'.",
      }),
    ),
    synthesis: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Optional synthesis prompt for parallel mode: after all tasks finish, one read-only child folds their outputs using this instruction and its result is delivered first.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Subagent request: single, parallel, status, wait, or cancel.",
  },
);

export type SubagentParams = Static<typeof SubagentParamsSchema>;
export type ParallelTaskInput = Static<typeof ParallelTaskItem>;

/**
 * Dedicated blocking-wait tool.
 *
 * `subagent` already exposes wait via `action: "wait"`, but collecting a
 * background run is the one management step a model reaches for reflexively
 * mid-flow, and burying it behind an action union costs a discovery step.
 * This mirrors the highest-adoption package in the ecosystem (`pi-subagents`
 * ships `subagent` + `subagent_wait` for the same reason). It is a thin
 * front-end over the identical handler — no second delivery path.
 */
export const SubagentWaitParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, description: "Run id (or unique prefix) of the background run to collect." }),
    timeout_ms: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 24 * 60 * 60_000,
        description: "Give up waiting after this long and return a still-running notice. The run is NOT cancelled; collect it later with subagent_wait or action:'status'. Omit to wait until the run settles.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Block until a background subagent run settles, then deliver its output.",
  },
);

/** Provider-facing projections without TypeBox's internal `~...` metadata. */
export const ProviderSubagentParamsSchema = sanitizeProviderSchema(SubagentParamsSchema);
export const ProviderSubagentWaitParamsSchema = sanitizeProviderSchema(SubagentWaitParamsSchema);

export type SubagentWaitParams = Static<typeof SubagentWaitParamsSchema>;

/** Runtime guard used by tests/docs to assert provider compatibility. */
export function assertObjectToolSchema(schema: unknown): asserts schema is { type: "object" } {
  if (!schema || typeof schema !== "object" || (schema as { type?: unknown }).type !== "object") {
    const type = schema && typeof schema === "object" ? (schema as { type?: unknown }).type : typeof schema;
    throw new Error(`Tool parameters must be JSON Schema type "object", got ${JSON.stringify(type ?? "None")}`);
  }
}
