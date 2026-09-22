import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig } from "./config.js";
import { MAX_ROUTING_MODELS } from "./routing-types.js";

/**
 * Durable, crash-surviving coordination primitives under `~/.pi/subagent-locks/`.
 *
 * Provides:
 * - Per-child-session exclusive resume locks (file lock via O_EXCL lock directory)
 * - Machine-wide concurrency tokens (slot files)
 * - Run process identity records (PID + startTime + pgid) for orphan reconcile
 *
 * Locks use mkdir atomicity (POSIX + Node) and embed owner identity so stale
 * locks from dead processes can be reclaimed conservatively (PID birth-time
 * checked where available).
 */

export interface ProcessIdentity {
  pid: number;
  /** Process start time in ms since epoch when known; 0 when unknown. */
  startTime: number;
  pgid?: number;
  hostname: string;
}

export interface SessionLockOwner {
  ownerId: string;
  runId: string;
  parentSessionKey: string;
  process: ProcessIdentity;
  acquiredAt: number;
  leaseExpiresAt: number;
  childSessionId: string;
}

export interface SessionLockAvailability {
  childSessionId: string;
  /** `reclaimable` means a demonstrably stale lock that a later acquire may reclaim. */
  status: "free" | "held" | "reclaimable";
  owner?: SessionLockOwner;
  reason?: string;
}

export interface RunProcessRecord {
  runId: string;
  parentSessionKey: string;
  childSessionId?: string;
  /** Ranked task's attempt sessions, protected together until final terminalization. */
  childSessionIds?: string[];
  /** Live worktree checkout of this run; shields it from machine-wide GC sweeps. */
  worktreeCwd?: string;
  process: ProcessIdentity;
  startedAt: number;
  state: "running" | "terminal";
  terminalState?: string;
  updatedAt: number;
}

/** Bounded machine-wide session protection; old single-session records still work. */
export function runRecordSessionIds(record: RunProcessRecord): string[] {
  const values: unknown[] = [record.childSessionId, ...(Array.isArray(record.childSessionIds) ? record.childSessionIds.slice(0, MAX_ROUTING_MODELS) : [])];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 256))].slice(0, MAX_ROUTING_MODELS);
}

export interface SlotToken {
  slotId: string;
  path: string;
  runId: string;
  released: boolean;
}

export interface ProcessLockOptions {
  rootDir?: string;
  /** Soft lease for session locks; current holders renew while active. */
  leaseMs?: number;
  /** Max concurrent child Pi processes machine-wide. 0 = no global limit. */
  maxGlobalActive?: number;
  /**
   * Nesting ceiling used for depth-tiered global slots. Defaults to
   * `defaultConfig.maxDepth` so shallow tiers reserve room for deeper ones.
   */
  maxDepth?: number;
  /** Now override for tests. */
  now?: () => number;
  /** isAlive override for tests. */
  isAlive?: (identity: ProcessIdentity) => boolean;
}

const DEFAULT_LEASE_MS = 60_000;
const HOSTNAME = (() => {
  try {
    return os.hostname();
  } catch {
    return "unknown";
  }
})();

function lockRoot(root?: string): string {
  return root ?? path.join(defaultConfig.sessionDir, "..", "subagent-locks");
}

function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function sessionLockPath(root: string, childSessionId: string): string {
  // Nested dirs: keep file names short and FS-safe.
  const safe = childSessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return path.join(root, "sessions", `${safe}.lock`);
}

function slotDir(root: string): string {
  return path.join(root, "slots");
}

function runRecordPath(root: string, runId: string): string {
  // Parallel/synthesis IDs contain ':', which is not a valid Windows filename.
  // Encode '%' as well to keep IDs distinct; preserve existing POSIX records.
  const filename = process.platform === "win32" ? encodeURIComponent(runId) : runId;
  return path.join(root, "runs", `${filename}.json`);
}

function readJsonSync<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomicSync(file: string, value: unknown): void {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Best-effort process start-time identity. On Linux uses `/proc/<pid>/stat`
 * field 22 (starttime in clock ticks). On macOS/BSD uses `ps -o lstart=`
 * (epoch seconds). Elsewhere falls back to 0 (we still check `kill(pid, 0)`
 * for liveness, but PID-reuse protection is weaker).
 */
export function processStartTime(pid: number): number {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Proc name may contain spaces/parens; starttime is the 22nd field after the closing ')'.
      const close = stat.lastIndexOf(")");
      if (close >= 0) {
        const fields = stat.slice(close + 2).trim().split(/\s+/);
        const startTicks = Number(fields[19]); // field 22 absolute = index 19 after cmd
        if (Number.isFinite(startTicks)) return startTicks;
      }
    } catch {
      /* fall through */
    }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        const epoch = Math.floor(new Date(out).getTime() / 1000);
        if (Number.isFinite(epoch) && epoch > 0) return epoch;
      }
    } catch {
      /* fall through */
    }
  }
  return 0;
}

export function currentProcessIdentity(): ProcessIdentity {
  let pgid: number | undefined;
  try {
    // Node exposes getpgrp on POSIX but the type package has not always
    // declared it. Access reflectively for portability.
    const getpgrp = (process as NodeJS.Process & { getpgrp?: () => number }).getpgrp;
    if (process.platform !== "win32" && typeof getpgrp === "function") {
      pgid = getpgrp.call(process);
    }
  } catch {
    pgid = undefined;
  }
  return {
    pid: process.pid,
    startTime: processStartTime(process.pid),
    pgid,
    hostname: HOSTNAME,
  };
}

export function isProcessAlive(identity: ProcessIdentity): boolean {
  if (!identity.pid || identity.pid <= 0) return false;
  // Only check processes on this host; cross-host records are treated as dead so
  // local reconcile does not wait forever.
  if (identity.hostname && identity.hostname !== HOSTNAME) return false;
  try {
    process.kill(identity.pid, 0);
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists but we cannot signal it.
    if (error?.code === "EPERM") {
      // Still verify startTime if known.
    } else {
      return false;
    }
  }
  if (identity.startTime > 0) {
    const live = processStartTime(identity.pid);
    // If we can read startTime and it differs, this is a recycled PID.
    if (live > 0 && live !== identity.startTime) return false;
  }
  return true;
}

export function killProcessTree(identity: ProcessIdentity, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!identity.pid) return;
  try {
    if (process.platform === "win32") {
      // Use taskkill for the process tree.
      // Spawned fire-and-forget: callers that need confirmation re-check liveness.
      const force = signal === "SIGKILL";
      const args = ["/pid", String(identity.pid), "/T", ...(force ? ["/F"] : [])];
      const killer = spawn("taskkill", args, { shell: false, stdio: "ignore" });
      killer.unref();
      return;
    }
    const target = identity.pgid && identity.pgid > 0 ? -identity.pgid : -identity.pid;
    try {
      process.kill(target, signal);
    } catch (error: any) {
      if (error?.code !== "ESRCH") {
        try {
          process.kill(identity.pid, signal);
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* best effort */
  }
}

export class ProcessLockManager {
  private readonly root: string;
  private readonly leaseMs: number;
  private readonly maxGlobalActive: number;
  private readonly maxDepth: number;
  private readonly now: () => number;
  private readonly isAlive: (identity: ProcessIdentity) => boolean;
  private renewTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: ProcessLockOptions = {}) {
    this.root = lockRoot(options.rootDir);
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxGlobalActive = options.maxGlobalActive ?? 0;
    this.maxDepth = options.maxDepth ?? defaultConfig.maxDepth;
    this.now = options.now ?? Date.now;
    this.isAlive = options.isAlive ?? isProcessAlive;
    ensureDirSync(this.root);
    ensureDirSync(path.join(this.root, "sessions"));
    ensureDirSync(path.join(this.root, "slots"));
    ensureDirSync(path.join(this.root, "runs"));
  }

  get rootDir(): string {
    return this.root;
  }

  // ---- Session resume locks ------------------------------------------------

  /**
   * Acquire exclusive ownership of a child session for direct resume.
   * Returns the owner record on success, or the current conflict owner.
   */
  acquireSessionLock(
    childSessionId: string,
    owner: { ownerId: string; runId: string; parentSessionKey: string },
  ): { ok: true; lock: SessionLockOwner } | { ok: false; conflict: SessionLockOwner } {
    const file = sessionLockPath(this.root, childSessionId);
    ensureDirSync(path.dirname(file));
    // Attempt up to 2 times: reclaim a demonstrably-stale lock then retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      let created = false;
      let fd: number | undefined;
      let identity: fs.Stats | undefined;
      try {
        // Exclusive create. Existence of the file == lock held.
        fd = fs.openSync(file, "wx");
        created = true;
        identity = fs.fstatSync(fd);
        const record: SessionLockOwner = {
          ownerId: owner.ownerId,
          runId: owner.runId,
          parentSessionKey: owner.parentSessionKey,
          process: currentProcessIdentity(),
          acquiredAt: this.now(),
          leaseExpiresAt: this.now() + this.leaseMs,
          childSessionId,
        };
        fs.writeFileSync(fd, JSON.stringify(record, null, 2), "utf8");
        fs.closeSync(fd);
        fd = undefined;
        this.startLeaseRenewal(childSessionId, record);
        return { ok: true, lock: record };
      } catch (error: any) {
        if (created) {
          if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Preserve the original initialization error. */ } }
          this.stopLeaseRenewal(childSessionId);
          // Only clean up the file we just created, never another owner's replacement.
          try {
            const current = fs.statSync(file);
            if (identity && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(file);
          } catch { /* Cleanup cannot mask the original I/O failure. */ }
          throw error;
        }
        if (error?.code !== "EEXIST") throw error;
        const existing = readJsonSync<SessionLockOwner>(file);
        if (!existing) {
          // Another process may be between exclusive creation and its first write.
          // An unreadable existing record is ambiguous, never proof of a stale owner.
          break;
        }
        // Same owner re-acquiring is fine (idempotent).
        if (existing.ownerId === owner.ownerId || existing.runId === owner.runId) {
          existing.leaseExpiresAt = this.now() + this.leaseMs;
          writeJsonAtomicSync(file, existing);
          this.startLeaseRenewal(childSessionId, existing);
          return { ok: true, lock: existing };
        }
        // Stale evaluation: see isSessionLockStale (host × identity × lease matrix).
        const stale = this.isSessionLockStale(existing);
        if (stale && attempt === 0) {
          try {
            fs.unlinkSync(file);
          } catch {
            /* raced with another reclaim */
          }
          continue;
        }
        return { ok: false, conflict: existing };
      }
    }
    const conflict = readJsonSync<SessionLockOwner>(sessionLockPath(this.root, childSessionId));
    return {
      ok: false,
      conflict: conflict ?? {
        ownerId: "unknown",
        runId: "unknown",
        parentSessionKey: "unknown",
        process: { pid: 0, startTime: 0, hostname: HOSTNAME },
        acquiredAt: 0,
        leaseExpiresAt: 0,
        childSessionId,
      },
    };
  }

  releaseSessionLock(childSessionId: string, ownerIdOrRunId?: string): void {
    this.stopLeaseRenewal(childSessionId);
    const file = sessionLockPath(this.root, childSessionId);
    const existing = readJsonSync<SessionLockOwner>(file);
    if (!existing) return;
    if (
      ownerIdOrRunId &&
      existing.ownerId !== ownerIdOrRunId &&
      existing.runId !== ownerIdOrRunId
    ) {
      return;
    }
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }

  /**
   * Read-only availability probe for a direct-resume lock. Uses the same
   * host × identity × lease staleness matrix as acquisition, but **never** opens,
   * unlinks, writes, renews or reaps anything. Live/ambiguous owners report `held`
   * (the caller must reject); a demonstrably stale owner reports `reclaimable` and
   * is left untouched for the authoritative atomic acquire at launch.
   */
  checkResumeAvailability(childSessionId: string): SessionLockAvailability {
    const file = sessionLockPath(this.root, childSessionId);
    const owner = readJsonSync<SessionLockOwner>(file);
    if (!owner) {
      // Distinguish "no lock" from an unreadable/ambiguous record that still exists.
      if (fs.existsSync(file)) {
        return { childSessionId, status: "held", reason: "lock record is unreadable or ambiguous" };
      }
      return { childSessionId, status: "free" };
    }
    if (this.isSessionLockStale(owner)) {
      return { childSessionId, status: "reclaimable", owner, reason: "stale owner (dead process or expired lease); reclaimable at acquire" };
    }
    return { childSessionId, status: "held", owner, reason: "live or ambiguous owner" };
  }

  private startLeaseRenewal(childSessionId: string, record: SessionLockOwner): void {
    this.stopLeaseRenewal(childSessionId);
    const interval = Math.max(1_000, Math.floor(this.leaseMs / 3));
    const timer = setInterval(() => {
      const file = sessionLockPath(this.root, childSessionId);
      const current = readJsonSync<SessionLockOwner>(file);
      if (!current || (current.ownerId !== record.ownerId && current.runId !== record.runId)) {
        this.stopLeaseRenewal(childSessionId);
        return;
      }
      current.leaseExpiresAt = this.now() + this.leaseMs;
      current.process = currentProcessIdentity();
      try {
        writeJsonAtomicSync(file, current);
      } catch {
        this.stopLeaseRenewal(childSessionId);
      }
    }, interval);
    timer.unref?.();
    this.renewTimers.set(childSessionId, timer);
  }

  private stopLeaseRenewal(childSessionId: string): void {
    const timer = this.renewTimers.get(childSessionId);
    if (timer) {
      clearInterval(timer);
      this.renewTimers.delete(childSessionId);
    }
  }

  // ---- Global concurrency slots -------------------------------------------

  /**
   * Slots held back for strictly deeper nesting tiers so a shallow fan-out cannot
   * exhaust the machine-wide cap while nested parents wait on their children.
   *
   * With defaults (cap 16, maxDepth 2): depth-0 may hold at most 15 slots, so
   * depth-1 spawns always have ≥1 free. Single-level fan-out at maxDepth 1
   * reserves 0 and can still fill the full cap.
   *
   * PLAN 3.1 numeric contract: reserve `max(0, maxDepth - 1 - depth)` (the
   * written `min(depth, maxDepth-1)` form is inverted relative to the example).
   */
  private reservedFor(depth: number): number {
    if (this.maxDepth <= 1) return 0;
    return Math.max(0, this.maxDepth - 1 - Math.max(0, depth));
  }

  /**
   * Try to claim a machine-wide concurrency slot. Returns undefined when the
   * global cap is 0 (disabled) or when a slot is granted. Throws when the
   * tiered budget for `depth` is exhausted.
   *
   * Slot records store `depth` (migration: missing field counts as depth 0).
   * Admission: `activeAtOrBelowDepth(depth) < maxGlobalActive - reservedFor(depth)`.
   */
  tryAcquireGlobalSlot(runId: string, depth = 0): SlotToken | undefined {
    if (!this.maxGlobalActive || this.maxGlobalActive <= 0) return undefined;
    const normalizedDepth = Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0;
    ensureDirSync(slotDir(this.root));
    this.reapDeadSlots();
    const limit = this.maxGlobalActive - this.reservedFor(normalizedDepth);
    const activeAtOrBelow = this.countLiveSlotsAtOrBelow(normalizedDepth);
    if (activeAtOrBelow >= limit || limit <= 0) {
      throw new Error(
        `Machine-wide subagent process limit reached (${this.maxGlobalActive}` +
          `; depth ${normalizedDepth} budget ${Math.max(0, limit)}). ` +
          `Wait for other Pi sessions to finish, raise PI_SUBAGENT_MAX_GLOBAL_ACTIVE, or cancel running subagents.`,
      );
    }
    const slotId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const file = path.join(slotDir(this.root), `${slotId}.slot`);
    const token: SlotToken = { slotId, path: file, runId, released: false };
    writeJsonAtomicSync(file, {
      slotId,
      runId,
      depth: normalizedDepth,
      process: currentProcessIdentity(),
      acquiredAt: this.now(),
    });
    return token;
  }

  releaseGlobalSlot(token: SlotToken | undefined): void {
    if (!token || token.released) return;
    token.released = true;
    try {
      fs.unlinkSync(token.path);
    } catch {
      /* already gone */
    }
  }

  /** Count live slot files whose recorded depth is ≤ the given depth (missing → 0). */
  private countLiveSlotsAtOrBelow(depth: number): number {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(slotDir(this.root));
    } catch {
      return 0;
    }
    let count = 0;
    for (const name of entries) {
      if (!name.endsWith(".slot")) continue;
      const file = path.join(slotDir(this.root), name);
      const data = readJsonSync<{ depth?: number; process?: ProcessIdentity }>(file);
      if (!data?.process || !this.isAlive(data.process)) continue;
      const slotDepth = typeof data.depth === "number" && Number.isFinite(data.depth) ? data.depth : 0;
      if (slotDepth <= depth) count++;
    }
    return count;
  }

  private reapDeadSlots(): void {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(slotDir(this.root));
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".slot")) continue;
      const file = path.join(slotDir(this.root), name);
      const data = readJsonSync<{ process?: ProcessIdentity }>(file);
      if (!data?.process || !this.isAlive(data.process)) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* raced */
        }
      }
    }
  }

  /**
   * Whether an existing session lock may be unlinked and reclaimed.
   *
   * Matrix (host match × identity-verifiable × lease):
   * - Same host, start-time identity match, process dead → reclaim immediately.
   * - Same host, identity unknown (no startTime) → reclaim after **2×** lease
   *   (clock skew / PID recycle both plausible on one machine). Live PIDs
   *   with unknown identity still need the 2× window even if the soft lease
   *   expired once.
   * - Different host (or otherwise not locally verifiable across hosts) →
   *   reclaim after **one** lease period (`leaseExpiresAt < now`). Local
   *   process checks are meaningless cross-host, so dead-looking hosts are
   *   not treated as immediate free-for-all.
   *
   * Clock-skew assumption (inline): on the same host, clocks are shared so a
   * single expired lease could be skew or a stall; double the window before
   * trusting expiry alone. Across hosts, we only have the lease wall-clock
   * and resume after one period once expired — we never assume foreign
   * host liveness.
   */
  private isSessionLockStale(owner: SessionLockOwner): boolean {
    const now = this.now();
    const leaseExpiresAt = owner.leaseExpiresAt;
    const leaseExpired = leaseExpiresAt > 0 && leaseExpiresAt < now;
    const doubleLeaseExpired = leaseExpiresAt > 0 && leaseExpiresAt + this.leaseMs < now;
    const sameHost = !owner.process.hostname || owner.process.hostname === HOSTNAME;
    // Non-zero startTime lets isAlive distinguish recycled PIDs from the owner.
    const identityVerifiable = owner.process.pid > 0 && owner.process.startTime > 0;

    if (sameHost) {
      if (identityVerifiable) {
        // Verifiably dead with start-time match → immediate. Live owner keeps the lock
        // even if a renewal ticked late (degrade open on runtime).
        return !this.isAlive(owner.process);
      }
      // Identity unknown: ESRCH means nothing is at that pid → free immediately.
      // If something answers kill(0), only the 2× lease window can reclaim.
      if (!this.isAlive(owner.process)) return true;
      return doubleLeaseExpired;
    }

    // Cross-host / foreign host: do **not** consult local isAlive (default
    // treats other hostnames as dead). Reclaim only after one lease period.
    return leaseExpired;
  }

  // ---- Run process records (orphan reconcile) ------------------------------

  writeRunRecord(record: RunProcessRecord): void {
    const previous = this.readRunRecord(record.runId);
    if (record.childSessionIds !== undefined || (previous?.state === "running" && previous.childSessionIds !== undefined)) {
      record = { ...record, childSessionIds: [...new Set([
        ...runRecordSessionIds(record),
        ...(previous?.state === "running" ? runRecordSessionIds(previous) : []),
      ])].slice(0, MAX_ROUTING_MODELS) };
    }
    writeJsonAtomicSync(runRecordPath(this.root, record.runId), record);
  }

  readRunRecord(runId: string): RunProcessRecord | undefined {
    return readJsonSync<RunProcessRecord>(runRecordPath(this.root, runId));
  }

  markRunTerminal(runId: string, terminalState: string): void {
    const existing = this.readRunRecord(runId);
    const next: RunProcessRecord = existing
      ? { ...existing, state: "terminal", terminalState, updatedAt: this.now() }
      : {
          runId,
          parentSessionKey: "",
          process: { pid: 0, startTime: 0, hostname: HOSTNAME },
          startedAt: this.now(),
          state: "terminal",
          terminalState,
          updatedAt: this.now(),
        };
    this.writeRunRecord(next);
  }

  deleteRunRecord(runId: string): void {
    try {
      fs.unlinkSync(runRecordPath(this.root, runId));
    } catch {
      /* gone */
    }
  }

  listRunRecords(): RunProcessRecord[] {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(path.join(this.root, "runs"));
    } catch {
      return [];
    }
    const out: RunProcessRecord[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const record = readJsonSync<RunProcessRecord>(path.join(this.root, "runs", name));
      if (record) out.push(record);
    }
    return out;
  }

  /**
   * Kill any still-alive process trees recorded as running (orphan reclaim).
   * Returns the set of runIds that were reaped.
   */
  async reconcileOrphans(options: {
    /** Grace between SIGTERM and SIGKILL. */
    killGraceMs?: number;
    /** Only reconcile records for this parent session key (optional). */
    parentSessionKey?: string;
    /** Skip run ids that the current registry still owns live. */
    skipRunIds?: ReadonlySet<string>;
  } = {}): Promise<{ reaped: string[]; stillAlive: string[]; alreadyDead: string[] }> {
    const killGraceMs = options.killGraceMs ?? 3_000;
    const report = { reaped: [] as string[], stillAlive: [] as string[], alreadyDead: [] as string[] };
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
    for (const record of this.listRunRecords()) {
      if (record.state === "terminal") {
        // Keep terminal records briefly for diagnostics; sweep later.
        continue;
      }
      if (options.parentSessionKey && record.parentSessionKey !== options.parentSessionKey) continue;
      if (options.skipRunIds?.has(record.runId)) continue;
      if (!this.isAlive(record.process)) {
        this.markRunTerminal(record.runId, "orphaned-dead");
        report.alreadyDead.push(record.runId);
        if (record.childSessionId) this.releaseSessionLock(record.childSessionId, record.runId);
        continue;
      }
      // Still alive: force-kill so "lost" is an honest terminal fact.
      killProcessTree(record.process, "SIGTERM");
      const deadline = this.now() + killGraceMs;
      while (this.now() < deadline && this.isAlive(record.process)) {
        await sleep(50);
      }
      if (this.isAlive(record.process)) {
        killProcessTree(record.process, "SIGKILL");
        await sleep(100);
      }
      this.markRunTerminal(record.runId, "orphaned-killed");
      if (record.childSessionId) this.releaseSessionLock(record.childSessionId, record.runId);
      if (this.isAlive(record.process)) report.stillAlive.push(record.runId);
      else report.reaped.push(record.runId);
    }
    return report;
  }

  /**
   * Remove terminal run records older than retentionMs and dead session locks.
   */
  sweep(retentionMs = 7 * 24 * 60 * 60_000): { removedRuns: number; removedLocks: number } {
    let removedRuns = 0;
    let removedLocks = 0;
    const cutoff = this.now() - retentionMs;
    for (const record of this.listRunRecords()) {
      if (record.state === "terminal" && record.updatedAt < cutoff) {
        this.deleteRunRecord(record.runId);
        removedRuns++;
      }
    }
    let locks: string[] = [];
    try {
      locks = fs.readdirSync(path.join(this.root, "sessions"));
    } catch {
      locks = [];
    }
    for (const name of locks) {
      if (!name.endsWith(".lock")) continue;
      const file = path.join(this.root, "sessions", name);
      const owner = readJsonSync<SessionLockOwner>(file);
      if (owner && this.isSessionLockStale(owner)) {
        try {
          fs.unlinkSync(file);
          removedLocks++;
        } catch {
          /* raced */
        }
      }
    }
    this.reapDeadSlots();
    return { removedRuns, removedLocks };
  }

  dispose(): void {
    for (const childSessionId of [...this.renewTimers.keys()]) this.stopLeaseRenewal(childSessionId);
  }
}

/** Async mkdir variation used when callers need await. */
export async function ensureLockRoot(root?: string): Promise<string> {
  const dir = lockRoot(root);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.mkdir(path.join(dir, "sessions"), { recursive: true });
  await fsp.mkdir(path.join(dir, "slots"), { recursive: true });
  await fsp.mkdir(path.join(dir, "runs"), { recursive: true });
  return dir;
}
