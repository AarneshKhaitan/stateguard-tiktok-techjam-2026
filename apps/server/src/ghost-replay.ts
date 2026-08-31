import { mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceDiff } from "./types.js";

export interface GhostEvent {
  sequence: number;
  kind: "added" | "modified" | "deleted";
  path: string;
  contentBase64?: string;
  /** Present when content was deliberately not inlined. The event still replays
   *  structurally; only the preview of its contents is unavailable. */
  omitted?: "sensitive-path" | "too-large" | "journal-budget-exhausted";
}

/** Never inline the contents of a file whose name suggests it holds credentials.
 *  The journal is persisted into the metadata store and served to the browser, and
 *  the challenge rules forbid exposing keys or unredacted secrets there. */
const SENSITIVE = /(^|\/)(\.env(\..*)?|.*\.(key|pem|p12|pfx)|.*secret.*|.*credential.*|id_rsa.*)$/i;

/** Inlining more than this per file, or in total, would bloat launchpad.json — which
 *  JsonStore rewrites in full on EVERY mutation, making all later writes slower. */
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;

/**
 * Presentation journal only. The manifest diff remains authoritative: an event whose
 * content was withheld still replays as a structural change, and the diff is what
 * every gate decision is made from.
 */
export async function buildGhostJournal(baseDir: string, candidateDir: string, diff: WorkspaceDiff): Promise<GhostEvent[]> {
  const events: GhostEvent[] = [];
  let budget = MAX_TOTAL_BYTES;
  for (const [sequence, change] of diff.changes.slice().sort((a, b) => a.path.localeCompare(b.path)).entries()) {
    const event: GhostEvent = { sequence, kind: change.kind, path: change.path };
    if (change.kind !== "deleted") {
      if (SENSITIVE.test(change.path)) event.omitted = "sensitive-path";
      else {
        const content = await readFile(path.join(candidateDir, change.path));
        if (content.byteLength > MAX_FILE_BYTES) event.omitted = "too-large";
        else if (content.byteLength > budget) event.omitted = "journal-budget-exhausted";
        else {
          event.contentBase64 = content.toString("base64");
          budget -= content.byteLength;
        }
      }
    }
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
    else if (event.omitted) continue; // content withheld: leave the source file as-is
    else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, Buffer.from(event.contentBase64 ?? "", "base64")); }
  }
}
