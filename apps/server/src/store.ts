import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";
import { defaultGatePolicy } from "./policy.js";

const emptyDatabase = (): Database => ({
  version: 3,
  agents: [],
  messages: [],
  runs: [],
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
      if (![1, 2, 3].includes(parsed.version) || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      this.data = {
        ...parsed,
        version: 3,
        agents: parsed.agents.map((agent) => ({ ...agent, activeGenerationId: agent.activeGenerationId ?? "gen_0001", policy: agent.policy ?? defaultGatePolicy() })),
      };
      if (parsed.version !== 3) await this.persist(this.data);
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
