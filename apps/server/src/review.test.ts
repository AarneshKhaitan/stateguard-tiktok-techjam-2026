import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("review acknowledgement", () => {
  it("requires an audited acknowledgement before promoting flagged drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stateguard-review-")); roots.push(root);
    const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "test", ARK_MODEL: "ep-test" });
    const runner: AgentRunner = { async run(request) { const instructions = await readFile(path.join(request.workspacePath, "AGENTS.md"), "utf8"); if (instructions.includes("flagged")) await rm(path.join(request.workspacePath, "docs", "legacy-notes.md"), { force: true }); return { output: "ok", threadId: null, usage: null }; }, async cancel() { return false; }, async isAvailable() { return true; } };
    const verifier: VerificationRunner = { async run() { return { passed: true, output: "ok", exitCode: 0 }; } };
    const service = new AgentService(config, new JsonStore(path.join(root, "data", "db.json")), new WorkspaceManager(path.join(root, "workspaces")), runner, verifier);
    await service.initialize(); const agent = await service.createAgent({ name: "Guard" });
    await mkdir(path.join(agent.workspacePath, "generations", "gen_0001", "docs"), { recursive: true }); await writeFile(path.join(agent.workspacePath, "generations", "gen_0001", "docs", "legacy-notes.md"), "keep", "utf8");
    await service.updateAgent(agent.id, { instructions: "flagged cleanup" }); const started = await service.validateCandidate(agent.id, "tidy");
    await expect.poll(() => service.getValidation(started.id).status, { timeout: 15_000, interval: 25 }).toBe("blocked");
    await expect(service.promote(agent.id, started.id)).rejects.toThrow(/validation is blocked/);
    const acknowledged = await service.acknowledgeValidation(started.id, "operator-1", "Reviewed the deletion for this controlled migration");
    expect(acknowledged.status).toBe("review_required"); expect(acknowledged.reviewAcknowledgement?.actor).toBe("operator-1");
    await expect(service.promote(agent.id, started.id)).rejects.toThrow(/actor and reason/);
    const promoted = await service.promote(agent.id, started.id, "operator-1", "Approved after review");
    expect(promoted.activeReleaseId).toBe(acknowledged.candidateReleaseId); expect(promoted.activeGenerationId).toBe("gen_0001");
    const record = service.getValidation(started.id); expect(record.promotionAudit?.actor).toBe("operator-1"); expect(record.promotionAudit?.reason).toBe("Approved after review");
  });
});
