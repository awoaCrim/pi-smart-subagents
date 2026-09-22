import * as path from "node:path";
import type { AgentDefinition } from "./agents.js";
import { resolveAgent } from "./agents.js";
import { isPlausibleSchema, repairDoubleEncodedText } from "./structured.js";
import { defaultConfig, type TaskDefaults, type TaskDefaultsByProfile } from "./config.js";
import type { ModelAttemptSpec, OutputMode, TaskProfile, TaskSpec } from "./types.js";
import type { ParallelTaskInput, SubagentParams } from "./schema.js";
import { BACKEND_NAMES, checkCapabilities, type BackendName } from "./backend.js";
import { resolveBackend } from "./backends/index.js";
import { validateModelRanking } from "./model-failover.js";
import type { JevRoutingConfig, RoutingDecision, RoutingModelCandidate } from "./routing-types.js";
import { isThinkingLevel } from "./thinking.js";

export const DEPTH_ENV_VAR = "PI_SUBAGENT_DEPTH";
export const SPAWNS_ENV_VAR = "PI_SUBAGENT_SPAWNS";
export const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "fffind",
  "ffgrep",
  "fff-multi-grep",
  "firecrawl_scrape",
  "firecrawl_search",
  "firecrawl_map",
  "firecrawl_crawl",
  "web_search",
  "web_fetch",
]);
/**
 * Pi context-management tools are control-plane capabilities: they may update
 * continuity notes or the remote context window, but they cannot modify the
 * child checkout. Keep them separate from ordinary source-inspection tools so
 * the read-only profile's exception remains explicit.
 */
export const CONTEXT_MANAGEMENT_TOOLS = new Set([
  "new_context",
  "get_context_remaining",
  "history",
  "notes",
]);
const NON_WRITING_TOOLS = new Set([...READ_ONLY_TOOLS, ...CONTEXT_MANAGEMENT_TOOLS]);
export const KNOWN_WRITE_TOOLS = new Set(["bash", "edit", "write"]);
/** Backward-compatible export; policy uses fail-closed classification above. */
export const WRITE_TOOLS = KNOWN_WRITE_TOOLS;

export interface ParentContext {
  cwd: string;
  model?: string;
  thinking?: TaskSpec["thinking"];
  availableTools: string[];
  activeTools?: string[];
  depth?: number;
  /** Persisted parent session file; required for context:'fork'. */
  sessionFile?: string;
}

export interface ResolvedTask extends TaskSpec {
  label: string;
  canWrite: boolean;
  effectiveTools: string[];
  resolutionNotes: string[];
}

/** Local preparation cannot launch: it has candidates, not an execution model/tools. */
export interface PreparedTask extends Omit<ResolvedTask, "model" | "canWrite" | "effectiveTools" | "routing"> {
  candidateTools: string[];
  mandatoryTools: string[];
  /** Request > agent > profile. Selected candidate and parent are applied only after routing. */
  requestedThinking?: TaskSpec["thinking"];
  parentThinking?: TaskSpec["thinking"];
}

export interface PreparationOptions {
  maxDepth?: number;
  maxTasks?: number;
  defaultTimeoutMs?: number;
  taskDefaults?: TaskDefaultsByProfile;
  agents?: Map<string, AgentDefinition>;
  jevRouting?: JevRoutingConfig;
  jevRoutingError?: string;
}

export type ManagementMode = "status" | "wait" | "cancel" | "steer" | "diff" | "apply" | "discard";

export type ValidationResult =
  | {
      ok: true;
      mode: "single" | "parallel" | ManagementMode;
      async: boolean;
      id?: string;
      message?: string;
      index?: number;
      synthesis?: string;
      tasks: PreparedTask[];
      /** True when action:"plan" requested a dry-run — no spawn. */
      planOnly?: boolean;
    }
  | { ok: false; error: string };

function resolvePath(cwd: string, value?: string): string {
  return value ? (path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value)) : path.resolve(cwd);
}

function resolveTools(
  profile: TaskProfile,
  requested: string[] | undefined,
  availableTools: string[],
  backend: BackendName,
): { tools?: string[]; canWrite?: boolean; error?: string } {
  const available = new Set(availableTools);
  const contextTools = backend === "pi"
    ? [...CONTEXT_MANAGEMENT_TOOLS].filter((tool) => available.has(tool))
    : [];
  const nonWritingTools = backend === "pi" ? NON_WRITING_TOOLS : READ_ONLY_TOOLS;
  // Keep Pi's context-management control plane available to every child when
  // the parent exposes it, even if the task requested a narrower tool subset.
  const addContextTools = (tools: readonly string[]): string[] =>
    [...new Set([...tools, ...contextTools])];

  if (requested) {
    const unknown = requested.filter((tool) => !available.has(tool));
    if (unknown.length) return { error: `Unknown or unavailable tools: ${unknown.join(", ")}` };
  }

  if (profile === "explore" || profile === "review") {
    const source = addContextTools(requested ?? [...nonWritingTools].filter((tool) => available.has(tool)));
    const unsafe = source.filter((tool) => !nonWritingTools.has(tool));
    if (unsafe.length) {
      return {
        error: `${profile} is strictly read-only. Unclassified or writable tools are not allowed: ${unsafe.join(", ")}`,
      };
    }
    return { tools: source, canWrite: false };
  }

  const source = addContextTools(requested ?? availableTools);
  const unknown = source.filter((tool) => !available.has(tool));
  if (unknown.length) return { error: `Candidate tools are unavailable: ${unknown.join(", ")}` };
  // General-profile custom tools are conservatively write-capable unless explicitly known non-writing.
  return {
    tools: source,
    canWrite: source.some((tool) => KNOWN_WRITE_TOOLS.has(tool) || !nonWritingTools.has(tool)),
  };
}

function normalizeTask(
  item: {
    task: string;
    agent?: string;
    description?: string;
    system_prompt?: string;
    model?: string;
    thinking?: TaskSpec["thinking"];
    tools?: string[];
    profile?: TaskProfile;
    cwd?: string;
    timeout_ms?: number;
    max_turns?: number;
    max_cost?: number;
    grace_turns?: number;
    fallback_models?: string[];
    max_retries?: number;
    context?: "fresh" | "fork";
    output?: string;
    output_mode?: OutputMode;
    output_schema?: Record<string, unknown>;
    resume?: string;
    fork_resume?: boolean;
    isolation?: "shared" | "worktree";
    allow_shared_writes?: boolean;
    keep_background?: boolean;
    include_wip?: boolean;
    backend?: BackendName;
  },
  index: number,
  parent: ParentContext,
  defaultProfile: TaskProfile,
  defaults: PreparationOptions = {},
): { task?: PreparedTask; error?: string } {
  if (!item.task?.trim()) return { error: `Task ${index + 1} must not be blank` };

  // Named agent resolution is still used for persona/profile/tool behavior;
  // its legacy model/fallback fields are deliberately ignored below.
  // request params still win field-by-field. The agent body is the child's
  // system prompt; an explicit system_prompt is appended after it.
  let agent: AgentDefinition | undefined;
  if ((item as { agent?: string }).agent) {
    const lookup = resolveAgent(defaults.agents ?? new Map(), (item as { agent?: string }).agent!);
    if (!lookup.agent) return { error: `Task ${index + 1}: ${lookup.error}` };
    agent = lookup.agent;
  }
  if (item.model !== undefined || item.fallback_models !== undefined) {
    return { error: `Task ${index + 1}: omit model and fallback_models (including empty lists). Jev must select from jevRouting.models; manual/fixed routing is no longer supported.` };
  }
  if (item.output_mode && !item.output) return { error: `Task ${index + 1}: output_mode requires output` };
  if (item.fork_resume && !item.resume) return { error: `Task ${index + 1}: fork_resume requires resume` };
  if (item.timeout_ms !== undefined && (!Number.isInteger(item.timeout_ms) || item.timeout_ms < 1)) {
    return { error: `Task ${index + 1}: timeout_ms must be a positive integer` };
  }
  if (item.max_turns !== undefined && (!Number.isInteger(item.max_turns) || item.max_turns < 1)) {
    return { error: `Task ${index + 1}: max_turns must be a positive integer` };
  }
  if (item.max_cost !== undefined && (!Number.isFinite(item.max_cost) || item.max_cost < 0)) {
    return { error: `Task ${index + 1}: max_cost must be >= 0` };
  }
  if (item.grace_turns !== undefined && (!Number.isInteger(item.grace_turns) || item.grace_turns < 0)) {
    return { error: `Task ${index + 1}: grace_turns must be a non-negative integer` };
  }
  if (item.max_retries !== undefined && (!Number.isInteger(item.max_retries) || item.max_retries < 0)) {
    return { error: `Task ${index + 1}: max_retries must be a non-negative integer` };
  }
  if (item.context === "fork") {
    if (item.resume) return { error: `Task ${index + 1}: context:'fork' cannot be combined with resume (resume already carries its own context)` };
    if (!parent.sessionFile) {
      return { error: `Task ${index + 1}: context:'fork' requires a persisted parent session; this session has no session file. Use context:'fresh'.` };
    }
  }
  if (item.output_schema !== undefined && !isPlausibleSchema(item.output_schema)) {
    return { error: `Task ${index + 1}: output_schema must be a JSON Schema object (type/properties/required)` };
  }
  if (item.include_wip === true) {
    const isolation = item.isolation ?? agent?.isolation ?? "shared";
    if (isolation !== "worktree") {
      return { error: `Task ${index + 1}: include_wip requires isolation:"worktree" (dirty-baseline works only on isolated worktrees)` };
    }
  }

  const backend: BackendName = item.backend ?? agent?.backend ?? "pi";
  if (!BACKEND_NAMES.includes(backend)) {
    return { error: `Task ${index + 1}: unknown backend '${backend}' (expected ${BACKEND_NAMES.join(", ")})` };
  }
  if (backend !== "pi") return { error: `Task ${index + 1}: new Jev-routed work supports backend:"pi" only; ${backend} is not supported. Existing-run management remains available.` };
  const profile = item.profile ?? agent?.profile ?? defaultProfile;
  const requestedTools = item.tools;
  const childDepth = (parent.depth ?? parseDepth()) + 1;
  const nestedAllowed = profile === "general" && childDepth < (defaults.maxDepth ?? defaultConfig.maxDepth)
    && agent?.spawns !== false && (!Array.isArray(agent?.spawns) || agent.spawns.length > 0);
  const availableTools = parent.availableTools.filter((tool) => nestedAllowed || !["subagent", "subagent_wait"].includes(tool));
  const resolved = resolveTools(profile, requestedTools, availableTools, backend);
  if (resolved.error || !resolved.tools || resolved.canWrite === undefined) return { error: resolved.error ?? "Tool resolution failed" };
  const cwd = resolvePath(parent.cwd, item.cwd);
  const output = item.output ? resolvePath(cwd, item.output) : undefined;
  // Non-model fields retain the existing precedence: explicit request > agent
  // file > per-profile config defaults; candidate/parent thinking waits for routing.
  const profileDefaults: TaskDefaults = defaults.taskDefaults?.[profile] ?? {};
  const requestedThinking = item.thinking ?? agent?.thinking ?? profileDefaults.thinking;
  const effectiveThinking = requestedThinking ?? parent.thinking;
  if (effectiveThinking !== undefined && !isThinkingLevel(effectiveThinking)) {
    return { error: `Task ${index + 1}: thinking must be a non-empty Pi thinking level string without whitespace or control characters` };
  }
  const label = item.description?.trim()
    ? item.description.trim().slice(0, 60)
    : agent
      ? agent.name
      : `task-${index + 1}`;
  const systemPrompt = [agent?.systemPrompt, item.system_prompt].filter(Boolean).join("\n\n") || undefined;

  // Backend capability gate. Refuse combinations the backend cannot honor
  // rather than silently dropping a budget or a read-only guarantee.
  const capabilities = resolveBackend(backend).capabilities;
  const problems = checkCapabilities(
    {
      maxCost: item.max_cost ?? agent?.maxCost ?? profileDefaults.maxCost,
      resume: item.resume,
      forkResume: item.fork_resume,
      contextFork: item.context === "fork",
      // Only report a tool-restriction problem when the profile actually
      // restricts: profile 'general' inherits the parent set and does not
      // promise a read-only sandbox.
      tools: profile === "general" ? undefined : resolved.tools,
      thinking: effectiveThinking,
      outputSchema: item.output_schema ?? agent?.outputSchema,
      profile,
      canWrite: resolved.canWrite,
    },
    capabilities,
    backend,
  );
  if (problems.length) {
    return { error: `Task ${index + 1}: ${problems.join("; ")}` };
  }

  return {
    task: {
      backend,
      label,
      task: repairDoubleEncodedText(item.task.trim()),
      systemPrompt: systemPrompt ? repairDoubleEncodedText(systemPrompt) : systemPrompt,
      // No model or effective tool set exists until finalizeRoutedTasks succeeds.
      requestedThinking,
      parentThinking: parent.thinking,
      thinking: requestedThinking,
      candidateTools: resolved.tools.filter((tool) => !CONTEXT_MANAGEMENT_TOOLS.has(tool)),
      mandatoryTools: resolved.tools.filter((tool) => CONTEXT_MANAGEMENT_TOOLS.has(tool)),
      profile,
      cwd,
      timeoutMs: item.timeout_ms ?? agent?.timeoutMs ?? profileDefaults.timeoutMs ?? defaults.defaultTimeoutMs ?? defaultConfig.defaultTimeoutMs,
      maxTurns: item.max_turns ?? agent?.maxTurns ?? profileDefaults.maxTurns,
      maxCost: item.max_cost ?? agent?.maxCost ?? profileDefaults.maxCost,
      graceTurns: item.grace_turns ?? agent?.graceTurns,
      fallbackModels: [],
      maxRetries: item.max_retries ?? agent?.maxRetries ?? profileDefaults.maxRetries,
      contextFork: item.context === "fork",
      parentSessionFile: item.context === "fork" ? parent.sessionFile : undefined,
      output,
      outputMode: item.output_mode,
      outputSchema: item.output_schema ?? agent?.outputSchema,
      resume: item.resume,
      forkResume: item.fork_resume,
      isolation: item.isolation ?? agent?.isolation ?? "shared",
      allowSharedWrites: item.allow_shared_writes === true,
      keepBackground: item.keep_background === true,
      includeWip: item.include_wip === true,
      // Child's own future-spawn allowlist never inherits from boot env —
      // only the named persona's frontmatter `spawns` restricts grandchildren.
      spawns: agent?.spawns,

      resolutionNotes: [
        `backend=${backend}`,
        `profile=${profile}`,

        ...(agent ? [`agent=${agent.name}`] : []),
        "routing=jev (pending)",
      ],
    },
  };
}

function validateParallel(tasks: Array<Pick<TaskSpec, "output" | "canWrite" | "isolation" | "cwd" | "allowSharedWrites">>): string | undefined {
  const outputs = new Set<string>();
  for (const task of tasks) {
    if (task.output && outputs.has(task.output)) return `Duplicate output path: ${task.output}`;
    if (task.output) outputs.add(task.output);
  }

  const sharedByCwd = new Map<string, Array<Pick<TaskSpec, "output" | "canWrite" | "isolation" | "cwd" | "allowSharedWrites">>>();
  for (const task of tasks.filter((task) => task.canWrite && task.isolation !== "worktree")) {
    const list = sharedByCwd.get(task.cwd!) ?? [];
    list.push(task);
    sharedByCwd.set(task.cwd!, list);
  }
  for (const [cwd, writers] of sharedByCwd) {
    if (writers.length > 1 && !writers.every((task) => task.allowSharedWrites)) {
      return `Parallel writers share ${cwd}. Use isolation:"worktree", distinct cwd values, or explicit allow_shared_writes:true.`;
    }
  }
  return undefined;
}

/**
 * Parse nesting depth. Missing (undefined / empty) means top-level (0).
 * Malformed or negative values fail *closed* by returning a large sentinel so
 * the depth-cap check rejects nested work rather than resetting the counter
 * after env scrubbing after a forged zero.
 */
export function parseDepth(value = process.env[DEPTH_ENV_VAR]): number {
  if (value === undefined || value === "") return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 100; // fail closed
  return Math.min(parsed, 100);
}

export type SpawnPolicy = { kind: "unrestricted" } | { kind: "disabled" } | { kind: "allowlist"; agents: string[] };

/**
 * Parse the spawn allowlist env var.
 * - unset / "*" → unrestricted
 * - empty / "false" / "off" / "none" → disabled
 * - "a,b" / "[a, b]" → allowlist (agentless also rejected)
 * Malformed values fail closed to disabled.
 */
export function parseSpawnPolicy(value?: string): SpawnPolicy {
  if (value === undefined) return { kind: "unrestricted" };
  // Empty after trim is intentional disable; also treat bare false synonyms.
  const trimmed = value.trim();
  if (trimmed === "" || /^false|off|none$/i.test(trimmed)) return { kind: "disabled" };
  if (trimmed === "*") return { kind: "unrestricted" };
  // Reject control characters / bad forms before any permissive poke.
  if (/[\x00-\x1f]/.test(trimmed)) return { kind: "disabled" };
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  const agents = inner
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter(Boolean);
  if (agents.length === 0) return { kind: "disabled" };
  // Agent names must stay simple identifiers; anything else is a forged policy.
  if (agents.some((name) => !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name))) return { kind: "disabled" };
  return { kind: "allowlist", agents };
}

function describeSpawnPolicy(policy: SpawnPolicy): string {
  if (policy.kind === "disabled") return "spawning disabled";
  if (policy.kind === "allowlist") return `spawn allowlist: ${policy.agents.join(", ")}`;
  return "unrestricted";
}

/** True when this process should avoid spawning further nested subagents. */
export function shouldRegisterSubagentTool(
  depth = parseDepth(),
  maxDepth = defaultConfig.maxDepth,
): boolean {
  return depth < maxDepth;
}

export function validateSubagentRequest(
  params: SubagentParams,
  parent: ParentContext,
  options: PreparationOptions = {},
): ValidationResult {
  const defaults = options;
  const hasAction = params.action !== undefined;
  const hasTask = typeof params.task === "string";
  const hasTasks = Array.isArray(params.tasks);
  const planOnly = params.action === "plan";

  // action:"plan" is a dry-run of spawn modes: it MUST combine with task/tasks.
  // Other actions remain exclusive with task/tasks.
  if (planOnly) {
    if (hasTask === hasTasks) {
      // Both or neither: plan alone is invalid; task+tasks is also invalid.
      if (!hasTask && !hasTasks) {
        return { ok: false, error: "action:\"plan\" requires task or tasks[] (dry-run of a spawn request)" };
      }
      return { ok: false, error: "Provide exactly one of: task or tasks" };
    }
  } else {
    const modes = [hasAction, hasTask, hasTasks].filter(Boolean).length;
    if (modes === 0) {
      return { ok: false, error: "Provide task, tasks, or action (status|wait|cancel|plan)" };
    }
    if (modes > 1) {
      return { ok: false, error: "Provide exactly one of: action, task, or tasks" };
    }
  }

  if (hasAction && !planOnly) {
    if (params.action !== "status" && !params.id) {
      return { ok: false, error: `${params.action} requires a run id` };
    }
    if (params.action === "steer" && !params.message?.trim()) {
      return { ok: false, error: "steer requires a non-empty message" };
    }
    // Management actions ignore task-config fields; reject obvious conflict residues.
    if (params.async !== undefined) {
      return { ok: false, error: "async cannot be combined with action" };
    }
    // `!planOnly` above excludes "plan"; TS cannot narrow the union across the flag.
    return { ok: true, mode: params.action as ManagementMode, async: false, id: params.id, message: params.message, index: params.index, tasks: [] };
  }

  const depth = parent.depth ?? parseDepth();
  const maxDepth = options.maxDepth ?? defaultConfig.maxDepth;
  if (depth >= maxDepth) return { ok: false, error: `Subagent nesting depth limit reached (${depth} >= ${maxDepth})` };
  if (!options.jevRouting) return { ok: false, error: options.jevRoutingError ?? "Jev routing is not configured. Add jevRouting.models with exact IDs and descriptions to ~/.pi/subagent.json; existing-run management remains available." };
  // Boot spawn policy (from our parent) — fail closed; applies to new spawn modes only.
  const spawnPolicy = parseSpawnPolicy(process.env[SPAWNS_ENV_VAR]);
  if (spawnPolicy.kind !== "unrestricted") {
    const hasSpawnWork = typeof params.task === "string" || Array.isArray(params.tasks);
    if (hasSpawnWork) {
      if (spawnPolicy.kind === "disabled") {
        return { ok: false, error: `Subagent spawning is disabled by parent policy (${describeSpawnPolicy(spawnPolicy)})` };
      }
      // Allowlist requires a named agent from the list; agentless is rejected.
      const requestedAgents: Array<string | undefined> = Array.isArray(params.tasks)
        ? params.tasks.map((t) => t.agent)
        : [params.agent];
      for (let i = 0; i < requestedAgents.length; i++) {
        const agentName = requestedAgents[i]?.trim().toLowerCase();
        if (!agentName) {
          return {
            ok: false,
            error: `Task ${i + 1}: agentless tasks are not allowed under parent ${describeSpawnPolicy(spawnPolicy)}`,
          };
        }
        if (!spawnPolicy.agents.includes(agentName)) {
          return {
            ok: false,
            error: `Task ${i + 1}: agent "${agentName}" is not in parent ${describeSpawnPolicy(spawnPolicy)}`,
          };
        }
      }
    }
  }

  if (hasTasks) {
    const rawTasks = params.tasks!;
    const maxTasks = options.maxTasks ?? defaultConfig.maxTasksPerRun;
    if (!rawTasks.length || rawTasks.length > maxTasks) return { ok: false, error: `Expected 1..${maxTasks} tasks (configurable via maxTasksPerRun)` };
    // Top-level TaskFields apply only to single-task mode.
    if (params.system_prompt !== undefined || params.model !== undefined || params.fallback_models !== undefined || params.tools !== undefined || params.profile !== undefined || params.cwd !== undefined || params.resume !== undefined || params.agent !== undefined) {
      return { ok: false, error: "Top-level task options cannot be combined with tasks[]; set them on each tasks[] item" };
    }
    // Context forking duplicates the whole parent conversation per child;
    // that cost is intentional for one focused writer, not an 8-way fanout.
    if (rawTasks.length > 1 && rawTasks.some((task) => task.context === "fork")) {
      return { ok: false, error: "context:'fork' is single-task only; parallel fanout would duplicate the parent conversation per child" };
    }
    const tasks: PreparedTask[] = [];
    for (let index = 0; index < rawTasks.length; index++) {
      const normalized = normalizeTask(rawTasks[index] as ParallelTaskInput, index, parent, "explore", defaults);
      if (normalized.error || !normalized.task) return { ok: false, error: normalized.error ?? "Invalid task" };
      tasks.push(normalized.task);
    }
    const parallelError = validateParallel(tasks);
    if (parallelError) return { ok: false, error: parallelError };
    return {
      ok: true,
      mode: tasks.length > 1 ? "parallel" : "single",
      async: params.async === true,
      synthesis: params.synthesis?.trim() || undefined,
      tasks,
      planOnly: planOnly || undefined,
    };
  }

  if (params.synthesis !== undefined) {
    return { ok: false, error: "synthesis applies to parallel mode only (tasks[])" };
  }
  // Single-task mode: top-level fields form the one task.
  const normalized = normalizeTask(params as ParallelTaskInput, 0, parent, "general", defaults);
  if (normalized.error || !normalized.task) return { ok: false, error: normalized.error ?? "Invalid task" };
  return { ok: true, mode: "single", async: params.async === true, tasks: [normalized.task], planOnly: planOnly || undefined };
}

export function describeCapability(task: ResolvedTask): string {
  return `${task.profile}/${task.canWrite ? "RW" : "RO"} tools=[${task.effectiveTools.join(",")}]`;
}

/** Final local authority: no raw caller model field is synthesized to bypass policy. */
export function finalizeRoutedTasks(
  prepared: readonly PreparedTask[],
  decisions: readonly RoutingDecision[],
  models: readonly RoutingModelCandidate[],
): { ok: true; tasks: ResolvedTask[] } | { ok: false; error: string } {
  if (prepared.length !== decisions.length) return { ok: false, error: "Routing decision count does not match the prepared tasks." };
  const tasks: ResolvedTask[] = [];
  for (let index = 0; index < prepared.length; index++) {
    const item = prepared[index]!;
    const decision = decisions[index]!;
    const candidate = models.find((entry) => entry.model === decision.selectedModel);
    if (!candidate) return { ok: false, error: `Task ${index + 1}: selector chose a model outside the available dedicated candidates.` };
    if (new Set(decision.selectedTools).size !== decision.selectedTools.length || decision.selectedTools.some((tool) => !item.candidateTools.includes(tool))) {
      return { ok: false, error: `Task ${index + 1}: selector chose tools outside the locally permitted candidates.` };
    }
    const tools = [...new Set([...decision.selectedTools, ...item.mandatoryTools])];
    const canWrite = tools.some((tool) => !NON_WRITING_TOOLS.has(tool));
    if (item.profile !== "general" && canWrite) return { ok: false, error: `Task ${index + 1}: writable selector choice violates ${item.profile}.` };
    // The probability ranking is mandatory for every new route: without it there
    // is no failover plan, and a persisted/legacy decision shape must never be
    // silently re-promoted into one.
    const ranked = decision.rankedModels;
    const rankingProblem = validateModelRanking(ranked, models.map((entry) => entry.model), decision.selectedModel);
    if (rankingProblem) return { ok: false, error: `Task ${index + 1}: ${rankingProblem}.` };
    const { candidateTools: _candidates, mandatoryTools, requestedThinking, parentThinking, ...spec } = item;
    // One frozen attempt plan per ranked candidate: same shared tools and route,
    // per-candidate thinking under explicit > agent > profile > candidate > parent.
    const modelAttemptPlan: ModelAttemptSpec[] = [];
    for (const entry of ranked!) {
      const candidateEntry = models.find((model) => model.model === entry.model)!;
      const thinking = requestedThinking ?? candidateEntry.thinking ?? parentThinking;
      if (thinking !== undefined && !isThinkingLevel(thinking)) {
        return { ok: false, error: `Task ${index + 1}: candidate ${JSON.stringify(entry.model)} has an invalid Pi thinking default.` };
      }
      modelAttemptPlan.push(Object.freeze({
        model: entry.model,
        probability: entry.probability,
        ...(thinking === undefined ? {} : { thinking }),
      }));
    }
    const first = modelAttemptPlan[0]!;
    tasks.push({
      ...spec, model: candidate.model, thinking: first.thinking, tools, effectiveTools: tools, canWrite,
      fallbackModels: [],
      modelAttemptPlan: Object.freeze(modelAttemptPlan),
      routing: { ...decision, mandatoryTools: [...mandatoryTools], outcome: "success" },
      resolutionNotes: [...item.resolutionNotes.filter((note) => !note.startsWith("routing=")), "routing=jev", `access=${canWrite ? "RW" : "RO"}`],
    });
  }
  const problem = validateParallel(tasks);
  return problem ? { ok: false, error: problem } : { ok: true, tasks };
}
