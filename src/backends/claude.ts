/**
 * Claude Code backend — spawns the `claude` CLI in
 * `--print --output-format stream-json` mode and translates its event stream
 * into our normalized `ProtocolUpdate` shape.
 *
 * **Why the CLI and not `@anthropic-ai/claude-agent-sdk`:** the reference
 * implementation we ported from drives the SDK in-process, which would add a
 * heavy hard dependency and put a second agent runtime inside the parent. The
 * CLI exposes everything we need (`--output-format stream-json`,
 * `--allowedTools`, `--append-system-prompt`, `--json-schema`, `--resume`,
 * `--fork-session`) and keeps the process-per-child model that all of our
 * safety machinery is built around. Zero new dependencies.
 *
 * Event vocabulary (captured from claude-code 2.1.219):
 *
 *   {"type":"system","subtype":"init","session_id":"…","tools":[…],"model":"…"}
 *   {"type":"assistant","message":{"role":"assistant","content":[…],"usage":{…}}}
 *   {"type":"user","message":{…}}                       // tool results
 *   {"type":"result","subtype":"success","total_cost_usd":0.01,"usage":{…},
 *    "num_turns":3,"result":"final text","is_error":false}
 *
 * Capability notes:
 * - **Cost IS reported** (`total_cost_usd` on the result event), so `max_cost`
 *   is honored. It arrives once at the end rather than per turn, so the budget
 *   check fires on the terminal event — enforcement is real but coarse.
 * - **Tool restriction** via `--allowedTools`, so explore/review map cleanly.
 * - **No mid-run steering** in one-shot print mode (streaming stdin input is
 *   possible but adds a second protocol; deliberately out of scope for now),
 *   so graceful budget wrap-up is unsupported and a breach hard-stops.
 * - `--json-schema` provides native structured output.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendInvocation,
  BackendLaunchContext,
  BackendParser,
} from "../backend.js";
import type { ProtocolUpdate } from "../protocol.js";
import type { TaskResult, TaskSpec, UsageStats } from "../types.js";
import { emptyUsage } from "../types.js";
import { schemaContract } from "../structured.js";

const CLAUDE_CAPABILITIES: BackendCapabilities = {
  steer: false,
  gracefulWrapUp: false,
  // total_cost_usd on the terminal result event.
  costReporting: true,
  resume: true,
  fork: true,
  toolRestriction: true,
  thinking: false,
  outputSchema: true,
};

const TRANSCRIPT_MAX_LINES = 2000;

/**
 * Map our tool names onto Claude Code's. Unmapped names are passed through so
 * a caller can name Claude tools directly.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  grep: "Grep",
  find: "Glob",
  glob: "Glob",
  ls: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
};

function mapTools(tools: readonly string[]): string[] {
  const mapped = new Set<string>();
  for (const tool of tools) {
    if (tool === "subagent") continue;
    mapped.add(TOOL_NAME_MAP[tool] ?? tool);
  }
  return [...mapped];
}

export class ClaudeParser implements BackendParser {
  private buffer = "";
  private sessionId?: string;
  private model?: string;
  private messages: Message[] = [];
  private usage: UsageStats = emptyUsage();
  private liveText = "";
  private transcriptLines: string[] = [];
  private transcriptJoined?: string;
  private parseErrors = 0;
  private validEvents = 0;
  private initSeen = false;
  private resultSeen = false;
  private assistantSeen = false;
  private errorMessage?: string;
  private apiErrorSeen = false;

  feed(data: Buffer | string): ProtocolUpdate[] {
    this.buffer += typeof data === "string" ? data : data.toString("utf8");
    const updates: ProtocolUpdate[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      updates.push(...this.handleLine(line));
    }
    return updates;
  }

  flush(): ProtocolUpdate[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    return this.handleLine(line);
  }

  private handleLine(raw: string): ProtocolUpdate[] {
    const trimmed = raw.trim();
    if (!trimmed || !trimmed.startsWith("{")) return [];
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      this.parseErrors++;
      return [];
    }
    if (!event || typeof event !== "object") {
      this.parseErrors++;
      return [];
    }
    this.validEvents++;

    // The terminal event is identified by type:"result" (it has no subtype
    // discriminator we can rely on beyond that).
    if (event.type === "result") return this.handleResult(event);
    if (event.type === "system") {
      if (event.subtype === "init") {
        this.initSeen = true;
        if (typeof event.session_id === "string" && event.session_id) {
          this.sessionId = event.session_id;
          if (typeof event.model === "string") this.model = event.model;
          return [{ type: "session", sessionId: event.session_id }];
        }
      }
      return [];
    }
    if (event.type === "assistant") return this.handleAssistant(event);
    if (event.type === "user") {
      // Tool results echoed back; record for the transcript only.
      const content = event.message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === "tool_result") this.pushTranscript(`[tool result] ${previewOf(part.content)}`);
        }
      }
      return [];
    }
    return [];
  }

  private handleAssistant(event: any): ProtocolUpdate[] {
    const message = event.message;
    if (!message || typeof message !== "object") return [];
    // Rate-limit / API-error messages arrive as synthetic assistant turns.
    if (event.error || event.is_api_error_message === true) {
      const text = textOf(message.content);
      this.apiErrorSeen = true;
      this.errorMessage = text || `Claude API error (${event.error ?? "unknown"})`;
      return [{ type: "fatal", error: this.errorMessage }];
    }
    const text = textOf(message.content);
    this.mergeUsage(message.usage);
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_use") this.pushTranscript(`[tool] ${part.name ?? "?"} ${previewOf(part.input)}`);
      }
    }
    const updates: ProtocolUpdate[] = [];
    if (text) {
      this.assistantSeen = true;
      this.liveText = text;
      this.pushTranscript(text);
      updates.push({ type: "live-text", delta: text, liveText: this.liveText });
    }
    if (typeof message.model === "string" && message.model !== "<synthetic>") this.model = message.model;
    const normalized = {
      role: "assistant",
      content: Array.isArray(message.content) ? message.content : [{ type: "text", text }],
      provider: "anthropic",
      api: "claude-code",
      model: this.model ?? "claude",
      stopReason: message.stop_reason === "tool_use" ? "toolUse" : "stop",
      timestamp: Date.now(),
      usage: message.usage,
    } as unknown as Message;
    this.messages.push(normalized);
    updates.push({ type: "message", message: normalized, usage: { ...this.usage } });
    return updates;
  }

  private handleResult(event: any): ProtocolUpdate[] {
    this.resultSeen = true;
    const cost = typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd)
      ? event.total_cost_usd
      : 0;
    this.mergeUsage(event.usage);
    this.usage = {
      ...this.usage,
      cost: cost,
      turns: typeof event.num_turns === "number" && event.num_turns > 0 ? event.num_turns : this.usage.turns,
    };
    if (event.is_error === true) {
      const text = typeof event.result === "string" ? event.result : "Claude reported an error";
      this.errorMessage = text;
      // Surface the final text so paid partial work is not lost.
      if (text && !this.liveText) this.liveText = text;
      return [{ type: "fatal", error: text }];
    }
    if (typeof event.result === "string" && event.result) {
      this.liveText = event.result;
      this.assistantSeen = true;
    }
    return [{ type: "agent-end" }, { type: "agent-settled" }];
  }

  private mergeUsage(usage: any): void {
    if (!usage || typeof usage !== "object") return;
    const num = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    this.usage = {
      ...this.usage,
      input: Math.max(this.usage.input, num(usage.input_tokens)),
      output: Math.max(this.usage.output, num(usage.output_tokens)),
      cacheRead: Math.max(this.usage.cacheRead, num(usage.cache_read_input_tokens)),
      cacheWrite: Math.max(this.usage.cacheWrite, num(usage.cache_creation_input_tokens)),
      turns: Math.max(this.usage.turns, 1),
    };
  }

  private pushTranscript(line: string): void {
    this.transcriptLines.push(line);
    if (this.transcriptLines.length > TRANSCRIPT_MAX_LINES) {
      this.transcriptLines.splice(0, this.transcriptLines.length - TRANSCRIPT_MAX_LINES);
    }
    this.transcriptJoined = undefined;
  }

  getTranscript(): string | undefined {
    if (this.transcriptJoined === undefined) this.transcriptJoined = this.transcriptLines.join("\n");
    return this.transcriptJoined || undefined;
  }

  getLiveText(): string {
    return this.liveText;
  }

  getMessages(): Message[] {
    return this.messages;
  }

  finalize(exitCode: number | null, signal?: NodeJS.Signals, stderr = ""): TaskResult {
    this.flush();
    const protocol = {
      headerSeen: this.initSeen,
      assistantEndSeen: this.assistantSeen,
      agentEndSeen: this.resultSeen,
      agentSettledSeen: this.resultSeen,
      validEvents: this.validEvents,
      parseErrors: this.parseErrors,
    };
    const completeProtocol = this.initSeen && this.resultSeen;
    const failed = !!this.errorMessage || this.apiErrorSeen;
    const successfulExit = exitCode === 0 && !signal && !failed;
    const hasUsefulOutput = this.assistantSeen && this.liveText.length > 0;
    let state: TaskResult["state"];
    if (successfulExit && completeProtocol) state = "completed";
    else if (hasUsefulOutput && !failed) state = "partial";
    else state = "failed";
    const stopReason = signal
      ? "unexpected_signal"
      : failed
        ? "error"
        : exitCode !== 0
          ? "nonzero_exit"
          : !completeProtocol
            ? "protocol_error"
            : "stop";
    return {
      label: "subagent",
      task: "",
      state,
      exitCode: exitCode === 0 && state === "failed" ? 1 : exitCode,
      signal,
      messages: [...this.messages],
      stderr,
      usage: { ...this.usage },
      model: this.model ?? "claude",
      stopReason,
      errorMessage:
        this.errorMessage ||
        (signal ? `Claude subagent terminated unexpectedly by ${signal}` : undefined) ||
        (exitCode !== 0 ? `Claude subagent exited with code ${exitCode}` : undefined) ||
        (state === "partial" && !completeProtocol ? "Claude event stream truncated; partial output preserved" : undefined),
      liveText: this.liveText || undefined,
      transcript: this.getTranscript(),
      protocol,
      sessionId: this.sessionId,
    };
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

function previewOf(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

export class ClaudeBackend implements BackendAdapter {
  readonly name = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  async buildInvocation(spec: TaskSpec, _context: BackendLaunchContext): Promise<BackendInvocation> {
    const args = ["--print", "--output-format", "stream-json", "--verbose"];
    if (spec.model) args.push("--model", spec.model);
    if (spec.maxTurns !== undefined) args.push("--max-turns", String(spec.maxTurns));

    if (spec.tools !== undefined) {
      const tools = mapTools(spec.tools);
      // Claude has no "no tools at all" flag; an empty allowlist is the
      // closest honest equivalent.
      args.push("--allowedTools", ...(tools.length ? tools : ["Read"]));
    }
    if (!spec.canWrite) {
      // Belt and braces: even with a read-only allowlist, explicitly deny the
      // mutating tools in case a future default adds one back.
      args.push("--disallowedTools", "Edit", "Write", "NotebookEdit");
    }

    if (spec.resume) {
      args.push("--resume", spec.resume);
      if (spec.forkResume) args.push("--fork-session");
    }

    const cleanupDirs: string[] = [];
    const appendPrompt = [
      spec.systemPrompt?.trim(),
      spec.outputSchema ? schemaContract(spec.outputSchema) : undefined,
    ].filter(Boolean).join("\n\n");
    if (appendPrompt) args.push("--append-system-prompt", appendPrompt);
    if (spec.outputSchema) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-claude-schema-"));
      cleanupDirs.push(dir);
      const schemaPath = path.join(dir, "output-schema.json");
      await fs.writeFile(schemaPath, JSON.stringify(spec.outputSchema), { encoding: "utf8", mode: 0o600 });
      args.push("--json-schema", schemaPath);
    }

    args.push(spec.task);
    return { command: "claude", args, cleanupDirs };
  }

  createParser(): BackendParser {
    return new ClaudeParser();
  }
}
