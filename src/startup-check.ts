/**
 * Pi child startup-handshake contract for Jev-routed subagent tasks.
 *
 * A routed dispatch must prove *before* the real task prompt reaches the child that the
 * child loaded the expected execution model and negotiated a bounded effective capability
 * set from the parent candidate allowlist. Pi may omit a parent-only extension tool from a
 * child, so ordinary candidate names are intersected with child evidence; only explicitly
 * forced names are fail-closed. Native activity remains host-owned, and nested dispatch
 * provenance is checked whenever that capability is actually exposed.
 * Parent-side catalog knowledge is not proof: Pi silently drops unknown `--tools` names,
 * and a child may load a different (possibly older) copy of this package, whose nested
 * `subagent` tool would bypass routing entirely.
 *
 * This module is the single source of truth for the bounded, non-secret handshake:
 *
 *  - manifest + acknowledgement schemas and the private command naming scheme,
 *  - the pure command resolver and capability-negotiation verifier,
 *  - the host-version gate for the one baseline that was actually verified.
 *
 * It is imported by `src/backends/pi.ts` (writes the temporary manifest and loads the
 * private extension), `src/child-preflight.ts` (runs inside the child and answers), and
 * `src/runner.ts` (drives and verifies). It carries no HTTP, config, policy or process
 * dependencies, so it also loads cleanly from an isolated offline harness.
 *
 * Nothing here is a sandbox. It is a capability check against stale installs, dropped
 * tools and misconfigured children — not a defence against a malicious local extension.
 */

import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_TOOL_NAMES, MAX_TOOL_NAME_LENGTH, isToolNameList, isToolNameSubset } from "./pi-tools.js";
import type { ToolNegotiationDiagnostics } from "./types.js";
import { isThinkingLevel } from "./thinking.js";

/** Custom-message type of the child-side acknowledgement. */
export const PREFLIGHT_ACK_TYPE = "pi-subagent-preflight-ack";
/** Schema tag inside the acknowledgement payload. */
export const PREFLIGHT_ACK_SCHEMA = "pi-subagent-preflight-ack/1";
/** Schema tag inside the temporary expectation manifest. */
export const PREFLIGHT_MANIFEST_SCHEMA = "pi-subagent-preflight-manifest/1";
/** Private command prefix; the nonce makes each invocation name unique per run. */
export const PREFLIGHT_COMMAND_PREFIX = "pi_subagent_preflight_";
/** Env var carrying the *path* to the temporary manifest (never its contents in argv). */
export const PREFLIGHT_MANIFEST_ENV = "PI_SUBAGENT_PREFLIGHT_MANIFEST";

/**
 * Lowest Pi host version whose startup contract was actually exercised offline.
 * A *known* older host is refused rather than silently degraded; an unknown version is
 * accepted only because the behavioural handshake (command + acknowledgement) already
 * proved the contract exists.
 */
export const MIN_VERIFIED_HOST_VERSION = "0.86.0";

/** Stop reason a failed startup check produces. Deliberately not in the transient set. */
export const PREFLIGHT_FAILURE_STOP_REASON = "capability_mismatch";

/** Local bounds; all handshake input is untrusted child output. */
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ACK_TOOLS = 512;
const MAX_ACK_NESTED = 512;
const MAX_MODEL_LENGTH = 512;
const MAX_PROBLEMS_IN_MESSAGE = 8;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Bounded, non-secret expectation the backend writes and the child reads back. */
export interface PreflightManifest {
  readonly schema: typeof PREFLIGHT_MANIFEST_SCHEMA;
  readonly nonce: string;
  /** Exact `provider/modelId` the child must have active. */
  readonly model: string;
  /** Finalized child candidate allowlist (ordinary + official native definitions). */
  readonly tools: readonly string[];
  /** Explicit caller-requested names that must be effective in the child. */
  readonly forcedTools?: readonly string[];
  /** Official non-direct definitions whose activation is host-owned. */
  readonly nativeTools?: readonly string[];
  /** Nested dispatch tools whose loaded source must be this package's extension entry. */
  readonly nestedTools?: readonly string[];
}

/** What the control side verifies the acknowledgement against. */
export interface PreflightExpectation {
  readonly nonce: string;
  readonly model: string;
  readonly tools: readonly string[];
  readonly forcedTools?: readonly string[];
  readonly nativeTools?: readonly string[];
  readonly nestedTools?: readonly string[];
  /** Expected own extension entry paths; defaults to the current package's entries. */
  readonly ownEntryPaths?: readonly string[];
  /** Expected source path of the private preflight command; defaults to this package's. */
  readonly preflightCommandPath?: string | null;
}

/** One provenance row for a nested tool, echoed by the child in its acknowledgement. */
export interface PreflightToolSource {
  readonly name: string;
  readonly path?: string | null;
  readonly source?: string | null;
}

export interface PreflightAckPayload {
  readonly schema?: unknown;
  readonly nonce?: unknown;
  readonly model?: { provider?: unknown; id?: unknown } | null;
  /** Optional host-effective Pi thinking level; absent on reduced/older hosts. */
  readonly thinking?: unknown;
  readonly tools?: unknown;
  readonly registeredNativeTools?: unknown;
  readonly nestedToolsWithSource?: unknown;
  readonly host?: { version?: unknown } | null;
}

/** Result-message prefix for a refused routed startup, stable for callers/TUI matching. */
export const STARTUP_FAILURE_RESULT_PREFIX = "Subagent startup check failed";

/**
 * Marker for a startup capability failure carried by a *plain* `Error`.
 *
 * This repository forbids custom `Error` subclasses, so a pre-spawn/startup refusal is a
 * plain Error whose message carries a stable, bounded marker plus an owned code; the
 * runner narrows it with `readStartupFailure` and maps it to a non-transient
 * `PREFLIGHT_FAILURE_STOP_REASON` result instead of rethrowing for control flow.
 */
export const STARTUP_FAILURE_MARKER = "subagent-startup-check-failed";

/** Build a plain Error carrying an owned startup failure code. */
export function startupFailure(code: string, detail: string): Error {
  const error = new Error(`${STARTUP_FAILURE_MARKER}: ${code}: ${detail}`);
  (error as Error & { startupCode?: string }).startupCode = code;
  return error;
}

/** Narrow any thrown value to an owned startup failure, or undefined. */
export function readStartupFailure(error: unknown): { code: string; detail: string } | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { startupCode?: unknown }).startupCode;
  if (typeof code === "string" && code.length > 0) {
    const raw = (error as { message?: unknown }).message;
    const message = typeof raw === "string" ? raw : "";
    const prefix = `${STARTUP_FAILURE_MARKER}: ${code}: `;
    const detail = message.startsWith(prefix) ? message.slice(prefix.length) : message;
    return { code, detail: detail || "startup check failed" };
  }
  return undefined;
}

/** Bounded startup timeout used when a routed child never answers the handshake. */
export function startupTimeoutDetail(budgetMs: number): string {
  return `The child did not complete startup verification within ${Math.max(0, Math.round(budgetMs))} ms.`;
}

export function isValidPreflightNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

export function createPreflightNonce(): string {
  return crypto.randomBytes(12).toString("hex");
}

export function preflightCommandBase(nonce: string): string {
  return `${PREFLIGHT_COMMAND_PREFIX}${nonce}`;
}

/**
 * Normalize a filesystem path for provenance comparison. Symlinked installs and Windows
 * drive-case differences must not turn an identical copy into a false mismatch.
 */
export function normalizeFsPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let resolved: string;
  try {
    resolved = path.resolve(value);
  } catch {
    resolved = value;
  }
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    /* path may not exist from this process's view; keep the lexical form */
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Absolute path of this package's private preflight extension, used both as the explicit
 * `-e` target and as the expected `sourceInfo.path` of the startup command.
 */
export function ownPreflightExtensionPath(baseUrl: string = import.meta.url): string | null {
  try {
    const candidate = path.join(path.dirname(fileURLToPath(baseUrl)), "child-preflight.ts");
    return fs.existsSync(candidate) ? normalizeFsPath(candidate) : null;
  } catch {
    return null;
  }
}

/**
 * Package extension entries that legitimately host the nested `subagent` / `subagent_wait`
 * tools. Derived from this module's own location so a child that loaded a different
 * installed copy is detected rather than trusted.
 */
export function ownExtensionEntryCandidates(baseUrl: string = import.meta.url): string[] {
  let srcDir: string;
  try {
    srcDir = path.dirname(fileURLToPath(baseUrl));
  } catch {
    return [];
  }
  const root = path.resolve(srcDir, "..");
  const candidates: string[] = [];
  for (const relative of ["extensions/subagent.ts", "src/extension.ts"]) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const normalized = normalizeFsPath(absolute);
    if (normalized) candidates.push(normalized);
  }
  return candidates;
}

export type PreflightManifestParse =
  | { readonly ok: true; readonly manifest: PreflightManifest }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Validate untrusted manifest text read from the temporary file. */
export function parsePreflightManifest(raw: unknown): PreflightManifestParse {
  if (typeof raw !== "string") {
    return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest was not readable text." };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
    return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest exceeded the local size bound." };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest was not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || parsed.schema !== PREFLIGHT_MANIFEST_SCHEMA) {
    return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest schema tag did not match." };
  }
  if (!isValidPreflightNonce(parsed.nonce)) {
    return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest carried an unusable correlation nonce." };
  }
  if (typeof parsed.model !== "string" || parsed.model.length === 0 || parsed.model.length > MAX_MODEL_LENGTH) {
    return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest carried no usable model expectation." };
  }
  const tools = readNameList(parsed.tools, MAX_ACK_TOOLS);
  if (!tools) {
    return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest carried no usable tool list." };
  }
  const forcedTools = parsed.forcedTools === undefined ? undefined : readNameList(parsed.forcedTools, MAX_ACK_TOOLS);
  if (parsed.forcedTools !== undefined && (!forcedTools || !isToolNameSubset(forcedTools, tools))) {
    return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest carried an unusable forced tool set." };
  }
  const nativeTools = parsed.nativeTools === undefined ? undefined : readNameList(parsed.nativeTools, MAX_ACK_TOOLS);
  if (parsed.nativeTools !== undefined && (!nativeTools || !isToolNameSubset(nativeTools, tools))) {
    return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest carried an unusable native tool set." };
  }
  let nestedTools: string[] | undefined;
  if (parsed.nestedTools !== undefined) {
    nestedTools = readNameList(parsed.nestedTools, MAX_ACK_NESTED) ?? undefined;
    if (parsed.nestedTools !== undefined && nestedTools === undefined) {
      return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest carried an unusable nested-tool list." };
    }
    if (nestedTools !== undefined && !isToolNameSubset(nestedTools, tools)) {
      return { ok: false, code: "preflight_manifest_unreadable", message: "The preflight manifest carried nested tools outside its candidate allowlist." };
    }
  }
  return {
    ok: true,
    manifest: { schema: PREFLIGHT_MANIFEST_SCHEMA, nonce: parsed.nonce, model: parsed.model, tools, nestedTools,
      ...(forcedTools === undefined ? {} : { forcedTools }),
      ...(nativeTools === undefined ? {} : { nativeTools }),
    },
  };
}

function readNameList(value: unknown, maxCount: number): string[] | null {
  return isToolNameList(value, maxCount) ? [...value] : null;
}

export interface ResolvedPreflightCommand {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  readonly path?: string;
  readonly sourceInfoSource?: string;
  readonly scope?: string;
  readonly origin?: string;
}

export type PreflightCommandResolution =
  | { readonly ok: true; readonly code: "verified"; readonly invocableName: string; readonly entry: ResolvedPreflightCommand }
  | {
      readonly ok: false;
      readonly code:
        | "command-absent"
        | "command-path-mismatch"
        | "command-ambiguous"
        | "command-source-not-extension";
      readonly invocableName: null;
      readonly candidates: ReadonlyArray<{ name: string; source?: string; path: string | null }>;
    };

/**
 * Resolve the invocable startup command from a raw `get_commands` payload.
 *
 * Requires BOTH the nonce-specific name AND an expected source file path: Pi suffixes
 * duplicate command names (`name:1`, `name:2`), so name-only matching could select a
 * different extension's copy — and an unverified slash command would be treated as an
 * ordinary model prompt.
 */
export function resolvePreflightCommand(
  commands: unknown,
  baseName: string,
  expectedPaths: string | readonly string[],
  allowedSources: readonly string[] = ["extension"],
): PreflightCommandResolution {
  const expected = (Array.isArray(expectedPaths) ? expectedPaths : [expectedPaths])
    .map((candidate) => normalizeFsPath(candidate))
    .filter((candidate): candidate is string => candidate !== null);

  const list = Array.isArray(commands) ? commands : [];
  const byName = list.filter(
    (entry: any) =>
      entry &&
      typeof entry === "object" &&
      typeof entry.name === "string" &&
      (entry.name === baseName || entry.name.startsWith(`${baseName}:`)),
  );
  const describe = (entry: any) => ({
    name: String(entry?.name ?? ""),
    source: typeof entry?.source === "string" ? entry.source : undefined,
    path: typeof entry?.sourceInfo?.path === "string" ? entry.sourceInfo.path : null,
  });

  if (byName.length === 0) {
    return { ok: false, code: "command-absent", invocableName: null, candidates: [] };
  }
  const byPath = byName.filter((entry: any) => {
    const observed = normalizeFsPath(entry?.sourceInfo?.path);
    return observed !== null && expected.includes(observed);
  });
  if (byPath.length === 0) {
    return { ok: false, code: "command-path-mismatch", invocableName: null, candidates: byName.map(describe) };
  }
  if (byPath.length > 1) {
    return { ok: false, code: "command-ambiguous", invocableName: null, candidates: byPath.map(describe) };
  }
  const entry: any = byPath[0];
  if (typeof entry.source !== "string" || !allowedSources.includes(entry.source)) {
    return { ok: false, code: "command-source-not-extension", invocableName: null, candidates: [describe(entry)] };
  }
  return {
    ok: true,
    code: "verified",
    invocableName: entry.name,
    entry: {
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : undefined,
      source: entry.source,
      path: typeof entry.sourceInfo?.path === "string" ? entry.sourceInfo.path : undefined,
      sourceInfoSource: typeof entry.sourceInfo?.source === "string" ? entry.sourceInfo.source : undefined,
      scope: typeof entry.sourceInfo?.scope === "string" ? entry.sourceInfo.scope : undefined,
      origin: typeof entry.sourceInfo?.origin === "string" ? entry.sourceInfo.origin : undefined,
    },
  };
}

/** Parse the child's custom-message content. Never throws; returns null when unusable. */
export function parsePreflightAckContent(content: unknown): PreflightAckPayload | null {
  if (typeof content !== "string" || content.length === 0) return null;
  if (Buffer.byteLength(content, "utf8") > MAX_MANIFEST_BYTES) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? (parsed as PreflightAckPayload) : null;
  } catch {
    return null;
  }
}

/** `major.minor.patch` compare; unparseable input is "unknown", never "older". */
export function compareHostVersion(version: unknown): "ok" | "unsupported" | "unknown" {
  if (typeof version !== "string") return "unknown";
  const parse = (value: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const actual = parse(version);
  const floor = parse(MIN_VERIFIED_HOST_VERSION);
  if (!actual || !floor) return "unknown";
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > floor[index]) return "ok";
    if (actual[index] < floor[index]) return "unsupported";
  }
  return "ok";
}

/** Bounded result of the child capability negotiation. */
export interface PreflightAckInspection {
  readonly problems: readonly string[];
  readonly diagnostics: ToolNegotiationDiagnostics;
}

/**
 * Inspect an acknowledgement and negotiate the child-effective tool set.
 *
 * The finalized candidate list is intentionally not treated as proof that every
 * definition exists in the child: Pi may omit a parent-only extension tool from
 * the child registry. Such names become `omittedTools`. Only explicitly forced
 * names are fail-closed; active names outside the candidate allowlist remain a
 * hard mismatch because capability negotiation must never broaden access.
 */
export function negotiatePreflightAck(ack: unknown, expectation: PreflightExpectation): PreflightAckInspection {
  const parsedCandidates = readNameList(expectation.tools, MAX_ACK_TOOLS);
  const candidateValid = parsedCandidates !== null;
  const candidateTools = parsedCandidates ?? [];
  const rawForced = expectation.forcedTools;
  const parsedForced = rawForced === undefined ? [] : readNameList(rawForced, MAX_ACK_TOOLS);
  const forcedValid = !candidateValid
    || (rawForced === undefined ? true : parsedForced !== null && isToolNameSubset(parsedForced, candidateTools));
  const forcedTools = candidateValid && forcedValid ? [...(parsedForced ?? [])] : [];
  const problems: string[] = [];
  if (!candidateValid) problems.push("candidate-expectation-invalid");
  if (!forcedValid) problems.push("forced-expectation-invalid");

  const freezeDiagnostics = (
    effectiveTools: readonly string[],
    omittedTools: readonly string[],
  ): ToolNegotiationDiagnostics => Object.freeze({
    candidateTools: Object.freeze([...candidateTools]),
    effectiveTools: Object.freeze([...effectiveTools]),
    omittedTools: Object.freeze([...omittedTools]),
    forcedTools: Object.freeze([...forcedTools]),
  });
  const emptyDiagnostics = (): ToolNegotiationDiagnostics => freezeDiagnostics([], candidateTools);
  if (!ack || typeof ack !== "object") return { problems: [...problems, "ack-malformed"], diagnostics: emptyDiagnostics() };
  const payload = ack as PreflightAckPayload;
  if (payload.schema !== PREFLIGHT_ACK_SCHEMA) problems.push("ack-schema-mismatch");
  if (payload.nonce !== expectation.nonce) problems.push("nonce-mismatch");

  const hostVersion = payload.host?.version;
  if (compareHostVersion(hostVersion) === "unsupported") {
    problems.push(`host-version-unsupported:${String(hostVersion).slice(0, 32)}`);
  }

  if (payload.thinking !== undefined && !isThinkingLevel(payload.thinking)) problems.push("thinking-invalid");

  const model = payload.model;
  if (!model || typeof model !== "object") {
    problems.push("model-absent");
  } else {
    const provider = typeof model.provider === "string" ? model.provider : "";
    const id = typeof model.id === "string" ? model.id : "";
    if (!provider || !id || `${provider}/${id}` !== expectation.model) problems.push("model-mismatch");
  }

  const expectedNative = expectation.nativeTools === undefined ? EMPTY_TOOL_NAMES : expectation.nativeTools;
  const validNative = isToolNameSubset(expectedNative, candidateTools);
  if (!validNative) problems.push("native-expectation-invalid");
  const nativeTools = validNative ? expectedNative : EMPTY_TOOL_NAMES;

  // A missing native registration is now negotiable: it is simply not part of
  // childEffectiveTools unless the caller explicitly forced that name. A malformed
  // non-null claim remains a hard evidence problem and is never trusted as capability.
  let registeredNative = new Set<string>();
  if (nativeTools.length > 0 && payload.registeredNativeTools !== undefined && payload.registeredNativeTools !== null) {
    if (!isToolNameSubset(payload.registeredNativeTools, nativeTools)) {
      problems.push("native-registration-invalid");
    } else {
      registeredNative = new Set(payload.registeredNativeTools);
    }
  }

  const active = new Set<string>();
  let activeListValid = false;
  if (!Array.isArray(payload.tools)) {
    problems.push("tools-not-array");
  } else if (payload.tools.length > MAX_ACK_TOOLS) {
    problems.push("ack-too-large");
  } else {
    activeListValid = true;
    for (const entry of payload.tools) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_TOOL_NAME_LENGTH) {
        problems.push("tool-name-invalid");
        continue;
      }
      if (active.has(entry)) problems.push(`tool-duplicate:${entry}`);
      active.add(entry);
    }
    for (const observed of active) {
      if (!candidateTools.includes(observed)) problems.push(`unexpected-tool:${observed}`);
    }
  }

  const observed = new Set<string>();
  if (activeListValid) {
    for (const name of candidateTools) {
      if (nativeTools.includes(name)) {
        if (registeredNative.has(name)) observed.add(name);
      } else if (active.has(name)) {
        observed.add(name);
      }
    }
  }
  // Native definitions are host-managed and may be inactive, so registration
  // proof can make them effective even when they are absent from getActiveTools().
  for (const name of registeredNative) observed.add(name);

  const rawNested = expectation.nestedTools;
  const parsedNested = rawNested === undefined ? [] : readNameList(rawNested, MAX_ACK_NESTED);
  const nestedValid = rawNested === undefined
    ? true
    : parsedNested !== null && isToolNameSubset(parsedNested, candidateTools, MAX_ACK_NESTED);
  const nested = nestedValid ? (parsedNested ?? []) : [];
  if (!nestedValid) problems.push("nested-expectation-invalid");
  if (nested.length > 0) {
    const expectedEntries = expectation.ownEntryPaths ?? ownExtensionEntryCandidates();
    const rows = Array.isArray(payload.nestedToolsWithSource) ? payload.nestedToolsWithSource : [];
    if (rows.length > MAX_ACK_NESTED) problems.push("ack-too-large");
    const byName = new Map<string, PreflightToolSource>();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const candidate = row as PreflightToolSource;
      if (typeof candidate.name !== "string") continue;
      if (!byName.has(candidate.name)) byName.set(candidate.name, candidate);
    }
    // Source attestation is required only when the child actually exposes the
    // nested capability (or when it was explicitly forced). An absent row is an
    // ordinary omission under the negotiated capability model.
    for (const tool of nested) {
      if (!active.has(tool) && !forcedTools.includes(tool)) continue;
      const row = byName.get(tool);
      if (!row) {
        problems.push(`nested-tool-source-missing:${tool}`);
        continue;
      }
      const source = typeof row.source === "string" ? row.source : "";
      if (!source || source === "builtin" || source === "sdk") {
        problems.push(`nested-tool-source-not-extension:${tool}`);
        continue;
      }
      const observedPath = normalizeFsPath(row.path);
      if (!observedPath || expectedEntries.length === 0 || !expectedEntries.includes(observedPath)) {
        problems.push(`nested-tool-source-mismatch:${tool}`);
      }
    }
  }

  const effectiveTools = candidateTools.filter((name, index) => observed.has(name) && candidateTools.indexOf(name) === index);
  const omittedTools = candidateTools.filter((name, index) => !observed.has(name) && candidateTools.indexOf(name) === index);
  for (const required of forcedTools) {
    if (!observed.has(required)) problems.push(`missing-forced-tool:${required}`);
  }
  return {
    problems,
    diagnostics: freezeDiagnostics(effectiveTools, omittedTools),
  };
}

/** Backward-compatible problem-only verifier for focused callers and old harnesses. */
export function verifyPreflightAck(ack: unknown, expectation: PreflightExpectation): string[] {
  return [...negotiatePreflightAck(ack, expectation).problems];
}

/** Bounded, safe diagnostic text for a verification failure. */
export function summarizePreflightProblems(problems: readonly string[]): string {
  if (problems.length === 0) return "startup acknowledgement rejected";
  const shown = problems.slice(0, MAX_PROBLEMS_IN_MESSAGE).map((problem) => problem.slice(0, 96));
  const suffix = problems.length > shown.length ? ` (+${problems.length - shown.length} more)` : "";
  return shown.join("; ") + suffix;
}

/** Bounded command-resolution diagnostic for a failure detail. */
export function summarizeCommandResolution(resolution: PreflightCommandResolution): string {
  if (resolution.ok) return `verified /${resolution.invocableName}`;
  const candidates = resolution.candidates
    .slice(0, 3)
    .map((candidate) => `${candidate.name || "<unnamed>"}@${candidate.path ?? candidate.source ?? "unknown"}`)
    .join(", ");
  return `${resolution.code}${candidates ? ` [${candidates.slice(0, 300)}]` : ""}`;
}
