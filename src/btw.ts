/**
 * `/btw` — "by the way" side questions.
 *
 * A user aside runs as a normal subagent run, but its result is delivered to
 * the TUI through `pi.appendEntry()`, which does not participate in LLM
 * context. The main agent therefore keeps working without seeing the question
 * or the answer, while the user still gets a rendered result in the
 * transcript. Inspired by davis7dotsh/my-pi-setup's by-the-way feature.
 */

/** Custom entry type for `/btw` results (model-hidden by construction). */
export const BTW_ENTRY_TYPE = "subagent-btw";

export interface BtwEntry {
  state: "running" | "done" | "failed";
  question: string;
  label: string;
  answer?: string;
}

export const BTW_LABEL_MAX_LENGTH = 60;

/**
 * Compact transcript label from the first non-empty line of the question.
 * Counts code points so multi-byte characters are never split mid-glyph.
 */
export function btwLabel(question: string): string {
  const firstLine = question.split("\n").find((line) => line.trim())?.trim();
  const collapsed = firstLine?.replace(/\s+/g, " ") ?? "";
  if (!collapsed) return "by the way";
  const points = Array.from(collapsed);
  if (points.length <= BTW_LABEL_MAX_LENGTH) return collapsed;
  return `${points.slice(0, BTW_LABEL_MAX_LENGTH - 1).join("")}…`;
}
