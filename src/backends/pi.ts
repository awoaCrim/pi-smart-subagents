/**
 * Pi backend — the original and default. Spawns `pi --mode rpc` and speaks
 * Pi's documented JSON event stream over stdio.
 *
 * This is a straight extraction of the logic that lived inline in
 * `ChildRunner.run()`; behavior is unchanged. It is the only backend that
 * supports every capability, because the protocol was designed for it.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendAdapter, BackendCapabilities, BackendInvocation, BackendLaunchContext, BackendParser } from "../backend.js";
import { ProtocolParser } from "../protocol.js";
import { schemaContract } from "../structured.js";
import type { TaskSpec } from "../types.js";
import {
  PREFLIGHT_MANIFEST_ENV,
  PREFLIGHT_MANIFEST_SCHEMA,
  createPreflightNonce,
  startupFailure,
  type PreflightManifest,
} from "../startup-check.js";

import { EMPTY_TOOL_NAMES, NESTED_DISPATCH_TOOLS, isToolNameSubset } from "../pi-tools.js";

const PI_CAPABILITIES: BackendCapabilities = {
  steer: true,
  gracefulWrapUp: true,
  costReporting: true,
  resume: true,
  fork: true,
  toolRestriction: true,
  thinking: true,
  outputSchema: true,
};

export class PiBackend implements BackendAdapter {
  readonly name = "pi" as const;
  readonly capabilities = PI_CAPABILITIES;

  async buildInvocation(spec: TaskSpec, context: BackendLaunchContext): Promise<BackendInvocation> {
    // A Jev-routed spec requires the provider-free capability negotiation before the real
    // task prompt: Pi silently drops unknown `--tools` names, so parent catalog knowledge
    // is not proof of what the child actually loaded.
    const routed = spec.routing !== undefined;
    const nativeTools = spec.nativeTools === undefined ? EMPTY_TOOL_NAMES : spec.nativeTools;
    const forcedTools = spec.forcedTools === undefined ? EMPTY_TOOL_NAMES : spec.forcedTools;
    if (!isToolNameSubset(nativeTools, spec.tools ?? []) || (!routed && nativeTools.length > 0)) {
      throw startupFailure(
        "native_tools_invalid",
        "Official native tools must be a normalized subset of a routed tool allowlist; prepare the task through local routing policy.",
      );
    }
    if (!isToolNameSubset(forcedTools, spec.tools ?? []) || (!routed && forcedTools.length > 0)) {
      throw startupFailure(
        "forced_tools_invalid",
        "Explicitly forced tools must be a normalized subset of a routed tool allowlist; prepare the task through local routing policy.",
      );
    }
    if (routed) {
      if (!spec.model?.trim()) {
        throw startupFailure(
          "model_missing",
          "A routed subagent task must carry the Jev-selected execution model.",
        );
      }
      if (!Array.isArray(spec.tools)) {
        throw startupFailure(
          "tools_missing",
          "A routed subagent task must carry the finalized tool candidate allowlist so the child's effective capabilities can be negotiated.",
        );
      }
    }

    // RPC mode keeps a live stdin command channel so steering messages can be
    // injected mid-run. The event stream on stdout is a superset of json mode.
    const args = ["--mode", "rpc", "--session-dir", context.sessionDir];
    if (spec.forkResume && spec.resume) args.push("--fork", spec.resume);
    else if (spec.resume) args.push("--session", spec.resume);
    else if (spec.contextFork) {
      // Context fork: the child starts from a real branched copy of the
      // parent conversation, then receives the task as its next prompt.
      // Fail fast rather than silently degrading to a fresh session.
      if (!spec.parentSessionFile) {
        throw new Error("context:'fork' requires a persisted parent session (none available). Save the session or use context:'fresh'.");
      }
      await fs.access(spec.parentSessionFile).catch(() => {
        throw new Error(`context:'fork' failed: parent session file ${spec.parentSessionFile} is not readable.`);
      });
      args.push("--fork", spec.parentSessionFile);
    }
    if (spec.model) args.push("--model", spec.model);
    if (spec.thinking) args.push("--thinking", spec.thinking);
    // A routed task's finalized tools are already profile-filtered; the parent
    // applies depth/spawn/profile gating before nested dispatch tools become
    // candidates. Unrouted (trusted SDK) callers keep the historical behaviour.
    let toolList: string[] | undefined;
    let finalizedToolList: string[] | undefined;
    if (spec.tools !== undefined) {
      finalizedToolList = routed ? [...new Set(spec.tools)] : spec.tools;
      // Pass the full finalized routed allowlist. Pi's official exposure metadata
      // controls how native names participate; the acknowledgement verifies their
      // registration but does not require them to appear in the active set.
      toolList = routed ? finalizedToolList : finalizedToolList.filter((tool) => tool !== "subagent");
      if (toolList.length === 0) args.push("--no-tools");
      else args.push("--tools", toolList.join(","));
    }
    // Persona/system prompt first, structured-output contract last (highest salience).
    const appendPrompt = [spec.systemPrompt?.trim(), spec.outputSchema ? schemaContract(spec.outputSchema) : undefined]
      .filter(Boolean)
      .join("\n\n");
    const cleanupDirs: string[] = [];
    try {
    if (appendPrompt) {
      const tempPromptDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-prompt-"));
      cleanupDirs.push(tempPromptDir);
      const promptPath = path.join(tempPromptDir, "system-prompt.md");
      await fs.writeFile(promptPath, appendPrompt, { encoding: "utf8", mode: 0o600 });
      args.push("--append-system-prompt", promptPath);
    }

    let env: Record<string, string> | undefined;
    if (routed) {
      env = {};
      const preflightExtension = fileURLToPath(new URL("../child-preflight.ts", import.meta.url));
      await fs.access(preflightExtension).catch(() => {
        throw startupFailure(
          "preflight_extension_missing",
          "The packaged child-preflight extension is missing, so the routed child's model and tools cannot be verified.",
        );
      });
      const nestedTools = (finalizedToolList ?? []).filter((tool) => (NESTED_DISPATCH_TOOLS as readonly string[]).includes(tool));
      const manifest: PreflightManifest = {
        schema: PREFLIGHT_MANIFEST_SCHEMA,
        nonce: createPreflightNonce(),
        model: spec.model!,
        tools: finalizedToolList ?? [],
        ...(forcedTools.length > 0 ? { forcedTools } : {}),
        ...(nativeTools.length > 0 ? { nativeTools } : {}),
        ...(nestedTools.length > 0 ? { nestedTools } : {}),
      };
      const tempPreflightDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-preflight-"));
      cleanupDirs.push(tempPreflightDir);
      const manifestPath = path.join(tempPreflightDir, "preflight.json");
      await fs.writeFile(manifestPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
      // Bounded, non-secret expectation only: nonce, model ID, tool names, manifest path.
      env[PREFLIGHT_MANIFEST_ENV] = manifestPath;
      // Explicit `-e` pins the package-local extension. `--no-extensions` is deliberately
      // NOT used: the child must still load the extensions that provide Jev-selected tools.
      args.push("-e", preflightExtension);
    }

    const invocation = context.getPiCommand(args);
    return { command: invocation.command, args: invocation.args, env, cleanupDirs };
    } catch (error) {
      // The runner cannot own cleanupDirs until an invocation is returned.
      for (const dir of cleanupDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* best-effort cleanup */ });
      throw error;
    }
  }

  createParser(): BackendParser {
    return new ProtocolParser();
  }

  steerCommand(message: string): unknown {
    return { type: "steer", message };
  }

  promptCommand(message: string): unknown {
    return { type: "prompt", message };
  }

  uiCancelCommand(id: string): unknown {
    return { type: "extension_ui_response", id, cancelled: true };
  }

  stateCommand(): unknown {
    return { type: "get_state" };
  }
}
