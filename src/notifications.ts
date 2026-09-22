/**
 * Background-run completion notifications.
 *
 * When an async run reaches a terminal state, the parent LLM is notified with
 * a steer message (queued for delivery before the next LLM call) so it can
 * react without polling status/wait. Matches the notification-as-delivery
 * semantics of `wait`: whichever path delivers first wins via markDelivered.
 *
 * Batching: successes completing within a short window group into a single
 * message (no notification spam in fanouts). Failures bypass batching and
 * flush immediately, carrying any held successes with them.
 */

export interface CompletionBatcherOptions {
  /** Quiet window after the most recent completion before flushing. */
  debounceMs?: number;
  /** Hard cap measured from the first held completion; nothing waits longer. */
  maxWaitMs?: number;
}

export class CompletionBatcher {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private pending: string[] = [];
  private timer?: NodeJS.Timeout;
  private firstHeldAt?: number;
  private disposed = false;

  constructor(
    private readonly onFlush: (runIds: string[]) => void,
    options: CompletionBatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 2_000;
    this.maxWaitMs = options.maxWaitMs ?? 10_000;
  }

  add(runId: string, isFailure: boolean): void {
    if (this.disposed) return;
    if (!this.pending.includes(runId)) this.pending.push(runId);
    if (isFailure) {
      // Failure signals are never delayed; held successes ride along.
      this.flushNow();
      return;
    }
    const now = Date.now();
    this.firstHeldAt ??= now;
    const remainingCap = Math.max(0, this.firstHeldAt + this.maxWaitMs - now);
    const wait = Math.min(this.debounceMs, remainingCap);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushNow(), wait);
    this.timer.unref?.();
  }

  flushNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.firstHeldAt = undefined;
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.onFlush(batch);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }
}

/** Compact renderer-facing payload for one completed task in a run. */
export interface CompletionDetailsTask {
  label: string;
  state: string;
  preview: string;
  turns: number;
  tokens: number;
  cost: number;
  model?: string;
  attempts?: number;
  attemptedModels?: string[];
  pointers: string[];
}

/** Compact renderer-facing payload for one completed run. */
export interface CompletionDetailsRun {
  id: string;
  label: string;
  state: string;
  preview: string;
  turns: number;
  tokens: number;
  cost: number;
  durationMs: number;
  /** Kept for single-task consumers; parallel consumers must use tasks[]. */
  model?: string;
  attempts?: number;
  attemptedModels?: string[];
  pointers: string[];
  tasks: CompletionDetailsTask[];
}

export interface CompletionDetails {
  runs: CompletionDetailsRun[];
}

export const COMPLETION_MESSAGE_TYPE = "subagent-completion";
