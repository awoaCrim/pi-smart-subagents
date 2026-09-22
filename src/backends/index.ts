/**
 * Backend registry.
 *
 * Backends are constructed lazily and cached, so a user who never asks for
 * the Claude backend never pays for importing its SDK.
 */

import type { BackendAdapter, BackendName } from "../backend.js";
import { PiBackend } from "./pi.js";
import { CodexBackend } from "./codex.js";
import { ClaudeBackend } from "./claude.js";

const cache = new Map<BackendName, BackendAdapter>();

export function resolveBackend(name: BackendName): BackendAdapter {
  const cached = cache.get(name);
  if (cached) return cached;
  const backend: BackendAdapter =
    name === "codex" ? new CodexBackend() : name === "claude" ? new ClaudeBackend() : new PiBackend();
  cache.set(name, backend);
  return backend;
}

export { PiBackend } from "./pi.js";
export { CodexBackend } from "./codex.js";
export { ClaudeBackend } from "./claude.js";
