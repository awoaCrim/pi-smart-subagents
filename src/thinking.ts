/**
 * Opaque thinking-level value understood by the active Pi/model.
 *
 * Pi owns the vocabulary and model-specific mappings (for example `max` may
 * be supported by one model while another exposes a different set). The
 * subagent package must therefore validate only the transport-safe shape and
 * pass the value through unchanged.
 */
export type ThinkingLevel = string;

const MAX_THINKING_LEVEL_LENGTH = 64;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_THINKING_LEVEL_LENGTH
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}
