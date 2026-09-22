import type { Message, Usage } from "@earendil-works/pi-ai";
import type { RoutingReceipt } from "./routing-types.js";
import type { RunSnapshot, UsageStats } from "./types.js";
import { emptyUsage } from "./types.js";
import { foldRoutingReceipts, RUN_ENTRY_TYPE } from "./persistence.js";

export interface UsageLedger {
  root: UsageStats;
  subagents: UsageStats;
  /** Reported selector tokens only; `cost` is the numeric placeholder 0 (currency unreported). */
  routing: UsageStats;
  combined: UsageStats;
  runCount: number;
  taskCount: number;
  /** Number of distinct routing receipts counted once on the active branch. */
  routingRequests: number;
  /** Receipts whose selector usage was not validly reported (honest unknown, not zero-spend). */
  routingUnknown: number;
  /** TypeSafe reports tokens, never billed currency; numeric USD totals exclude this. */
  routingCurrency: "unreported";
}

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function normalizeUsage(value: Partial<UsageStats> | undefined): UsageStats {
  return {
    input: finite(value?.input),
    output: finite(value?.output),
    cacheRead: finite(value?.cacheRead),
    cacheWrite: finite(value?.cacheWrite),
    reasoning: finite(value?.reasoning),
    cost: finite(value?.cost),
    costInput: finite(value?.costInput),
    costOutput: finite(value?.costOutput),
    costCacheRead: finite(value?.costCacheRead),
    costCacheWrite: finite(value?.costCacheWrite),
    contextTokens: finite(value?.contextTokens),
    turns: finite(value?.turns),
  };
}

export function addUsage(...values: Array<Partial<UsageStats> | undefined>): UsageStats {
  return values.reduce<UsageStats>((sum, value) => {
    const next = normalizeUsage(value);
    sum.input += next.input;
    sum.output += next.output;
    sum.cacheRead += next.cacheRead;
    sum.cacheWrite += next.cacheWrite;
    sum.reasoning = (sum.reasoning ?? 0) + (next.reasoning ?? 0);
    sum.cost += next.cost;
    sum.costInput = (sum.costInput ?? 0) + (next.costInput ?? 0);
    sum.costOutput = (sum.costOutput ?? 0) + (next.costOutput ?? 0);
    sum.costCacheRead = (sum.costCacheRead ?? 0) + (next.costCacheRead ?? 0);
    sum.costCacheWrite = (sum.costCacheWrite ?? 0) + (next.costCacheWrite ?? 0);
    // Context size is a point-in-time measurement, not additive billed usage.
    if (next.contextTokens > 0) sum.contextTokens = next.contextTokens;
    sum.turns += next.turns;
    return sum;
  }, emptyUsage());
}

/**
 * Untrusted provider usage payload from a child's event stream. Old Pi builds
 * reported `cost` as a bare number; new ones report a category object.
 */
interface ProviderUsageLike {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  reasoning?: unknown;
  totalTokens?: unknown;
  cost?: number | { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; total?: unknown };
}

/** Shared normalization of Pi's provider `Usage` payload into our aggregate stats. */
function statsFromProviderUsage(usage: ProviderUsageLike, turns: number, contextTokens: unknown): UsageStats {
  const cost = typeof usage.cost === "object" && usage.cost !== null ? usage.cost : undefined;
  const categoryTotal = [cost?.input, cost?.output, cost?.cacheRead, cost?.cacheWrite]
    .reduce((sum: number, value: unknown) => sum + finite(value), 0);
  const reportedTotal = typeof cost?.total === "number" && Number.isFinite(cost.total) && cost.total >= 0
    ? cost.total
    : typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
      ? usage.cost
      : categoryTotal;
  return normalizeUsage({
    input: finite(usage.input),
    output: finite(usage.output),
    cacheRead: finite(usage.cacheRead),
    cacheWrite: finite(usage.cacheWrite),
    reasoning: finite(usage.reasoning),
    cost: reportedTotal,
    costInput: finite(cost?.input),
    costOutput: finite(cost?.output),
    costCacheRead: finite(cost?.cacheRead),
    costCacheWrite: finite(cost?.cacheWrite),
    contextTokens: finite(contextTokens),
    turns,
  });
}

/** Message-shaped value with an optional usage payload (untrusted stream data). */
type MessageWithUsage = { role?: unknown; usage?: ProviderUsageLike };

export function usageFromMessage(message: Message | unknown): UsageStats {
  const msg = message as MessageWithUsage; // structural read of untrusted stream JSON; every field re-validated
  if (msg?.role !== "assistant" || !msg.usage) return emptyUsage();
  return statsFromProviderUsage(msg.usage, 1, msg.usage.totalTokens);
}

/**
 * Nested LLM usage reported on a toolResult message (Pi ≥ #6671, e.g. a
 * grandchild subagent's spend). Not a turn; not a context measurement.
 */
export function usageFromToolResultMessage(message: Message | unknown): UsageStats {
  const msg = message as MessageWithUsage; // structural read of untrusted stream JSON; every field re-validated
  if (msg?.role !== "toolResult" || !msg.usage) return emptyUsage();
  return statsFromProviderUsage(msg.usage, 0, 0);
}

/** True when the stats represent any billed work (tokens or cost). */
export function hasBilledUsage(stats: Partial<UsageStats> | undefined): boolean {
  const n = normalizeUsage(stats);
  return n.cost > 0 || n.input + n.output + n.cacheRead + n.cacheWrite > 0;
}

/**
 * Convert aggregate stats into Pi's native `Usage` shape for tool-result
 * accounting (AgentToolResult.usage / tool_result hook). Pi folds the four
 * token categories plus `cost.total` into footer, /session, and RPC totals.
 */
export function toPiUsage(stats: UsageStats): Usage {
  const n = normalizeUsage(stats);
  return {
    input: n.input,
    output: n.output,
    cacheRead: n.cacheRead,
    cacheWrite: n.cacheWrite,
    ...(n.reasoning ? { reasoning: n.reasoning } : {}),
    totalTokens: n.input + n.output + n.cacheRead + n.cacheWrite,
    cost: {
      input: n.costInput ?? 0,
      output: n.costOutput ?? 0,
      cacheRead: n.costCacheRead ?? 0,
      cacheWrite: n.costCacheWrite ?? 0,
      total: n.cost,
    },
  };
}

/** Root usage from active-branch session message entries only. */
export function rootUsageFromEntries(entries: readonly unknown[]): UsageStats {
  const seenMessageEntries = new Set<string>();
  const usages: UsageStats[] = [];
  for (const raw of entries) {
    const entry = raw as { type?: string; id?: string; message?: Message };
    if (entry.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
    if (entry.id && seenMessageEntries.has(entry.id)) continue;
    if (entry.id) seenMessageEntries.add(entry.id);
    usages.push(usageFromMessage(entry.message));
  }
  return addUsage(...usages);
}

/** Count each terminal snapshot once by full run ID. */
export function subagentUsageFromSnapshots(snapshots: Iterable<RunSnapshot>): {
  usage: UsageStats;
  runCount: number;
  taskCount: number;
} {
  const byId = new Map<string, RunSnapshot>();
  for (const snapshot of snapshots) byId.set(snapshot.id, snapshot);
  const runs = [...byId.values()];
  const taskUsages = runs.flatMap((run) => run.results.map((result) => result.usage));
  return { usage: addUsage(...taskUsages), runCount: runs.length, taskCount: taskUsages.length };
}

/**
 * Selector usage as a separate category. Counts validated reported token fields;
 * `cost` stays the honest numeric placeholder 0 because TypeSafe never reports billed
 * currency. Partial reports retain known tokens while their completeness stays unknown.
 */
export function routingUsage(receipts: readonly RoutingReceipt[]): UsageStats {
  let input = 0;
  let output = 0;
  for (const receipt of receipts) {
    if (!receipt) continue;
    input += finite(receipt.inputTokens);
    output += finite(receipt.outputTokens);
  }
  return normalizeUsage({ input, output });
}

/**
 * Reconstruct cost directly from terminal persistence events on the active
 * branch. This remains complete even when old UI snapshots are evicted.
 */
interface RunUsage {
  usage: UsageStats;
  taskCount: number;
}

export function subagentUsageFromEntries(entries: readonly unknown[]): {
  usage: UsageStats;
  runCount: number;
  taskCount: number;
  runIds: Set<string>;
  byRun: Map<string, RunUsage>;
} {
  const latestById = new Map<string, { results: any[] }>();
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: any };
    if (entry.type !== "custom" || entry.customType !== RUN_ENTRY_TYPE) continue;
    const event = entry.data;
    if (!event || event.schemaVersion !== 1 || typeof event.id !== "string") continue;
    // Start/checkpoint/terminal records carry cumulative task usage. Session
    // branch order is canonical, so the latest results replace earlier values.
    if (["start", "checkpoint", "terminal"].includes(event.type) && Array.isArray(event.data?.results)) {
      latestById.set(event.id, { results: event.data.results });
    }
  }
  const byRun = new Map<string, RunUsage>();
  for (const [id, run] of latestById) {
    const usages = run.results.map((result) => result.usage);
    byRun.set(id, { usage: addUsage(...usages), taskCount: usages.length });
  }
  return {
    usage: addUsage(...[...byRun.values()].map((run) => run.usage)),
    runCount: byRun.size,
    taskCount: [...byRun.values()].reduce((sum, run) => sum + run.taskCount, 0),
    runIds: new Set(byRun.keys()),
    byRun,
  };
}

function messageFingerprint(message: any): string {
  return JSON.stringify([
    message?.timestamp ?? null,
    message?.provider ?? null,
    message?.model ?? null,
    message?.responseId ?? null,
    message?.usage?.input ?? null,
    message?.usage?.output ?? null,
    message?.usage?.cacheRead ?? null,
    message?.usage?.cacheWrite ?? null,
    message?.usage?.cost?.total ?? null,
  ]);
}

export function buildUsageLedger(
  activeBranchEntries: readonly unknown[],
  currentSnapshots: Iterable<RunSnapshot> = [],
  pendingRootMessages: readonly Message[] = [],
  pendingRoutingEvents: readonly unknown[] = [],
): UsageLedger {
  const branchRoot = rootUsageFromEntries(activeBranchEntries);
  const branchFingerprintCounts = new Map<string, number>();
  for (const raw of activeBranchEntries as any[]) {
    if (raw?.type !== "message" || raw.message?.role !== "assistant") continue;
    const fingerprint = messageFingerprint(raw.message);
    branchFingerprintCounts.set(fingerprint, (branchFingerprintCounts.get(fingerprint) ?? 0) + 1);
  }
  const pending = pendingRootMessages.filter((message) => {
    const fingerprint = messageFingerprint(message);
    const remaining = branchFingerprintCounts.get(fingerprint) ?? 0;
    if (remaining === 0) return true;
    branchFingerprintCounts.set(fingerprint, remaining - 1);
    return false;
  });
  const root = addUsage(branchRoot, ...pending.map(usageFromMessage));
  const persisted = subagentUsageFromEntries(activeBranchEntries);
  // Current in-memory snapshots are newer than SessionManager visibility. They
  // replace the same run's persisted checkpoint, while unrelated runs remain.
  const currentById = new Map<string, RunSnapshot>();
  for (const snapshot of currentSnapshots) currentById.set(snapshot.id, snapshot);
  const persistedOnly = [...persisted.byRun.entries()].filter(([id]) => !currentById.has(id));
  const current = subagentUsageFromSnapshots(currentById.values());
  const subagents = addUsage(
    ...persistedOnly.map(([, run]) => run.usage),
    current.usage,
  );
  // Fold routing receipts once by full request ID. Child native usage already carries
  // any descendant routing that a grandchild reported, so only this branch's own
  // selector events are added; route references inside results are never re-added.
  const foldedRouting = foldRoutingReceipts(activeBranchEntries, pendingRoutingEvents);
  const routingReceipts = [...foldedRouting.values()].map((entry) => entry.receipt);
  const routing = routingUsage(routingReceipts);
  return {
    root,
    subagents,
    routing,
    combined: addUsage(root, subagents, routing),
    runCount: persistedOnly.length + current.runCount,
    taskCount: persistedOnly.reduce((sum, [, run]) => sum + run.taskCount, 0) + current.taskCount,
    routingRequests: routingReceipts.length,
    routingUnknown: routingReceipts.filter((receipt) => receipt.usageStatus !== "reported").length,
    routingCurrency: "unreported",
  };
}

export function formatLedger(ledger: UsageLedger): string {
  const money = (n: number) => `$${n.toFixed(4)}`;
  const tokens = (u: UsageStats) => `${u.input + u.output} tok`;
  const parts = [
    `root ${money(ledger.root.cost)} (${tokens(ledger.root)})`,
    `subagents ${money(ledger.subagents.cost)} (${tokens(ledger.subagents)}, ${ledger.runCount} runs/${ledger.taskCount} tasks)`,
  ];
  if (ledger.routingRequests > 0) {
    const unknown = ledger.routingUnknown > 0 ? `, ${ledger.routingUnknown} unknown $` : "";
    parts.push(`routing ${tokens(ledger.routing)} (${ledger.routingRequests} req${unknown}; $ unreported)`);
  }
  const moneyNote = ledger.routingRequests > 0 ? "; USD excl. unreported routing" : "";
  parts.push(`combined ${money(ledger.combined.cost)} (${tokens(ledger.combined)}${moneyNote})`);
  return parts.join(" · ");
}
