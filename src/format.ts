import type { UsageStats, RunSnapshot, RunState, RunMode, TimeoutPhase, ToolActivity, ModelAttemptRecord } from './types.js';
import type { RankedModelOption } from './routing-types.js';
import { utf8SafePrefix } from './model-failover.js';
import { Buffer } from 'node:buffer';
import type { Theme } from '@earendil-works/pi-coding-agent';
import * as os from 'node:os';
import { truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

/**
 * Formatting helpers for pi-subagent UI.
 * ANSI-safe, respects terminal width, supports spinners, elapsed, etc.
 * Independent of runner/registry.
 */

export const SPINNERS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const ACTIVE_STATES: ReadonlySet<string> = new Set(['queued', 'running']);

export function isActiveState(state: string | undefined): boolean {
  return state !== undefined && ACTIVE_STATES.has(state);
}

/** Collapse whitespace/newlines into a single display line. */
export function oneLine(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, Math.max(0, max - 1))}…` : collapsed;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
}

export function formatElapsed(ms: number | undefined, now = Date.now()): string {
  if (!ms) return '0s';
  return formatDuration(Math.max(0, now - ms));
}

export function formatTokens(n: number | undefined): string {
  if (!n || n === 0) return '0';
  if (n < 1000) return n.toString();
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

export function formatCost(cost: number): string {
  if (cost >= 0.095) return `$${cost.toFixed(2)}`;
  if (cost >= 0.00095) return `$${cost.toFixed(3)}`;
  return '<$0.001';
}

export function formatUsage(usage: UsageStats, model?: string, compact = true): string {
  const parts: string[] = [];
  if (usage.turns && usage.turns > 0) parts.push(`${usage.turns}t`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost > 0.0001) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model && !compact) parts.push(model);
  return parts.join(' ');
}

/**
 * Structural subset of the persisted Jev route metadata that the TUI can render.
 * `TaskRouting` structurally satisfies this; legacy/empty input yields `undefined` so
 * old runs simply render no route line. A truncated/ranked display preview is
 * presentation only — it is never a valid routing decision or execution plan.
 */
export interface RoutingLineInput {
  selectedModel?: string;
  selectorModel?: string;
  selectorVersion?: string;
  selectedTools?: readonly string[];
  mandatoryTools?: readonly string[];
  confidence?: number;
  latencyMs?: number;
  outcome?: string;
  code?: string;
  /** Display window of the probability ranking (bounded; never an execution plan). */
  rankedModels?: readonly RankedModelOption[];
  /** Total ranked candidates when the display window truncates the ranking. */
  rankedTotal?: number;
}

const ROUTE_MAX_TOOLS = 8;
const ROUTE_MAX_TOOL_NAME = 24;
/** Ranked candidates named in compact/model-facing projections before counting. */
export const RANKED_DISPLAY_LIMIT = 5;

/**
 * One shared bounded display projection for plan and compact details: keeps a
 * small ranked window plus the total instead of echoing a maximum-size catalog
 * into model-facing output. The truncated window is presentation only and is
 * never reused as a routing decision or execution plan. Persisted/internal
 * routing keeps the full bounded ranking.
 */
export function projectRoutingForDisplay<TRouting extends RoutingLineInput | undefined>(routing: TRouting): RoutingLineInput | undefined {
  if (!routing || typeof routing !== 'object') return undefined;
  const { rankedModels, ...rest } = routing;
  if (!Array.isArray(rankedModels) || rankedModels.length === 0) return { ...rest };
  return {
    ...rest,
    rankedModels: rankedModels.slice(0, RANKED_DISPLAY_LIMIT),
    rankedTotal: rankedModels.length,
  };
}

/**
 * One bounded ranked preview: `a=.65>b=.25>c=.10` plus the total when more
 * candidates exist. Model IDs are shortened to their last path segment so a
 * large configured catalog stays inside display bounds; full bounded ranking
 * remains available internally on the routing object.
 */
export function formatRankedPreview(
  ranked: readonly RankedModelOption[] | undefined,
  limit = RANKED_DISPLAY_LIMIT,
): string | undefined {
  if (!Array.isArray(ranked) || ranked.length === 0) return undefined;
  const short = (model: unknown): string | undefined => {
    if (typeof model !== 'string' || !model.trim()) return undefined;
    const parts = model.split('/');
    return parts[parts.length - 1] ?? model;
  };
  const shown: string[] = [];
  for (const entry of ranked.slice(0, Math.max(1, limit))) {
    if (!entry || typeof entry !== 'object') return undefined; // malformed shape: display-skip whole preview, never execute
    const name = short(entry.model);
    if (!name) return undefined;
    const probability = typeof entry.probability === 'number' && Number.isFinite(entry.probability)
      ? `=${entry.probability.toFixed(2)}`
      : '';
    shown.push(`${name}${probability}`);
  }
  const remaining = ranked.length - shown.length;
  return remaining > 0 ? `${shown.join('>')} +${remaining}` : shown.join('>');
}

/** Descriptive tail preview only; full histories remain in the run store. */
export function projectAttemptsForDisplay(
  result: { modelAttempts?: readonly ModelAttemptRecord[]; attemptedModels?: readonly string[] },
  maxBytes = 4_096,
) {
  const modelAttempts = result.modelAttempts?.slice(-RANKED_DISPLAY_LIMIT).map((record) => ({
    ...record,
    outputPreview: record.outputPreview ? utf8SafePrefix(record.outputPreview, 128) : undefined,
  }));
  const attemptedModels = result.attemptedModels?.slice(-RANKED_DISPLAY_LIMIT);
  const projected = {
    modelAttempts, modelAttemptsTotal: result.modelAttempts?.length,
    attemptedModels, attemptedModelsTotal: result.attemptedModels?.length,
  };
  while (Buffer.byteLength(JSON.stringify(projected), 'utf8') > Math.max(256, maxBytes)
    && (modelAttempts?.length || attemptedModels?.length)) {
    modelAttempts?.shift();
    attemptedModels?.shift();
  }
  return projected;
}

function summarizeRoutingTools(tools: readonly string[]): string {
  const shown = tools.slice(0, ROUTE_MAX_TOOLS).map((name) => (name.length > ROUTE_MAX_TOOL_NAME ? `${name.slice(0, ROUTE_MAX_TOOL_NAME - 1)}…` : name));
  return tools.length > shown.length ? `${shown.join(',')} +${tools.length - shown.length}` : shown.join(',');
}

/**
 * One minimal route line for existing expanded surfaces: selected model, selector
 * version, chosen tools, locally added mandatory controls, outcome and latency.
 * ANSI-free and capped so the caller's `truncateToWidth` stays authoritative.
 */
export function formatRouteLine(routing?: RoutingLineInput, max = 160): string | undefined {
  if (!routing || typeof routing !== 'object') return undefined;
  const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const list = (value: unknown): readonly string[] | undefined =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, 64)
      : undefined;

  const selectedModel = str(routing.selectedModel);
  const selectorModel = str(routing.selectorModel);
  const selectorVersion = str(routing.selectorVersion);
  const selectedTools = list(routing.selectedTools);
  const mandatoryTools = list(routing.mandatoryTools);
  const outcome = str(routing.outcome);
  const code = str(routing.code);
  const confidence = typeof routing.confidence === 'number' && Number.isFinite(routing.confidence) ? routing.confidence : undefined;
  const latencyMs = typeof routing.latencyMs === 'number' && Number.isFinite(routing.latencyMs) && routing.latencyMs >= 0 ? routing.latencyMs : undefined;

  const meaningful = !!(selectedModel || selectorModel || selectorVersion || outcome)
    || confidence !== undefined || latencyMs !== undefined
    || selectedTools !== undefined || mandatoryTools !== undefined;
  if (!meaningful) return undefined;

  const parts: string[] = [];
  if (selectedModel) parts.push(selectedModel);
  const selector = selectorModel ? (selectorVersion ? `${selectorModel}@${selectorVersion}` : selectorModel) : selectorVersion;
  if (selector) parts.push(`sel ${selector}`);
  const rankedPreview = formatRankedPreview(routing.rankedModels, ROUTE_MAX_TOOLS);
  if (rankedPreview) {
    const total = typeof routing.rankedTotal === 'number' && routing.rankedTotal > 0 ? routing.rankedTotal : (Array.isArray(routing.rankedModels) ? routing.rankedModels.length : 0);
    parts.push(`rank ${rankedPreview}${total > RANKED_DISPLAY_LIMIT ? ` (of ${total})` : ''}`);
  }
  if (confidence !== undefined) parts.push(`conf ${confidence.toFixed(2)}`);
  parts.push(`tools ${selectedTools && selectedTools.length ? summarizeRoutingTools(selectedTools) : 'none'}`);
  if (mandatoryTools && mandatoryTools.length) parts.push(`+${summarizeRoutingTools(mandatoryTools)}`);
  if (outcome) parts.push(code ? `${outcome}/${code}` : outcome);
  if (latencyMs !== undefined) parts.push(formatDuration(latencyMs));
  return oneLine(`route ${parts.join(' · ')}`, max);
}

export function formatPath(p?: string): string {
  if (!p) return '(none)';
  const home = os.homedir();
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p.length > 40 ? '...' + p.slice(-37) : p;
}

export function formatState(state: RunState, exitCode?: number | null): string {
  switch (state) {
    case 'running': return 'running';
    case 'completed': return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'queued': return 'queued';
    case 'partial': return 'partial';
    case 'lost': return 'lost';
    case 'timeout': return 'timeout';
    default: return state;
  }
}

/** Single-cell themed state glyph. Running states animate via spinnerFrame. */
export function stateGlyph(state: RunState | undefined, theme: Theme, spinnerFrame = 0): string {
  switch (state) {
    case 'queued': return theme.fg('dim', '◌');
    case 'running': return theme.fg('accent', SPINNERS[spinnerFrame % SPINNERS.length]!);
    case 'completed': return theme.fg('success', '✓');
    case 'partial': return theme.fg('warning', '◐');
    case 'cancelled': return theme.fg('muted', '−');
    case 'timeout': return theme.fg('warning', '◷');
    case 'lost': return theme.fg('error', '?');
    case 'failed': return theme.fg('error', '✗');
    default: return theme.fg('dim', '·');
  }
}

/** Status line preview (metadata only, not full summary). Duration freezes at endedAt. */
export function formatStatusPreview(snapshot: RunSnapshot, now = Date.now()): string {
  const done = snapshot.delivered ? 'delivered' : snapshot.resumeBlocked ? 'blocked' : 'ready';
  const elapsed = formatElapsed(snapshot.startedAt, snapshot.endedAt ?? now);
  const phase = snapshot.results.find((r) => r.timeoutPhase)?.timeoutPhase;
  const phaseTag = snapshot.state === 'timeout' && phase ? `/${phase}` : '';
  // Reliability flags from task results (attempt count, stall watchdog).
  let maxAttempts = 0;
  let stalledSince: number | undefined;
  for (const r of snapshot.results) {
    if (typeof r.attempts === 'number' && r.attempts > maxAttempts) maxAttempts = r.attempts;
    if (r.stalledSince && isActiveState(r.state)) {
      stalledSince = stalledSince === undefined ? r.stalledSince : Math.min(stalledSince, r.stalledSince);
    }
  }
  const flags: string[] = [];
  if (maxAttempts > 1) flags.push(`[attempt ${maxAttempts}]`);
  if (stalledSince !== undefined && isActiveState(snapshot.state)) {
    flags.push(`[stalled ${formatDuration(now - stalledSince)}]`);
  }
  const flagText = flags.length ? ` ${flags.join(' ')}` : '';
  return `[${snapshot.id.slice(0, 8)}] ${snapshot.mode} ${formatState(snapshot.state)}${phaseTag} ${elapsed} ${done}${flagText}`;
}

// ── Inline tool-block rendering ─────────────────────────────────────────────
//
// Pi's tool shell (Box) already paints pending/success/error backgrounds and
// state, so inline blocks stay compact: a stats line plus a `⎿ activity`
// line, fixed height while streaming, mutating in place.

export interface InlineTaskView {
  label?: string;
  state?: RunState;
  usage?: Partial<UsageStats>;
  model?: string;
  stopReason?: string;
  timeoutPhase?: TimeoutPhase;
  errorMessage?: string;
  finalOutput?: string;
  outputFile?: string;
  sessionId?: string;
  worktree?: { cwd: string; branch: string };
  wrappedUp?: boolean;
  stalledSince?: number;
  attempts?: number;
  attemptedModels?: string[];
  /** Sticky pre-tool boundary state across this task's attempts. */
  toolActivity?: ToolActivity;
  /** Bounded ranked attempt history (reasons for switches; previews capped). */
  modelAttempts?: ModelAttemptRecord[];
  structuredOutput?: unknown;
  structuredError?: string;
  /** Bounded Jev route metadata; rendered only on expanded surfaces. */
  routing?: RoutingLineInput;
}

export interface InlineRunView {
  mode: RunMode;
  state?: RunState;
  startedAt?: number;
  endedAt?: number;
  results: InlineTaskView[];
}

export interface InlineRenderOptions {
  theme: Theme;
  width: number;
  expanded?: boolean;
  isPartial?: boolean;
  spinnerFrame?: number;
  now?: number;
}

interface AggregateStats { turns: number; tokens: number; cost: number }

function usageAggregate(results: InlineTaskView[]): AggregateStats {
  let turns = 0, tokens = 0, cost = 0;
  for (const r of results) {
    turns += r.usage?.turns ?? 0;
    tokens += (r.usage?.input ?? 0) + (r.usage?.output ?? 0);
    cost += r.usage?.cost ?? 0;
  }
  return { turns, tokens, cost };
}

function statsText(agg: AggregateStats, durationMs?: number): string {
  const parts: string[] = [];
  if (agg.turns > 0) parts.push(`↻${agg.turns}`);
  if (agg.tokens > 0) parts.push(`${formatTokens(agg.tokens)} tok`);
  if (agg.cost > 0.00005) parts.push(formatCost(agg.cost));
  if (durationMs !== undefined && durationMs >= 0) parts.push(formatDuration(durationMs));
  return parts.join(' · ');
}

function taskAnnotations(task: InlineTaskView, now: number): string[] {
  const notes: string[] = [];
  if (task.attempts && task.attempts > 1) {
    const chain = Array.isArray(task.attemptedModels) && task.attemptedModels.length > 1
      ? ` (${task.attemptedModels.slice(0, 3).map((m) => m.split('/').pop() ?? m).join('>')}${task.attemptedModels.length > 3 ? '…' : ''})`
      : '';
    notes.push(`attempt ${task.attempts}${chain}`);
  }
  if (task.stalledSince && isActiveState(task.state)) notes.push(`stalled ${formatDuration(now - task.stalledSince)}`);
  if (!isActiveState(task.state)) {
    if (task.structuredOutput !== undefined) notes.push('✓ schema');
    else if (task.structuredError) notes.push('schema ✗');
  }
  return notes;
}

function pickLine(text: string | undefined, which: 'first' | 'last'): string | undefined {
  if (!text) return undefined;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  return which === 'last' ? lines[lines.length - 1] : lines[0];
}

/** One-line collapsed call header: `subagent <preview>`. */
export function renderCallLine(args: any, theme: Theme, width: number): string {
  const title = theme.fg('toolTitle', theme.bold('subagent'));
  let preview = '';
  if (args?.action) {
    preview = `${args.action}${args.id ? ` ${String(args.id).slice(0, 8)}` : ''}`;
  } else if (Array.isArray(args?.tasks)) {
    const first = args.tasks[0]?.task;
    preview = `${args.tasks.length} parallel tasks${first ? ` — ${oneLine(String(first), 60)}` : ''}`;
  } else if (args?.resume) {
    preview = `resume ${String(args.resume).slice(0, 8)}${args.task ? ` — ${oneLine(String(args.task))}` : ''}`;
  } else if (args?.task) {
    preview = oneLine(String(args.task));
  }
  const tag = args?.async ? ` ${theme.fg('accent', '· background')}` : '';
  return truncateToWidth(`${title} ${theme.fg('muted', preview)}${tag}`, width);
}

function wrapLines(text: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(text, Math.max(10, width));
  return Array.isArray(wrapped) ? wrapped : String(wrapped).split('\n');
}

type ThemeColor = Parameters<Theme['fg']>[0];

function terminalTaskLine(theme: Theme, task: InlineTaskView): { text: string; color: ThemeColor } | undefined {
  switch (task.state) {
    case 'failed':
    case 'lost':
      return { text: `${formatState(task.state)} — ${oneLine(task.errorMessage ?? task.stopReason ?? 'unknown error')}`, color: 'error' };
    case 'cancelled':
      return { text: 'cancelled', color: 'muted' };
    case 'timeout':
      return { text: `timed out${task.timeoutPhase ? ` (${task.timeoutPhase})` : ''}`, color: 'warning' };
    case 'partial': {
      if (task.wrappedUp) {
        const first = pickLine(task.finalOutput, 'first');
        return { text: `wrapped up (${(task.stopReason ?? 'budget').replace('_', ' ')})${first ? ` — ${oneLine(first, 80)}` : ''}`, color: 'warning' };
      }
      if (task.stopReason === 'stalled') {
        return { text: `stalled — ${oneLine(task.errorMessage ?? 'no activity', 80)}`, color: 'warning' };
      }
      const first = pickLine(task.finalOutput, 'first');
      return first ? { text: oneLine(first), color: 'toolOutput' } : undefined;
    }
    default: {
      const first = pickLine(task.finalOutput, 'first');
      return first ? { text: oneLine(first), color: 'toolOutput' } : undefined;
    }
  }
}

function pointerText(task: InlineTaskView, expanded: boolean): string | undefined {
  const parts: string[] = [];
  if (task.outputFile) parts.push(`→ ${formatPath(task.outputFile)}`);
  if (task.worktree) parts.push(`⎇ ${task.worktree.branch}`);
  if (expanded && task.sessionId) parts.push(`session ${task.sessionId.slice(0, 8)}`);
  return parts.length ? parts.join(' · ') : undefined;
}

function expandedOutputLines(theme: Theme, task: InlineTaskView, width: number, cap: number): string[] {
  if (!task.finalOutput) return [];
  const lines: string[] = [''];
  const wrapped = wrapLines(task.finalOutput, width - 2);
  for (const line of wrapped.slice(0, cap)) lines.push(`  ${theme.fg('toolOutput', line)}`);
  if (wrapped.length > cap) {
    lines.push(theme.fg('dim', `  … +${wrapped.length - cap} lines (full output in ${task.outputFile ? formatPath(task.outputFile) : 'the child session'})`));
  }
  return lines;
}

/**
 * Compact run block. Fixed shape while streaming:
 *   ⠹ ↻3 · 12.4k tok · 8s
 *     ⎿ reading src/auth/middleware.ts…
 * Terminal:
 *   ↻8 · 33.8k tok · $0.012 · 12s
 *     ⎿ Found 5 middleware call sites…
 * Parallel collapsed: one line per task.
 */
export function renderRunLines(run: InlineRunView, opts: InlineRenderOptions): string[] {
  const { theme, width } = opts;
  const now = opts.now ?? Date.now();
  const frame = opts.spinnerFrame ?? 0;
  const running = opts.isPartial ?? isActiveState(run.state);
  const durationMs = run.startedAt ? (run.endedAt ?? now) - run.startedAt : undefined;
  const agg = usageAggregate(run.results);
  const stats = statsText(agg, durationMs);
  const spin = theme.fg('accent', SPINNERS[frame % SPINNERS.length]!);
  const lines: string[] = [];

  if (run.mode === 'parallel' && run.results.length > 1) {
    const total = run.results.length;
    const done = run.results.filter((r) => r.state && !isActiveState(r.state)).length;
    lines.push(running
      ? `${spin} ${theme.fg('dim', `${done}/${total} done${stats ? ` · ${stats}` : ''}`)}`
      : theme.fg('dim', `${total} tasks${stats ? ` · ${stats}` : ''}`));

    const shown = opts.expanded ? run.results : run.results.slice(0, 6);
    for (const task of shown) {
      const glyph = stateGlyph(task.state, theme, frame);
      const mini = statsText(usageAggregate([task]));
      const active = isActiveState(task.state);
      // The state glyph already communicates the outcome; parallel rows show
      // just the message/preview without repeating the state word.
      const tail = active
        ? pickLine(task.finalOutput, 'last')
        : ['failed', 'lost'].includes(task.state ?? '')
          ? (task.errorMessage ?? task.stopReason ?? formatState(task.state!))
          : task.state === 'timeout'
            ? `timed out${task.timeoutPhase ? ` (${task.timeoutPhase})` : ''}`
            : task.state === 'cancelled'
              ? undefined
              : pickLine(task.finalOutput, 'first');
      const tailColor: ThemeColor = !active && ['failed', 'lost'].includes(task.state ?? '') ? 'error' : 'muted';
      let line = `  ${glyph} ${theme.fg('dim', task.model ?? 'model unknown')} · ${theme.fg('text', task.label ?? 'task')}`;
      if (mini) line += theme.fg('dim', ` · ${mini}`);
      const notes = taskAnnotations(task, now);
      if (notes.length) line += ` ${theme.fg('warning', `[${notes.join(' · ')}]`)}`;
      if (task.wrappedUp && !active) line += ` ${theme.fg('warning', '◐ wrapped up')}`;
      if (tail) line += ` ${theme.fg(tailColor, `— ${oneLine(tail, 80)}`)}`;
      lines.push(line);
      if (opts.expanded) {
        const pointers = pointerText(task, true);
        if (pointers) lines.push(theme.fg('dim', `    ${pointers}`));
        const route = formatRouteLine(task.routing, Math.max(10, width - 6));
        if (route) lines.push(theme.fg('dim', `    ${route}`));
        lines.push(...expandedOutputLines(theme, task, width, 12).map((l) => l ? `  ${l}` : l));
      }
    }
    if (!opts.expanded && total > shown.length) {
      lines.push(theme.fg('dim', `  … +${total - shown.length} more`));
    }
  } else {
    const task = run.results[0] ?? {};
    if (running) {
      const notes = taskAnnotations(task, now);
      const noteText = notes.length ? ` ${theme.fg('warning', `[${notes.join(' · ')}]`)}` : '';
      const modelText = theme.fg('dim', task.model ?? 'model unknown');
      lines.push(`${spin} ${modelText} · ${theme.fg('dim', stats || 'starting…')}${noteText}`);
      const activity = pickLine(task.finalOutput, 'last');
      if (activity) lines.push(`  ${theme.fg('dim', '⎿')} ${theme.fg('muted', oneLine(activity, width))}`);
    } else {
      const modelText = task.model ?? 'model unknown';
      lines.push(theme.fg('dim', `${modelText} · ${stats || formatState(run.state ?? task.state ?? 'completed')}`));
      const summary = terminalTaskLine(theme, task);
      if (summary && !opts.expanded) lines.push(`  ${theme.fg('dim', '⎿')} ${theme.fg(summary.color, oneLine(summary.text, width))}`);
      const pointers = pointerText(task, opts.expanded ?? false);
      if (pointers) lines.push(theme.fg('dim', `  ${pointers}`));
      if (opts.expanded) {
        if (summary && ['error', 'warning', 'muted'].includes(summary.color)) {
          lines.push(`  ${theme.fg('dim', '⎿')} ${theme.fg(summary.color, oneLine(summary.text, width))}`);
        }
        const route = formatRouteLine(task.routing, Math.max(10, width - 4));
        if (route) lines.push(theme.fg('dim', `  ${route}`));
        lines.push(...expandedOutputLines(theme, task, width, 40));
      }
    }
  }

  return lines.map((line) => truncateToWidth(line, width));
}
