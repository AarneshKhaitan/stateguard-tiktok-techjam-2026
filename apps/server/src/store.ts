import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRelease, Database } from "./types.js";
import { defaultGatePolicy } from "./policy.js";
import { createRelease } from "./release.js";

const emptyDatabase = (): Database => ({
  version: 4,
  agents: [],
  messages: [],
  runs: [],
  releases: [],
  validations: [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database;
      if (![1, 2, 3, 4].includes(parsed.version) || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      const legacy = parsed as Database & { releases?: AgentRelease[]; validations?: Database["validations"] };
      const releases = [...(legacy.releases ?? [])];
      const agents = parsed.agents.map((agent) => {
        const activeReleaseId = agent.activeReleaseId ?? `${agent.id}:release:1`;
        if (!releases.some((release) => release.id === activeReleaseId)) releases.push({ ...createRelease(agent.id, agent, 1, "active", null), id: activeReleaseId });
        return { ...agent, activeGenerationId: agent.activeGenerationId ?? "gen_0001", policy: agent.policy ?? defaultGatePolicy(), activeReleaseId, candidateReleaseId: agent.candidateReleaseId ?? null, canaryPreviousReleaseId: agent.canaryPreviousReleaseId ?? null, canaryRunsRemaining: agent.canaryRunsRemaining ?? 0, canaryConsecutiveFailures: agent.canaryConsecutiveFailures ?? 0 };
      });
      for (const validation of legacy.validations ?? []) { validation.reviewAcknowledgement ??= null; validation.promotionAudit ??= null; validation.ghostJournal ??= []; validation.novelEffects ??= []; validation.historyRecordCount ??= 0; validation.historyMinRecords ??= 5; }
      this.data = {
        ...parsed,
        version: 4,
        agents,
        releases,
        validations: legacy.validations ?? [],
      };
      if (parsed.version !== 4) await this.persist(this.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
