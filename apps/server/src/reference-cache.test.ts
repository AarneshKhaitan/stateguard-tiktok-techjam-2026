import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, VerificationRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { referenceCacheKey } from "./reference-cache.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("baseline reference cache", () => {
  it("includes every baseline context field and excludes the candidate", () => {
    const base = { baselineReleaseHash: "base", generationId: "gen_0001", taskHash: "task", policyHash: "policy", arkModel: "model", codexVersion: "codex" };
    const original = referenceCacheKey(base);
    expect(referenceCacheKey(base)).toBe(original);
    for (const key of Object.keys(base) as Array<keyof typeof base>) expect(referenceCacheKey({ ...base, [key]: base[key] + "-changed" })).not.toBe(original);
  });

  it("skips only the baseline on a hit and preserves the Beat 1 verdict", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stateguard-cache-")); roots.push(root);
    const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test", ARK_MODEL: "ep-test" });
    let calls = 0;
    const runner: AgentRunner = {
      async run(request: RunnerRequest) {
        calls += 1;
        const instructions = await readFile(path.join(request.workspacePath, "AGENTS.md"), "utf8");
        if (instructions.includes("aggressive")) {
          await mkdir(path.join(request.workspacePath, "docs"), { recursive: true });
          await rm(path.join(request.workspacePath, "docs", "legacy-notes.md"), { force: true });
        }
        return { output: "fake", threadId: "ephemeral", usage: null };
      },
      async cancel() { return false; }, async isAvailable() { return true; },
    };
    const verifier: VerificationRunner = { async run() { return { passed: true, output: "ok", exitCode: 0 }; } };
    const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, verifier);
    await service.initialize();
    const agent = await service.createAgent({ name: "Guard" });
    await mkdir(path.join(agent.workspacePath, "generations", "gen_0001", "docs"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "generations", "gen_0001", "docs", "legacy-notes.md"), "keep", "utf8");
    await service.updateAgent(agent.id, { instructions: "aggressive cleanup" });
    const first = await service.validateCandidate(agent.id, "Tidy this workspace");
    await expect.poll(() => service.getValidation(first.id).status, { timeout: 15_000, interval: 25 }).toBe("review_required");
    const firstResult = service.getValidation(first.id);
    expect(firstResult.baselineGateFailures).toEqual([]); expect(firstResult.candidateGateFailures).toEqual([]); expect(firstResult.differentialDeletions).toEqual(["docs/legacy-notes.md"]);
    const callsAfterMiss = calls;
    const second = await service.validateCandidate(agent.id, "Tidy this workspace");
    await expect.poll(() => service.getValidation(second.id).status, { timeout: 15_000, interval: 25 }).toBe("review_required");
    const secondResult = service.getValidation(second.id);
    expect(secondResult.differentialDeletions).toEqual(firstResult.differentialDeletions);
    expect(secondResult.baselineGateFailures).toEqual(firstResult.baselineGateFailures);
    expect(secondResult.candidateGateFailures).toEqual(firstResult.candidateGateFailures);
    expect(calls).toBe(callsAfterMiss + 1);
  });
});
