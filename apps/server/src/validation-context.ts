import { createHash } from "node:crypto";
import type { ValidationContext } from "./types.js";

export type ValidationContextInput = Omit<ValidationContext, "contextHash">;

export function createValidationContext(input: ValidationContextInput): ValidationContext {
  return { ...input, contextHash: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
}
