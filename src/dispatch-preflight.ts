import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import type { PreparedTask } from "./policy.js";
import type { ResumeAvailabilityResult } from "./registry.js";

/** Read-only checks shared by plan and execution, before any paid selector request. */
export interface LocalPreflightDeps {
  signal: AbortSignal;
  assertOwner(): void;
  checkResumeAvailability(tasks: readonly PreparedTask[]): ResumeAvailabilityResult;
  isGitRepo(cwd: string, signal: AbortSignal): Promise<boolean>;
  stat?(path: string): Promise<{ isDirectory(): boolean }>;
  access?(path: string, mode?: number): Promise<void>;
}

export async function runLocalPreflights(
  tasks: readonly PreparedTask[],
  parentCwd: string,
  deps: LocalPreflightDeps,
): Promise<void> {
  deps.assertOwner();
  if (deps.signal.aborted) throw new Error("Local preflight cancelled; no selector request was sent.");
  const resume = deps.checkResumeAvailability(tasks);
  if (!resume.ok) {
    const conflict = resume.conflict!;
    throw new Error(`Child session ${conflict.sessionId} is unavailable (${conflict.reason}, run ${conflict.runId}). Use fork_resume:true for an independent continuation.`);
  }
  const direct = tasks.filter((task) => task.resume && !task.forkResume).map((task) => task.resume);
  if (new Set(direct).size !== direct.length) throw new Error("The same child session cannot be directly resumed by two tasks in one run. Use fork_resume:true.");
  const stat = deps.stat ?? fs.stat;
  const access = deps.access ?? fs.access;

  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index]!;
    const controller = new AbortController();
    let timedOut = false;
    const remaining = task.deadline === undefined ? task.timeoutMs : task.deadline - Date.now();
    const interrupted = () => new Error(timedOut
      ? `Task ${index + 1}: timeout during local preflight; no selector request was sent.`
      : "Local preflight cancelled; no selector request was sent.");
    const check = () => {
      deps.assertOwner();
      if (task.deadline !== undefined && Date.now() >= task.deadline) timedOut = true;
      if (timedOut || deps.signal.aborted || controller.signal.aborted) throw interrupted();
    };
    if (remaining <= 0) { timedOut = true; throw interrupted(); }
    check();
    let rejectInterrupted!: (reason: Error) => void;
    const interruption = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    const onAbort = () => { controller.abort(); rejectInterrupted(interrupted()); };
    deps.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; onAbort(); }, remaining);
    timer.unref?.();
    // fs.stat/access do not accept AbortSignal. Racing them bounds the caller; check()
    // after every await also prevents a late filesystem response from starting more work.
    const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
      check();
      const value = await Promise.race([operation(), interruption]);
      check();
      return value;
    };
    try {
      const cwd = task.cwd ?? parentCwd;
      const cwdStat = await wait(() => stat(cwd).catch(() => undefined));
      if (!cwdStat?.isDirectory()) throw new Error(`Task ${index + 1}: working directory does not exist: ${cwd}`);
      if (task.isolation === "worktree" && !(await wait(() => deps.isGitRepo(cwd, controller.signal)))) {
        throw new Error(`Task ${index + 1}: ${cwd} is not a git repository`);
      }
      if (task.contextFork) {
        if (!task.parentSessionFile) throw new Error(`Task ${index + 1}: context:'fork' requires a persisted parent session file`);
        const readable = await wait(() => access(task.parentSessionFile!).then(() => true, () => false));
        if (!readable) throw new Error(`Task ${index + 1}: context:'fork' parent session file is not readable.`);
      }
      if (task.output) {
        const parentDir = path.dirname(task.output);
        const parentStat = await wait(() => stat(parentDir).catch(() => undefined));
        if (!parentStat?.isDirectory()) throw new Error(`Task ${index + 1}: output parent directory does not exist: ${parentDir}`);
        const writable = await wait(() => access(parentDir, constants.W_OK).then(() => true, () => false));
        if (!writable) throw new Error(`Task ${index + 1}: output parent directory is not writable: ${parentDir}`);
      }
    } finally {
      clearTimeout(timer);
      deps.signal.removeEventListener("abort", onAbort);
    }
  }
}
