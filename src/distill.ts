import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Lifecycle-driven child-session distillation.
 *
 * A child session is "over" when its run reached a terminal state and nothing
 * on the current parent branch references it for resume. At that point the
 * meaningful impact of the session — what it was asked, what it answered,
 * what it cost — is preserved in a small `.digest.json`, and the full
 * transcript file is deleted. No wall-clock retention windows: the trigger is
 * run lifecycle, with a short min-age guard purely against races with
 * concurrent parents.
 */

export interface SessionDigest {
  schemaVersion: 1;
  sessionId: string;
  file: string;
  distilledAt: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  model?: string;
  thinking?: string;
  /** First user message (the task), capped. */
  task?: string;
  /** Last non-empty assistant text (the outcome), capped. */
  finalOutput?: string;
  assistantTurns: number;
  toolCalls: number;
  errors: number;
  usage?: { input: number; output: number; cost: number };
  /** Original transcript size in bytes. */
  originalBytes: number;
  /** Set when the transcript could not be parsed; digest is metadata-only. */
  parseFailed?: boolean;
}

export interface LifecycleSweepReport {
  distilled: string[];
  kept: number;
  failed: string[];
}

const TASK_CAP = 600;
const OUTPUT_CAP = 8_192;
/** Race guard for concurrent parents whose runs we cannot see. Not retention. */
export const SESSION_MIN_AGE_MS = 60 * 60_000;

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block && block.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("");
}

function countToolCalls(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((block: any) => block && (block.type === "toolCall" || block.type === "toolUse" || block.type === "tool_use")).length;
}

function sessionIdFromFile(file: string): string {
  const base = path.basename(file, ".jsonl");
  const underscore = base.lastIndexOf("_");
  return underscore >= 0 ? base.slice(underscore + 1) : base;
}

export function digestPathFor(file: string): string {
  return file.replace(/\.jsonl$/, ".digest.json");
}

/** Extract the meaningful impact of one child session transcript. */
export async function digestSessionFile(file: string): Promise<SessionDigest> {
  const stat = await fs.stat(file);
  const digest: SessionDigest = {
    schemaVersion: 1,
    sessionId: sessionIdFromFile(file),
    file: path.basename(file),
    distilledAt: Date.now(),
    assistantTurns: 0,
    toolCalls: 0,
    errors: 0,
    originalBytes: stat.size,
  };
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    digest.parseFailed = true;
    return digest;
  }

  let usageInput = 0;
  let usageOutput = 0;
  let usageCost = 0;
  let sawUsage = false;
  let parsedAny = false;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    parsedAny = true;
    const ts = parseTimestamp(entry.timestamp ?? entry.ts);
    if (ts !== undefined) {
      if (digest.startedAt === undefined) digest.startedAt = ts;
      digest.endedAt = ts;
    }
    if (entry.type === "model_change") {
      const model = entry.modelId ?? entry.model;
      if (typeof model === "string" && model) digest.model = model;
    }
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      digest.thinking = entry.thinkingLevel;
    }
    const message = entry.type === "message" ? entry.message : undefined;
    if (!message || typeof message !== "object") continue;
    if (message.role === "user" && digest.task === undefined) {
      const text = textOf(message.content).trim();
      if (text) digest.task = text.slice(0, TASK_CAP);
    }
    if (message.role === "assistant") {
      digest.assistantTurns++;
      digest.toolCalls += countToolCalls(message.content);
      if (message.stopReason === "error") digest.errors++;
      const text = textOf(message.content).trim();
      if (text) digest.finalOutput = text.slice(0, OUTPUT_CAP);
      const usage = message.usage;
      if (usage && typeof usage === "object") {
        const input = Number(usage.input);
        const output = Number(usage.output);
        const cost = typeof usage.cost === "number" ? usage.cost : Number(usage.cost?.total);
        if (Number.isFinite(input)) { usageInput += input; sawUsage = true; }
        if (Number.isFinite(output)) { usageOutput += output; sawUsage = true; }
        if (Number.isFinite(cost)) { usageCost += cost; sawUsage = true; }
      }
    }
  }

  if (!parsedAny) digest.parseFailed = true;
  if (sawUsage) digest.usage = { input: usageInput, output: usageOutput, cost: usageCost };
  if (digest.startedAt !== undefined && digest.endedAt !== undefined) {
    digest.durationMs = Math.max(0, digest.endedAt - digest.startedAt);
  }
  return digest;
}

/**
 * Distill one session file to a digest and remove the transcript.
 * The transcript is only removed after the digest is durably written.
 */
export async function distillSessionFile(file: string): Promise<SessionDigest> {
  const digest = await digestSessionFile(file);
  const target = digestPathFor(file);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(digest, null, 2), "utf8");
  await fs.rename(tmp, target);
  await fs.rm(file, { force: true });
  return digest;
}

export interface LifecycleSweepOptions {
  /** Session ids that must be kept (referenced by the live parent branch). */
  keep: ReadonlySet<string>;
  /** Session ids that are busy machine-wide (running run records, live locks). */
  busy: ReadonlySet<string>;
  minAgeMs?: number;
  now?: number;
}

/**
 * Distill every child session whose run is over. "Over" is a lifecycle fact:
 * not referenced by the current branch, not owned by any running run record,
 * not locked, and past a short race guard. Age plays no retention role.
 */
export async function sweepSessionsLifecycle(
  sessionDir: string,
  options: LifecycleSweepOptions,
): Promise<LifecycleSweepReport> {
  const report: LifecycleSweepReport = { distilled: [], kept: 0, failed: [] };
  const minAge = options.minAgeMs ?? SESSION_MIN_AGE_MS;
  const now = options.now ?? Date.now();
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const base = entry.name.slice(0, -".jsonl".length);
    const isMatch = (id: string) => !!id && (base === id || base.includes(id));
    if ([...options.keep].some(isMatch) || [...options.busy].some(isMatch)) {
      report.kept++;
      continue;
    }
    const file = path.join(sessionDir, entry.name);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat || now - stat.mtimeMs < minAge) {
      report.kept++;
      continue;
    }
    try {
      await distillSessionFile(file);
      report.distilled.push(file);
    } catch {
      report.failed.push(file);
    }
  }
  return report;
}
