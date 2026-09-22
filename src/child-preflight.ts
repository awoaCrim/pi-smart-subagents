/**
 * Private, package-local Pi extension that answers the routed startup handshake.
 *
 * Loaded explicitly by the Pi backend (`pi -e <this file>`) for Jev-routed child tasks
 * only. It registers one nonce-specific command and, when invoked, reports the child's
 * *actual* active model and tool set plus nested-tool provenance. The control side
 * (`src/runner.ts`, via `src/startup-check.ts`) is what decides pass/fail — this file
 * never grants anything and never trusts itself.
 *
 * Deliberate properties:
 *
 *  - Registers the command unconditionally: nesting/depth/spawn registration rules must
 *    never disable the check.
 *  - Reads only the temporary manifest path from the environment; the manifest carries
 *    the nonce, the expected model ID and tool names — no task text, credentials or
 *    paths from the parent conversation.
 *  - Sends a bounded custom message with `triggerTurn: false` so no model turn starts.
 *  - Uses no imports beyond this package's own handshake module and Node builtins.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  PREFLIGHT_ACK_SCHEMA,
  PREFLIGHT_ACK_TYPE,
  PREFLIGHT_MANIFEST_ENV,
  parsePreflightManifest,
  preflightCommandBase,
} from "./startup-check.js";

/** Minimal structural view of the child ExtensionContext we rely on. */
interface PreflightCommandContext {
  model?: { provider?: unknown; id?: unknown } | null;
}

interface PreflightToolMetadata {
  name?: unknown;
  sourceInfo?: { path?: unknown; source?: unknown } | null;
}

/** Minimal structural view of the Pi extension API we rely on. */
interface PreflightApi {
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: PreflightCommandContext) => unknown },
  ): void;
  getActiveTools(): unknown;
  getAllTools(): unknown;
  sendMessage(
    message: { customType: string; content: string; display?: boolean },
    options?: { triggerTurn?: boolean },
  ): unknown;
}

const HOST_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const HOST_SEARCH_DEPTH = 6;

function safeActiveTools(pi: PreflightApi): string[] | null {
  try {
    const active = pi.getActiveTools();
    return Array.isArray(active) && active.every((name) => typeof name === "string") ? active : null;
  } catch {
    return null;
  }
}

function safeNestedProvenance(pi: PreflightApi, wanted: ReadonlySet<string>): Array<{
  name: string;
  path: string | null;
  source: string | null;
}> {
  if (wanted.size === 0) return [];
  try {
    const all = pi.getAllTools();
    if (!Array.isArray(all)) return [];
    return (all as PreflightToolMetadata[])
      .filter((tool) => typeof tool?.name === "string" && wanted.has(tool.name))
      .map((tool) => ({
        name: tool.name as string,
        path: typeof tool.sourceInfo?.path === "string" ? tool.sourceInfo.path : null,
        source: typeof tool.sourceInfo?.source === "string" ? tool.sourceInfo.source : null,
      }));
  } catch {
    return [];
  }
}

/**
 * Best-effort host identification for the version gate. `PI_PACKAGE_DIR` is documented,
 * and `process.argv[1]` is the CLI entry for Node-launched Pi. Anything unresolvable
 * stays `null`; the behavioural handshake, not a guessed version, is the real gate.
 */
function readHostInfo(): { version: string | null; packageDir: string | null } {
  const candidates: string[] = [];
  try {
    const override = process.env.PI_PACKAGE_DIR;
    if (typeof override === "string" && override.trim()) candidates.push(override.trim());
    const argv1 = process.argv[1];
    if (typeof argv1 === "string" && argv1) {
      let dir = path.dirname(path.resolve(argv1));
      for (let depth = 0; depth < HOST_SEARCH_DEPTH; depth += 1) {
        candidates.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch {
    /* fall through to unknown */
  }
  for (const dir of candidates) {
    try {
      const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.name === HOST_PACKAGE_NAME && typeof parsed.version === "string") {
        return { version: parsed.version, packageDir: dir };
      }
    } catch {
      /* not a package dir; keep looking */
    }
  }
  return { version: null, packageDir: null };
}

export default function childPreflight(pi: PreflightApi): void {
  const manifestPath = process.env[PREFLIGHT_MANIFEST_ENV];
  if (typeof manifestPath !== "string" || manifestPath.length === 0) return;

  let manifest;
  try {
    manifest = parsePreflightManifest(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return;
  }
  if (!manifest.ok) return;
  const expectation = manifest.manifest;
  const nestedWanted = new Set(expectation.nestedTools ?? []);

  pi.registerCommand(preflightCommandBase(expectation.nonce), {
    description: "private pi-subagent startup check",
    handler: async (_args: string, ctx: PreflightCommandContext) => {
      const model = ctx?.model
        ? {
            provider: typeof ctx.model.provider === "string" ? ctx.model.provider : undefined,
            id: typeof ctx.model.id === "string" ? ctx.model.id : undefined,
          }
        : null;
      const payload = {
        schema: PREFLIGHT_ACK_SCHEMA,
        nonce: expectation.nonce,
        model,
        tools: safeActiveTools(pi),
        nestedToolsWithSource: safeNestedProvenance(pi, nestedWanted),
        host: readHostInfo(),
      };
      pi.sendMessage(
        {
          customType: PREFLIGHT_ACK_TYPE,
          content: JSON.stringify(payload),
          display: false,
        },
        { triggerTurn: false },
      );
    },
  });
}
