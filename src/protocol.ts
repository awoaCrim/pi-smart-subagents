import type { Message } from "@earendil-works/pi-ai";
import type { TaskResult, ToolActivity, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";
import { addUsage, hasBilledUsage, usageFromMessage, usageFromToolResultMessage } from "./usage.js";
import { extractProviderError, mergeToolActivity } from "./model-failover.js";
import { PREFLIGHT_ACK_TYPE } from "./startup-check.js";

export type ProtocolUpdate =
  | { type: "session"; sessionId: string }
  | { type: "live-text"; delta: string; liveText: string }
  | { type: "message"; message: Message; usage: UsageStats }
  | { type: "agent-end"; willRetry?: boolean }
  | { type: "agent-settled" }
  /** RPC extension UI dialog awaiting an answer; headless children auto-cancel. */
  | { type: "ui-request"; id: string }
  /**
   * Correlated RPC command response (only when the request carried an `id`).
   * Uncorrelated prompt/parse failures keep the legacy `fatal` behaviour below, so
   * existing SDK callers that never set an `id` are unaffected.
   */
  | { type: "rpc-response"; id: string; command: string; success: boolean; data?: unknown; error?: string }
  /**
   * Bounded startup-handshake acknowledgement from the private preflight extension.
   * Kept out of `messages`, live text and usage: verification traffic is not task output.
   */
  | { type: "preflight-ack"; content: string }
  /** The child rejected the prompt; no agent events will follow. */
  | { type: "fatal"; error: string };

/** Strict-enough, line-buffered parser for Pi's documented JSON event stream. */
export class ProtocolParser {
  private buffer = "";
  private sessionId?: string;
  private messages: Message[] = [];
  private usage = emptyUsage();
  private liveText = "";
  private assistantText?: string;
  private parseErrors = 0;
  private validEvents = 0;
  private headerSeen = false;
  private assistantEndSeen = false;
  private agentEndSeen = false;
  private agentSettledSeen = false;
  private pendingRetry = false;
  private model?: string;
  private stopReason?: string;
  private errorMessage?: string;
  /**
   * Sticky current-invocation tool activity for the pre-tool switch boundary. Latches `started` on
   * tool_execution_start, a completed assistant toolCall or a toolResult; any
   * malformed/dropped protocol evidence raises an otherwise-clean `none` to
   * `unknown`. A later complete event never erases started/unknown and events
   * from resumed/forked history never reach this parser at all (only this
   * child's live event stream does), so historical tool records cannot create
   * false live activity.
   */
  private toolActivity: ToolActivity = "none";
  /** stopReason of the latest completed assistant message (settle diagnosis). */
  private lastAssistantStopReason?: string;
  /**
   * Bounded errorMessage and primitive diagnostics.error.code from the latest
   * completed assistant error, the only availability-classification input.
   * Replaced on every completed assistant message; never mixed with normal
   * content, arbitrary diagnostics or runner/RPC fallback text.
   */
  private providerError?: string;
  private transcriptLines: string[] = [];
  private transcriptBytes = 0;
  private transcriptTruncated = false;
  private transcriptJoined?: string;

  private static readonly MAX_TRANSCRIPT_BYTES = 32_768;
  /** Guard against a single unbounded JSON line exhausting parent memory. */
  private static readonly MAX_LINE_BYTES = 4 * 1024 * 1024;
  private static readonly MAX_BUFFER_BYTES = 8 * 1024 * 1024;

  /** Sticky failover-latch merge; never lowers an existing started/unknown mark. */
  private noteToolActivity(observed: ToolActivity): void {
    this.toolActivity = mergeToolActivity(this.toolActivity, observed);
  }

  /**
   * Conservative streamed assistant delta observations: a started tool call is
   * completed-call evidence, its end too; a delta without any start proves the
   * model was emitting a call and the outcome may have been lost — never a
   * conclusive `none`.
   */
  private observeAssistantDelta(deltaEvent: unknown): void {
    const event = deltaEvent as Record<string, unknown> | undefined;
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      this.noteMalformedEvidence();
      return;
    }
    if (event.type === "toolcall_start" || event.type === "toolcall_end") {
      // Compact RPC retains contentIndex for both start/end; Pi enriches
      // start with id/toolName, while end carries a nested toolCall. Accept
      // the indexed form as well as identity-bearing legacy events.
      const modern = typeof event.contentIndex === "number" && Number.isInteger(event.contentIndex) && event.contentIndex >= 0;
      const legacy = typeof event.id === "string" && !!event.id && typeof event.toolName === "string" && !!event.toolName;
      if (modern || legacy) this.noteToolActivity("started");
      else this.noteMalformedEvidence();
      return;
    }
    if (event.type === "toolcall_delta") {
      if (typeof event.contentIndex === "number" && Number.isInteger(event.contentIndex) && event.contentIndex >= 0) {
        this.noteToolActivity("unknown");
      } else {
        this.noteMalformedEvidence();
      }
    }
  }

  /** Malformed/dropped evidence: counts a parse error and blocks failover. */
  private noteMalformedEvidence(): void {
    this.parseErrors++;
    // A later complete event cannot erase the uncertainty this creates.
    this.noteToolActivity("unknown");
  }

  /** Append transcript lines incrementally; never re-flattens the full message list. */
  private appendTranscript(lines: string[]): void {
    for (const line of lines) {
      if (!line) continue;
      if (this.transcriptTruncated) return;
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (this.transcriptBytes + bytes > ProtocolParser.MAX_TRANSCRIPT_BYTES) {
        this.transcriptLines.push("[transcript truncated]");
        this.transcriptTruncated = true;
        this.transcriptJoined = undefined;
        return;
      }
      this.transcriptLines.push(line);
      this.transcriptBytes += bytes;
      this.transcriptJoined = undefined;
    }
  }

  private transcriptFromMessage(message: any): string[] {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      return (message.content as any[]).flatMap((part) => {
        if (part?.type === "text" && part.text) return [String(part.text)];
        if (part?.type === "toolCall") return [`→ ${part.name} ${JSON.stringify(part.arguments ?? {})}`];
        return [];
      });
    }
    if (message.role === "toolResult") {
      const text = Array.isArray(message.content)
        ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("")
        : "";
      return [`← ${message.toolName}${message.isError ? " [error]" : ""} ${text}`];
    }
    return [];
  }

  feed(data: Buffer | string): ProtocolUpdate[] {
    this.buffer += data.toString();
    // If a single line grows past the hard limit without a newline, drop it as a parse error.
    if (Buffer.byteLength(this.buffer, "utf8") > ProtocolParser.MAX_BUFFER_BYTES) {
      this.noteMalformedEvidence();
      this.buffer = "";
      return [];
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.parseLine(line));
  }

  /** Parse a final JSON object even when stdout omitted its trailing newline. */
  flush(): ProtocolUpdate[] {
    if (!this.buffer.trim()) return [];
    const line = this.buffer;
    this.buffer = "";
    return this.parseLine(line);
  }

  private parseLine(line: string): ProtocolUpdate[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (Buffer.byteLength(trimmed, "utf8") > ProtocolParser.MAX_LINE_BYTES) {
      this.noteMalformedEvidence();
      return [];
    }
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      this.noteMalformedEvidence();
      return [];
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      this.noteMalformedEvidence();
      return [];
    }
    this.validEvents++;

    if (event.type === "session") {
      if (typeof event.id !== "string" || !event.id) {
        this.noteMalformedEvidence();
        return [];
      }
      this.sessionId = event.id;
      this.headerSeen = true;
      return [{ type: "session", sessionId: event.id }];
    }

    // RPC-mode command responses. get_state supplies the session identity
    // (RPC mode has no print-mode session header line).
    if (event.type === "response") {
      const updates: ProtocolUpdate[] = [];
      const correlated = typeof event.id === "string" && event.id.length > 0;
      if (correlated) {
        updates.push({
          type: "rpc-response",
          id: event.id,
          command: typeof event.command === "string" ? event.command : "",
          success: event.success === true,
          data: event.data,
          error: typeof event.error === "string" ? event.error : event.error === undefined ? undefined : String(event.error),
        });
      }
      if (event.command === "get_state" && event.success && typeof event.data?.sessionId === "string" && event.data.sessionId) {
        this.sessionId = event.data.sessionId;
        this.headerSeen = true;
        updates.push({ type: "session", sessionId: this.sessionId! });
      }
      // A rejected prompt means the child will idle forever; surface it. Correlated
      // responses are owned by their requester, which can report a precise reason.
      if (!correlated && event.success === false && (event.command === "prompt" || event.command === "parse")) {
        updates.push({ type: "fatal", error: String(event.error ?? "child rejected the prompt") });
      }
      return updates;
    }

    // Extension UI dialogs block the child until answered. Headless subagents
    // cannot answer; the runner replies with a cancellation.
    if (event.type === "extension_ui_request") {
      const dialog = ["select", "confirm", "input", "editor"].includes(event.method);
      return dialog && typeof event.id === "string" ? [{ type: "ui-request", id: event.id }] : [];
    }

    // Tool execution begin is the pre-tool switch boundary. Pi emits it before tool
    // preparation (including some rejected/truncated calls); that conservative
    // start is still the no-restart line. Only shape-valid events latch
    // `started`; a malformed start event means a tool may have begun anyway, so
    // it raises `unknown`, which blocks failover just like a proven start.
    if (event.type === "tool_execution_start") {
      if (typeof event.toolCallId === "string" && event.toolCallId
        && typeof event.toolName === "string" && event.toolName) {
        this.noteToolActivity("started");
      } else {
        this.noteMalformedEvidence();
      }
      return [];
    }

    // Update/end events prove execution progressed even when the start event
    // was lost or the stream was truncated; neither may leave a `none` latch.
    if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      if (typeof event.toolCallId === "string" && event.toolCallId
        && typeof event.toolName === "string" && event.toolName) {
        this.noteToolActivity("started");
      } else {
        this.noteMalformedEvidence();
      }
      return [];
    }

    // Modern RPC message_update events are compact: {usage, assistantMessageEvent}
    // without the full message. Every message_update must carry a readable
    // assistant envelope or a typed delta event; one without either is dropped
    // evidence that could hide a tool call or the terminal error.
    if (event.type === "message_update") {
      const hasMessage = !!event.message && typeof event.message === "object" && !Array.isArray(event.message);
      const hasDeltaEvent = !!event.assistantMessageEvent && typeof event.assistantMessageEvent === "object" && !Array.isArray(event.assistantMessageEvent);
      if (!hasMessage && !hasDeltaEvent) {
        this.noteMalformedEvidence();
        return [];
      }
      if (hasDeltaEvent) this.observeAssistantDelta(event.assistantMessageEvent);
      if (!hasMessage || event.message.role !== "assistant") {
        // Compact streamed turn (no full message), or an unexpected envelope:
        // the delta observation above already recorded whatever is provable.
        return [];
      }
      // An assistant stream envelope whose content array carries unreadable
      // parts could hide a tool call: uncertain, never a conclusive none.
      if (event.message.content !== undefined
        && (!Array.isArray(event.message.content)
          || (event.message.content as unknown[]).some((part: any) => !part || typeof part !== "object" || Array.isArray(part)))) {
        this.noteMalformedEvidence();
      }
      if (Array.isArray(event.message.content) && event.message.content.some((part: any) => part?.type === "toolCall")) {
        this.noteToolActivity("started");
      }
      const delta =
        typeof (event.assistantMessageEvent as any)?.delta === "string"
          ? (event.assistantMessageEvent as any).delta
          : this.textParts(event.message).join("");
      if (!delta) return [];
      // Cap live text growth: keep the last 64KB of visible text so long runs stay bounded.
      this.liveText = (this.liveText + delta).slice(-64 * 1024);
      return [{ type: "live-text", delta, liveText: this.liveText }];
    }

    if (event.type === "message_end") {
      // A message_end without a readable message object could have carried the
      // final assistant error or a tool call; that uncertainty must not leave a
      // conclusive `none` for the failover gate.
      if (!event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
        this.noteMalformedEvidence();
        return [];
      }
      const message = event.message as Message & { customType?: unknown };
      // Startup-handshake acknowledgement: report it, but never fold verification
      // traffic into messages, transcript, live text or usage accounting.
      if (message.customType === PREFLIGHT_ACK_TYPE) {
        return [{ type: "preflight-ack", content: typeof (message as any).content === "string" ? (message as any).content : "" }];
      }
      if (typeof message.role !== "string" || !message.role) {
        // Roleless message envelope: nothing about it is trustworthy.
        this.noteMalformedEvidence();
        return [];
      }
      this.messages.push(message);
      this.appendTranscript(this.transcriptFromMessage(message));
      if (message.role === "assistant") {
        // Every new completed message needs a fresh terminal watermark, even
        // when an older host omits agent_start between task and repair turns.
        this.agentEndSeen = false;
        this.agentSettledSeen = false;
        this.assistantEndSeen = true;
        this.usage = addUsage(this.usage, usageFromMessage(message));
        this.model ||= message.model;
        this.stopReason = message.stopReason;
        this.errorMessage = message.errorMessage;
        const partsValid = Array.isArray(message.content) && (message.content as unknown[]).every((part: any) => !!part && typeof part === "object" && !Array.isArray(part));
        const validShape = partsValid && typeof message.stopReason === "string";
        this.lastAssistantStopReason = validShape ? message.stopReason : undefined;
        if (!validShape) {
          // Unreadable assistant content parts, non-array content, or a
          // missing/non-string stopReason: a tool call or terminal error could
          // be hidden in the unreadable shape, so activity becomes uncertain
          // and no error evidence is kept.
          this.noteMalformedEvidence();
          this.providerError = undefined;
        } else {
          const toolCallParts = (message.content as any[]).some((part: any) => part?.type === "toolCall");
          if (toolCallParts) {
            // A completed assistant tool call is conservative execution evidence:
            // a missing tool_execution_start/result must not authorize a restart.
            this.noteToolActivity("started");
          } else if (message.stopReason === "toolUse" || message.stopReason === "refusal") {
            // Claims turn continuation on tools without a readable tool call,
            // or a refusal shape we cannot interpret: uncertain by contract.
            this.noteMalformedEvidence();
          }
          this.providerError = message.stopReason === "error"
            ? extractProviderError(message.errorMessage, message.diagnostics)
            : undefined;
        }
        const text = this.textParts(message).join("");
        this.assistantText = text; // Empty latest messages must replace earlier failed text.
        if (text) this.liveText = text;
      } else if (message.role === "toolResult") {
        // Any completed tool result proves execution happened in this invocation.
        this.noteToolActivity("started");
        // Pi ≥ #6671: tool results may carry nested LLM usage (e.g. a
        // grandchild subagent). Fold it into the run's cumulative spend so
        // budgets and parent ledgers see true subtree cost.
        const nested = usageFromToolResultMessage(message);
        if (hasBilledUsage(nested)) this.usage = addUsage(this.usage, nested);
      }
      return [{ type: "message", message, usage: { ...this.usage } }];
    }

    if (event.type === "agent_end") {
      this.agentEndSeen = true;
      // `willRetry` must be a real boolean when present: a string "true" or any
      // other shape means the settle boundary is unreadable, which is uncertain
      // execution evidence and must block failover, never imply "no retry".
      if (event.willRetry !== undefined && typeof event.willRetry !== "boolean") {
        this.noteMalformedEvidence();
        return [];
      }
      // Pi may retry after agent_end (willRetry: true). That is NOT terminal;
      // only agent_settled marks a fully settled run.
      const willRetry = event.willRetry === true;
      this.pendingRetry = willRetry;
      return [{ type: "agent-end", willRetry }];
    }

    // A new live agent turn invalidates any earlier settle watermark: the run
    // is running again, and only a NEW agent_end-without-retry or
    // agent_settled may complete it. Without this reset, an old settle plus a
    // later provider retry could fake a complete protocol around the newest
    // terminal error.
    if (event.type === "agent_start") {
      this.agentEndSeen = false;
      this.agentSettledSeen = false;
      this.pendingRetry = false;
      return [];
    }

    if (event.type === "agent_settled") {
      this.agentSettledSeen = true;
      this.pendingRetry = false;
      return [{ type: "agent-settled" }];
    }

    // Other documented event types are valid but do not affect this projection.
    return [];
  }

  private textParts(message: any): string[] {
    if (!Array.isArray(message?.content)) return [];
    return message.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text);
  }

  finalize(exitCode: number | null, signal?: NodeJS.Signals, stderr = ""): TaskResult {
    this.flush();
    const protocol = {
      headerSeen: this.headerSeen,
      assistantEndSeen: this.assistantEndSeen,
      agentEndSeen: this.agentEndSeen,
      agentSettledSeen: this.agentSettledSeen,
      validEvents: this.validEvents,
      parseErrors: this.parseErrors,
    };
    // Prefer agent_settled as the true terminal watermark. Fall back to
    // agent_end without a pending retry for older Pi builds that never emitted
    // agent_settled (json print historically closed after agent_end).
    const settled = !this.pendingRetry && (this.agentSettledSeen || this.agentEndSeen);
    const completeProtocol = this.headerSeen && this.assistantEndSeen && settled;
    const assistantFailed = this.stopReason === "error" || this.stopReason === "aborted";
    const successfulExit = exitCode === 0 && !signal && !assistantFailed;
    // Preserve partial paid work when the process crashed (signal/nonzero) AFTER
    // producing assistant output but BEFORE a complete terminal protocol. A
    // complete protocol that still exits nonzero remains "failed".
    const hasUsefulOutput = this.assistantEndSeen && (this.liveText.length > 0 || this.usage.turns > 0);
    let state: TaskResult["state"];
    if (successfulExit && completeProtocol) {
      state = "completed";
    } else if (hasUsefulOutput && !assistantFailed && !completeProtocol) {
      state = "partial";
    } else if (hasUsefulOutput && !assistantFailed && signal) {
      // Complete protocol but killed by signal (e.g. parent shutdown): partial.
      state = "partial";
    } else {
      state = "failed";
    }
    const stopReason = signal
      ? "unexpected_signal"
      : exitCode !== 0
        ? "nonzero_exit"
        : !completeProtocol
          ? "protocol_error"
          : assistantFailed
            ? this.stopReason!
            : this.stopReason || "stop";
    return {
      label: "subagent",
      task: "",
      state,
      exitCode: exitCode === 0 && state === "failed" ? 1 : exitCode,
      signal,
      messages: [...this.messages],
      stderr,
      usage: { ...this.usage },
      model: this.model,
      stopReason,
      errorMessage:
        this.errorMessage ||
        (signal ? `Subagent terminated unexpectedly by ${signal}` : undefined) ||
        (exitCode !== 0 ? `Subagent exited with code ${exitCode}` : undefined) ||
        (state === "partial" && !completeProtocol
          ? "Protocol stream truncated; partial output preserved"
          : undefined),
      liveText: this.liveText || undefined,
      transcript: this.getTranscript(),
      toolActivity: this.toolActivity,
      providerError: this.providerError,
      protocol,
      sessionId: this.sessionId,
    };
  }

  /** Cached join; safe to call on every progress tick. */
  getTranscript(): string | undefined {
    if (this.transcriptJoined === undefined) this.transcriptJoined = this.transcriptLines.join("\n");
    return this.transcriptJoined || undefined;
  }

  getLiveText(): string {
    return this.liveText;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Sticky current-invocation tool activity observed by this parser. */
  getToolActivity(): ToolActivity {
    return this.toolActivity;
  }

  /** stopReason of the latest completed assistant message, if any. */
  getAssistantStopReason(): string | undefined {
    return this.lastAssistantStopReason;
  }

  /** Latest completed assistant text, including an explicitly empty message. */
  getAssistantText(): string | undefined {
    return this.assistantText;
  }
}
