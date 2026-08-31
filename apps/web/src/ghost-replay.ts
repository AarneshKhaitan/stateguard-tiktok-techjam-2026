export interface GhostEvent { sequence: number; kind: "added" | "modified" | "deleted"; path: string; contentBase64?: string; }

/** Client-side presentation replay. It is never used to decide certification. */
export function replayGhostJournal(source: Map<string, string>, events: GhostEvent[]): Map<string, string> {
  const result = new Map(source);
  for (const event of events.slice().sort((a, b) => a.sequence - b.sequence)) {
    if (event.kind === "deleted") result.delete(event.path);
    else result.set(event.path, event.contentBase64 ?? "");
  }
  return result;
}
