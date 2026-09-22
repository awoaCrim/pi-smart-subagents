/** Resolve an aborted signal into a promise for Promise.race patterns. */
export function abortAsPromise(signal: AbortSignal | undefined): Promise<"aborted"> | undefined {
  if (!signal) return undefined;
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
}
