/**
 * Codex backend — spawns `codex exec --json` and translates its JSONL event
 * stream into our normalized `ProtocolUpdate` shape.
 *
 * Event vocabulary (captured from codex-cli 0.144.6, `codex exec --json`):
 *
 *   {"type":"thread.started","thread_id":"019f96…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution",…}}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
 *   {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…,
 *                                    "cached_input_tokens":…,"reasoning_output_tokens":…}}
 *
 * Notable capability facts, verified against the real CLI rather than assumed:
 *
 * - **No cost reporting.** `turn.completed.usage` carries token counts but no
 *   dollar figure, and Codex bills against the user's own plan. So
 *   `costReporting: false` and `max_cost` is refused rather than ignored.
 * - **Read-only IS enforceable**, via `--sandbox read-only` — a real OS-level
 *   sandbox, arguably stronger than our tool allowlist. So explore/review
 *   profiles map cleanly and `toolRestriction` is true.
 * - **No mid-run steering.** `codex exec` is one-shot; there is no stdin
 *   command channel. Steering and graceful budget wrap-up are therefore
 *   unsupported: a budget breach hard-stops instead of asking for a summary.
 * - **Native structured output** via `--output-schema <file>`.
 * - **Resume** exists (`codex exec resume`), but not session *forking*.
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
import type { TaskResult, UsageStats } from "../types.js";
import { emptyUsage } from "../types.js";
import type { TaskSpec } from "../types.js";
import { schemaContract } from "../structured.js";

const CODEX_CAPABILITIES: BackendCapabilities = {
  steer: false,
  gracefulWrapUp: false,
  // Token counts only; no dollar cost, and billing runs through the user's plan.
  costReporting: false,
  resume: true,
  fork: false,
  // `--sandbox read-only` is a real OS sandbox, not an honor-system allowlist.
  toolRestriction: true,
  thinking: false,
  outputSchema: true,
};

const TRANSCRIPT_MAX_LINES = 2000;

/** Translates Codex's JSONL events into our normalized update stream. */
export class CodexParser implements BackendParser {
  private buffer = "";
  private threadId?: string;
  private messages: Message[] = [];
  private usage: UsageStats = emptyUsage();
  private liveText = "";
  private lastAssistantText = "";
  private transcriptLines: string[] = [];
  private transcriptJoined?: string;
  private parseErrors = 0;
  private validEvents = 0;
  private threadStarted = false;
  private turnCompleted = false;
  private assistantSeen = false;
  private errorMessage?: string;

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
    if (!trimmed) return [];
    // Codex writes tracing/ERROR lines to stdout in some builds; skip non-JSON
    // rather than counting it as a protocol violation.
    if (!trimmed.startsWith("{")) return [];
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      this.parseErrors++;
      return [];
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      this.parseErrors++;
      return [];
    }
    this.validEvents++;

    switch (event.type) {
      case "thread.started": {
        this.threadStarted = true;
        if (typeof event.thread_id === "string" && event.thread_id) {
          this.threadId = event.thread_id;
          return [{ type: "session", sessionId: event.thread_id }];
        }
        return [];
      }
      case "turn.started":
        return [];
      case "item.started":
        return this.handleItem(event.item, false);
      case "item.completed":
        return this.handleItem(event.item, true);
      case "turn.completed": {
        this.turnCompleted = true;
        this.applyUsage(event.usage);
        const updates: ProtocolUpdate[] = [];
        // Materialize the final assistant text as a message so downstream
        // usage folding and output extraction behave like the pi backend.
        if (this.lastAssistantText) {
          const message = this.assistantMessage(this.lastAssistantText);
          this.messages.push(message);
          updates.push({ type: "message", message, usage: { ...this.usage } });
        }
        updates.push({ type: "agent-end" }, { type: "agent-settled" });
        return updates;
      }
      case "turn.failed":
      case "error": {
        const message = typeof event.message === "string" ? event.message
          : typeof event.error === "string" ? event.error
          : "Codex reported a failure";
        this.errorMessage = message;
        return [{ type: "fatal", error: message }];
      }
      default:
        return [];
    }
  }

  private handleItem(item: any, completed: boolean): ProtocolUpdate[] {
    if (!item || typeof item !== "object" || typeof item.type !== "string") return [];
    if (item.type === "agent_message") {
      const text = typeof item.text === "string" ? item.text : "";
      if (!text) return [];
      this.assistantSeen = true;
      if (completed) {
        this.lastAssistantText = text;
        this.liveText = text;
        this.pushTranscript(text);
        return [{ type: "live-text", delta: text, liveText: this.liveText }];
      }
      return [];
    }
    if (item.type === "command_execution" && completed) {
      const command = typeof item.command === "string" ? item.command : "";
      const exit = item.exit_code === null || item.exit_code === undefined ? "?" : String(item.exit_code);
      if (command) this.pushTranscript(`$ ${command} (exit ${exit})`);
      return [];
    }
    if (item.type === "reasoning" && completed) {
      const text = typeof item.text === "string" ? item.text : "";
      if (text) this.pushTranscript(`[reasoning] ${text}`);
      return [];
    }
    return [];
  }

  private applyUsage(usage: any): void {
    if (!usage || typeof usage !== "object") return;
    const num = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    // Codex reports cumulative per-turn token counts and no cost. Leaving cost
    // at zero is deliberate and matches capabilities.costReporting === false.
    this.usage = {
      ...this.usage,
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cached_input_tokens),
      reasoning: num(usage.reasoning_output_tokens),
      turns: this.usage.turns + 1,
    };
  }

  private assistantMessage(text: string): Message {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      provider: "codex",
      api: "codex-exec",
      model: "codex",
      stopReason: "stop",
      timestamp: Date.now(),
    } as unknown as Message;
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
      headerSeen: this.threadStarted,
      assistantEndSeen: this.assistantSeen,
      agentEndSeen: this.turnCompleted,
      agentSettledSeen: this.turnCompleted,
      validEvents: this.validEvents,
      parseErrors: this.parseErrors,
    };
    const completeProtocol = this.threadStarted && this.turnCompleted;
    const successfulExit = exitCode === 0 && !signal && !this.errorMessage;
    const hasUsefulOutput = this.assistantSeen && (this.liveText.length > 0 || this.usage.turns > 0);
    let state: TaskResult["state"];
    if (successfulExit && completeProtocol) state = "completed";
    else if (hasUsefulOutput && !this.errorMessage) state = "partial";
    else state = "failed";
    const stopReason = signal
      ? "unexpected_signal"
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
      model: "codex",
      stopReason,
      errorMessage:
        this.errorMessage ||
        (signal ? `Codex subagent terminated unexpectedly by ${signal}` : undefined) ||
        (exitCode !== 0 ? `Codex subagent exited with code ${exitCode}` : undefined) ||
        (state === "partial" && !completeProtocol ? "Codex event stream truncated; partial output preserved" : undefined),
      liveText: this.liveText || undefined,
      transcript: this.getTranscript(),
      protocol,
      sessionId: this.threadId,
    };
  }
}

export class CodexBackend implements BackendAdapter {
  readonly name = "codex" as const;
  readonly capabilities = CODEX_CAPABILITIES;

  async buildInvocation(spec: TaskSpec, _context: BackendLaunchContext): Promise<BackendInvocation> {
    const args = ["exec", "--json", "--skip-git-repo-check"];
    // Map our profile onto Codex's real OS sandbox. canWrite is already the
    // resolved outcome of profile + tool policy, so it is the honest input.
    args.push("--sandbox", spec.canWrite ? "workspace-write" : "read-only");
    if (spec.model) args.push("--model", spec.model);

    const cleanupDirs: string[] = [];
    if (spec.outputSchema) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-codex-schema-"));
      cleanupDirs.push(dir);
      const schemaPath = path.join(dir, "output-schema.json");
      await fs.writeFile(schemaPath, JSON.stringify(spec.outputSchema), { encoding: "utf8", mode: 0o600 });
      args.push("--output-schema", schemaPath);
    }

    // Codex has no --append-system-prompt; fold persona + schema contract into
    // the prompt itself so the same contract text still reaches the model.
    const preamble = [
      spec.systemPrompt?.trim(),
      spec.outputSchema ? schemaContract(spec.outputSchema) : undefined,
    ].filter(Boolean).join("\n\n");
    const prompt = preamble ? `${preamble}\n\n---\n\n${spec.task}` : spec.task;

    if (spec.resume) {
      // `codex exec resume <id>` takes the prompt after the id.
      args.splice(1, 0, "resume");
      args.push(spec.resume);
    }
    args.push(prompt);

    return { command: "codex", args, cleanupDirs };
  }

  createParser(): BackendParser {
    return new CodexParser();
  }

  // No stdin command channel: steering/stop/ui-cancel are intentionally absent
  // so `checkCapabilities` refuses features that would silently no-op.
}
