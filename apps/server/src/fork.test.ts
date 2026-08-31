import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("fork from generation", () => {
  it("copies world state into an independent Agent and starts release lineage at v1", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stateguard-fork-")); roots.push(root);
    const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test", ARK_MODEL: "ep-test" });
    const runner: AgentRunner = { async run(request) { await writeFile(path.join(request.workspacePath, "fork-only.txt"), "fork", "utf8"); return { output: "ok", threadId: "fork-thread", usage: null }; }, async cancel() { return false; }, async isAvailable() { return true; } };
    const verifier: VerificationRunner = { async run() { return { passed: true, output: "ok", exitCode: 0 }; } };
    const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, verifier);
    await service.initialize();
    const source = await service.createAgent({ name: "Source", instructions: "source instructions" });
    await writeFile(path.join(source.workspacePath, "generations", "gen_0001", "source.txt"), "source", "utf8");
    const fork = await service.forkAgent(source.id, "gen_0001", "Fork");
    expect(fork.activeGenerationId).toBe("gen_0001"); expect(fork.codexThreadId).toBeNull();
    expect(service.getReleases(fork.id)).toHaveLength(1); expect(service.getReleases(fork.id)[0]?.version).toBe(1);
    expect(await readFile(path.join(fork.workspacePath, "generations", "gen_0001", "source.txt"), "utf8")).toBe("source");
    const run = await service.sendMessage(fork.id, "change fork");
    await expect.poll(() => service.getRun(run.run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");
    await expect(readFile(path.join(source.workspacePath, "generations", "gen_0001", "fork-only.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(fork.workspacePath, "generations", "gen_0002", "fork-only.txt"), "utf8")).toBe("fork");
  });
});
