import type { UsageStats, RunSnapshot, RunState, RunMode, TimeoutPhase, ToolActivity, ToolNegotiationDiagnostics, ModelAttemptRecord } from './types.js';
import type { RankedModelOption } from './routing-types.js';
import { utf8SafePrefix } from './model-failover.js';
import { Buffer } from 'node:buffer';
import type { Theme } from '@earendil-works/pi-coding-agent';
import * as os from 'node:os';
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

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
  if (ms === undefined) return '0s';
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
 * version, chosen tools, outcome and latency.
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
  const outcome = str(routing.outcome);
  const code = str(routing.code);
  const confidence = typeof routing.confidence === 'number' && Number.isFinite(routing.confidence) ? routing.confidence : undefined;
  const latencyMs = typeof routing.latencyMs === 'number' && Number.isFinite(routing.latencyMs) && routing.latencyMs >= 0 ? routing.latencyMs : undefined;

  const meaningful = !!(selectedModel || selectorModel || selectorVersion || outcome)
    || confidence !== undefined || latencyMs !== undefined
    || selectedTools !== undefined;
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

/**
 * Status line preview (metadata only, not full summary).
 * Live runs tick; terminal runs freeze at endedAt. A terminal snapshot that
 * never recorded an end time omits the duration instead of aging on every
 * render, and an immutable snapshot keeps the time it was captured with.
 */
export function formatStatusPreview(snapshot: RunSnapshot, now = Date.now(), observedAt?: number): string {
  const done = snapshot.delivered ? 'delivered' : snapshot.resumeBlocked ? 'blocked' : 'ready';
  const live = isActiveState(snapshot.state);
  const end = snapshot.endedAt ?? (live ? observedAt ?? now : undefined);
  const elapsed = end === undefined ? undefined : formatElapsed(snapshot.startedAt, end);
  const phase = snapshot.results.find((r) => r.timeoutPhase)?.timeoutPhase;
  const phaseTag = snapshot.state === 'timeout' && phase ? ` (${phase})` : '';
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
  if (stalledSince !== undefined && live) {
    flags.push(`[stalled ${formatDuration((observedAt ?? now) - stalledSince)}]`);
  }
  const flagText = flags.length ? ` ${flags.join(' ')}` : '';
  const elapsedText = elapsed === undefined ? '' : ` ${elapsed}`;
  return `[${snapshot.id.slice(0, 8)}] ${snapshot.mode} ${formatState(snapshot.state)}${phaseTag}${elapsedText} ${done}${flagText}`;
}

// ── Shared card vocabulary ──────────────────────────────────────────────────
//
// Every human surface renders the same ordered fields: optional identity,
// explicit child state with a truthful duration, one bounded body line, dim
// notes, then a low-emphasis metrics row. Surfaces may reduce rows (dense
// variants) but never change field meaning or the words used for a field.
// Pi's tool shell still owns pending/success/error backgrounds and the
// native call header; the inline card therefore omits its own identity line
// and shows the short run id alongside the state instead.

/** Code-point-safe bounded text (never splits a surrogate pair). */
export function clampText(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= Math.max(1, max)) return text;
  return `${points.slice(0, Math.max(1, max - 1)).join('')}…`;
}

const FENCE_MARKER = /^(?:```|~~~)/;
const HEADING_MARKER = /^#{1,6}\s+/;
const QUOTE_MARKER = /^>\s?/;
const BULLET_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
const LINK_SPAN = /\[([^\]\n]+)\]\(([^()\n]*)\)/g;
const CODE_SPAN = /`{1,2}([^`\n]*?\S)`{1,2}/g;
// Emphasis is only stripped on `*`/`**`/`~~` runs bounded by whitespace or line
// edges, so `a*b`, `file_name`, `x_y`, `2*3*4` and Windows paths survive.
// Underscore emphasis is deliberately never stripped: `__init__` and
// snake_case identifiers are far more common in child output than `_italics_`.
const STRONG_SPAN = /(^|[\s([{>])(\*\*)(?=\S)([^\n]*?\S)\2(?=$|[\s)\]}>.,;:!?])/g;
const EMPHASIS_SPAN = /(^|[\s([{>])(\*)(?=\S)([^*\n]*?\S)\2(?=$|[\s)\]}>.,;:!?])/g;
const STRIKE_SPAN = /(^|[\s([{>])(~~)(?=\S)([^\n]*?\S)\2(?=$|[\s)\]}>.,;:!?])/g;

/**
 * Conservative single-line Markdown cleanup for compact previews: removes
 * fence/heading/quote/list scaffolding and unambiguous inline emphasis only.
 * Raw output, diagnostics and identifiers are never rewritten; callers keep
 * the original text in the full/expanded view.
 */
export function cleanPreviewLine(raw: string): string | undefined {
  let line = raw.trim();
  if (!line) return undefined;
  if (FENCE_MARKER.test(line)) return undefined;
  line = line.replace(HEADING_MARKER, '').replace(QUOTE_MARKER, '');
  const bullet = BULLET_MARKER.exec(line);
  if (bullet && bullet[0].trim() !== line.trim()) line = line.slice(bullet[0].length);
  line = line
    .replace(LINK_SPAN, '$1')
    .replace(CODE_SPAN, '$1')
    .replace(STRONG_SPAN, '$1$3')
    .replace(EMPHASIS_SPAN, '$1$3')
    .replace(STRIKE_SPAN, '$1$3')
    .replace(/\s+/g, ' ')
    .trim();
  return line || undefined;
}

/**
 * First meaningful cleaned line of a bounded preview. Returns `undefined` for
 * empty or marker-only text so callers can fall back to another source.
 */
export function previewText(text: string | undefined, max = 160): string | undefined {
  if (!text) return undefined;
  for (const line of text.split('\n')) {
    const cleaned = cleanPreviewLine(line);
    if (cleaned) return clampText(cleaned, max);
  }
  return undefined;
}

/** Explicit label -> fallback, bounded without splitting characters. */
export function displayLabel(label: string | undefined, fallback: string, max = 60): string {
  const text = (label ?? '').trim();
  return text ? clampText(text, max) : fallback;
}

/** Distinct model names in first-seen order, bounded with an explicit total. */
export function formatModelList(models: readonly string[], max = 2): string {
  const distinct: string[] = [];
  for (const model of models) {
    if (!model || distinct.includes(model)) continue;
    distinct.push(model);
  }
  const shown = distinct.slice(0, max);
  return distinct.length > shown.length ? `${shown.join(', ')} +${distinct.length - shown.length}` : shown.join(', ');
}

export type PresentationKind = 'live' | 'result' | 'snapshot' | 'receipt' | 'startup' | 'plan' | 'error';

/** How a displayed duration is grounded; `unknown` omits it entirely. */
export type DurationKind = 'live' | 'frozen' | 'unknown';

/**
 * Narrow, optional, backward-compatible renderer envelope. It is presentation
 * only: engine projections, persisted run records and model-facing content are
 * unchanged, and details without it still render through the legacy heuristics.
 */
export interface RunPresentation {
  kind: PresentationKind;
  /** Short operation label for management receipts (`status`, `wait (timeout)`). */
  operation?: string;
  /** One bounded, already-readable receipt line for the body slot. */
  receipt?: string;
  /** Stable run/child id this block observes (full id; renderers shorten). */
  id?: string;
  /** Capture time for immutable snapshots; never used to keep a clock aging. */
  observedAt?: number;
  durationKind?: DurationKind;
  /** Bounded evidence lines (diff stat/patch preview), expanded only. */
  detailLines?: string[];
  /** Extra dim notes (warnings, artifact pointers). */
  notes?: string[];
}

export interface CardMetrics {
  model?: string;
  turns?: number;
  tokens?: number;
  cost?: number;
}

export interface CardTask {
  label?: string;
  state?: RunState;
  model?: string;
  turns?: number;
  tokens?: number;
  body?: string;
  notes?: string[];
}

/** One bounded card body in the shared grammar, without an outer frame. */
export interface CardItem {
  id?: string;
  label?: string;
  state?: RunState;
  exitCode?: number | null;
  durationMs?: number;
  durationKind?: DurationKind;
  operation?: string;
  body?: string;
  notes?: string[];
  metrics?: CardMetrics;
  tasks?: CardTask[];
  hiddenTasks?: number;
  progress?: { done: number; total: number };
  /** Default true; inline result blocks hide it (their call header owns it). */
  showIdentity?: boolean;
}

export interface CardRenderOptions {
  theme: Theme;
  width: number;
  /** Rows of per-task detail kept in a parallel card (>= 1). */
  maxTaskRows?: number;
  /** Set false to omit the metrics row (very narrow widths). */
  metrics?: boolean;
  /** Animated state glyph frame for live cards. */
  spinnerFrame?: number;
  /**
   * Streaming surfaces keep a stable row count: the body and metrics slots are
   * always emitted, with a placeholder when the data is still empty.
   */
  reserveSlots?: boolean;
}

/** Below this column count secondary statistics are dropped, not truncated. */
export const MIN_METRICS_WIDTH = 28;
const MAX_NOTE_ROWS = 3;

/**
 * Display form of a model: the last path segment, bounded. Full provider/model
 * ids stay in expanded detail, so the compact row never spends its width on a
 * long provider prefix.
 */
export function abbreviatedModel(model: string | undefined, max = 24): string | undefined {
  if (!model) return undefined;
  const parts = model.split('/');
  const name = parts[parts.length - 1] ?? model;
  return clampText(name || model, max);
}

export function formatMetricsText(metrics: CardMetrics | undefined, includeCost = true): string {
  if (!metrics) return '';
  const parts: string[] = [];
  const model = abbreviatedModel(metrics.model);
  if (model) parts.push(model);
  if (metrics.turns && metrics.turns > 0) parts.push(`${metrics.turns} turns`);
  if (metrics.tokens && metrics.tokens > 0) parts.push(`${formatTokens(metrics.tokens)} tokens (in+out)`);
  if (includeCost && metrics.cost && metrics.cost > 0.00005) parts.push(formatCost(metrics.cost));
  return parts.join(' · ');
}

/**
 * One card in the shared visual language. Callers own the surrounding frame
 * (Pi's tool Box, the widget tree, the inspector pane) and the expanded
 * extras; this function owns field order, vocabulary and width bounds.
 *
 * Width priority is identity first: at narrow widths optional metrics are
 * dropped and the label is dropped before the short id or the state word.
 */
export function renderCardLines(item: CardItem, opts: CardRenderOptions): string[] {
  const { theme } = opts;
  const width = Math.max(1, opts.width);
  const reserve = opts.reserveSlots ?? false;
  const showMetrics = (opts.metrics ?? true) && width >= MIN_METRICS_WIDTH;
  const lines: string[] = [];
  const shortId = item.id || item.operation ? item.id?.slice(0, 8) : undefined;
  const showIdentity = item.showIdentity !== false && !!(item.label || item.operation || shortId);
  const hasState = item.state !== undefined;
  const stateWord = hasState ? formatState(item.state ?? 'running', item.exitCode) : undefined;
  const frame = opts.spinnerFrame ?? 0;
  const glyph = item.operation && item.state === undefined ? theme.fg('accent', '·') : stateGlyph(item.state, theme, frame);

  if (showIdentity) {
    lines.push(identityLine(item.label ?? item.operation ?? '', item.id, theme, width));
  }

  if (hasState) {
    const parts: string[] = [];
    if (!showIdentity && shortId) parts.push(`[${shortId}]`);
    if (item.progress && item.progress.total > 0) parts.push(`${item.progress.done}/${item.progress.total} done`);
    const duration = item.durationKind === 'unknown' || item.durationMs === undefined
      ? undefined
      : formatDuration(Math.max(0, item.durationMs));
    if (duration) parts.push(duration);
    const stateText = parts.length ? `${stateWord} · ${parts.join(' · ')}` : stateWord!;
    lines.push(`${glyph} ${theme.fg(item.state === 'failed' || item.state === 'lost' ? 'error' : 'muted', stateText)}`);
  }

  const metricsText = showMetrics ? formatMetricsText(item.metrics) : '';
  const taskRows = item.tasks?.length
    ? renderTaskRows(item, opts, Math.max(1, opts.maxTaskRows ?? item.tasks.length))
    : undefined;

  if (taskRows) {
    // A parallel card's own body/notes must not disappear behind task rows:
    // management receipts and run-level diagnostics render first.
    const body = item.body ? previewText(item.body, 200) : undefined;
    if (body) lines.push(`  ${theme.fg('dim', '⎿')} ${theme.fg('toolOutput', body)}`);
    lines.push(...taskRows);
  } else {
    const body = previewText(item.body, 200);
    if (body || metricsText || reserve) {
      const text = body;
      const line = text ? `${theme.fg('dim', '⎿')} ${theme.fg('toolOutput', text)}` : `${theme.fg('dim', '⎿')} ${theme.fg('muted', reserve ? 'starting…' : '')}`;
      lines.push(`  ${line}`.trimEnd());
    }
  }

  const notes = dedupeNotes(item.notes);
  if (reserve) {
    // One stable reliability slot while streaming; new flags never grow the block.
    lines.push(notes.length ? theme.fg('warning', `  ${notes.join(' · ')}`) : '');
  } else {
    for (const note of notes) lines.push(theme.fg('warning', `  ${clampText(note, 140)}`));
  }
  if (showMetrics && (metricsText || reserve)) {
    lines.push(theme.fg('dim', metricsText ? `  ${metricsText}` : ' '));
  }
  return lines.map((line) => truncateToWidth(line, width));
}

/** Deduplicated, bounded notes; identical text is never printed twice. */
function dedupeNotes(notes: readonly string[] | undefined): string[] {
  if (!notes?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const note of notes) {
    const text = (note ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_NOTE_ROWS) break;
  }
  return out;
}

function renderTaskRows(item: CardItem, opts: CardRenderOptions, maxRows: number): string[] {
  const { theme } = opts;
  const rows: string[] = [];
  const tasks = item.tasks ?? [];
  const shown = tasks.slice(0, maxRows);
  for (const task of shown) {
    const metrics = opts.width >= MIN_METRICS_WIDTH
      ? formatMetricsText({ model: task.model, turns: task.turns, tokens: task.tokens }, false) : '';
    const warnings = dedupeNotes(task.notes).join(' · ');
    const tail = [previewText(task.body, 80), metrics].filter(Boolean).join(' · ');
    rows.push(`${stateGlyph(task.state, theme, opts.spinnerFrame ?? 0)} ${formatState(task.state ?? 'queued')}${warnings ? theme.fg('warning', ` · ${warnings}`) : ''} · ${theme.fg('text', displayLabel(task.label, 'task'))}${tail ? theme.fg('dim', ` — ${tail}`) : ''}`);
  }
  const hidden = item.hiddenTasks ?? Math.max(0, tasks.length - shown.length);
  if (hidden > 0) rows.push(theme.fg('dim', `  … +${hidden} more task${hidden === 1 ? '' : 's'}`));
  return rows;
}

/** Width-safe identity with room reserved for the stable short id. */
export function identityLine(label: string, id: string | undefined, theme: Theme, width: number): string {
  const suffix = id ? `[${id.slice(0, 8)}]` : '';
  const available = Math.max(0, width - visibleWidth(suffix) - (suffix ? 1 : 0));
  const title = available > 0 ? truncateToWidth(oneLine(label), available) : '';
  return truncateToWidth([title ? theme.bold(theme.fg('toolTitle', title)) : '', theme.fg('dim', suffix)].filter(Boolean).join(' '), Math.max(1, width));
}

/** Host Markdown, with theme callbacks bound only to this render (headless-safe). */
export function markdownLines(text: string, theme: Theme, width: number): string[] {
  const fg = (token: Parameters<Theme['fg']>[0]) => (value: string) => theme.fg(token, value);
  const markdown = new Markdown(text, 0, 0, {
    heading: fg('mdHeading'), link: fg('mdLink'), linkUrl: fg('mdLinkUrl'),
    code: fg('mdCode'), codeBlock: fg('mdCodeBlock'), codeBlockBorder: fg('mdCodeBlockBorder'),
    quote: fg('mdQuote'), quoteBorder: fg('mdQuoteBorder'), hr: fg('mdHr'), listBullet: fg('mdListBullet'),
    bold: (value) => theme.bold(value), italic: (value) => theme.italic(value),
    strikethrough: (value) => theme.strikethrough(value), underline: (value) => theme.underline(value),
  }, { color: fg('toolOutput') });
  return markdown.render(Math.max(1, width)).map((line) => truncateToWidth(line, Math.max(1, width)));
}

/** Legacy-safe generic card for payloads without structured results. */
export function renderFallbackLines(
  text: string,
  opts: { theme: Theme; width: number; expanded?: boolean; state?: RunState; label?: string; presentation?: RunPresentation },
): string[] {
  const { theme } = opts;
  const width = Math.max(1, opts.width);
  const summary = previewText(text, 200) ?? '(no output)';
  const label = typeof opts.presentation?.operation === 'string' ? opts.presentation.operation : undefined;
  const id = typeof opts.presentation?.id === 'string' ? opts.presentation.id : undefined;
  const lines = renderCardLines(
    {
      label: opts.label ?? label,
      id,
      state: opts.state ?? (opts.presentation ? undefined : 'completed'),
      durationKind: 'unknown',
      body: opts.expanded ? undefined : summary,
      showIdentity: !!(opts.label || opts.presentation),
    },
    { theme, width },
  );
  const all = String(text ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim());
  if (opts.expanded) {
    return [...lines, ...boundedEvidenceLines(text, theme, width)];
  }
  if (all.length > 1) lines.push(theme.fg('dim', `  … +${all.length - 1} more lines`));
  return lines;
}

/** One-line collapsed call header: `subagent <label|preview>`. */
export function renderCallLine(args: any, theme: Theme, width: number): string {
  const title = theme.fg('toolTitle', theme.bold('subagent'));
  let preview = '';
  if (args?.action) {
    preview = `${args.action}${args.id ? ` ${String(args.id).slice(0, 8)}` : ''}`;
  } else if (Array.isArray(args?.tasks)) {
    const first = args.tasks[0]?.description ?? args.tasks[0]?.task;
    preview = `${args.tasks.length} parallel tasks${first ? ` — ${oneLine(String(first), 60)}` : ''}`;
  } else if (args?.resume) {
    preview = `resume ${String(args.resume).slice(0, 8)}${args?.description ? ` — ${oneLine(String(args.description), 60)}` : args.task ? ` — ${oneLine(String(args.task), 60)}` : ''}`;
  } else if (args?.description) {
    preview = oneLine(String(args.description), 60);
  } else if (args?.task) {
    preview = oneLine(String(args.task));
  }
  const tag = args?.async ? ` ${theme.fg('accent', '· background')}` : '';
  return truncateToWidth(`${title} ${theme.fg('muted', preview)}${tag}`, width);
}

/**
 * `subagent_wait` reuses the subagent tool but the host renders its raw alias
 * arguments (`{ id, timeout_ms }`), so the shared header needs an explicit
 * wait identity instead of printing a bare `subagent`.
 */
export function renderWaitCallLine(args: any, theme: Theme, width: number): string {
  const title = theme.fg('toolTitle', theme.bold('subagent_wait'));
  const id = args?.id ? String(args.id).slice(0, 8) : undefined;
  const timeout = typeof args?.timeout_ms === 'number' && args.timeout_ms > 0 ? ` · timeout ${formatDuration(args.timeout_ms)}` : '';
  const preview = id ? `wait ${id}${timeout}` : `wait${timeout}`;
  return truncateToWidth(`${title} ${theme.fg('muted', preview)}`, width);
}

// ── Inline tool-block rendering ─────────────────────────────────────────────
//
// Pi's tool shell (Box) already paints pending/success/error backgrounds and
// owns the call header, so the inline card starts at the state line: child
// state + truthful duration, one bounded body line, dim notes, metrics.

export interface InlineTaskView {
  label?: string;
  state?: RunState;
  usage?: Partial<UsageStats>;
  model?: string;
  thinking?: string;
  effectiveThinking?: string;
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
  attemptedModelsTotal?: number;
  modelAttemptsTotal?: number;
  /** Sticky pre-tool boundary state across this task's attempts. */
  toolActivity?: ToolActivity;
  /** Child capability negotiation; omitted tools are non-fatal unless forced. */
  toolDiagnostics?: ToolNegotiationDiagnostics;
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
  id?: string;
  /** Optional presentation envelope; absent for legacy/unknown payloads. */
  presentation?: RunPresentation;
  results: InlineTaskView[];
}

export interface InlineRenderOptions {
  theme: Theme;
  width: number;
  expanded?: boolean;
  isPartial?: boolean;
  spinnerFrame?: number;
  now?: number;
  /** Existing tool content, used only for management evidence, never persisted twice. */
  evidence?: string;
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

function taskAnnotations(task: InlineTaskView, now: number): string[] {
  const notes: string[] = [];
  if (task.stalledSince !== undefined && isActiveState(task.state)) {
    notes.push(Number.isFinite(now) ? `stalled ${formatDuration(now - task.stalledSince)}` : 'stalled');
  }
  if (task.attempts && task.attempts > 1) notes.push(`attempt ${task.attempts}`);
  if (task.effectiveThinking && task.effectiveThinking !== task.thinking) {
    notes.push(`thinking:${task.thinking ?? 'default'}→${task.effectiveThinking}`);
  }
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

export type TaskDiagnosticKind = 'summary' | 'error' | 'timeout' | 'cancelled' | 'warning';

export interface TaskDiagnosticInput {
  label?: string;
  state?: RunState;
  stopReason?: string;
  timeoutPhase?: TimeoutPhase;
  errorMessage?: string;
  finalOutput?: string;
  wrappedUp?: boolean;
  stalledSince?: number;
}

export interface TaskDiagnostic {
  kind: TaskDiagnosticKind;
  tone: ThemeColor;
  /** ANSI-free bounded source text shared by compact and expanded surfaces. */
  text: string;
}

const MAX_DIAGNOSTIC_BYTES = 4_096;

function boundedDiagnosticText(value: unknown, maxBytes = MAX_DIAGNOSTIC_BYTES): string {
  const raw = String(value ?? '').trim();
  const limit = Math.max(1, Math.floor(maxBytes));
  if (!raw) return '';
  if (Buffer.byteLength(raw, 'utf8') <= limit) return raw;
  const suffix = '…';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (limit <= suffixBytes) return utf8SafePrefix(raw, limit);
  return `${utf8SafePrefix(raw, limit - suffixBytes)}${suffix}`;
}

function firstMeaningfulText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Pure semantic outcome projection shared by every TUI surface. */
export function taskDiagnostic(task: TaskDiagnosticInput, maxBytes = MAX_DIAGNOSTIC_BYTES): TaskDiagnostic | undefined {
  switch (task.state) {
    case 'failed':
    case 'lost':
      return {
        kind: 'error',
        tone: 'error',
        text: boundedDiagnosticText(
          firstMeaningfulText(task.errorMessage, task.stopReason, pickLine(task.finalOutput, 'first')) ?? 'unknown error',
          maxBytes,
        ) || 'unknown error',
      };
    case 'timeout':
      return {
        kind: 'timeout',
        tone: 'warning',
        text: `timeout${task.timeoutPhase ? ` (${task.timeoutPhase})` : ''}`,
      };
    case 'cancelled':
      return { kind: 'cancelled', tone: 'muted', text: 'cancelled' };
    case 'partial': {
      if (task.wrappedUp) {
        const first = pickLine(task.finalOutput, 'first');
        const reason = firstMeaningfulText(task.stopReason) ?? 'budget';
        return {
          kind: 'warning',
          tone: 'warning',
          text: `wrapped up (${reason.replace(/_/g, ' ')})${first ? ` — ${boundedDiagnosticText(first, 512)}` : ''}`,
        };
      }
      if (task.stopReason === 'stalled') {
        return {
          kind: 'warning',
          tone: 'warning',
          text: `stalled — ${boundedDiagnosticText(firstMeaningfulText(task.errorMessage) ?? 'no activity', maxBytes) || 'no activity'}`,
        };
      }
      const stopText = firstMeaningfulText(task.errorMessage);
      if (stopText) {
        return {
          kind: 'warning',
          tone: 'warning',
          text: `stopped — ${boundedDiagnosticText(stopText, maxBytes)}`,
        };
      }
      const reason = firstMeaningfulText(task.stopReason);
      if (reason) {
        return {
          kind: 'warning',
          tone: 'warning',
          text: `stopped (${reason.replace(/_/g, ' ')})`,
        };
      }
      break;
    }
  }
  const first = pickLine(task.finalOutput, 'first');
  return first ? { kind: 'summary', tone: 'toolOutput', text: boundedDiagnosticText(first, maxBytes) } : undefined;
}

/** Canonical task line used by compact renderers and notification text. */
export function formatTaskDiagnostic(task: TaskDiagnosticInput, maxBytes = MAX_DIAGNOSTIC_BYTES): string | undefined {
  const diagnostic = taskDiagnostic(task, maxBytes);
  if (!diagnostic) return undefined;
  if (diagnostic.kind === 'error') {
    const state = task.state === 'lost' ? 'lost' : 'failed';
    return `${state} — ${diagnostic.text}`;
  }
  return diagnostic.text;
}

/** ANSI-free compact form of the canonical task diagnostic. */
export function compactTaskDiagnostic(task: TaskDiagnosticInput, max = 120): string | undefined {
  const text = formatTaskDiagnostic(task);
  return text ? oneLine(text, max) : undefined;
}

export interface RunDiagnosticInput {
  mode?: RunMode;
  state: RunState;
  summary?: string;
  results: readonly TaskDiagnosticInput[];
}

/** Bounded run-level diagnostic for terminal/footer notifications. */
export function formatRunDiagnostic(run: RunDiagnosticInput, max = 180): string | undefined {
  const entries = run.results.map((task, index) => ({
    task,
    index,
    diagnostic: taskDiagnostic(task),
  })).filter((entry): entry is typeof entry & { diagnostic: TaskDiagnostic } => !!entry.diagnostic);
  const actionable = entries.filter((entry) => entry.diagnostic.kind !== 'summary');
  const selected = actionable.length ? actionable : entries;
  const state = formatState(run.state);

  if (run.state === 'completed') {
    const summary = boundedDiagnosticText(firstMeaningfulText(selected[0]?.diagnostic.text, run.summary), max);
    return summary ? `${state} — ${oneLine(summary, Math.max(1, max - state.length - 3))}` : state;
  }
  if (run.state === 'timeout') {
    return selected.find((entry) => entry.diagnostic.kind === 'timeout')?.diagnostic.text ?? state;
  }
  if (run.state === 'cancelled') return state;

  if (!selected.length) {
    const summary = boundedDiagnosticText(run.summary, max);
    return summary ? `${state} — ${oneLine(summary, Math.max(1, max - state.length - 3))}` : state;
  }
  const parallel = run.mode === 'parallel' || selected.length > 1;
  const details = selected.slice(0, 3).map((entry) => {
    if (entry.diagnostic.kind === 'error') {
      const text = formatTaskDiagnostic(entry.task) ?? entry.diagnostic.text;
      return parallel
        ? `${entry.task.label ?? `task-${entry.index + 1}`}: ${text}`
        : `${state} — ${entry.diagnostic.text}`;
    }
    const text = formatTaskDiagnostic(entry.task) ?? entry.diagnostic.text;
    return parallel ? `${entry.task.label ?? `task-${entry.index + 1}`}: ${text}` : text;
  }).join('; ');
  const prefix = state === 'done' || state === 'failed' || state === 'lost' ? '' : `${state} — `;
  return oneLine(`${prefix}${details}`, max);
}

function wrapLines(text: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(text, Math.max(10, width));
  return Array.isArray(wrapped) ? wrapped : String(wrapped).split('\n');
}

type ThemeColor = Parameters<Theme['fg']>[0];

/** Wrap actual operation evidence without Markdown interpreting a diff. */
export function boundedEvidenceLines(text: string, theme: Theme, width: number, cap = 400): string[] {
  const rows = text.split('\n').flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)));
  const lines = rows.slice(0, cap).map((line) => truncateToWidth(`  ${theme.fg('toolOutput', line)}`, Math.max(1, width)));
  if (rows.length > cap) lines.push(truncateToWidth(theme.fg('dim', `  … +${rows.length - cap} lines; full evidence in the tool result or referenced artifact`), Math.max(1, width)));
  return lines;
}

/** Full identifiers and reliability metadata belong in expanded/detail surfaces. */
export function taskDetailLines(task: InlineTaskView, theme: Theme, width: number): string[] {
  const entries: string[] = taskAnnotations(task, NaN);
  if (task.label) entries.unshift(`task: ${task.label}`);
  if (task.model) entries.push(`model: ${task.model}`);
  const usage = task.usage;
  if (usage) {
    const metrics = formatMetricsText({ turns: usage.turns, tokens: (usage.input ?? 0) + (usage.output ?? 0), cost: usage.cost });
    if (metrics) entries.push(metrics);
    entries.push(`input ${formatTokens(usage.input)} · output ${formatTokens(usage.output)} · cache read ${formatTokens(usage.cacheRead)} · cache write ${formatTokens(usage.cacheWrite)}`);
    if (usage.contextTokens) entries.push(`context ${formatTokens(usage.contextTokens)}`);
  }
  if (task.errorMessage) entries.push(task.errorMessage);
  if (task.structuredError) entries.push(`schema error: ${task.structuredError}`);
  const route = formatRouteLine(task.routing, 4096);
  if (route) entries.push(route);
  if (task.attemptedModels?.length) entries.push(`attempted models: ${task.attemptedModels.join(' → ')}${task.attemptedModelsTotal && task.attemptedModelsTotal > task.attemptedModels.length ? ` (showing ${task.attemptedModels.length} of ${task.attemptedModelsTotal})` : ''}`);
  for (const attempt of task.modelAttempts ?? []) entries.push(`attempt: ${JSON.stringify(attempt)}`);
  if (task.modelAttemptsTotal && task.modelAttemptsTotal > (task.modelAttempts?.length ?? 0)) entries.push(`showing ${task.modelAttempts?.length ?? 0} of ${task.modelAttemptsTotal} attempts; full history in the run store`);
  if (task.toolDiagnostics) entries.push(`capabilities: ${JSON.stringify(task.toolDiagnostics)}`);
  if (task.outputFile) entries.push(`output: ${task.outputFile}`);
  if (task.sessionId) entries.push(`session: ${task.sessionId}`);
  if (task.worktree) entries.push(`worktree: ${task.worktree.cwd} · branch ${task.worktree.branch}`);
  return entries.flatMap((text) => wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) => theme.fg('dim', `  ${line}`)));
}

function expandedOutputLines(theme: Theme, task: InlineTaskView, width: number, cap: number): string[] {
  if (!task.finalOutput) return [];
  const lines: string[] = [''];
  const wrapped = markdownLines(task.finalOutput, theme, width - 2);
  for (const line of wrapped.slice(0, cap)) lines.push(`  ${theme.fg('toolOutput', line)}`);
  if (wrapped.length > cap) {
    lines.push(theme.fg('dim', `  … +${wrapped.length - cap} lines (full output in ${task.outputFile ? formatPath(task.outputFile) : 'the child session'})`));
  }
  return lines;
}

/**
 * Compact run card in the shared visual language (fixed row count while
 * streaming). Vocabulary:
 *   ✓ Completed · 7m11s
 *     ⎿ Found 2 P2 issues; no P0/P1.
 *     gpt-6-sol · 24 turns · 192k tokens (in+out)
 * Expanded adds pointers, route/attempt diagnostics and bounded full output.
 */
export function renderRunLines(run: InlineRunView, opts: InlineRenderOptions): string[] {
  const { theme, width } = opts;
  const now = opts.now ?? Date.now();
  const frame = opts.spinnerFrame ?? 0;
  const running = opts.isPartial === true;
  const presentation = run.presentation;
  const agg = usageAggregate(run.results);
  const lines: string[] = [];

  // One clock policy: live surfaces tick, immutable snapshots freeze at their
  // capture time, terminal cards freeze at endedAt. A snapshot that never
  // carried an end time shows no duration at all rather than aging, and a
  // frozen card never re-derives elapsed time from the render clock.
  const immutable = presentation?.kind === 'snapshot' || presentation?.kind === 'receipt';
  const durationKind: DurationKind = immutable
    ? (presentation?.durationKind === 'unknown' ? 'unknown' : run.endedAt !== undefined || presentation?.observedAt !== undefined ? 'frozen' : 'unknown')
    : presentation?.durationKind ?? (running ? 'live' : run.endedAt !== undefined ? 'frozen' : 'unknown');
  const durationEnd = durationKind === 'frozen'
    ? run.endedAt ?? presentation?.observedAt
    : durationKind === 'live' ? run.endedAt ?? now : undefined;
  const annotationClock = immutable || !running ? run.endedAt ?? presentation?.observedAt ?? NaN : now;
  const receipt = presentation?.kind === 'receipt';
  const durationMs = durationEnd === undefined || run.startedAt === undefined
    ? undefined
    : Math.max(0, durationEnd - run.startedAt);
  const effectiveState = run.state ?? run.results[0]?.state;

  const primary = run.results[0];
  // Notes are collected once: presentation warnings first, then per-task
  // reliability annotations; renderCardLines de-duplicates identical text.
  const notes: string[] = [
    ...(presentation?.notes ?? []),
    ...(primary && run.results.length <= 1 ? taskAnnotations(primary, annotationClock) : []),
  ];

  const body = presentation?.receipt
    ?? (running
      ? pickLine(primary?.finalOutput ?? (primary as InlineTaskView & { liveText?: string })?.liveText, 'last')
      : primary ? formatTaskDiagnostic(primary) : undefined);

  if (receipt) {
    lines.push(...renderCardLines({
      id: run.id ?? presentation?.id, label: presentation?.operation,
      state: effectiveState, durationMs, durationKind,
      body: presentation?.receipt, notes,
    }, { theme, width }));
    if (opts.expanded) lines.push(...boundedEvidenceLines(opts.evidence ?? presentation?.detailLines?.join('\n') ?? '', theme, width));
    else if (opts.evidence?.includes('\n') || presentation?.detailLines?.length) lines.push(theme.fg('dim', '  … diff/evidence lines (expand for detail)'));
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  if (run.mode === 'parallel' && run.results.length > 1) {
    const total = run.results.length;
    const done = run.results.filter((r) => r.state && !isActiveState(r.state)).length;
    lines.push(...renderCardLines({
      id: run.id ?? presentation?.id,
      state: effectiveState,
      durationMs,
      durationKind,
      operation: presentation?.operation,
      label: presentation?.operation ?? `${run.results.length} parallel tasks`,
      metrics: { turns: agg.turns, tokens: agg.tokens, cost: agg.cost },
      progress: running ? { done, total } : undefined,
      showIdentity: !!presentation?.operation,
      notes,
      tasks: run.results.map((task) => ({
        label: displayLabel(task.label, 'task'),
        state: task.state,
        // A parallel row shows only its own model; cross-task models are never
        // joined into a false retry chain.
        model: task.model,
        turns: task.usage?.turns,
        tokens: (task.usage?.input ?? 0) + (task.usage?.output ?? 0),
        body: isActiveState(task.state) ? pickLine(task.finalOutput, 'last') : formatTaskDiagnostic(task),
        notes: taskAnnotations(task, annotationClock),
      })),
      hiddenTasks: opts.expanded ? 0 : Math.max(0, run.results.length - 6),
    }, { theme, width, spinnerFrame: frame, maxTaskRows: opts.expanded ? run.results.length : 6, reserveSlots: running }));

    if (opts.expanded) {
      for (const task of run.results) {
        lines.push(...taskDetailLines(task, theme, width));
        lines.push(...expandedOutputLines(theme, task, width, 12));
      }
    }
  } else {
    const task = primary ?? {};
    lines.push(...renderCardLines({
      id: run.id ?? presentation?.id,
      label: presentation?.operation,
      state: effectiveState,
      exitCode: task.stopReason === 'error' ? 1 : undefined,
      durationMs,
      durationKind,
      operation: presentation?.operation,
      body,
      metrics: { model: task.model, turns: agg.turns, tokens: agg.tokens, cost: agg.cost },
      showIdentity: !!presentation?.operation,
      notes,
    }, { theme, width, spinnerFrame: frame, reserveSlots: running }));

    if (opts.expanded) {
      if (presentation?.detailLines?.length) {
        lines.push('');
        for (const raw of presentation.detailLines) {
          for (const wrapped of wrapLines(raw, width - 2)) lines.push(`  ${theme.fg('toolOutput', wrapped)}`);
        }
      }
      lines.push(...taskDetailLines(task, theme, width));
      lines.push(...expandedOutputLines(theme, task, width, 40));
    } else if (presentation?.detailLines?.length) {
      lines.push(theme.fg('dim', `  … +${presentation.detailLines.length} diff/evidence lines (expand for full detail)`));
    }
  }

  return lines.map((line) => truncateToWidth(line, width));
}

// ── /btw entry ──────────────────────────────────────────────────────────────

export interface BtwView {
  state: "running" | "done" | "failed";
  label?: string;
  answer?: string;
}

/**
 * `/btw` shares the state glyph/word vocabulary but keeps its own title and
 * never invents metrics: `BtwEntry` has never carried run/model/usage data, and
 * the entry is delivered through `appendEntry` (model-hidden) rather than a
 * tool result.
 */
export function renderBtwLines(view: BtwView, opts: { theme: Theme; width: number; expanded?: boolean }): string[] {
  const { theme } = opts;
  const width = Math.max(1, opts.width);
  const state: RunState = view.state === "done" ? "completed" : view.state === "failed" ? "failed" : "running";
  const lines: string[] = [
    truncateToWidth(`${theme.bold(theme.fg('toolTitle', 'by the way'))} ${theme.fg('dim', clampText(view.label ?? 'by the way', 60))}`, width),
  ];
  const body = view.answer;
  if (body) {
    if (opts.expanded) {
      lines.push(...markdownLines(body, theme, Math.max(1, width - 2)).map((line) => truncateToWidth(`  ${line}`, width)));
    } else {
      const summary = previewText(body, 200);
      if (summary) lines.push(truncateToWidth(`  ${theme.fg('dim', '⎿')} ${theme.fg('toolOutput', summary)}`, width));
      const remaining = body.split('\n').filter((line) => line.trim()).length - 1;
      if (remaining > 0) lines.push(truncateToWidth(theme.fg('dim', `  … +${remaining} more lines (expand for full answer)`), width));
    }
  }
  const glyph = stateGlyph(state, theme);
  lines.splice(1, 0, truncateToWidth(`${glyph} ${theme.fg(view.state === 'failed' ? 'error' : 'muted', formatState(state))}`, width));
  return lines;
}

// ── Background widget ───────────────────────────────────────────────────────

export interface WidgetRunView {
  id: string;
  state?: RunState;
  startedAt?: number;
  mode: RunMode;
  results: Array<InlineTaskView & { liveText?: string }>;
}

export interface WidgetRenderOptions {
  theme: Theme;
  width: number;
  now?: number;
  /** Live run rows kept before the remainder counter. */
  maxRuns?: number;
  /** Per-run task rows kept before that run's remainder counter. */
  maxTasks?: number;
  spinnerFrame?: number;
}

/**
 * Dense live widget rows in the shared vocabulary: identity + run state, then
 * one per-task state row with its own model. Rows are bounded in both
 * directions and every hidden row is counted, so a fanout never grows without
 * limit.
 */
export function widgetRunLines(runs: readonly WidgetRunView[], opts: WidgetRenderOptions): string[] {
  const { theme } = opts;
  const width = Math.max(1, opts.width);
  const now = opts.now ?? Date.now();
  const frame = opts.spinnerFrame ?? Math.floor(now / 120) % SPINNERS.length;
  const maxRuns = Math.max(1, opts.maxRuns ?? 4);
  const maxTasks = Math.max(1, opts.maxTasks ?? 2);
  const lines: string[] = [theme.fg('accent', '●') + ' ' + theme.bold('Subagents')];
  const hiddenRuns = Math.max(0, runs.length - maxRuns);
  runs.slice(0, maxRuns).forEach((run) => {
    const primary = run.results[0];
    const parallel = run.mode === 'parallel' && run.results.length > 1;
    const agg = usageAggregate(run.results);
    lines.push(...renderCardLines({
      id: run.id,
      label: parallel ? `${run.results.length} parallel tasks` : displayLabel(primary?.label, 'Subagent'),
      state: run.state,
      durationKind: run.startedAt === undefined ? 'unknown' : 'live',
      durationMs: run.startedAt === undefined ? undefined : now - run.startedAt,
      body: parallel ? undefined : primary?.liveText ?? primary?.finalOutput,
      notes: parallel ? undefined : primary ? taskAnnotations(primary, now) : undefined,
      metrics: { model: parallel ? undefined : primary?.model, ...agg },
      tasks: parallel ? run.results.map((task) => ({
        label: task.label, state: task.state, model: task.model,
        turns: task.usage?.turns, tokens: (task.usage?.input ?? 0) + (task.usage?.output ?? 0),
        body: task.liveText ?? task.finalOutput, notes: taskAnnotations(task, now),
      })) : undefined,
    }, { theme, width, spinnerFrame: frame, maxTaskRows: maxTasks, reserveSlots: true }));
  });
  if (hiddenRuns > 0) lines.push(theme.fg('dim', `└─ +${hiddenRuns} more run${hiddenRuns === 1 ? '' : 's'} · /subagents`));
  return lines.map((line) => truncateToWidth(line, width));
}

// ── Completion notification card ────────────────────────────────────────────

export interface CompletionCardTask {
  label: string;
  state: string;
  model?: string;
  turns: number;
  tokens: number;
  cost?: number;
  diagnostic?: string;
  preview?: string;
  pointers?: readonly string[];
  attemptedModels?: readonly string[];
  attemptedModelsTotal?: number;
  attempts?: number;
}

export interface CompletionCardRun {
  id: string;
  state: string;
  durationMs: number;
  mode?: RunMode;
  label?: string;
  tasks: readonly CompletionCardTask[];
  pointers?: readonly string[];
}

/**
 * One human-facing completion card per finished background run, drawn in the
 * same vocabulary as inline results. The model-facing completion message stays
 * separate and untouched; `expanded` only adds pointers and bounded attempt
 * history.
 */
export function renderCompletionLines(
  runs: readonly CompletionCardRun[],
  opts: { theme: Theme; width: number; expanded?: boolean },
): string[] {
  const { theme } = opts;
  const width = Math.max(1, opts.width);
  const lines: string[] = [];
  runs.forEach((run, index) => {
    if (index > 0) lines.push('');
    const state = isRunStateName(run.state) ? run.state : undefined;
    const parallel = run.mode === 'parallel' || run.tasks.length > 1;
    lines.push(...renderCardLines({
      id: run.id,
      label: run.label ?? (parallel ? `${run.tasks.length} parallel tasks` : run.tasks[0]?.label),
      state,
      durationMs: run.durationMs,
      durationKind: 'frozen',
      body: parallel ? undefined : run.tasks[0]?.diagnostic ?? run.tasks[0]?.preview,
      metrics: {
        model: parallel ? undefined : run.tasks[0]?.model,
        turns: run.tasks.reduce((sum, task) => sum + (task.turns ?? 0), 0),
        tokens: run.tasks.reduce((sum, task) => sum + (task.tokens ?? 0), 0),
        cost: run.tasks.reduce((sum, task) => sum + (task.cost ?? 0), 0),
      },
      tasks: parallel
        ? run.tasks.map((task) => ({
          label: task.label,
          state: isRunStateName(task.state) ? task.state : undefined,
          model: task.model,
          turns: task.turns,
          tokens: task.tokens,
          body: task.diagnostic ?? task.preview,
        }))
        : undefined,
      notes: opts.expanded
        ? run.tasks.flatMap((task) => (task.attemptedModels?.length ?? 0) > 1 ? [`attempt ${task.attempts ?? task.attemptedModels!.length}: ${formatModelList(task.attemptedModels!, 3)}`] : [])
        : undefined,
    }, {
      theme,
      width,
      // Bounded per-run task rows; the remainder stays a visible count.
      maxTaskRows: opts.expanded ? run.tasks.length : 4,
    }));
    const pointers = opts.expanded
      ? (parallel ? run.tasks.flatMap((task) => task.pointers ?? []) : run.tasks[0]?.pointers ?? run.pointers ?? [])
      : [];
    if (opts.expanded) {
      for (const task of run.tasks) {
        if (task.model) lines.push(...boundedEvidenceLines(`model: ${task.model}`, theme, width));
        const metrics = formatMetricsText({ turns: task.turns, tokens: task.tokens, cost: task.cost });
        if (metrics) lines.push(...boundedEvidenceLines(metrics, theme, width));
        if (task.attemptedModels?.length) lines.push(...boundedEvidenceLines(`attempted models (${task.attemptedModels.length} of ${task.attemptedModelsTotal ?? task.attemptedModels.length}): ${task.attemptedModels.join(' → ')}`, theme, width));
        if (task.preview) lines.push(...boundedEvidenceLines(task.preview, theme, width));
      }
    }
    if (pointers.length) lines.push(...boundedEvidenceLines(pointers.join('\n'), theme, width));
  });
  return lines.map((line) => truncateToWidth(line, width));
}

function isRunStateName(value: unknown): value is RunState {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'partial'
    || value === 'failed' || value === 'cancelled' || value === 'lost' || value === 'timeout';
}
