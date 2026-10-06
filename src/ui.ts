import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RunSnapshot } from "./types.js";
import {
  displayLabel,
  identityLine,
  abbreviatedModel,
  taskDetailLines,
  markdownLines,
  formatDuration,
  formatMetricsText,
  formatModelList,
  formatState,
  formatTaskDiagnostic,
  isActiveState,
  oneLine,
  SPINNERS,
  stateGlyph,
  taskDiagnostic,
  widgetRunLines,
} from "./format.js";
import { tailSessionFile, type TailSessionStatus } from "./transcript.js";

export interface SubagentAdapter {
  getActiveRuns(): RunSnapshot[];
  getCompletedRuns(): RunSnapshot[];
  getRunById(id: string): RunSnapshot | null;
  cancelRun(id: string): void;
  dismissRun(id: string): void;
  resumeRun(id: string): Promise<void>;
  showOutput(id: string): void;
  getReadyCount(): number;
  getUsageSummary?(): string;
  subscribe?(listener: () => void): () => void;
  notify?(message: string, level?: "info" | "warn" | "error"): void;
  /** Prompt for a message and inject it into the running child. */
  steerRun?(id: string): Promise<void>;
  /** Apply a finished run's changed worktree into the main checkout. */
  applyWorktree?(id: string): Promise<void>;
  /** Confirm and discard a finished run's worktree + branch. */
  discardWorktree?(id: string): Promise<void>;
  /** Resolve child session .jsonl path for a run (for live transcript tail). */
  getSessionFilePath?(id: string): string | undefined;

}

export interface UIAction {
  type: "cancel" | "dismiss" | "resume" | "output" | "close" | "select" | "transcript" | "steer";
  id?: string;
}

/** Shared with the overlayOptions maxHeight configuration in extension.ts. */
export const SUBAGENTS_OVERLAY_MAX_HEIGHT_PERCENT = 80;

/**
 * Terse footer segment. Pi's native footer already reports session cost, so
 * this only surfaces actionable subagent state: running and ready counts.
 */
export class FooterStatusModel {
  constructor(private readonly adapter: SubagentAdapter) {}
  private running = 0;
  private ready = 0;
  private onUpdate?: () => void;
  private notified = new Set<string>();

  setOnUpdate(callback: () => void): void { this.onUpdate = callback; }
  update(running: number, ready?: number): void {
    const nextReady = ready ?? this.adapter.getReadyCount();
    if (running !== this.running || nextReady !== this.ready) {
      this.running = running;
      this.ready = nextReady;
      this.onUpdate?.();
    }
  }
  /** Empty string means "nothing actionable" — the caller should clear the status. */
  render(theme: Theme, width = 80): string {
    const ready = this.adapter.getReadyCount();
    if (!this.running && !ready) return "";
    const parts = [
      this.running ? theme.fg("warning", `⚙ ${this.running} running`) : "",
      ready ? theme.fg("success", `${ready} ready`) : "",
      theme.fg("dim", "/subagents"),
    ].filter(Boolean);
    return truncateToWidth(parts.join(theme.fg("dim", " · ")), width);
  }
  notifyTerminal(id: string, message: string, level: "info" | "warn" = "info"): void {
    if (this.notified.has(id)) return;
    this.notified.add(id);
    this.adapter.notify?.(message, level);
    this.onUpdate?.();
  }
  notifyTransition(id: string, message: string, level: "info" | "warn" = "info"): void {
    this.notifyTerminal(id, message, level);
  }
  dispose(): void { this.onUpdate = undefined; this.notified.clear(); }
}

function wrapLines(text: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(text, Math.max(10, width));
  return Array.isArray(wrapped) ? wrapped : String(wrapped).split("\n");
}

/** Aggregate turns/tokens/cost for one run; cost is included separately. */
function runAggregate(run: RunSnapshot): { turns: number; tokens: number; cost: number } {
  let turns = 0, tokens = 0, cost = 0;
  for (const result of run.results) {
    turns += result.usage?.turns ?? 0;
    tokens += (result.usage?.input ?? 0) + (result.usage?.output ?? 0);
    cost += result.usage?.cost ?? 0;
  }
  return { turns, tokens, cost };
}

/**
 * Honest duration for one run: terminal runs freeze at `endedAt`, live runs
 * tick, and a run that never recorded an end time reports no duration rather
 * than aging the render clock.
 */
function runDuration(run: RunSnapshot, now: number): { ms?: number; kind: "live" | "frozen" | "unknown" } {
  if (isActiveState(run.state)) return { ms: Math.max(0, now - run.startedAt), kind: "live" };
  if (run.endedAt !== undefined) return { ms: Math.max(0, run.endedAt - run.startedAt), kind: "frozen" };
  return { kind: "unknown" };
}

/**
 * Distinct models actually used by one run, in first-seen order. Each task
 * contributes only its own model, so a parallel run never renders a false
 * `a → b` retry chain; an explicit retry chain comes from `attemptedModels`.
 */
function runModels(run: RunSnapshot): string[] {
  const models: string[] = [];
  for (const result of run.results) {
    const own = result.model ? [result.model] : [];
    for (const model of own) if (!models.includes(model)) models.push(model);
  }
  return models;
}

function runTitle(run: RunSnapshot): string {
  if (run.results[0]?.label) return displayLabel(run.results[0].label, 'Subagent');
  const preview = run.taskPreviews[0] ?? run.summary ?? "";
  const label = preview.includes(": ") ? preview.slice(preview.indexOf(": ") + 2) : preview;
  return oneLine(label || "(no task preview)", 100);
}

export class SubagentsOverlay implements Component {
  wantsKeyRelease = false;
  private selected = 0;
  private detailId?: string;
  private scroll = 0;
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private disposed = false;
  /** Live child-session tail visible in the running-run detail view. */
  private liveTranscript = false;
  /** Auto-follow the tail unless the user has scrolled up. */
  private transcriptFollow = true;
  private transcriptLines: string[] = [];
  private transcriptStatus: TailSessionStatus | "unset" = "unset";
  private transcriptPoll?: NodeJS.Timeout;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly adapter: SubagentAdapter,
  ) {
    this.unsubscribe = this.adapter.subscribe?.(() => {
      if (this.disposed) return;
      this.syncAnimation();
      this.invalidate();
      this.tui.requestRender();
    });
    this.syncAnimation();
  }

  private runs(): RunSnapshot[] {
    return [...this.adapter.getActiveRuns(), ...this.adapter.getCompletedRuns()];
  }

  private syncAnimation(): void {
    const running = this.adapter.getActiveRuns().length > 0;
    if (running && !this.timer && !this.disposed) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNERS.length;
        this.invalidate();
        this.tui.requestRender();
        if (this.adapter.getActiveRuns().length === 0) this.stopAnimation();
      }, 100);
      this.timer.unref?.();
    } else if (!running) {
      this.stopAnimation();
    }
  }

  private stopAnimation(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private stopTranscriptPoll(): void {
    if (this.transcriptPoll) clearInterval(this.transcriptPoll);
    this.transcriptPoll = undefined;
  }

  private exitLiveTranscript(): void {
    this.liveTranscript = false;
    this.transcriptFollow = true;
    this.transcriptLines = [];
    this.transcriptStatus = "unset";
    this.stopTranscriptPoll();
  }

  private refreshTranscript(): void {
    if (this.disposed || !this.liveTranscript || !this.detailId) return;
    const run = this.adapter.getRunById(this.detailId);
    if (!run || !isActiveState(run.state)) {
      // Finished/gone: drop live mode so the normal checkpointed detail shows.
      this.exitLiveTranscript();
      return;
    }
    const path = this.adapter.getSessionFilePath?.(run.id);
    if (!path) {
      this.transcriptStatus = "missing";
      this.transcriptLines = [];
      return;
    }
    const result = tailSessionFile(path);
    this.transcriptStatus = result.status;
    this.transcriptLines = result.lines;
  }

  private syncTranscriptPoll(): void {
    const want =
      !this.disposed &&
      this.liveTranscript &&
      !!this.detailId &&
      (() => {
        const run = this.adapter.getRunById(this.detailId!);
        return !!run && isActiveState(run.state);
      })();
    if (!want) {
      this.stopTranscriptPoll();
      return;
    }
    if (this.transcriptPoll) return;
    this.refreshTranscript();
    this.transcriptPoll = setInterval(() => {
      if (this.disposed) {
        this.stopTranscriptPoll();
        return;
      }
      this.refreshTranscript();
      if (this.liveTranscript && this.transcriptFollow) {
        // Keep the viewport glued to the newest lines while following.
        this.scroll = Number.MAX_SAFE_INTEGER;
      }
      if (!this.liveTranscript) {
        this.stopTranscriptPoll();
        return;
      }
      this.invalidate();
      this.tui.requestRender();
    }, 500);
    this.transcriptPoll.unref?.();
  }

  private handleAction(data: string, run: RunSnapshot | null): void {
    if (!run) return;
    if (data === "c" && isActiveState(run.state)) this.adapter.cancelRun(run.id);
    if (data === "s" && isActiveState(run.state)) void this.adapter.steerRun?.(run.id);
    if (data === "d") this.adapter.dismissRun(run.id);
    if (data === "r") void this.adapter.resumeRun(run.id);
    if (data === "o") this.adapter.showOutput(run.id);
    const hasWorktree = run.results.some((result) => result.worktree?.changed);
    if (data === "a" && !isActiveState(run.state) && hasWorktree) void this.adapter.applyWorktree?.(run.id);
    if (data === "x" && !isActiveState(run.state) && hasWorktree) void this.adapter.discardWorktree?.(run.id);
  }

  handleInput(data: string): void {
    const runs = this.runs();
    if (this.detailId) {
      const detailRun = this.adapter.getRunById(this.detailId);
      if (matchesKey(data, "escape") || matchesKey(data, "backspace") || data === "b") {
        this.exitLiveTranscript();
        this.detailId = undefined;
        this.scroll = 0;
      } else if (data === "t" && detailRun && isActiveState(detailRun.state)) {
        this.liveTranscript = !this.liveTranscript;
        this.transcriptFollow = true;
        this.scroll = 0;
        if (!this.liveTranscript) {
          this.exitLiveTranscript();
        } else {
          this.syncTranscriptPoll();
        }
      } else if (matchesKey(data, "down") || data === "j") {
        this.scroll++;
      } else if (matchesKey(data, "up") || data === "k") {
        this.scroll = Math.max(0, this.scroll - 1);
        if (this.liveTranscript) this.transcriptFollow = false;
      } else if (matchesKey(data, "pageDown")) {
        this.scroll += 10;
      } else if (matchesKey(data, "pageUp")) {
        this.scroll = Math.max(0, this.scroll - 10);
        if (this.liveTranscript) this.transcriptFollow = false;
      } else {
        // Steering (and other actions) remain available from the live transcript pane.
        this.handleAction(data, detailRun);
      }
    } else if (matchesKey(data, "escape") || data === "q") {
      this.close();
      return;
    } else if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(Math.max(0, runs.length - 1), this.selected + 1);
    } else if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "enter") && runs[this.selected]) {
      this.exitLiveTranscript();
      this.detailId = runs[this.selected]!.id;
      this.scroll = 0;
    } else {
      this.handleAction(data, runs[this.selected] ?? null);
    }
    this.syncAnimation();
    this.syncTranscriptPoll();
    this.invalidate();
    this.tui.requestRender();
  }




  private header(width: number): string[] {
    const theme = this.theme;
    const active = this.adapter.getActiveRuns().length;
    const ready = this.adapter.getReadyCount();
    const counters = [
      active ? theme.fg("warning", `${active} running`) : "",
      ready ? theme.fg("success", `${ready} ready`) : "",
    ].filter(Boolean).join(theme.fg("dim", " · "));
    const title = theme.bold(theme.fg("accent", " Subagents"));
    const lines = [truncateToWidth(counters ? `${title}  ${counters}` : title, width)];
    const usage = this.adapter.getUsageSummary?.();
    if (usage) lines.push(truncateToWidth(theme.fg("muted", ` ${usage}`), width));
    lines.push(theme.fg("dim", "─".repeat(Math.max(0, width))));
    return lines;
  }

  private listLines(width: number, headerRows: number): string[] {
    const theme = this.theme;
    const runs = this.runs();
    const lines: string[] = [];
    if (!runs.length) {
      lines.push(theme.fg("muted", " No subagent runs in this branch."));
      lines.push("");
      lines.push(theme.fg("dim", " esc close"));
      return lines;
    }
    this.selected = Math.min(this.selected, runs.length - 1);
    const now = Date.now();
    // Bound the list viewport so a long session cannot push the selection out
    // of reach; the selected row is always inside the visible slice.
    const available = Math.max(1, this.maxOverlayRows() - headerRows);
    const rowHeight = available >= 6 ? 3 : 1;
    const pageSize = Math.max(1, Math.floor((available - 3) / rowHeight));
    const first = Math.max(0, Math.min(this.selected - pageSize + 1, Math.max(0, runs.length - pageSize)));
    const visible = runs.slice(first, first + pageSize);
    if (first > 0 && available >= 5) lines.push(theme.fg("dim", ` ↑ +${first} more`));
    visible.forEach((run, offset) => {
      const index = first + offset;
      const isSelected = index === this.selected;
      const cursor = isSelected ? theme.fg("accent", "▶") : " ";
      const glyph = stateGlyph(run.state, theme, this.frame);
      // Field order matches every other surface: id, state, task, then the
      // optional metrics row. At narrow widths the metrics row is dropped
      // before the state or id.
      const stateText = run.delivered ? formatState(run.state) : isActiveState(run.state) ? formatState(run.state) : `${formatState(run.state)} · ready`;
      const stateTone = ["failed", "lost"].includes(run.state) ? "error" : isActiveState(run.state) ? "warning" : run.delivered ? "muted" : "success";
      const title = runTitle(run);
      if (rowHeight === 1) {
        lines.push(truncateToWidth(`${cursor} ${glyph} ${stateText} [${run.id.slice(0, 8)}] ${title}`, width));
        return;
      }
      lines.push(`${cursor} ${identityLine(title, run.id, theme, Math.max(1, width - 2))}`);
      const duration = runDuration(run, now);
      lines.push(truncateToWidth(`  ${glyph} ${theme.fg(stateTone, stateText)}${duration.ms === undefined ? '' : ` · ${formatDuration(duration.ms)}`}`, width));
      const bits = [
        run.mode === "parallel" ? `${run.results.length} tasks` : "",
        formatModelList(runModels(run).map((model) => abbreviatedModel(model)!), 2),
        ...(() => {
          const agg = runAggregate(run);
          const text = formatMetricsText({ turns: agg.turns, tokens: agg.tokens, cost: agg.cost });
          return text ? [text] : [];
        })(),
      ].filter(Boolean);
      lines.push(truncateToWidth(theme.fg("dim", `     ${bits.join(" · ")}`), width));
    });
    const hidden = runs.length - (first + visible.length);
    if (hidden > 0 && lines.length < available - 1) lines.push(theme.fg("dim", ` ↓ +${hidden} more (↑↓ to scroll)`));
    lines.push(truncateToWidth(theme.fg("dim", " ↑↓ select · enter details · c cancel · s steer · o output · r resume · a apply · x discard · d dismiss · esc close"), width));
    return lines;
  }

  private maxOverlayRows(): number {
    const rows = this.tui.terminal?.rows;
    // Real Pi TUI instances expose terminal.rows. Keep a bounded fallback for
    // reduced/headless hosts that only provide the Component surface.
    return Number.isFinite(rows) && rows > 0
      ? Math.max(1, Math.floor(rows * SUBAGENTS_OVERLAY_MAX_HEIGHT_PERCENT / 100))
      : 24;
  }

  private detailPageSize(headerRows: number): number {
    // Reserve pagination, the blank separator, and the help line even when
    // pagination is not currently needed; otherwise the marker can overflow
    // the configured overlay height on the next render.
    const reservedRows = 3;
    return Math.max(1, this.maxOverlayRows() - headerRows - reservedRows);
  }

  private detailLines(width: number, headerRows: number): string[] {
    const theme = this.theme;
    const run = this.detailId ? this.adapter.getRunById(this.detailId) : null;
    if (!run) return [theme.fg("error", " Run no longer exists"), "", theme.fg("dim", " esc back")];
    const now = Date.now();
    const body: string[] = [];

    // Same field order as every other surface: identity, explicit state with a
    // truthful duration, then the secondary labelled metrics.
    const glyph = stateGlyph(run.state, theme, this.frame);
    const duration = runDuration(run, now);
    const agg = runAggregate(run);
    body.push(identityLine(runTitle(run), run.id, theme, width));
    body.push(...wrapLines(`run: ${run.id}`, width));
    body.push(theme.fg("dim", `${run.mode} · ${formatState(run.state)}${duration.ms !== undefined ? ` · ${formatDuration(duration.ms)}` : ""} · ${run.delivered ? "delivered" : "ready"}`));
    const metrics = formatMetricsText({ turns: agg.turns, tokens: agg.tokens, cost: agg.cost });
    if (metrics) body.push(theme.fg("dim", metrics));
    // Full model identifiers are emitted once per task below.

    if (this.liveTranscript && isActiveState(run.state)) {
      body.push("");
      const followTag = this.transcriptFollow ? "live · follow" : "live · paused";
      body.push(theme.fg("accent", ` Transcript (${followTag})`));
      body.push(theme.fg("dim", "─".repeat(Math.max(0, width - 1))));
      if (this.transcriptStatus === "missing" || this.transcriptStatus === "unset") {
        body.push(theme.fg("muted", " waiting for child session…"));
      } else if (this.transcriptStatus === "empty" || !this.transcriptLines.length) {
        body.push(theme.fg("muted", " (no messages yet)"));
      } else {
        for (const line of this.transcriptLines) {
          for (const wrapped of wrapLines(line, width - 2)) {
            body.push(` ${theme.fg("toolOutput", wrapped)}`);
          }
        }
      }
    } else {
      if (run.summary) {
        body.push("");
        for (const line of wrapLines(run.summary, width - 2)) body.push(theme.fg("text", line));
      }

      run.results.forEach((result, index) => {
        body.push("");
        const rGlyph = stateGlyph(result.state, theme, this.frame);
        const label = theme.bold(theme.fg("toolTitle", displayLabel(result.label, `task-${index + 1}`)));
        const caps = [
          // Full provider/model id stays available in detail (never duplicated
          // in the compact row).
          result.profile ? `${result.profile}/${result.canWrite ? "RW" : "RO"}` : "",
          result.effectiveThinking && result.effectiveThinking !== result.thinking
            ? `thinking:${result.thinking ?? "default"}→${result.effectiveThinking}`
            : result.effectiveThinking
              ? `thinking:${result.effectiveThinking}`
              : result.thinking
                ? `thinking:${result.thinking}`
                : "",
        ].filter(Boolean).join(" · ");
        body.push(truncateToWidth(`${rGlyph} ${label} · ${formatState(result.state)}`, width));
        if (caps) body.push(...wrapLines(caps, width).map((line) => theme.fg('dim', line)));
        body.push(...taskDetailLines({ ...result, label: undefined }, theme, width));
        const diagnostic = taskDiagnostic(result);
        const diagnosticText = formatTaskDiagnostic(result);
        if (diagnostic && diagnosticText && diagnostic.kind !== "summary") {
          for (const line of wrapLines(diagnosticText, width - 2)) body.push(`  ${theme.fg(diagnostic.tone, line)}`);
        }

        const text = result.transcript || result.finalOutput;
        if (text) {
          const rendered = result.transcript ? wrapLines(text, width - 2) : markdownLines(text, theme, Math.max(1, width - 2));
          for (const line of rendered) body.push(`  ${theme.fg("toolOutput", line)}`);
        } else if (!diagnostic || diagnostic.kind === "summary") {
          body.push(theme.fg("dim", "  (no output)"));
        }
      });
    }

    const pageSize = this.detailPageSize(headerRows);
    const maxScroll = Math.max(0, body.length - pageSize);
    if (this.liveTranscript && this.transcriptFollow) {
      this.scroll = maxScroll;
    } else {
      this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
      // Reaching the end re-enables auto-follow for live tails.
      if (this.liveTranscript && this.scroll >= maxScroll) this.transcriptFollow = true;
    }
    const visible = body.slice(this.scroll, this.scroll + pageSize);
    const lines = visible.map((line) => truncateToWidth(line, width));
    if (body.length > pageSize) {
      lines.push(theme.fg("dim", ` ${this.scroll + visible.length}/${body.length} lines`));
    }
    lines.push("");
    const liveHelp = isActiveState(run.state)
      ? (this.liveTranscript
        ? " ↑↓ scroll · t hide transcript · esc back · c cancel · s steer · o output"
        : " ↑↓ scroll · t transcript · esc back · c cancel · s steer · r resume · o output · a apply · x discard · d dismiss")
      : " ↑↓ scroll · esc back · c cancel · s steer · r resume · o output · a apply · x discard · d dismiss";
    lines.push(truncateToWidth(theme.fg("dim", liveHelp), width));
    return lines;
  }

  render(width: number): string[] {
    this.syncAnimation();
    this.syncTranscriptPoll();
    const maxRows = this.maxOverlayRows();
    const header = this.header(width).slice(0, Math.max(0, maxRows - 4));
    const lines = [...header];
    lines.push(...(this.detailId ? this.detailLines(width, header.length) : this.listLines(width, header.length)));
    return lines.slice(0, maxRows).map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  invalidate(): void {
    // Stateless rendering; method required by Component.
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    this.disposed = true;
    this.stopAnimation();
    this.stopTranscriptPoll();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

export function createSubagentsOverlay(tui: TUI, theme: Theme, adapter: SubagentAdapter, done: () => void): SubagentsOverlay {
  return new SubagentsOverlay(tui, theme, done, adapter);
}

/** Small pure model retained for regression tests. */
export class SubagentsUIModel {
  state = {
    listMode: true,
    selectedIndex: 0,
    scrollOffset: 0,
    expanded: false,
    detailId: undefined as string | undefined,
    /** Live transcript pane on a running run's detail view. */
    liveTranscript: false,
    /** Auto-follow newest lines unless the user scrolls up. */
    transcriptFollow: true,
  };
  constructor(private readonly adapter: SubagentAdapter) {}
  get runs(): RunSnapshot[] { return [...this.adapter.getActiveRuns(), ...this.adapter.getCompletedRuns()]; }
  select(index: number): void { this.state.selectedIndex = Math.max(0, Math.min(index, Math.max(0, this.runs.length - 1))); }
  toggleExpanded(): void { this.state.expanded = !this.state.expanded; }
  drillDown(): void {
    const run = this.runs[this.state.selectedIndex];
    if (run) {
      this.state.listMode = false;
      this.state.detailId = run.id;
      this.state.liveTranscript = false;
      this.state.transcriptFollow = true;
      this.state.scrollOffset = 0;
    }
  }
  goBack(): void {
    this.state.listMode = true;
    this.state.detailId = undefined;
    this.state.liveTranscript = false;
    this.state.transcriptFollow = true;
    this.state.scrollOffset = 0;
  }
  /** Toggle live transcript for the active detail run when it is still running. */
  toggleLiveTranscript(): boolean {
    if (this.state.listMode || !this.state.detailId) return false;
    const run = this.adapter.getRunById(this.state.detailId);
    if (!run || !isActiveState(run.state)) return false;
    this.state.liveTranscript = !this.state.liveTranscript;
    this.state.transcriptFollow = true;
    this.state.scrollOffset = 0;
    return true;
  }
  scrollUp(amount = 1): void {
    this.state.scrollOffset = Math.max(0, this.state.scrollOffset - amount);
    if (this.state.liveTranscript) this.state.transcriptFollow = false;
  }
  scrollDown(amount = 1): void {
    this.state.scrollOffset += amount;
    // Down toward the end does not pause follow; up does.
  }
  simulateKey(key: string): UIAction | null {
    if (key === "Escape") return { type: "close" };
    if (key === "Enter") { this.drillDown(); return { type: "select", id: this.state.detailId }; }
    if (key === "t") {
      if (this.toggleLiveTranscript()) return { type: "transcript", id: this.state.detailId };
      return null;
    }
    if (key === "c") return { type: "cancel", id: this.runs[this.state.selectedIndex]?.id };
    if (key === "s" && this.state.detailId) return { type: "steer", id: this.state.detailId };
    return null;
  }
  isRunning(): boolean { return this.runs.some((run) => isActiveState(run.state)); }
}

/**
 * Width-aware ambient widget for background runs.
 *
 * The host requires a `Component` factory for real TUI mode; RPC mode forwards
 * only `string[]` and ignores factories, so `extension.ts` picks the
 * appropriate install path. The widget renders through the shared dense rows
 * (`widgetRunLines`) and owns a single animation interval that stops itself
 * when nothing is live and is always cleared by the host's `dispose()` call.
 */
export interface WidgetRowSource {
  /** Current live background runs, already filtered by the caller. */
  getRuns(): RunSnapshot[];
  /** Resolve theme replacements without reinstalling the widget. */
  getTheme?(): Theme;
  /** Optional registry subscription for immediate repaints. */
  subscribe?(listener: () => void): () => void;
}

export class SubagentWidget implements Component {
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private unsubscribe?: () => void;
  private tui?: TUI;
  private theme?: Theme;

  constructor(private readonly source: WidgetRowSource, theme?: Theme) {
    this.theme = theme;
  }

  /** Bind the host's live collaborators; safe to call again on install. */
  attach(tui: TUI, theme: Theme): Component & { dispose?(): void } {
    if (this.disposed) return this;
    this.tui = tui;
    this.theme = theme;
    if (!this.unsubscribe) {
      this.unsubscribe = this.source.subscribe?.(() => {
        if (this.disposed) return;
        this.syncAnimation();
        this.tui?.requestRender();
      });
    }
    this.syncAnimation();
    return this;
  }

  private liveRuns(): RunSnapshot[] {
    return this.source.getRuns();
  }

  private syncAnimation(): void {
    const running = this.liveRuns().length > 0;
    if (running && !this.timer && !this.disposed) {
      this.timer = setInterval(() => {
        if (this.disposed) {
          this.stopAnimation();
          return;
        }
        this.frame = (this.frame + 1) % SPINNERS.length;
        this.tui?.requestRender();
        if (this.liveRuns().length === 0) this.stopAnimation();
      }, 250);
      this.timer.unref?.();
    } else if (!running) {
      this.stopAnimation();
    }
  }

  private stopAnimation(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const theme = this.source.getTheme?.() ?? this.theme;
    if (!theme) return [];
    const runs = this.liveRuns().map((run) => ({
      id: run.id,
      state: run.state,
      startedAt: run.startedAt,
      mode: run.mode,
      results: run.results,
    }));
    if (!runs.length) return [];
    return widgetRunLines(runs, {
      theme,
      width: Math.max(1, width),
      now: Date.now(),
      spinnerFrame: this.frame,
    });
  }

  invalidate(): void {
    // Rendering derives from the adapter on every pass; nothing to cache.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAnimation();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.tui = undefined;
  }
}
