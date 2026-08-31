import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { BehaviouralHistory, type EffectRecord } from "./behavioural-history.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, VerificationRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class PassingVerifier implements VerificationRunner { async run() { return { passed: true, output: "ok", exitCode: 0 }; } }

async function makeService(): Promise<{ service: AgentService; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "stateguard-history-")); roots.push(root);
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test", ARK_MODEL: "test", HISTORY_MIN_RECORDS: "5" });
  const runner: AgentRunner = {
    async run(request: RunnerRequest) {
      if (request.prompt === "production") await writeFile(path.join(request.workspacePath, "history.txt"), "published", "utf8");
      if (request.prompt === "delete docs") await rm(path.join(request.workspacePath, "docs", "other.md"), { force: true });
      if (request.prompt === "delete src") await rm(path.join(request.workspacePath, "src", "index.ts"), { force: true });
      if (request.prompt === "blocked") await writeFile(path.join(request.workspacePath, "config", "production.json"), "no", "utf8");
      return { output: "fake", threadId: "thread", usage: null };
    },
    async cancel() { return false; }, async isAvailable() { return true; },
  };
  const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, new PassingVerifier());
  await service.initialize();
  return { service, root };
}

async function settle(service: AgentService, agentId: string, task: string) {
  const started = await service.validateCandidate(agentId, task);
  await expect.poll(() => service.getValidation(started.id).status, { timeout: 15_000, interval: 20 }).not.toBe("running");
  return service.getValidation(started.id);
}

function records(agentId: string, prefix: string, count: number): EffectRecord[] {
  return Array.from({ length: count }, (_, index) => ({ id: "record-" + index, agentId, runId: "run-" + index, releaseId: "release", generationId: "gen_" + index, taskHash: "task", effects: [{ kind: "deleted" as const, path: prefix + "/old-" + index + ".md" }], createdAt: new Date(0).toISOString() }));
}

describe("behavioural history", () => {
  it("appends only published production generations, never blocked or validation work", async () => {
    const { service, root } = await makeService(); const agent = await service.createAgent({ name: "History" });
    const production = await service.sendMessage(agent.id, "production");
    await expect.poll(() => service.getRun(production.run.id).status, { timeout: 15_000, interval: 20 }).toBe("completed");
    const file = path.join(root, "data", "history", agent.id + ".jsonl");
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);

    const blocked = await service.sendMessage(agent.id, "blocked");
    await expect.poll(() => service.getRun(blocked.run.id).status, { timeout: 15_000, interval: 20 }).toBe("failed");
    await service.updateAgent(agent.id, { instructions: "candidate" });
    await settle(service, agent.id, "delete docs");
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("uses history as a cold-start-aware signal, not an absolute gate", async () => {
    const { service, root } = await makeService(); const agent = await service.createAgent({ name: "History" });
    const generation = path.join(agent.workspacePath, "generations", "gen_0001");
    await (await import("node:fs/promises")).mkdir(path.join(generation, "docs"), { recursive: true });
    await (await import("node:fs/promises")).mkdir(path.join(generation, "src"), { recursive: true });
    await writeFile(path.join(generation, "docs", "other.md"), "keep", "utf8"); await writeFile(path.join(generation, "src", "index.ts"), "keep", "utf8");
    const history = new BehaviouralHistory(path.join(root, "data", "history"));
    for (const record of records(agent.id, "docs", 5)) await history.append(record);
    await service.updateAgent(agent.id, { instructions: "candidate" });

    const knownPrefix = await settle(service, agent.id, "delete docs");
    expect(knownPrefix.status).toBe("certified"); expect(knownPrefix.novelEffects).toEqual([]); expect(knownPrefix.candidateGateFailures).toEqual([]);
    const novelPrefix = await settle(service, agent.id, "delete src");
    expect(novelPrefix.status).toBe("review_required"); expect(novelPrefix.novelEffects).toEqual(["src/index.ts"]); expect(novelPrefix.differentialDeletions).toEqual([]); expect(novelPrefix.candidateGateFailures).toEqual([]);
  });

  it("records a cold-start novelty without escalating it", async () => {
    const { service, root } = await makeService(); const agent = await service.createAgent({ name: "History" });
    const generation = path.join(agent.workspacePath, "generations", "gen_0001");
    await (await import("node:fs/promises")).mkdir(path.join(generation, "src"), { recursive: true });
    await writeFile(path.join(generation, "src", "index.ts"), "keep", "utf8");
    const history = new BehaviouralHistory(path.join(root, "data", "history"));
    for (const record of records(agent.id, "docs", 4)) await history.append(record);
    await service.updateAgent(agent.id, { instructions: "candidate" });
    const validation = await settle(service, agent.id, "delete src");
    expect(validation.status).toBe("certified"); expect(validation.novelEffects).toEqual(["src/index.ts"]); expect(validation.historyRecordCount).toBe(4); expect(validation.candidateGateFailures).toEqual([]);
  });
});
