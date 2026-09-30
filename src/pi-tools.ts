/**
 * Structural view of Pi's official tool metadata.
 *
 * Tool exposure is owned by Pi itself. This module deliberately contains no
 * user-configured names or source/name presets: it only normalizes the official
 * exposure values and keeps the bounded name-list proof used by the startup
 * handshake.
 */

export const TOOL_EXPOSURES = Object.freeze([
  "direct",
  "model-only",
  "codemode",
  "deferred",
  "hidden",
] as const);
export type ToolExposure = (typeof TOOL_EXPOSURES)[number];

export const MAX_TOOL_NAMES = 512;
export const MAX_TOOL_NAME_LENGTH = 256;
export const EMPTY_TOOL_NAMES: readonly string[] = Object.freeze([]);

/** Own dispatch names remain subject to spawn/depth policy, never exposure trust. */
export const NESTED_DISPATCH_TOOLS: readonly string[] = Object.freeze(["subagent", "subagent_wait"]);

export interface PiToolSourceInfo {
  readonly source?: string;
  readonly scope?: string;
  readonly origin?: string;
  readonly path?: string;
}

/** Small, immutable projection of Pi's ToolInfo; schemas and executors never cross this boundary. */
export interface PiToolInfoView {
  readonly name: string;
  readonly description: string;
  readonly exposure: ToolExposure;
  readonly sourceInfo?: PiToolSourceInfo;
}

export interface PiToolPartition {
  /** Every valid, uniquely named definition in the snapshot, including hidden rows. */
  readonly registered: readonly PiToolInfoView[];
  /** Active direct tools; these are the only ordinary Jev candidates. */
  readonly ordinary: readonly PiToolInfoView[];
  /** Registered official non-direct, non-hidden tools; activity remains host-owned. */
  readonly native: readonly PiToolInfoView[];
}

function isExactToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOOL_NAME_LENGTH
    && !/[\s\x00-\x1f\x7f-\x9f,*?\[\]{}]/u.test(value);
}

/** Missing exposure is the Pi default (`direct`); an unknown present value is malformed. */
export function normalizeToolExposure(value: unknown): ToolExposure | null {
  if (value === undefined) return "direct";
  return typeof value === "string" && (TOOL_EXPOSURES as readonly string[]).includes(value)
    ? value as ToolExposure
    : null;
}

/** Parse only the bounded metadata needed for classification and diagnostics. */
export function readPiToolInfo(value: unknown): PiToolInfoView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isExactToolName(record.name)) return null;
  const exposure = normalizeToolExposure(record.exposure);
  if (!exposure) return null;
  const source = record.sourceInfo;
  const sourceInfo = source && typeof source === "object" && !Array.isArray(source)
    ? Object.freeze(Object.fromEntries(
        ["source", "scope", "origin", "path"]
          .filter((key) => typeof (source as Record<string, unknown>)[key] === "string")
          .map((key) => [key, (source as Record<string, unknown>)[key]] as const),
      ) as PiToolSourceInfo)
    : undefined;
  return Object.freeze({
    name: record.name,
    description: typeof record.description === "string" ? record.description : "",
    exposure,
    ...(sourceInfo && Object.keys(sourceInfo).length > 0 ? { sourceInfo } : {}),
  });
}

/**
 * Partition one `getAllTools()` + `getActiveTools()` snapshot.
 * Duplicate valid names are discarded from the result instead of guessing which
 * definition Pi would call. Invalid metadata never creates a native tool.
 */
export function partitionPiTools(rawTools: readonly unknown[], activeNames: ReadonlySet<string>): PiToolPartition {
  const byName = new Map<string, PiToolInfoView>();
  const duplicateNames = new Set<string>();
  for (const raw of rawTools) {
    const info = readPiToolInfo(raw);
    if (!info || duplicateNames.has(info.name)) continue;
    if (byName.has(info.name)) {
      byName.delete(info.name);
      duplicateNames.add(info.name);
      continue;
    }
    byName.set(info.name, info);
  }
  const registered = [...byName.values()];
  const ordinary = registered.filter((tool) => tool.exposure === "direct" && activeNames.has(tool.name));
  const native = registered.filter((tool) => tool.exposure !== "direct" && tool.exposure !== "hidden");
  return Object.freeze({
    registered: Object.freeze(registered),
    ordinary: Object.freeze(ordinary),
    native: Object.freeze(native),
  });
}

/** Validate child/manifest name evidence without repairing, sorting or deduplicating it. */
export function isToolNameList(value: unknown, maxCount = MAX_TOOL_NAMES): value is readonly string[] {
  return Array.isArray(value) && value.length <= maxCount
    && value.every((name) => isExactToolName(name))
    && new Set(value).size === value.length;
}

/** Validate a normalized name subset against a parent-derived allowlist. */
export function isToolNameSubset(value: unknown, allowed: readonly string[], maxCount = MAX_TOOL_NAMES): value is readonly string[] {
  return isToolNameList(value, maxCount) && value.every((name) => allowed.includes(name));
}
