import { mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceDiff } from "./types.js";

export interface GhostEvent {
  sequence: number;
  kind: "added" | "modified" | "deleted";
  path: string;
  contentBase64?: string;
}

/** Presentation journal only. The manifest diff remains authoritative. */
export async function buildGhostJournal(baseDir: string, candidateDir: string, diff: WorkspaceDiff): Promise<GhostEvent[]> {
  const events: GhostEvent[] = [];
  for (const [sequence, change] of diff.changes.slice().sort((a, b) => a.path.localeCompare(b.path)).entries()) {
    const event: GhostEvent = { sequence, kind: change.kind, path: change.path };
    if (change.kind !== "deleted") event.contentBase64 = (await readFile(path.join(candidateDir, change.path))).toString("base64");
    events.push(event);
  }
  void baseDir;
  return events;
}

export async function replayGhostJournal(sourceDir: string, targetDir: string, events: GhostEvent[]): Promise<void> {
  await rm(targetDir, { recursive: true, force: true }); await cp(sourceDir, targetDir, { recursive: true });
  for (const event of events.slice().sort((a, b) => a.sequence - b.sequence)) {
    const target = path.join(targetDir, event.path);
    if (event.kind === "deleted") await rm(target, { recursive: true, force: true });
    else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, Buffer.from(event.contentBase64 ?? "", "base64")); }
  }
}
