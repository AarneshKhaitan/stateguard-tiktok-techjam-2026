import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, VerificationRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function makeService(advance: boolean): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "stateguard-p4-")); roots.push(root);
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test", ARK_MODEL: "ep-test" });
  let calls = 0;
  const runner: AgentRunner = {
    async run(request: RunnerRequest) {
      calls += 1;
      if (advance && calls === 3) await writeFile(path.join(request.workspacePath, "production.txt"), "advanced", "utf8");
      return { output: "ok", threadId: calls >= 3 ? "old-production-thread" : "validation-thread", usage: null };
    },
    async cancel() { return false; }, async isAvailable() { return true; },
  };
  const verifier: VerificationRunner = { async run() { return { passed: true, output: "ok", exitCode: 0 }; } };
  const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, verifier);
  await service.initialize(); return service;
}

async function certify(service: AgentService, agentId: string) {
  await service.updateAgent(agentId, { instructions: "safe candidate" });
  const started = await service.validateCandidate(agentId, "fixed task");
  await expect.poll(() => service.getValidation(started.id).status, { timeout: 15_000, interval: 25 }).toBe("certified");
  return service.getValidation(started.id);
}

describe("P4 promotion and staleness", () => {
  it("promotes only a certified candidate, changes release not generation, and resets thread", async () => {
    const service = await makeService(false); const agent = await service.createAgent({ name: "Guard" });
    const validation = await certify(service, agent.id);
    await service.sendMessage(agent.id, "normal production work");
    await expect.poll(() => service.getAgent(agent.id).codexThreadId, { timeout: 15_000, interval: 25 }).toBe("old-production-thread");
    const before = service.getAgent(agent.id);
    const promoted = await service.promote(agent.id, validation.id);
    expect(promoted.activeReleaseId).toBe(validation.candidateReleaseId);
    expect(promoted.candidateReleaseId).toBeNull();
    expect(promoted.activeGenerationId).toBe(before.activeGenerationId);
    expect(promoted.codexThreadId).toBeNull();
    expect(service.getReleases(agent.id).find((release) => release.id === validation.candidateReleaseId)?.status).toBe("active");
  }, 30_000);

  it("refuses promotion after production advances the certified generation", async () => {
    const service = await makeService(true); const agent = await service.createAgent({ name: "Guard" });
    const validation = await certify(service, agent.id);
    const run = await service.sendMessage(agent.id, "advance production");
    await expect.poll(() => service.getRun(run.run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");
    await expect(service.promote(agent.id, validation.id)).rejects.toThrow(/generationId drifted.*gen_0001.*gen_0002/);
    expect(service.getAgent(agent.id).activeReleaseId).not.toBe(validation.candidateReleaseId);
  });

  it("refuses promotion after policyHash drifts", async () => {
    const service = await makeService(false); const agent = await service.createAgent({ name: "Guard" });
    const validation = await certify(service, agent.id);
    await service.updatePolicy(agent.id, { protectedPaths: ["secrets.json"], verificationCommand: "exit 0", changeBudget: 20 });
    await expect(service.promote(agent.id, validation.id)).rejects.toThrow(/policyHash drifted/);
  });

  it("refuses blocked, running, and failed validations", async () => {
    const service = await makeService(false); const agent = await service.createAgent({ name: "Guard" });
    await expect(service.promote(agent.id)).rejects.toThrow(/no validation/);
    const validation = await certify(service, agent.id);
    await expect(service.promote(agent.id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/no validation/);
    expect(validation.status).toBe("certified");
  });
});
