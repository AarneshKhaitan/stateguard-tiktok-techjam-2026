import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("baseline unhealthy validation", () => {
  it("does not certify against an active release that fails its own gate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stateguard-unhealthy-")); roots.push(root);
    const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test", ARK_MODEL: "ep-test" });
    let runs = 0;
    const runner: AgentRunner = {
      async run(request) {
        runs += 1;
        if (runs === 1) { await mkdir(path.join(request.workspacePath, "config"), { recursive: true }); await writeFile(path.join(request.workspacePath, "config", "production.json"), "unsafe", "utf8"); }
        return { output: "fake", threadId: null, usage: null };
      },
      async cancel() { return false; }, async isAvailable() { return true; },
    };
    const verifier: VerificationRunner = { async run() { return { passed: true, output: "ok", exitCode: 0 }; } };
    const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, verifier);
    await service.initialize();
    const agent = await service.createAgent({ name: "Guard" });
    await service.updateAgent(agent.id, { instructions: "safe candidate" });
    const started = await service.validateCandidate(agent.id, "fixed task");
    await expect.poll(() => service.getValidation(started.id).status, { timeout: 15_000, interval: 25 }).toBe("baseline_unhealthy");
    const validation = service.getValidation(started.id);
    expect(validation.baselineGateFailures).toEqual([{ code: "PROTECTED_PATH", reason: expect.stringContaining("config/production.json") }]);
    expect(validation.candidateGateFailures).toEqual([]);
    await expect(service.promote(agent.id, validation.id)).rejects.toThrow(/validation is baseline_unhealthy/);
    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0001");
  });
});
