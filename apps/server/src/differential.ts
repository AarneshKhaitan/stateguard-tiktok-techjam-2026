import type { WorkspaceDiff } from "./types.js";

export function newDestructiveDeletions(baseline: WorkspaceDiff, candidate: WorkspaceDiff): string[] {
  const baselineDeletions = new Set(baseline.changes.filter((change) => change.kind === "deleted").map((change) => change.path));
  return candidate.changes.filter((change) => change.kind === "deleted" && !baselineDeletions.has(change.path)).map((change) => change.path).sort();
}
