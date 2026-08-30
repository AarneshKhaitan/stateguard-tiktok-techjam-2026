import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { newDestructiveDeletions } from "./differential.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, VerificationRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { createValidationContext } from "./validation-context.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => (await import("node:fs/promises")).rm(root, { recursive: true, force: true }))));

function diff(deletions: string[]) {
  return { baseGenerationId: "gen_0001", changes: deletions.map((path) => ({ path, kind: "deleted" as const })), addedCount: 0, modifiedCount: 0, deletedCount: deletions.length, isEmpty: deletions.length === 0 };
}

class PassingVerifier implements VerificationRunner { async run() { return { passed: true, output: "ok", exitCode: 0 }; } }

async function makeService(): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "stateguard-p3-")); roots.push(root);
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test", ARK_MODEL: "ep-test" });
  const runner: AgentRunner = {
    async run(request: RunnerRequest) {
      const agents = await readFile(path.join(request.workspacePath, "AGENTS.md"), "utf8");
      if (agents.includes("aggressive")) await (await import("node:fs/promises")).rm(path.join(request.workspacePath, "docs", "legacy-notes.md"), { force: true });
      return { output: "fake", threadId: "validation-thread-must-not-persist", usage: null };
    },
    async cancel() { return false; }, async isAvailable() { return true; },
  };
  const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, new PassingVerifier());
  await service.initialize(); return service;
}

describe("P3 differential validation", () => {
  it("blocks a new deletion even when every absolute gate passes", async () => {
    const service = await makeService(); const agent = await service.createAgent({ name: "Guard" });
    await mkdir(path.join(agent.workspacePath, "generations", "gen_0001", "docs"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "generations", "gen_0001", "docs", "legacy-notes.md"), "keep", "utf8");
    const candidate = await service.updateAgent(agent.id, { instructions: "Be aggressive about cleanup" });
    const validation = await service.validateCandidate(agent.id, "clean up");
    expect(validation.status).toBe("blocked");
    expect(validation.baselineGateFailures).toEqual([]);
    expect(validation.candidateGateFailures).toEqual([]);
    expect(validation.differentialDeletions).toEqual(["docs/legacy-notes.md"]);
    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0001");
    expect(service.getAgent(agent.id).codexThreadId).toBeNull();
    expect(await readdir(path.join(agent.workspacePath, "staging"))).toEqual([]);
    expect(candidate.candidateReleaseId).not.toBeNull();
  });

  it("certifies a safe candidate and keeps release versions immutable", async () => {
    const service = await makeService(); const agent = await service.createAgent({ name: "Guard" });
    const before = service.getReleases(agent.id); const updated = await service.updateAgent(agent.id, { instructions: "Be careful" });
    const after = service.getReleases(agent.id);
    expect(after).toHaveLength(2); expect(after.find((item) => item.id === before[0]?.id)?.instructions).toBe(before[0]?.instructions);
    expect(updated.candidateReleaseId).toBe(after[0]?.id);
    expect((await service.validateCandidate(agent.id, "inspect")).status).toBe("certified");
    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0001");
  });

  it("compares deletions against the baseline, not against a heuristic", () => {
    expect(newDestructiveDeletions(diff(["docs/legacy-notes.md"]), diff(["docs/legacy-notes.md"]))).toEqual([]);
    expect(newDestructiveDeletions(diff([]), diff(["docs/legacy-notes.md"]))).toEqual(["docs/legacy-notes.md"]);
  });

  it("changes the context fingerprint for every input", () => {
    const base = { baselineReleaseHash: "a", candidateReleaseHash: "b", generationId: "gen_0001", taskHash: "t", policyHash: "p", arkModel: "m", codexVersion: "c" };
    const original = createValidationContext(base).contextHash;
    for (const key of Object.keys(base) as Array<keyof typeof base>) expect(createValidationContext({ ...base, [key]: base[key] + "-changed" }).contextHash).not.toBe(original);
  });
});
