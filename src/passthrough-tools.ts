/** Shared, transport-safe name contract; no foreign-tool presets or effect inference. */
export const MAX_PASSTHROUGH_TOOLS = 256;
export const MAX_PASSTHROUGH_TOOL_NAME = 256;
export const EMPTY_PASSTHROUGH_TOOLS: readonly string[] = Object.freeze([]);

/** Own dispatch names remain subject to spawn/depth/profile policy, never infrastructure trust. */
export const NESTED_DISPATCH_TOOLS: readonly string[] = Object.freeze(["subagent", "subagent_wait"]);

function isExactToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PASSTHROUGH_TOOL_NAME
    && !/[\s\x00-\x1f\x7f-\x9f,*?\[\]{}]/u.test(value);
}

export type PassthroughToolsParse =
  | { readonly ok: true; readonly tools: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** Normalize only user config. Diagnostics never echo untrusted values or config contents. */
export function parsePassthroughTools(value: unknown): PassthroughToolsParse {
  if (value === undefined) return { ok: true, tools: EMPTY_PASSTHROUGH_TOOLS };
  if (!Array.isArray(value) || value.length > MAX_PASSTHROUGH_TOOLS) {
    return { ok: false, error: `passthroughTools must be an array of at most ${MAX_PASSTHROUGH_TOOLS} exact tool names.` };
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    const name = typeof entry === "string" ? entry.trim() : entry;
    if (!isExactToolName(name)) {
      return { ok: false, error: `passthroughTools[${index}] must be a non-blank exact tool name of at most ${MAX_PASSTHROUGH_TOOL_NAME} characters, without whitespace, control characters, commas or wildcards.` };
    }
    if (!seen.has(name)) {
      seen.add(name);
      tools.push(name);
    }
  }
  return { ok: true, tools: tools.length ? Object.freeze(tools) : EMPTY_PASSTHROUGH_TOOLS };
}

/** Execution/protocol evidence must already be normalized; never repair or deduplicate it. */
export function isPassthroughToolSubset(value: unknown, allowed: readonly string[]): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_PASSTHROUGH_TOOLS
    && value.every((name) => isExactToolName(name) && allowed.includes(name))
    && new Set(value).size === value.length;
}
