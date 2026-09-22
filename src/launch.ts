import * as fs from "node:fs";
import * as path from "node:path";
import type { GetPiCommand } from "./runner.js";

/**
 * Resolve the command used to spawn child `pi` processes.
 *
 * Preference order:
 * 1. `PI_SUBAGENT_BIN` (explicit override; path or PATH name)
 * 2. Same Node runtime + current CLI entry (`process.execPath` + `process.argv[1]`)
 * 3. Bare `"pi"` on PATH as a last-resort, logged fallback
 *
 * Pinning the executing entrypoint avoids ENOENT under GUI/editor launches and
 * wrong-version silent failures when multiple Pi installs share PATH.
 */
export interface LaunchResolution {
  command: string;
  /** Prefix args inserted before child flags (usually the CLI entry path). */
  argsPrefix: string[];
  source: "env" | "exec-path" | "path-fallback";
  note?: string;
}

function looksLikeJsEntry(file: string): boolean {
  const lower = file.toLowerCase();
  return (
    lower.endsWith(".js") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  );
}

function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an argv[1] candidate to a real JS entry file, following symlinks.
 * npm/Homebrew global installs expose extensionless bin shims (e.g.
 * `/opt/homebrew/bin/pi -> …/dist/cli.js`), so the symlink target — not the
 * shim path — is what identifies a Node CLI entry.
 */
function resolveJsEntry(candidate: string): string | undefined {
  let entry = path.resolve(candidate);
  try {
    entry = fs.realpathSync(entry);
  } catch {
    return undefined;
  }
  return looksLikeJsEntry(entry) && fileExists(entry) ? entry : undefined;
}

/** Pure resolver suitable for tests; does not touch process globals until called. */
export function resolvePiLaunch(
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
  argv: readonly string[] = process.argv,
): LaunchResolution {
  const override = env.PI_SUBAGENT_BIN?.trim();
  if (override) {
    return { command: override, argsPrefix: [], source: "env" };
  }

  // `argv[1]` is the userland entry for a normal Node CLI / tsx / “node path/to/pi.js”
  // launch. Global installs go through an extensionless bin symlink, so follow
  // symlinks to the real file before judging it. Bundled / pkg-style binaries
  // often leave argv[1] unset or not a real path.
  const entry = argv[1] ? resolveJsEntry(argv[1]) : undefined;
  if (entry && execPath) {
    return {
      command: execPath,
      argsPrefix: [entry],
      source: "exec-path",
      note: `Using ${execPath} ${entry}`,
    };
  }

  return {
    command: "pi",
    argsPrefix: [],
    source: "path-fallback",
    note: "Could not resolve the current Pi CLI entry; falling back to bare 'pi' on PATH. Set PI_SUBAGENT_BIN to pin an executable.",
  };
}

let cached: LaunchResolution | undefined;
let warnedFallback = false;

/** Cached resolution for the process lifetime. */
export function getLaunchResolution(force = false): LaunchResolution {
  if (!cached || force) cached = resolvePiLaunch();
  return cached;
}

/** GetPiCommand wired to the resolved launch. */
export function createGetPiCommand(resolution?: LaunchResolution): GetPiCommand {
  const resolved = resolution ?? getLaunchResolution();
  if (resolved.source === "path-fallback" && !warnedFallback) {
    warnedFallback = true;
    // eslint-disable-next-line no-console
    console.warn(`[pi-subagent] ${resolved.note ?? "Falling back to bare 'pi' on PATH."}`);
  }
  return (args) => ({
    command: resolved.command,
    args: [...resolved.argsPrefix, ...args],
  });
}

/** Reset module state (tests only). */
export function _resetLaunchCacheForTests(): void {
  cached = undefined;
  warnedFallback = false;
}
