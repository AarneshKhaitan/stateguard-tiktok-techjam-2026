import { createHash } from "node:crypto";
import type { ValidationContext } from "./types.js";

export type ValidationContextInput = Omit<ValidationContext, "contextHash">;

/**
 * Hashed over sorted keys, not raw JSON.stringify, whose output depends on property
 * insertion order. Promotion staleness in P4 compares these hashes across time, so a
 * later refactor that merely reorders the object literal must not silently invalidate
 * every stored certification. Same discipline as hashPolicy.
 */
export function createValidationContext(input: ValidationContextInput): ValidationContext {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))),
  );
  return { ...input, contextHash: createHash("sha256").update(canonical).digest("hex") };
}
