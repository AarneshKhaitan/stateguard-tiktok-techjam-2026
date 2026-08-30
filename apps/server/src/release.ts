import { createHash, randomUUID } from "node:crypto";
import type { Agent, AgentRelease, ReleaseStatus } from "./types.js";

export type ReleaseFields = Pick<Agent, "name" | "description" | "instructions">;

export function hashRelease(fields: ReleaseFields): string {
  return createHash("sha256").update(JSON.stringify({ name: fields.name, description: fields.description, instructions: fields.instructions })).digest("hex");
}

export function createRelease(agentId: string, fields: ReleaseFields, version: number, status: ReleaseStatus, parentReleaseId: string | null): AgentRelease {
  return { id: randomUUID(), agentId, version, ...fields, releaseHash: hashRelease(fields), status, parentReleaseId, createdAt: new Date().toISOString() };
}
