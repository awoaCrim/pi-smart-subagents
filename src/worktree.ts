import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultConfig } from "./config.js";

export interface ExecResult { code: number; stdout: string; stderr: string }
export type ExecFn = (command: string, args: string[], cwd?: string, signal?: AbortSignal) => Promise<ExecResult>;

export interface WorktreeHandle {
  cwd: string;
  branch: string;
  baseCwd: string;
  baseCommit: string;
  changed: boolean;
  diffSummary?: string;
  /**
   * Baseline patch (vs baseCommit) seeded from the parent checkout's WIP when
   * `includeWip` was requested. Includes untracked files as intent-to-add diffs
   * after seeding. Used to subtract parent WIP from agent-only reports.
   */
  wipPatch?: string;
  /** Relative paths of parent untracked files copied into the worktree. */
  wipUntracked?: string[];
}

export interface SweepReport {
  pruned: boolean;
  removed: string[];
  kept: string[];
  /** Patch files written for reclaimed worktrees that held unique work. */
  archived: string[];
}

export interface GlobalSweepReport extends SweepReport {
  /** Base repos that were swept (resolved from containers + the current checkout). */
  swept: string[];
  /** Containers whose base repo is gone; kept untouched — see sweepAll policy. */
  orphanedContainers: string[];
}

export interface CreateWorktreeOptions {
  /** Seed the worktree with the parent checkout's uncommitted WIP (default false). */
  includeWip?: boolean;
}

export interface WorktreeDiffResult {
  stat: string;
  patch: string;
  truncated: boolean;
  /** Set when the report may still contain parent WIP because subtraction failed. */
  warning?: string;
}

export interface WorktreeApplyResult {
  applied: boolean;
  stat: string;
  /** Set when the applied patch may still contain parent WIP because subtraction failed. */
  warning?: string;
}

const WIP_PATCH_FILE = "wip.patch";
const BASE_REPO_FILE = "base-repo";
const WIP_UNTRACKED_FILE = "wip-untracked.txt";
const BASE_COMMIT_FILE = "base-commit";
/** Archived unique work of reclaimed worktrees, per repo container. */
const PATCHES_DIR = "_patches";
export const INCLUDES_PARENT_WIP = "[includes parent WIP]";

async function defaultExec(command: string, args: string[], cwd?: string, signal?: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Worktree command aborted"));
    const child = spawn(command, args, { cwd, signal, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function normalizePatch(patch: string): string {
  return patch.replace(/\r\n/g, "\n").replace(/\n+$/g, "\n");
}

/**
 * Safe git-worktree isolation. Changed means uncommitted changes OR commits beyond base.
 *
 * Worktrees live under a durable root (default ~/.pi/subagent-worktrees/<repo-hash>/),
 * never a purgeable OS tmpdir, so preserved work survives reboots. `sweep()` garbage
 * collects unchanged or expired leftovers from crashes and failed finalizations.
 */
export class WorktreeManager {
  constructor(
    private readonly execFn: ExecFn = defaultExec,
    private readonly rootDir: string = defaultConfig.worktreeDir,
  ) {}

  async isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
    // Spawn rejects (ENOENT) when cwd itself no longer exists — not a repo.
    const result = await this.execFn("git", ["rev-parse", "--is-inside-work-tree"], cwd, signal)
      .catch(() => ({ code: 1, stdout: "", stderr: "" }));
    return result.code === 0 && result.stdout.trim() === "true";
  }

  /** Stable per-repo container so sweep can enumerate all worktrees for one repo. */
  repoRoot(baseCwd: string): string {
    const hash = createHash("sha256").update(path.resolve(baseCwd)).digest("hex").slice(0, 12);
    const name = path.basename(path.resolve(baseCwd)).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 32) || "repo";
    return path.join(this.rootDir, `${name}-${hash}`);
  }

  private containerOf(cwd: string): string {
    return path.dirname(cwd);
  }

  private async writeWipArtifacts(cwd: string, wipPatch: string, wipUntracked: string[]): Promise<void> {
    const root = this.containerOf(cwd);
    await fs.writeFile(path.join(root, WIP_PATCH_FILE), wipPatch, "utf8").catch(() => {});
    await fs.writeFile(path.join(root, WIP_UNTRACKED_FILE), `${wipUntracked.join("\n")}${wipUntracked.length ? "\n" : ""}`, "utf8").catch(() => {});
  }

  private async loadWipArtifacts(cwd: string): Promise<{ wipPatch?: string; wipUntracked?: string[] }> {
    const root = this.containerOf(cwd);
    const patch = await fs.readFile(path.join(root, WIP_PATCH_FILE), "utf8").catch(() => undefined);
    const listRaw = await fs.readFile(path.join(root, WIP_UNTRACKED_FILE), "utf8").catch(() => undefined);
    const wipUntracked = listRaw === undefined
      ? undefined
      : listRaw.split("\n").map((line) => line.trim()).filter(Boolean);
    return {
      wipPatch: patch === undefined ? undefined : patch,
      wipUntracked,
    };
  }

  private async resolveWip(
    worktree: { cwd: string; wipPatch?: string; wipUntracked?: string[] },
  ): Promise<{ wipPatch?: string; wipUntracked?: string[] }> {
    if (worktree.wipPatch !== undefined || worktree.wipUntracked !== undefined) {
      return { wipPatch: worktree.wipPatch, wipUntracked: worktree.wipUntracked };
    }
    return this.loadWipArtifacts(worktree.cwd);
  }

  private async captureParentWip(
    baseCwd: string,
    signal?: AbortSignal,
  ): Promise<{ patch: string; untracked: string[] }> {
    const diff = await this.execFn("git", ["diff", "--binary", "HEAD"], baseCwd, signal);
    if (diff.code !== 0) throw new Error(`Unable to capture parent WIP: ${diff.stderr.trim()}`);
    const ls = await this.execFn("git", ["ls-files", "-o", "--exclude-standard"], baseCwd, signal);
    if (ls.code !== 0) throw new Error(`Unable to list untracked files: ${ls.stderr.trim()}`);
    const untracked = ls.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return { patch: diff.stdout, untracked };
  }

  /** Stream a patch into `git apply` (optionally reverse). */
  private async applyPatchStream(
    cwd: string,
    patch: string,
    options: { reverse?: boolean; check?: boolean; signal?: AbortSignal } = {},
  ): Promise<ExecResult> {
    if (!patch.trim()) return { code: 0, stdout: "", stderr: "" };
    const args = ["apply", "--whitespace=nowarn"];
    if (options.reverse) args.push("--reverse");
    if (options.check) args.push("--check");
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("git", args, {
        cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        signal: options.signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin?.on("error", () => { /* EPIPE when git exits early */ });
      child.stdin?.end(patch);
    });
  }

  private async seedWipIntoWorktree(
    cwd: string,
    baseCwd: string,
    baseCommit: string,
    parentWip: { patch: string; untracked: string[] },
    signal?: AbortSignal,
  ): Promise<{ wipPatch: string; wipUntracked: string[] }> {
    if (parentWip.patch.trim()) {
      const applied = await this.applyPatchStream(cwd, parentWip.patch, { signal });
      if (applied.code !== 0) {
        throw new Error(`Unable to seed parent WIP into worktree: ${applied.stderr.trim() || applied.stdout.trim() || "git apply failed"}`);
      }
    }
    for (const rel of parentWip.untracked) {
      // Guard against absolute / traversal paths from a hostile listing.
      if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) continue;
      const src = path.join(baseCwd, rel);
      const dest = path.join(cwd, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
    // Snapshot the full baseline (tracked WIP + untracked as intent-to-add) so
    // later subtraction is a single reverse-apply against one stored patch.
    await this.stageUntracked(cwd, signal);
    const snap = await this.execFn("git", ["diff", "--binary", baseCommit], cwd, signal);
    if (snap.code !== 0) throw new Error(`Unable to snapshot seeded WIP: ${snap.stderr.trim()}`);
    return { wipPatch: snap.stdout, wipUntracked: parentWip.untracked };
  }

  async create(
    baseCwd: string,
    label = "subagent",
    signal?: AbortSignal,
    options: CreateWorktreeOptions = {},
  ): Promise<WorktreeHandle> {
    if (!(await this.isGitRepo(baseCwd, signal))) throw new Error(`${baseCwd} is not a git repository`);
    const head = await this.execFn("git", ["rev-parse", "HEAD"], baseCwd, signal);
    if (head.code !== 0) throw new Error(`Unable to resolve HEAD: ${head.stderr.trim()}`);
    const baseCommit = head.stdout.trim();
    const id = randomUUID().slice(0, 8);
    const safe = label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 24) || "task";
    const branch = `pi-subagent/${safe}-${id}`;
    const root = path.join(this.repoRoot(baseCwd), `${safe}-${id}`);
    await fs.mkdir(root, { recursive: true });
    const cwd = path.join(root, "work");

    // Capture parent WIP before worktree add so concurrent parent edits mid-create
    // cannot partially seed the child.
    let parentWip: { patch: string; untracked: string[] } | undefined;
    if (options.includeWip) {
      parentWip = await this.captureParentWip(baseCwd, signal);
    }

    try {
      const result = await this.execFn("git", ["worktree", "add", "-b", branch, cwd, baseCommit], baseCwd, signal);
      if (result.code !== 0) throw new Error(result.stderr.trim() || "git worktree add failed");
      // Markers let sweep() find the owning repo and diff base for orphaned directories.
      await fs.writeFile(path.join(root, BASE_REPO_FILE), `${path.resolve(baseCwd)}\n`, "utf8").catch(() => {});
      await fs.writeFile(path.join(root, BASE_COMMIT_FILE), `${baseCommit}\n`, "utf8").catch(() => {});

      let wipPatch: string | undefined;
      let wipUntracked: string[] | undefined;
      if (parentWip && (parentWip.patch.trim() || parentWip.untracked.length)) {
        const seeded = await this.seedWipIntoWorktree(cwd, baseCwd, baseCommit, parentWip, signal);
        wipPatch = seeded.wipPatch;
        wipUntracked = seeded.wipUntracked;
        await this.writeWipArtifacts(cwd, wipPatch, wipUntracked);
      }
      return { cwd, branch, baseCwd, baseCommit, changed: false, wipPatch, wipUntracked };
    } catch (error) {
      await this.execFn("git", ["worktree", "remove", "--force", cwd], baseCwd).catch(() => {});
      await this.execFn("git", ["branch", "-D", branch], baseCwd).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * True when the worktree has no commits beyond base and its working tree is
   * either empty or bit-for-bit the seeded parent WIP baseline.
   */
  private async isOnlyWipSeed(handle: WorktreeHandle, signal?: AbortSignal): Promise<boolean> {
    const { wipPatch } = await this.resolveWip(handle);
    if (wipPatch === undefined) return false;
    await this.stageUntracked(handle.cwd, signal);
    const current = await this.execFn("git", ["diff", "--binary", handle.baseCommit], handle.cwd, signal);
    if (current.code !== 0) return false;
    return normalizePatch(current.stdout) === normalizePatch(wipPatch);
  }

  async refreshStatus(handle: WorktreeHandle, signal?: AbortSignal): Promise<WorktreeHandle> {
    const status = await this.execFn("git", ["status", "--porcelain"], handle.cwd, signal);
    if (status.code !== 0) throw new Error(`Unable to inspect worktree: ${status.stderr.trim()}`);
    const head = await this.execFn("git", ["rev-parse", "HEAD"], handle.cwd, signal);
    if (head.code !== 0) throw new Error(`Unable to inspect worktree HEAD: ${head.stderr.trim()}`);
    const hasCommits = head.stdout.trim() !== handle.baseCommit;
    const hasWorkingChanges = status.stdout.trim().length > 0;
    let changed = hasCommits || hasWorkingChanges;
    // Seeded-but-untouched WIP is not agent work → treat as unchanged so finalize cleans up.
    if (changed && !hasCommits && (handle.wipPatch !== undefined || (await this.loadWipArtifacts(handle.cwd)).wipPatch !== undefined)) {
      if (await this.isOnlyWipSeed(handle, signal)) changed = false;
    }
    let diffSummary: string | undefined;
    if (changed) {
      const diff = await this.execFn("git", ["diff", "--stat", `${handle.baseCommit}..HEAD`], handle.cwd, signal);
      const working = await this.execFn("git", ["diff", "--stat"], handle.cwd, signal);
      diffSummary = [diff.stdout.trim(), working.stdout.trim(), status.stdout.trim()].filter(Boolean).join("\n");
    }
    return { ...handle, changed, diffSummary };
  }

  /** Preserve any branch with commits or uncommitted work; delete only truly unchanged worktrees. */
  async finalize(handle: WorktreeHandle, signal?: AbortSignal): Promise<WorktreeHandle> {
    const latest = await this.refreshStatus(handle, signal);
    if (latest.changed) return latest;
    const removed = await this.execFn("git", ["worktree", "remove", "--force", latest.cwd], latest.baseCwd);
    if (removed.code !== 0) throw new Error(`Unable to remove unchanged worktree: ${removed.stderr.trim()}`);
    await this.execFn("git", ["branch", "-D", latest.branch], latest.baseCwd).catch(() => {});
    await fs.rm(path.dirname(latest.cwd), { recursive: true, force: true });
    return latest;
  }

  /** Make untracked files visible to `git diff` (intent-to-add). Safe on finished worktrees. */
  private async stageUntracked(cwd: string, signal?: AbortSignal): Promise<void> {
    await this.execFn("git", ["add", "-A", "--intent-to-add"], cwd, signal).catch(() => {});
  }

  private async currentFullDiff(
    worktree: { cwd: string; baseCommit: string },
    signal?: AbortSignal,
  ): Promise<{ stat: string; patch: string }> {
    await this.stageUntracked(worktree.cwd, signal);
    const stat = await this.execFn("git", ["diff", "--stat", worktree.baseCommit], worktree.cwd, signal);
    if (stat.code !== 0) throw new Error(`Unable to diff worktree: ${stat.stderr.trim()}`);
    const patch = await this.execFn("git", ["diff", "--binary", worktree.baseCommit], worktree.cwd, signal);
    if (patch.code !== 0) throw new Error(`Unable to diff worktree: ${patch.stderr.trim()}`);
    return { stat: stat.stdout.trim(), patch: patch.stdout };
  }

  /**
   * Subtract stored parent WIP from the combined worktree delta when reverse
   * application is clean. Returns combined delta + warning otherwise.
   */
  private async subtractWip(
    worktree: { cwd: string; baseCommit: string; baseCwd?: string },
    combined: { stat: string; patch: string },
    wipPatch: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ stat: string; patch: string; clean: boolean }> {
    if (wipPatch === undefined) return { ...combined, clean: true };
    if (!wipPatch.trim()) return { ...combined, clean: true };
    if (!combined.patch.trim()) return { stat: "", patch: "", clean: true };
    if (normalizePatch(combined.patch) === normalizePatch(wipPatch)) {
      return { stat: "", patch: "", clean: true };
    }

    // Reverse-apply WIP on a throwaway worktree that first receives the combined
    // delta. Success → remaining diff is agent-only. Failure → never invent a
    // partial result; callers report the combined delta with a warning.
    const preferBase = worktree.baseCwd;
    const tmpRoot = await fs.mkdtemp(path.join(this.containerOf(worktree.cwd), "wip-sub-"));
    const tmp = path.join(tmpRoot, "work");
    try {
      // Attach against the live base checkout when known; otherwise the seeded
      // worktree itself (same object store) so extension actions without baseCwd work.
      let addBase = worktree.cwd;
      if (preferBase && (await this.isGitRepo(preferBase, signal))) addBase = preferBase;
      const added = await this.execFn(
        "git",
        ["worktree", "add", "--detach", tmp, worktree.baseCommit],
        addBase,
        signal,
      );
      if (added.code !== 0) return { ...combined, clean: false };

      const forward = await this.applyPatchStream(tmp, combined.patch, { signal });
      if (forward.code !== 0) return { ...combined, clean: false };
      const reverse = await this.applyPatchStream(tmp, wipPatch, { reverse: true, signal });
      if (reverse.code !== 0) return { ...combined, clean: false };

      await this.stageUntracked(tmp, signal);
      const agentStat = await this.execFn("git", ["diff", "--stat", worktree.baseCommit], tmp, signal);
      const agentPatch = await this.execFn("git", ["diff", "--binary", worktree.baseCommit], tmp, signal);
      if (agentStat.code !== 0 || agentPatch.code !== 0) return { ...combined, clean: false };
      return { stat: agentStat.stdout.trim(), patch: agentPatch.stdout, clean: true };
    } catch {
      return { ...combined, clean: false };
    } finally {
      if (preferBase) {
        await this.execFn("git", ["worktree", "remove", "--force", tmp], preferBase).catch(() => {});
      }
      await this.execFn("git", ["worktree", "remove", "--force", tmp], worktree.cwd).catch(() => {});
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Full patch (committed beyond base + uncommitted + untracked) of a worktree, capped. */
  async diff(
    worktree: { cwd: string; baseCommit: string; wipPatch?: string; wipUntracked?: string[]; baseCwd?: string },
    maxBytes = 256 * 1024,
    signal?: AbortSignal,
  ): Promise<WorktreeDiffResult> {
    const combined = await this.currentFullDiff(worktree, signal);
    const { wipPatch } = await this.resolveWip(worktree);
    const subtracted = await this.subtractWip(worktree, combined, wipPatch, signal);
    const full = subtracted.patch;
    const truncated = Buffer.byteLength(full, "utf8") > maxBytes;
    const warning = subtracted.clean ? undefined : INCLUDES_PARENT_WIP;
    const patch = truncated ? full.slice(0, maxBytes) : full;
    // When subtraction emptied the patch, recompute a neutral stat string.
    let stat = subtracted.stat;
    if (subtracted.clean && !full.trim()) stat = "";
    return {
      stat,
      patch,
      truncated,
      warning,
    };
  }

  /**
   * Apply a worktree's changes (committed + uncommitted vs base) onto the base
   * checkout as working-tree changes via `git apply --3way`. Never commits and
   * never deletes the worktree — review/discard stays a separate explicit step.
   *
   * With a stored WIP baseline, only agent-only changes are applied when
   * subtraction is clean; otherwise the combined delta is applied and a warning
   * is returned.
   */
  async apply(
    worktree: { cwd: string; baseCommit: string; branch?: string; wipPatch?: string; wipUntracked?: string[]; baseCwd?: string },
    baseCwd: string,
    signal?: AbortSignal,
  ): Promise<WorktreeApplyResult> {
    if (!(await this.isGitRepo(baseCwd, signal))) throw new Error(`${baseCwd} is not a git repository`);
    const status = await this.execFn("git", ["status", "--porcelain"], worktree.cwd, signal);
    if (status.code !== 0) throw new Error(`Unable to inspect worktree: ${status.stderr.trim()}`);
    const combined = await this.currentFullDiff(worktree, signal);
    const { wipPatch } = await this.resolveWip(worktree);
    const subtracted = await this.subtractWip({ ...worktree, baseCwd }, combined, wipPatch, signal);
    if (!subtracted.patch.trim()) return { applied: false, stat: "(no changes to apply)" };

    // --3way merges via blob identity (same object store) and surfaces conflicts
    // as markers instead of failing outright on drifted context.
    const result = await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("git", ["apply", "--3way", "--whitespace=nowarn"], {
        cwd: baseCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin?.on("error", () => { /* EPIPE when git exits early */ });
      child.stdin?.end(subtracted.patch);
    });
    if (result.code !== 0) {
      throw new Error(`git apply failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
    }
    const stat = await this.execFn("git", ["diff", "--stat"], baseCwd, signal);
    return {
      applied: true,
      stat: stat.stdout.trim() || "(applied)",
      warning: subtracted.clean ? undefined : INCLUDES_PARENT_WIP,
    };
  }

  async forceRemove(handle: WorktreeHandle): Promise<void> {
    await this.execFn("git", ["worktree", "remove", "--force", handle.cwd], handle.baseCwd).catch(() => {});
    await this.execFn("git", ["branch", "-D", handle.branch], handle.baseCwd).catch(() => {});
    await fs.rm(path.dirname(handle.cwd), { recursive: true, force: true });
  }

  /** Minimum age before sweep may touch a worktree; shields concurrent runtimes not in keepPaths. */
  static readonly SWEEP_MIN_AGE_MS = 60 * 60_000;

  /** Deterministic archived-patch location for a (possibly deleted) worktree cwd. */
  archivedPatchPathFor(cwd: string): string {
    const entry = path.basename(path.dirname(cwd));
    return path.join(path.dirname(path.dirname(cwd)), PATCHES_DIR, `${entry}.patch`);
  }

  /** Diff base for archival: create-time marker, else merge-base with the base repo HEAD. */
  private async resolveArchiveBase(cwd: string, baseCwd: string): Promise<string | undefined> {
    const marker = await fs
      .readFile(path.join(path.dirname(cwd), BASE_COMMIT_FILE), "utf8")
      .then((raw) => raw.trim())
      .catch(() => "");
    if (marker) return marker;
    const baseHead = await this.execFn("git", ["rev-parse", "HEAD"], baseCwd);
    if (baseHead.code !== 0) return undefined;
    const mergeBase = await this.execFn("git", ["merge-base", "HEAD", baseHead.stdout.trim()], cwd);
    if (mergeBase.code !== 0) return undefined;
    return mergeBase.stdout.trim() || undefined;
  }

  /**
   * Preserve a worktree's unique work (committed beyond base + uncommitted +
   * untracked) as one applyable patch file before its directory is reclaimed.
   * Returns the patch path, or undefined when nothing could be captured.
   */
  private async archiveWorktreePatch(
    cwd: string,
    base: string,
    meta: { branch: string; baseCwd: string },
  ): Promise<string | undefined> {
    await this.stageUntracked(cwd);
    const patch = await this.execFn("git", ["diff", "--binary", base], cwd);
    if (patch.code !== 0) return undefined;
    const body = patch.stdout;
    if (!body.trim()) return undefined;
    const file = this.archivedPatchPathFor(cwd);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const header = [
      `Archived pi-subagent worktree patch`,
      `branch: ${meta.branch}`,
      `base-commit: ${base}`,
      `base-repo: ${path.resolve(meta.baseCwd)}`,
      `archived-at: ${new Date().toISOString()}`,
      `apply with: git apply --3way ${path.basename(file)}`,
      ``,
    ].join("\n");
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, header + body, "utf8");
    await fs.rename(tmp, file);
    return file;
  }

  /** Apply an archived worktree patch onto a checkout as working-tree changes. */
  async applyArchivedPatch(patchFile: string, baseCwd: string, signal?: AbortSignal): Promise<WorktreeApplyResult> {
    if (!(await this.isGitRepo(baseCwd, signal))) throw new Error(`${baseCwd} is not a git repository`);
    const patch = await fs.readFile(patchFile, "utf8");
    const result = await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("git", ["apply", "--3way", "--whitespace=nowarn"], {
        cwd: baseCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin?.on("error", () => { /* EPIPE when git exits early */ });
      child.stdin?.end(patch);
    });
    if (result.code !== 0) {
      throw new Error(`git apply failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
    }
    const stat = await this.execFn("git", ["diff", "--stat"], baseCwd, signal);
    return { applied: true, stat: stat.stdout.trim() || "(applied)" };
  }

  /** True when every commit on `sha` is reachable from some ref other than `branch` itself. */
  private async isReachableElsewhere(baseCwd: string, sha: string, branch: string): Promise<boolean> {
    if (!sha) return false;
    const refs = await this.execFn(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "--contains", sha, "refs/heads", "refs/remotes", "refs/tags"],
      baseCwd,
    );
    if (refs.code !== 0) return false;
    return refs.stdout.split("\n").map((line) => line.trim()).filter(Boolean).some((ref) => ref !== branch);
  }

  /**
   * Lifecycle-driven reclamation for one repo. A worktree is "over" when it is
   * not referenced by any live run (`keepPaths`) and is past the concurrency
   * safety window. Over-worktrees are always reclaimed immediately — there is
   * no wall-clock retention. Their meaningful impact is preserved first:
   * - Unique work (dirty tree, or commits on no other ref) is archived as one
   *   applyable patch under `<repo-container>/_patches/`.
   * - A branch whose commits exist nowhere else is NEVER deleted, so committed
   *   work stays recoverable from git itself.
   * - The multi-GB directory (checkout + node_modules) is then removed.
   * `git worktree prune` clears stale registrations (deleted directories).
   * Never touches worktrees referenced by `keepPaths` (live runs).
   */
  async sweep(
    baseCwd: string,
    _retentionDays = defaultConfig.worktreeRetentionDays,
    keepPaths: ReadonlySet<string> = new Set(),
    now = Date.now(),
  ): Promise<SweepReport> {
    return this.sweepContainer(baseCwd, this.repoRoot(baseCwd), keepPaths, now);
  }

  /**
   * Sweep one container against its base repo. Split from `sweep()` because a
   * container's on-disk path may differ from `repoRoot(baseCwd)` when the base
   * path was recovered through a symlink-resolving gitdir pointer.
   */
  private async sweepContainer(
    baseCwd: string,
    container: string,
    keepPaths: ReadonlySet<string>,
    now: number,
  ): Promise<SweepReport> {
    const report: SweepReport = { pruned: false, removed: [], kept: [], archived: [] };
    if (!(await this.isGitRepo(baseCwd))) return report;
    const pruned = await this.execFn("git", ["worktree", "prune"], baseCwd).catch(() => ({ code: 1 } as ExecResult));
    report.pruned = pruned.code === 0;

    const entries = await fs.readdir(container, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // The archive directory is not a worktree container; never treat it as one.
      if (entry.name === PATCHES_DIR) continue;
      const root = path.join(container, entry.name);
      const cwd = path.join(root, "work");
      if (keepPaths.has(cwd)) {
        report.kept.push(cwd);
        continue;
      }
      const stat = await fs.stat(cwd).catch(() => undefined);
      if (!stat) {
        // Orphaned container (work dir already gone).
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
        report.removed.push(cwd);
        continue;
      }
      const age = now - stat.mtimeMs;
      if (age < WorktreeManager.SWEEP_MIN_AGE_MS) {
        // Too young: may belong to a concurrent runtime whose keepPaths we cannot see.
        report.kept.push(cwd);
        continue;
      }

      const branchResult = await this.execFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => undefined);
      const shaResult = await this.execFn("git", ["rev-parse", "HEAD"], cwd).catch(() => undefined);
      const statusResult = await this.execFn("git", ["status", "--porcelain"], cwd).catch(() => undefined);
      if (branchResult?.code !== 0 || shaResult?.code !== 0 || statusResult?.code !== 0) {
        // Unable to prove safety: keep.
        report.kept.push(cwd);
        continue;
      }
      const branch = branchResult.stdout.trim();
      const sha = shaResult.stdout.trim();
      let dirty = statusResult.stdout.trim().length > 0;
      // WIP-seeded leftovers with no agent edits are treated as clean for sweep.
      if (dirty) {
        const artifacts = await this.loadWipArtifacts(cwd);
        if (artifacts.wipPatch !== undefined) {
          const onlyWip = await this.isOnlyWipSeed(
            { cwd, branch, baseCwd, baseCommit: sha, changed: dirty, wipPatch: artifacts.wipPatch, wipUntracked: artifacts.wipUntracked },
          ).catch(() => false);
          if (onlyWip) dirty = false;
        }
      }
      const handle: WorktreeHandle = { cwd, branch, baseCwd, baseCommit: sha, changed: dirty };
      const uniqueCommits = !(await this.isReachableElsewhere(baseCwd, sha, branch));

      if (!dirty && !uniqueCommits) {
        // Fully redundant: clean tree, commits preserved on other refs.
        await this.forceRemove(handle).catch(() => {});
        report.removed.push(cwd);
        continue;
      }

      // The run is over and the worktree holds unique work: distill it. Archive
      // the full delta as one patch, then reclaim the directory. Failure to
      // archive keeps the worktree (never destroy work we could not preserve).
      const base = await this.resolveArchiveBase(cwd, baseCwd);
      let archived: string | undefined;
      if (base) {
        archived = await this.archiveWorktreePatch(cwd, base, { branch, baseCwd }).catch(() => undefined);
      }
      if (!archived) {
        report.kept.push(cwd);
        continue;
      }
      report.archived.push(archived);
      if (uniqueCommits) {
        // Keep the branch (commits exist nowhere else); drop only the directory.
        await this.execFn("git", ["worktree", "remove", "--force", cwd], baseCwd).catch(() => {});
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      } else {
        await this.forceRemove(handle).catch(() => {});
      }
      report.removed.push(cwd);
    }
    return report;
  }

  /**
   * Base repo of a container, from any worktree's create-time marker or its
   * linked `.git` gitdir pointer. A marker is trusted only when the base's
   * container hash round-trips (rejects moved repos / foreign directories);
   * a gitdir pointer only when its admin dir under the base still exists
   * (hashes cannot round-trip — git stores realpaths, containers may not).
   */
  private async resolveContainerBase(container: string): Promise<string | undefined> {
    const entries = await fs.readdir(container, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === PATCHES_DIR) continue;
      const root = path.join(container, entry.name);
      const marker = await fs.readFile(path.join(root, BASE_REPO_FILE), "utf8").then((raw) => raw.trim()).catch(() => "");
      if (marker && this.repoRoot(marker) === container && (await this.isGitRepo(marker))) return marker;
      const gitFile = await fs.readFile(path.join(root, "work", ".git"), "utf8").catch(() => "");
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile)?.[1];
      const linked = gitdir?.split(`${path.sep}.git${path.sep}worktrees${path.sep}`)[0];
      if (!linked || linked === gitdir) continue;
      const adminDir = await fs.stat(gitdir!).catch(() => undefined);
      if (adminDir?.isDirectory() && (await this.isGitRepo(linked))) return linked;
    }
    return undefined;
  }

  /**
   * Machine-wide lifecycle sweep: every repo container under the worktree root,
   * not just the current checkout's. Each container's base repo is resolved via
   * `resolveContainerBase` and reclaimed with the exact `sweep()` safety model
   * (archive-then-remove, unreachable branches kept, keepPaths + min-age shields).
   *
   * Policy for containers whose base repo no longer exists: **keep, never
   * delete**. The worktree's object store lives inside the deleted base repo,
   * so we cannot diff, archive, or even distinguish unique work from a pristine
   * checkout — removal could destroy the only remaining copy. They are reported
   * in `orphanedContainers` so the owner can delete them deliberately. Only
   * containers holding neither worktrees nor archived patches are removed.
   */
  async sweepAll(
    currentCwd?: string,
    keepPaths: ReadonlySet<string> = new Set(),
    now = Date.now(),
  ): Promise<GlobalSweepReport> {
    const report: GlobalSweepReport = { pruned: false, removed: [], kept: [], archived: [], swept: [], orphanedContainers: [] };
    const sweptContainers = new Set<string>();
    const sweepBase = async (baseCwd: string, container: string) => {
      if (sweptContainers.has(container)) return;
      sweptContainers.add(container);
      report.swept.push(path.resolve(baseCwd));
      const sub = await this.sweepContainer(path.resolve(baseCwd), container, keepPaths, now);
      report.pruned = report.pruned || sub.pruned;
      report.removed.push(...sub.removed);
      report.kept.push(...sub.kept);
      report.archived.push(...sub.archived);
    };
    if (currentCwd) await sweepBase(currentCwd, this.repoRoot(currentCwd)).catch(() => {});

    const containers = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of containers) {
      if (!entry.isDirectory()) continue;
      const container = path.join(this.rootDir, entry.name);
      if (sweptContainers.has(container)) continue;
      const baseCwd = await this.resolveContainerBase(container);
      if (baseCwd) {
        await sweepBase(baseCwd, container).catch(() => {});
        continue;
      }
      const contents = await fs.readdir(container).catch(() => []);
      const worktreeEntries = contents.filter((name) => name !== PATCHES_DIR);
      const patches = await fs.readdir(path.join(container, PATCHES_DIR)).catch(() => []);
      if (!worktreeEntries.length && !patches.length) {
        await fs.rm(container, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (worktreeEntries.length) report.orphanedContainers.push(container);
    }
    return report;
  }
}
