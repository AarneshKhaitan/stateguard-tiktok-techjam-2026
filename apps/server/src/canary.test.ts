import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, VerificationRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("feature-flagged canary rollback", () => {
  it("reverts after two consecutive production gate failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stateguard-canary-")); roots.push(root);
    const config = loadConfig({ NODE_ENV: "test", CANARY_ENABLED: "true", CANARY_RUNS: "3", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test", ARK_MODEL: "ep-test" });
    let verificationCalls = 0;
    const runner: AgentRunner = { async run() { return { output: "ok", threadId: "old-thread", usage: null }; }, async cancel() { return false; }, async isAvailable() { return true; } };
    const verifier: VerificationRunner = { async run() { verificationCalls += 1; return { passed: verificationCalls <= 2, output: verificationCalls <= 2 ? "ok" : "canary failure", exitCode: verificationCalls <= 2 ? 0 : 1 }; } };
    const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, verifier);
    await service.initialize(); const agent = await service.createAgent({ name: "Guard" }); const originalRelease = agent.activeReleaseId;
    await service.updateAgent(agent.id, { instructions: "new release" }); const validation = await service.validateCandidate(agent.id, "fixed task");
    await expect.poll(() => service.getValidation(validation.id).status, { timeout: 15_000, interval: 25 }).toBe("certified");
    await service.promote(agent.id, validation.id); const promoted = service.getAgent(agent.id); expect(promoted.activeReleaseId).not.toBe(originalRelease);
    const first = await service.sendMessage(agent.id, "one"); await expect.poll(() => service.getRun(first.run.id).status, { timeout: 15_000, interval: 25 }).toBe("failed");
    expect(service.getAgent(agent.id).canaryConsecutiveFailures).toBe(1);
    const second = await service.sendMessage(agent.id, "two"); await expect.poll(() => service.getRun(second.run.id).status, { timeout: 15_000, interval: 25 }).toBe("failed");
    const rolledBack = service.getAgent(agent.id); expect(rolledBack.activeReleaseId).toBe(originalRelease); expect(rolledBack.codexThreadId).toBeNull(); expect(rolledBack.canaryRunsRemaining).toBe(0);
  });
});
