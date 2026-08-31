import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FileChange } from "./types.js";

export interface EffectRecord {
  id: string;
  agentId: string;
  runId: string;
  releaseId: string;
  generationId: string;
  taskHash: string;
  effects: Array<Pick<FileChange, "kind" | "path">>;
  createdAt: string;
}

export interface BehaviouralEnvelope {
  recordCount: number;
  deletedPrefixes: Map<string, number>;
  modifiedPrefixes: Map<string, number>;
  everTouched: Set<string>;
}

function prefixFor(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? "" : filePath.slice(0, slash);
}

export function envelopeFrom(records: EffectRecord[]): BehaviouralEnvelope {
  const envelope: BehaviouralEnvelope = {
    recordCount: records.length,
    deletedPrefixes: new Map(),
    modifiedPrefixes: new Map(),
    everTouched: new Set(),
  };
  for (const record of records) {
    for (const effect of record.effects) {
      envelope.everTouched.add(effect.path);
      const prefixes = effect.kind === "deleted" ? envelope.deletedPrefixes : effect.kind === "modified" ? envelope.modifiedPrefixes : null;
      if (prefixes) {
        const prefix = prefixFor(effect.path);
        prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
      }
    }
  }
  return envelope;
}

/** A small append-only evidence store. JsonStore deliberately does not own this data:
 *  recording every production effect must not rewrite the control-plane database. */
export class BehaviouralHistory {
  private readonly envelopeCache = new Map<string, BehaviouralEnvelope>();

  constructor(private readonly root: string) {}

  private file(agentId: string): string { return path.join(this.root, agentId + ".jsonl"); }

  async append(record: EffectRecord): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendFile(this.file(record.agentId), JSON.stringify(record) + "\n", "utf8");
    this.envelopeCache.delete(record.agentId);
  }

  async envelope(agentId: string): Promise<BehaviouralEnvelope> {
    const cached = this.envelopeCache.get(agentId);
    if (cached) return cached;
    let records: EffectRecord[] = [];
    try {
      records = (await readFile(this.file(agentId), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EffectRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const result = envelopeFrom(records);
    this.envelopeCache.set(agentId, result);
    return result;
  }

  async novelDeletedPaths(agentId: string, changes: FileChange[]): Promise<{ paths: string[]; recordCount: number }> {
    const envelope = await this.envelope(agentId);
    return {
      recordCount: envelope.recordCount,
      paths: changes
        .filter((change) => change.kind === "deleted" && !envelope.deletedPrefixes.has(prefixFor(change.path)))
        .map((change) => change.path),
    };
  }
}
