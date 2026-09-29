import * as fs from "node:fs";
import * as path from "node:path";
import { oneLine } from "./format.js";

/** Distinguishable tail outcomes for the live transcript view. */
export type TailSessionStatus = "missing" | "empty" | "ok";

export interface TailSessionResult {
  status: TailSessionStatus;
  lines: string[];
}

const DEFAULT_MAX_LINES = 80;
/** Bound the end-window so we never slurp large session files. */
const DEFAULT_MAX_BYTES = 64 * 1024;
const TEXT_PREVIEW = 160;
const ARG_PREVIEW = 80;

/**
 * Resolve `sessionDir/<…sessionId….jsonl>` the same way the retention sweep
 * matches files: basename without extension equals or contains the session id.
 * Prefers an exact `{id}.jsonl` match; otherwise the newest mtime include-match.
 */
export function resolveSessionFilePath(sessionDir: string, sessionId: string): string | undefined {
  if (!sessionDir || !sessionId) return undefined;
  const exact = path.join(sessionDir, `${sessionId}.jsonl`);
  try {
    if (fs.statSync(exact).isFile()) return exact;
  } catch {
    /* fall through to directory scan */
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return undefined;
  }
  let best: { file: string; mtimeMs: number } | undefined;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const base = name.slice(0, -".jsonl".length);
    if (base !== sessionId && !base.includes(sessionId)) continue;
    const file = path.join(sessionDir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
  }
  return best?.file;
}

/**
 * Read the last `maxLines` compact lines from a session `.jsonl` file.
 * Uses a bounded byte window from the end (never slurps unbounded files),
 * skips unparseable lines, and ignores a partial leading line when reading
 * mid-file. Missing file → `{ status: "missing" }`; empty/no-renderable
 * content → `{ status: "empty" }`.
 */
export function tailSessionFile(
  filePath: string,
  maxLines: number = DEFAULT_MAX_LINES,
  maxBytes: number = DEFAULT_MAX_BYTES,
  render: (raw: string) => string | null = renderSessionLine,
): TailSessionResult {
  if (!filePath) return { status: "missing", lines: [] };

  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (error: unknown) {
    if (isErrno(error) && error.code === "ENOENT") return { status: "missing", lines: [] };
    return { status: "missing", lines: [] };
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.size) return { status: "empty", lines: [] };

    const window = Math.min(stat.size, Math.max(1, maxBytes));
    const start = Math.max(0, stat.size - window);
    const buf = Buffer.alloc(window);
    const bytesRead = fs.readSync(fd, buf, 0, window, start);
    const text = buf.toString("utf8", 0, bytesRead);

    // Drop incomplete leading fragment when the window starts mid-line.
    let body = text;
    if (start > 0) {
      const firstNl = body.indexOf("\n");
      if (firstNl === -1) return { status: "empty", lines: [] };
      body = body.slice(firstNl + 1);
    }

    const rawLines = body.split("\n");
    // Trailing partial line (no final newline) is still attempted; unparseable → skip.
    const rendered: string[] = [];
    for (const raw of rawLines) {
      const compact = render(raw);
      if (compact === null) continue;
      // Assistant messages may expand to multiple compact lines (text + tools).
      for (const line of compact.split("\n")) {
        if (line) rendered.push(line);
      }
    }

    const lines = rendered.length > maxLines ? rendered.slice(rendered.length - maxLines) : rendered;
    if (!lines.length) return { status: "empty", lines: [] };
    return { status: "ok", lines };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/** Parse one JSONL session entry into compact display line(s), or null to skip. */
export function renderSessionLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;

  const rec = entry as Record<string, unknown>;
  if (rec.type === "message" && rec.message && typeof rec.message === "object") {
    return renderMessage(rec.message as Record<string, unknown>);
  }
  if (rec.type === "custom_message" && rec.display) {
    const text = contentText(rec.content);
    return text ? `note: ${oneLine(text, TEXT_PREVIEW)}` : null;
  }
  // Header / model changes / thinking / compaction / labels: not conversation.
  return null;
}

function renderMessage(message: Record<string, unknown>): string | null {
  const role = message.role;
  if (role === "user") {
    const text = contentText(message.content);
    return text ? `user: ${oneLine(text, TEXT_PREVIEW)}` : null;
  }
  if (role === "assistant") {
    if (!Array.isArray(message.content)) return null;
    const parts: string[] = [];
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string" && p.text) {
        parts.push(`assistant: ${oneLine(p.text, TEXT_PREVIEW)}`);
      } else if (p.type === "toolCall") {
        const name = typeof p.name === "string" ? p.name : "tool";
        const args = p.arguments !== undefined ? oneLine(JSON.stringify(p.arguments), ARG_PREVIEW) : "";
        parts.push(args ? `→ ${name} ${args}` : `→ ${name}`);
      }
      // skip thinking/reasoning blobs for compact live tail
    }
    return parts.length ? parts.join("\n") : null;
  }
  if (role === "toolResult") {
    const name = typeof message.toolName === "string" ? message.toolName : "tool";
    const text = contentText(message.content);
    const err = message.isError ? " [error]" : "";
    return text ? `← ${name}${err} ${oneLine(text, TEXT_PREVIEW)}` : `← ${name}${err}`;
  }
  return null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      if (!part || typeof part !== "object") return false;
      const p = part as Record<string, unknown>;
      return p.type === "text" && typeof p.text === "string";
    })
    .map((part) => part.text)
    .join("");
}
