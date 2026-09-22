import { Buffer } from "node:buffer";
import type { SubagentConfig } from "./config.js";
import { earlierAttemptOutputNote } from "./model-failover.js";
import type { OutputMode, RunSnapshot, TaskResult } from "./types.js";

export interface CappedDelivery {
  text: string;
  cappedResults: Array<Record<string, unknown>>;
  totalBytes: number;
  totalLines: number;
}

function finalAssistantText(messages: any[], latestOnly = false): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    if (!Array.isArray(message.content)) { if (latestOnly) return undefined; continue; }
    const text = message.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");
    if (text || latestOnly) return text || undefined;
  }
  return undefined;
}

/** Truncate a string to UTF-8 bytes without splitting a code point. */
function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function enforceBudget(value: string, maxBytes: number, maxLines: number, marker: string): string {
  const safeLines = Math.max(1, maxLines);
  let text = value.split("\n").slice(0, safeLines).join("\n");
  const wasLineCapped = value.split("\n").length > safeLines;
  const wasByteCapped = Buffer.byteLength(text, "utf8") > maxBytes;
  if (!wasLineCapped && !wasByteCapped) return text;

  const markerLines = marker.split("\n").length;
  const contentLineBudget = Math.max(0, safeLines - markerLines);
  text = text.split("\n").slice(0, contentLineBudget).join("\n");
  const separator = text ? "\n" : "";
  const reserved = Buffer.byteLength(separator + marker, "utf8");
  text = utf8Prefix(text, Math.max(0, maxBytes - reserved));
  return `${text}${text ? separator : ""}${marker}`;
}

export class OutputManager {
  constructor(private readonly config: SubagentConfig) {}

  makeStatusPreview(run: RunSnapshot, maxBytes = 200): string {
    const base = `${run.id} [${run.state}] ${run.mode} (${run.results.length} tasks)`;
    return utf8Prefix(base, maxBytes);
  }

  capOutputForDelivery(
    results: TaskResult[] | RunSnapshot["results"],
    isMultiWait = false,
    requestedOutputMode?: OutputMode,
  ): CappedDelivery {
    const count = Math.max(1, results.length);
    const sections: string[] = [];
    const cappedResults: Array<Record<string, unknown>> = [];
    const separator = "\n\n---\n\n";
    const headerBytes = isMultiWait
      ? results.reduce((sum, _, i) => sum + Buffer.byteLength(`## Run section ${i + 1}\n\n`, "utf8"), 0)
      : 0;
    const separatorBytes = Math.max(0, count - 1) * Buffer.byteLength(separator, "utf8");
    const separatorLines = Math.max(0, count - 1) * 4;
    const availableBytes = Math.max(0, this.config.maxResultBytes - headerBytes - separatorBytes);
    const availableLines = Math.max(1, this.config.maxResultLines - separatorLines - (isMultiWait ? count * 2 : 0));
    const perBytes = Math.max(1, Math.floor(availableBytes / count));
    const perLines = Math.max(1, Math.floor(availableLines / count));

    results.forEach((result: any, index) => {
      const mode = requestedOutputMode ?? result.outputMode;
      let raw: string;
      if (mode === "file-only") {
        raw = result.outputFile
          ? `Output written to ${result.outputFile}${result.sessionId ? `\nSession: ${result.sessionId}` : ""}`
          : result.errorMessage || "file-only output requested, but no artifact was produced";
      } else if (result.structuredOutput !== undefined) {
        // Validated structured result: deliver the machine-readable JSON, not
        // the narrative preamble around the fenced block.
        raw = JSON.stringify(result.structuredOutput, null, 2);
      } else {
        const primary = result.finalOutput || finalAssistantText(result.messages || [], !!result.routing?.rankedModels) || result.liveText;
        raw = primary || result.errorMessage || result.stderr || "(no output)";
        const earlier = !primary ? earlierAttemptOutputNote(result) : undefined;
        if (earlier) raw += `\n\n${earlier}`;
      }
      const artifact = result.outputFile ? ` Full output: ${result.outputFile}` : " Full output is in the child session transcript.";
      const marker = `[Truncated.${artifact}]`;
      const section = enforceBudget(raw, perBytes, perLines, marker);
      const prefix = isMultiWait ? `## Run section ${index + 1}\n\n` : "";
      sections.push(prefix + section);
      cappedResults.push({
        ...result,
        finalOutput: section,
        capped: section !== raw,
        bytes: Buffer.byteLength(section, "utf8"),
      });
    });

    let text = sections.join(separator);
    // Defensive final enforcement includes the global marker inside both limits.
    text = enforceBudget(
      text,
      this.config.maxResultBytes,
      this.config.maxResultLines,
      "[Global output cap reached. Full output remains in artifacts or child sessions.]",
    ).trim();
    return {
      text,
      cappedResults,
      totalBytes: Buffer.byteLength(text, "utf8"),
      totalLines: text ? text.split("\n").length : 0,
    };
  }

  testUnicodeBytes(value: string): { bytes: number; lines: number } {
    return { bytes: Buffer.byteLength(value, "utf8"), lines: value.split("\n").length };
  }
}
