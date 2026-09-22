/**
 * Fair, abort-aware semaphore for limiting concurrent Pi subagent processes.
 *
 * - maxActive: maximum concurrent processes
 * - maxQueued: maximum tasks waiting for a slot
 * - FIFO queue
 * - Aborted waiters are removed without ever starting work
 */
export class Semaphore {
  private readonly maxActive: number;
  private readonly maxQueued: number;
  private active = 0;
  private queue: Array<{
    resolve: () => void;
    reject: (reason?: unknown) => void;
    onAbort?: () => void;
    signal?: AbortSignal;
  }> = [];
  private releaseListeners = new Set<() => void>();

  constructor(maxActive = 4, maxQueued = 32) {
    this.maxActive = Math.max(1, maxActive);
    this.maxQueued = Math.max(0, maxQueued);
  }

  /**
   * Acquire a slot. Rejects immediately if the queue is full.
   * If `signal` is already aborted (or aborts while waiting), rejects without starting work.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Semaphore acquisition aborted before enqueue");
    }

    if (this.active < this.maxActive) {
      this.active++;
      return;
    }

    if (this.queue.length >= this.maxQueued) {
      throw new Error(`Semaphore queue full (${this.maxQueued})`);
    }

    return new Promise<void>((resolve, reject) => {
      const entry: {
        resolve: () => void;
        reject: (reason?: unknown) => void;
        onAbort?: () => void;
        signal?: AbortSignal;
      } = {
        resolve: () => {
          this.detachAbort(entry);
          resolve();
        },
        reject: (reason?: unknown) => {
          this.detachAbort(entry);
          reject(reason);
        },
        signal,
      };

      if (signal) {
        entry.onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx === -1) return;
          this.queue.splice(idx, 1);
          entry.reject(new Error("Semaphore acquisition aborted before spawn"));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      this.queue.push(entry);
    });
  }

  /** Release a slot and wake the next non-aborted waiter. */
  release(): void {
    this.active = Math.max(0, this.active - 1);

    while (this.queue.length > 0 && this.active < this.maxActive) {
      const next = this.queue.shift()!;
      if (next.signal?.aborted) {
        next.reject(new Error("Semaphore acquisition aborted before spawn"));
        continue;
      }
      this.active++;
      next.resolve();
      break;
    }

    for (const listener of this.releaseListeners) listener();
  }

  /** Lightweight EventEmitter-compatible API used by tests. */
  on(event: "release", listener: () => void): this {
    if (event === "release") this.releaseListeners.add(listener);
    return this;
  }

  off(event: "release", listener: () => void): this {
    if (event === "release") this.releaseListeners.delete(listener);
    return this;
  }

  getStats() {
    return {
      active: this.active,
      queued: this.queue.length,
      maxActive: this.maxActive,
      maxQueued: this.maxQueued,
    };
  }

  private detachAbort(entry: {
    onAbort?: () => void;
    signal?: AbortSignal;
  }): void {
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    entry.onAbort = undefined;
  }
}
