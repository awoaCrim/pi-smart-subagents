import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskProfile } from "./types.js";
import { isThinkingLevel, type ThinkingLevel } from "./thinking.js";
import { isPlausibleSchema } from "./structured.js";

/**
 * Named agent files: reusable subagent personas discovered from the same
 * conventional locations the ecosystem uses for skills.
 *
 * Discovery roots (highest precedence first — same name in a higher root wins):
 *   1. <cwd>/.pi/agents/<name>.md            project (authoritative)
 *   2. <cwd>/.agents/agents/<name>.md        shared cross-tool workspace
 *   3. $PI_CODING_AGENT_DIR/agents/<name>.md global (default ~/.pi/agent/agents/)
 *
 * Format: YAML frontmatter + markdown body. The body becomes the child's
 * appended system prompt. Frontmatter fields use the same snake_case names as
 * the tool parameters they default.
 *
 * Model routing is intentionally excluded from agent files. Agent frontmatter
 * may still contain legacy model/fallback fields for compatibility, but the
 * model policy is the only source used for new spawns.
 */

const PROFILES = ["explore", "review", "general"] as const;

export interface AgentDefinition {
  /** Agent CLI backend this persona runs on (pi | codex | claude). */
  backend?: "pi" | "codex" | "claude";
  /** Agent name (the file name without extension). */
  name: string;
  /** One-line routing description shown to the orchestrating model. */
  description: string;
  /** Markdown body — appended to the child's system prompt. */
  systemPrompt?: string;
  /** File the definition was loaded from. */
  source: string;
  /** Which discovery root supplied it. */
  scope: "project" | "shared" | "global";
  model?: string;
  thinking?: ThinkingLevel;
  profile?: TaskProfile;
  tools?: string[];
  maxTurns?: number;
  maxCost?: number;
  timeoutMs?: number;
  graceTurns?: number;
  fallbackModels?: string[];
  maxRetries?: number;
  isolation?: "shared" | "worktree";
  /** JSON Schema the persona's final result must satisfy (inline JSON or @file.json). */
  outputSchema?: Record<string, unknown>;
  /**
   * Which agents this persona may spawn as children.
   * `false` disables nesting; `"*"` unrestricted; string[] is an allowlist.
   * Absent means unrestricted (same as `"*"`).
   */
  spawns?: false | "*" | string[];
}

/** Agent names are file-name-safe identifiers; anything else is skipped. */

const MAX_AGENT_FILE_BYTES = 64 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function agentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) {
    return envDir.startsWith("~") ? path.join(os.homedir(), envDir.slice(1)) : envDir;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export function discoveryRoots(cwd: string): Array<{ dir: string; scope: AgentDefinition["scope"] }> {
  return [
    { dir: path.join(cwd, ".pi", "agents"), scope: "project" },
    { dir: path.join(cwd, ".agents", "agents"), scope: "shared" },
    { dir: path.join(agentDir(), "agents"), scope: "global" },
  ];
}

// ── Frontmatter parsing (flat YAML subset; no dependency) ───────────────────

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** `[a, b]` or `a, b` → string array. */
function parseList(value: string): string[] {
  const inner = value.trim().startsWith("[") && value.trim().endsWith("]")
    ? value.trim().slice(1, -1)
    : value;
  return inner.split(",").map((item) => stripQuotes(item)).filter(Boolean);
}

function parseNumber(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Frontmatter `spawns:` — false | * | list. Invalid forms degrade to unrestricted (absent). */
function parseSpawns(value: string): AgentDefinition["spawns"] | undefined {
  const trimmed = stripQuotes(value.trim());
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "false" || lower === "off" || lower === "none") return false;
  if (trimmed === "*" || lower === "true" || lower === "any") return "*";
  const list = parseList(trimmed).map((item) => item.toLowerCase()).filter((item) => NAME_PATTERN.test(item));
  // Non-empty list only; garbage becomes unrestricted (same as absent frontmatter).
  return list.length > 0 ? list : undefined;
}

/**
 * Shared 64KB / regular-file / readable guard for `@path` references.
 * Symlinks and oversized/missing files return undefined (callers degrade open).
 */
function readGuardedRelativeFile(agentFile: string, relativePath: string): string | undefined {
  if (!relativePath || relativePath.includes("\0")) return undefined;
  const file = path.resolve(path.dirname(agentFile), relativePath);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_AGENT_FILE_BYTES) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** `output_schema` value: inline single-line JSON, or `@relative/path.json`. */
function parseSchemaValue(value: string, agentFile: string): Record<string, unknown> | undefined {
  let text = value.trim();
  if (text.startsWith("@")) {
    const loaded = readGuardedRelativeFile(agentFile, text.slice(1));
    if (loaded === undefined) return undefined;
    text = loaded;
  }
  try {
    const parsed = JSON.parse(text);
    return isPlausibleSchema(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Expand one-level `@include relative/path.md` body lines; missing/bad refs stay verbatim. */
function expandIncludes(body: string, agentFile: string): string {
  const lines = body.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*@include\s+(\S+)\s*$/.exec(lines[i]!);
    if (!match) continue;
    const loaded = readGuardedRelativeFile(agentFile, match[1]!);
    if (loaded === undefined) continue;
    lines[i] = loaded.replace(/\r?\n$/, "");
    changed = true;
  }
  return changed ? lines.join("\n") : body;
}

export function parseAgentFile(name: string, raw: string, source: string, scope: AgentDefinition["scope"]): AgentDefinition | undefined {
  let frontmatter: Record<string, string> = {};
  let body = raw;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match) {
    body = raw.slice(match[0].length);
    for (const line of match[1]!.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator <= 0 || /^\s*#/.test(line)) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key && value) frontmatter[key] = value;
    }
  }

  const thinking = isThinkingLevel(frontmatter.thinking) ? frontmatter.thinking : undefined;
  const profile = frontmatter.profile && (PROFILES as readonly string[]).includes(frontmatter.profile)
    ? (frontmatter.profile as TaskProfile)
    : undefined;
  const isolation = frontmatter.isolation === "worktree" ? "worktree" as const
    : frontmatter.isolation === "shared" ? "shared" as const
    : undefined;
  const spawns = frontmatter.spawns !== undefined ? parseSpawns(frontmatter.spawns) : undefined;
  const backend = frontmatter.backend === "codex" ? "codex" as const
    : frontmatter.backend === "claude" ? "claude" as const
    : frontmatter.backend === "pi" ? "pi" as const
    : undefined;

  const expanded = expandIncludes(body, source);
  const systemPrompt = expanded.trim() || undefined;
  const definition: AgentDefinition = {
    name,
    description: stripQuotes(frontmatter.description ?? "").slice(0, 200) || name,
    systemPrompt,
    source,
    scope,
    model: frontmatter.model ? stripQuotes(frontmatter.model) : undefined,
    thinking,
    profile,
    tools: frontmatter.tools ? parseList(frontmatter.tools) : undefined,
    maxTurns: frontmatter.max_turns ? parseNumber(frontmatter.max_turns) : undefined,
    maxCost: frontmatter.max_cost ? parseNumber(frontmatter.max_cost) : undefined,
    timeoutMs: frontmatter.timeout_ms ? parseNumber(frontmatter.timeout_ms) : undefined,
    graceTurns: frontmatter.grace_turns ? parseNumber(frontmatter.grace_turns) : undefined,
    fallbackModels: frontmatter.fallback_models ? parseList(frontmatter.fallback_models) : undefined,
    maxRetries: frontmatter.max_retries ? parseNumber(frontmatter.max_retries) : undefined,
    isolation,
    backend,
    outputSchema: frontmatter.output_schema ? parseSchemaValue(frontmatter.output_schema, source) : undefined,
    spawns,
  };
  return definition;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Discover agent definitions across the conventional roots. Synchronous by
 * design: it runs at session start and on tool execute, reads a handful of
 * small files, and failure of any root is silent (missing dirs are normal).
 * Symlinked agent files are skipped (matching skill-loading conservatism).
 */
export function discoverAgents(cwd: string): Map<string, AgentDefinition> {
  const catalog = new Map<string, AgentDefinition>();
  // Iterate lowest precedence first so higher roots overwrite.
  for (const root of [...discoveryRoots(cwd)].reverse()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -3);
      if (!NAME_PATTERN.test(name)) continue;
      const file = path.join(root.dir, entry.name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_AGENT_FILE_BYTES) continue;
        const raw = fs.readFileSync(file, "utf8");
        const definition = parseAgentFile(name.toLowerCase(), raw, file, root.scope);
        if (definition) catalog.set(definition.name, definition);
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  return catalog;
}

/** Case-insensitive lookup with a helpful error listing available names. */
export function resolveAgent(
  catalog: Map<string, AgentDefinition>,
  name: string,
): { agent?: AgentDefinition; error?: string } {
  const agent = catalog.get(name.toLowerCase());
  if (agent) return { agent };
  const available = [...catalog.keys()].sort();
  return {
    error: available.length
      ? `Unknown agent "${name}". Available agents: ${available.join(", ")}`
      : `Unknown agent "${name}". No agent files found (define them in .pi/agents/<name>.md).`,
  };
}

/** One line per agent for the tool guidelines / status output. */
export function describeCatalog(catalog: Map<string, AgentDefinition>): string[] {
  return [...catalog.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((agent) => {
      const traits = [
        agent.profile,
        agent.isolation === "worktree" ? "worktree" : "",
      ].filter(Boolean).join(", ");
      return `${agent.name}: ${agent.description}${traits ? ` (${traits})` : ""}`;
    });
}
