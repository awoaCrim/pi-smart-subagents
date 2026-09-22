import * as fs from "node:fs";
import * as os from "node:os";
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
 * Resolve a child transcript file for non-pi backends.
 *
 * The vendor CLIs write their own JSONL transcripts in fixed locations:
 *   codex  → $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl
 *   claude → ~/.claude/projects/<slugified-cwd>/<session_id>.jsonl
 *
 * We locate by session id rather than reconstructing the timestamp/slug, so a
 * layout tweak degrades to "not found" instead of showing the wrong run.
 * Returns undefined when nothing matches, which the UI reports honestly.
 */
export function resolveBackendSessionFilePath(
  backend: "pi" | "codex" | "claude",
  sessionId: string,
  options: { sessionDir?: string; home?: string; cwd?: string } = {},
): string | undefined {
  if (!sessionId) return undefined;
  if (backend === "pi") {
    return options.sessionDir ? resolveSessionFilePath(options.sessionDir, sessionId) : undefined;
  }
  const home = options.home ?? os.homedir();
  if (backend === "codex") {
    const root = process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, "sessions")
      : path.join(home, ".codex", "sessions");
    return findByIdRecursive(root, sessionId, 4);
  }
  // claude: one directory per project, named from the cwd with separators
  // replaced by dashes (e.g. /private/tmp/x → -private-tmp-x).
  const projects = path.join(home, ".claude", "projects");
  const cwd = options.cwd ?? process.cwd();
  const slug = cwd.replace(/[/\\]/g, "-");
  const direct = path.join(projects, slug, `${sessionId}.jsonl`);
  try {
    if (fs.statSync(direct).isFile()) return direct;
  } catch {
    /* fall through to a bounded scan */
  }
  return findByIdRecursive(projects, sessionId, 2);
}

/**
 * Bounded breadth-limited search for `*<sessionId>*.jsonl`. Depth-capped so a
 * deep or hostile tree cannot turn a UI refresh into a filesystem walk.
 */
function findByIdRecursive(root: string, sessionId: string, maxDepth: number): string | undefined {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let best: { file: string; mtimeMs: number } | undefined;
  let visited = 0;
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (depth > maxDepth || visited > 512) break;
    visited++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.name.endsWith(".jsonl") || !entry.name.includes(sessionId)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtimeMs > best.mtimeMs) best = { file: full, mtimeMs };
    }
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

/**
 * Codex rollout renderer. Codex writes `{type,payload}` envelopes; the
 * conversation lives in `response_item` messages and `event_msg` tool events.
 * Developer/permissions preamble is skipped: it is boilerplate, not content.
 */
export function renderCodexSessionLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let entry: any;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const payload = entry?.payload;
  if (!payload || typeof payload !== "object") return null;
  if (entry.type === "response_item" && payload.type === "message") {
    // Skip the injected sandbox/permissions preamble.
    if (payload.role === "developer") return null;
    const text = codexText(payload.content);
    if (!text) return null;
    const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : String(payload.role ?? "?");
    return `${role}: ${oneLine(text, TEXT_PREVIEW)}`;
  }
  if (entry.type === "response_item" && (payload.type === "function_call" || payload.type === "local_shell_call")) {
    const name = payload.name ?? "shell";
    const args = typeof payload.arguments === "string" ? payload.arguments : JSON.stringify(payload.action ?? {});
    return `tool ${name}(${oneLine(args, ARG_PREVIEW)})`;
  }
  if (entry.type === "event_msg" && payload.type === "agent_reasoning") {
    const text = typeof payload.text === "string" ? payload.text : "";
    return text ? `thinking: ${oneLine(text, TEXT_PREVIEW)}` : null;
  }
  return null;
}

function codexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) =>
      typeof part?.text === "string" && (part.type === "input_text" || part.type === "output_text" || part.type === "text")
        ? part.text
        : "",
    )
    .filter(Boolean)
    .join("");
}

/**
 * Claude Code transcript renderer. Claude writes `{type:"assistant"|"user",
 * message:{...}}` plus bookkeeping entries (queue-operation, hooks) that are
 * not conversation.
 */
export function renderClaudeSessionLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let entry: any;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (entry?.type === "assistant" || entry?.type === "user") {
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          parts.push(`${entry.type}: ${oneLine(part.text, TEXT_PREVIEW)}`);
        } else if (part?.type === "tool_use") {
          parts.push(`tool ${part.name ?? "?"}(${oneLine(JSON.stringify(part.input ?? {}), ARG_PREVIEW)})`);
        } else if (part?.type === "tool_result") {
          const text = typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
          parts.push(`  -> ${oneLine(text, ARG_PREVIEW)}`);
        }
      }
      return parts.length ? parts.join("\n") : null;
    }
    if (typeof content === "string" && content.trim()) return `${entry.type}: ${oneLine(content, TEXT_PREVIEW)}`;
  }
  return null;
}

/** Renderer for a backend's own transcript dialect. */
export function sessionLineRenderer(backend: "pi" | "codex" | "claude"): (raw: string) => string | null {
  return backend === "codex" ? renderCodexSessionLine : backend === "claude" ? renderClaudeSessionLine : renderSessionLine;
}
