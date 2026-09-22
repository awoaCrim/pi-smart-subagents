/**
 * Structured output contract: a task may declare an `output_schema` (JSON
 * Schema subset). The child is instructed to end its final message with a
 * fenced ```json:result block; the parent extracts and validates it on this
 * side of the process boundary.
 *
 * Validation is a dependency-free JSON-Schema *subset* (type / properties /
 * required / items / enum / const / nested combinations). Unknown keywords are
 * ignored rather than rejected so callers can pass richer schemas; we enforce
 * what we understand and never fail on what we don't.
 */

export interface SchemaCheckResult {
  ok: boolean;
  errors: string[];
}

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => typeof value === "number" && Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  null: (value) => value === null,
};

/** Validate that a caller-supplied schema is a plausible JSON Schema object. */
export function isPlausibleSchema(schema: unknown): schema is Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  if (s.type !== undefined && typeof s.type !== "string" && !Array.isArray(s.type)) return false;
  if (s.properties !== undefined && (typeof s.properties !== "object" || s.properties === null)) return false;
  if (s.required !== undefined && !Array.isArray(s.required)) return false;
  return true;
}

/** Structural validation against the supported JSON-Schema subset. */
export function checkAgainstSchema(value: unknown, schema: unknown, path = "$"): SchemaCheckResult {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return { ok: true, errors };
  const s = schema as Record<string, any>;

  if (s.const !== undefined && JSON.stringify(value) !== JSON.stringify(s.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((candidate: unknown) => JSON.stringify(candidate) === JSON.stringify(value))) {
    errors.push(`${path}: value not in enum [${s.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}]`);
  }

  const types: string[] = typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? s.type : [];
  if (types.length) {
    const matched = types.some((type) => TYPE_CHECKS[type]?.(value));
    if (!matched) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
      return { ok: false, errors }; // wrong type: nested checks would be noise
    }
  }

  if (TYPE_CHECKS.object(value)) {
    const record = value as Record<string, unknown>;
    for (const key of Array.isArray(s.required) ? s.required : []) {
      if (typeof key === "string" && !(key in record)) errors.push(`${path}: missing required property "${key}"`);
    }
    if (s.properties && typeof s.properties === "object") {
      for (const [key, propSchema] of Object.entries(s.properties as Record<string, unknown>)) {
        if (key in record) {
          errors.push(...checkAgainstSchema(record[key], propSchema, `${path}.${key}`).errors);
        }
      }
    }
  }

  if (Array.isArray(value) && s.items && typeof s.items === "object" && !Array.isArray(s.items)) {
    value.forEach((item, index) => {
      errors.push(...checkAgainstSchema(item, s.items, `${path}[${index}]`).errors);
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Extract the structured result from the child's final assistant text.
 * Preference order: last ```json:result fence → last plain ```json fence →
 * trailing bare JSON object/array. Returns undefined when nothing parses.
 */
export function extractStructuredResult(text: string | undefined): { value?: unknown; raw?: string } {
  if (!text) return {};
  const fences = [/```json:result\s*\n([\s\S]*?)```/g, /```json\s*\n([\s\S]*?)```/g];
  for (const pattern of fences) {
    let last: string | undefined;
    for (const match of text.matchAll(pattern)) last = match[1];
    if (last !== undefined) {
      try {
        return { value: JSON.parse(last), raw: last.trim() };
      } catch {
        return { raw: last.trim() }; // fence found but unparseable: report it
      }
    }
  }
  // Trailing bare JSON object/array (last non-empty chunk starting with { or [).
  const trimmed = text.trimEnd();
  const start = Math.max(trimmed.lastIndexOf("\n{"), trimmed.lastIndexOf("\n["));
  const candidate = start >= 0 ? trimmed.slice(start + 1) : trimmed.startsWith("{") || trimmed.startsWith("[") ? trimmed : undefined;
  if (candidate) {
    try {
      return { value: JSON.parse(candidate), raw: candidate };
    } catch {
      /* not JSON */
    }
  }
  return {};
}

/** The contract appended to the child's system prompt (after the persona). */
export function schemaContract(schema: Record<string, unknown>): string {
  return [
    "STRUCTURED OUTPUT CONTRACT",
    "Your FINAL message MUST end with a fenced code block tagged json:result containing ONLY a JSON value that validates against this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "Rules: the fenced block is your machine-readable result — narrative goes before it, never inside. Do not wrap the JSON in prose or stringify it. Example shape:",
    "```json:result",
    '{ "your": "result here" }',
    "```",
  ].join("\n");
}

/** Steering message for one repair round after failed validation. */
export function repairMessage(errors: string[]): string {
  const detail = errors.slice(0, 10).join("; ");
  return (
    `Your structured result failed validation: ${detail}. ` +
    "Re-emit your COMPLETE final result now as a single fenced ```json:result block that validates against the schema from your instructions. Output only the corrected block."
  );
}

// ── Arg repair (double-encoded JSON de-mangling) ─────────────────────────────

/**
 * LLMs sometimes double-encode natural-language string fields (the value
 * arrives as a JSON-string-inside-a-string: `"line1\\nline2"` with literal
 * backslash escapes). Detect structural escape patterns and decode ONCE when
 * the decoded form is a plausible improvement. Never applied to identifier
 * fields (agent, model, id) or arrays — only free-text fields.
 */
export function repairDoubleEncodedText(value: string): string {
  if (value.length < 4) return value;
  // High-signal escapes only: literal \n or \" strongly indicate a
  // JSON-string-inside-a-string. \t and \\ alone are NOT sufficient — they
  // occur naturally in Windows paths (C:\temp) and regex/code snippets.
  const highSignal = /\\n|\\"/.test(value);
  if (!highSignal) return value;
  const hasRealNewlines = value.includes("\n");
  if (hasRealNewlines) return value; // mixed content: too ambiguous, leave it
  // A lone backslash before a non-escape char (e.g. C:\Users mixed with \n)
  // would make JSON.parse fail or corrupt — require every backslash to start
  // a valid JSON escape sequence.
  if (/\\(?![nrtbf"\\/u])/.test(value)) return value;
  try {
    const decoded = JSON.parse(`"${value.replace(/(?<!\\)"/g, '\\"')}"`);
    if (typeof decoded === "string" && decoded !== value && decoded.length > 0) return decoded;
  } catch {
    /* not decodable: leave as-is */
  }
  return value;
}
