import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, VerificationRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
class Verifier implements VerificationRunner { async run() { return { passed: true, output: "ok", exitCode: 0 }; } }

async function serviceForBisection() {
  const root = await mkdtemp(path.join(tmpdir(), "stateguard-bisect-")); roots.push(root);
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test", ARK_MODEL: "test" });
  const runner: AgentRunner = { async run(request: RunnerRequest) { const agents = await (await import("node:fs/promises")).readFile(path.join(request.workspacePath, "AGENTS.md"), "utf8"); if (agents.includes("CULPRIT")) await rm(path.join(request.workspacePath, "docs", "legacy.md"), { force: true }); return { output: "fake", threadId: "ephemeral", usage: null }; }, async cancel() { return false; }, async isAvailable() { return true; } };
  const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, new Verifier()); await service.initialize();
  return service;
}
async function settle(service: AgentService, agentId: string) { const started = await service.validateCandidate(agentId, "tidy"); await expect.poll(() => service.getValidation(started.id).status, { timeout: 15_000, interval: 20 }).not.toBe("running"); return service.getValidation(started.id); }

describe("behavioural bisection", () => {
  it("isolates one of three instruction changes with discarded ephemeral probes", async () => {
    const service = await serviceForBisection(); const agent = await service.createAgent({ name: "Probe" });
    await mkdir(path.join(agent.workspacePath, "generations", "gen_0001", "docs"), { recursive: true }); await writeFile(path.join(agent.workspacePath, "generations", "gen_0001", "docs", "legacy.md"), "keep");
    await service.updateAgent(agent.id, { instructions: "first harmless change\n\nCULPRIT delete documentation\n\nthird harmless change" });
    const validation = await settle(service, agent.id); const result = await service.bisectValidation(validation.id, "docs/legacy.md");
    expect(result.inconclusive).toBe(false); expect(result.culpritSegments).toEqual(["CULPRIT delete documentation"]); expect(result.probes).toHaveLength(2); expect(result.probes.every((probe) => probe.runId)).toBe(true);
    expect(service.getReleases(agent.id).every((release) => release.status !== "probe")).toBe(true); expect(service.getAgent(agent.id).codexThreadId).toBeNull(); expect((await readdir(path.join(agent.workspacePath, "staging"))).sort()).toEqual([]);
  });

  it("records inconclusive attribution evidence when the target did not reproduce", async () => {
    const service = await serviceForBisection(); const agent = await service.createAgent({ name: "Probe" }); await service.updateAgent(agent.id, { instructions: "first\n\nsecond" });
    const validation = await settle(service, agent.id); const result = await service.bisectValidation(validation.id, "missing.md");
    expect(result.inconclusive).toBe(true); expect(result.culpritSegments).toEqual([]); expect(result.probes).toEqual([]);
  });
});
