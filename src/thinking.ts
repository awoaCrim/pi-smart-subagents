/**
 * Opaque thinking-level value understood by the active Pi/model.
 *
 * Pi owns the vocabulary and model-specific mappings (for example `max` may
 * be supported by one model while another exposes a different set). The
 * subagent package must therefore validate only the transport-safe shape and
 * pass the value through unchanged.
 */
import type { TaskDifficulty } from "./types.js";

/** Opaque value passed to Pi; the host owns model-specific support and mapping. */
export type ThinkingLevel = string;

const MAX_THINKING_LEVEL_LENGTH = 64;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_THINKING_LEVEL_LENGTH
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

/**
 * Small default only for tasks that did not provide a thinking level.
 * Pi 0.99.1 understands `minimal`; it still owns the final model mapping.
 */
export function adaptiveThinkingForDifficulty(difficulty: TaskDifficulty | undefined): ThinkingLevel | undefined {
  if (difficulty === "simple") return "minimal";
  if (difficulty === "moderate") return "medium";
  if (difficulty === "complex") return "high";
  return undefined;
}
