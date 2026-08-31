import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, VerificationRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const roots: string[] = []; afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
class Verifier implements VerificationRunner { async run() { return { passed: true, output: "ok", exitCode: 0 }; } }
async function makeService() {
  const root = await mkdtemp(path.join(tmpdir(), "stateguard-worlds-")); roots.push(root); let arrivals = 0; let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
  const runner: AgentRunner = { async run(request) { arrivals += 1; if (arrivals === 2) release(); await barrier; await writeFile(path.join(request.workspacePath, request.prompt), request.agentId); return { output: "ok", threadId: request.agentId, usage: null }; }, async cancel() { return false; }, async isAvailable() { return true; } };
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test", ARK_MODEL: "test" });
  const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, new Verifier()); await service.initialize(); return service;
}
async function settle(service: AgentService, runId: string) { await expect.poll(() => ["completed", "failed", "cancelled"].includes(service.getRun(runId).status), { timeout: 15_000, interval: 20 }).toBe(true); return service.getRun(runId); }
describe("shared worlds", () => {
  it("refuses an overlapping concurrent write and names the winning generation", async () => { const service = await makeService(); const a = await service.createAgent({ name: "A" }); const b = await service.createAgent({ name: "B" }); await service.attachAgentToWorld(b.id, a.worldId); const [ra, rb] = await Promise.all([service.sendMessage(a.id, "same.txt"), service.sendMessage(b.id, "same.txt")]); const results = await Promise.all([settle(service, ra.run.id), settle(service, rb.run.id)]); expect(results.map((run) => run.status).sort()).toEqual(["completed", "failed"]); expect(results.find((run) => run.status === "failed")?.error).toContain("same.txt"); expect(service.getWorld(a.worldId).activeGenerationId).toBe("gen_0002"); });
  it("rebases disjoint concurrent writes and keeps both files", async () => { const service = await makeService(); const a = await service.createAgent({ name: "A" }); const b = await service.createAgent({ name: "B" }); await service.attachAgentToWorld(b.id, a.worldId); const [ra, rb] = await Promise.all([service.sendMessage(a.id, "a.txt"), service.sendMessage(b.id, "b.txt")]); await Promise.all([settle(service, ra.run.id), settle(service, rb.run.id)]); const world = service.getWorld(a.worldId); expect(world.activeGenerationId).toBe("gen_0003"); expect(await readFile(path.join(a.workspacePath, "generations", "gen_0003", "a.txt"), "utf8")).toBeTruthy(); expect(await readFile(path.join(a.workspacePath, "generations", "gen_0003", "b.txt"), "utf8")).toBeTruthy(); });
});
