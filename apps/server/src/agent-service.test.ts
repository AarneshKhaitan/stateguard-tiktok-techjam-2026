import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult, VerificationRequest, VerificationResult, VerificationRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class PassingVerificationRunner implements VerificationRunner {
  async run(_request: VerificationRequest): Promise<VerificationResult> {
    return { passed: true, output: "verified", exitCode: 0 };
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner(), verifier: VerificationRunner = new PassingVerificationRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    verifier,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0001");
  });

  it("commits a changed staging workspace as the next generation", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "hello.txt"), "hello\n", "utf8");
        return { output: "created", threadId: "thread-2", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Writer" });
    const { run } = await service.sendMessage(agent.id, "create hello.txt");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");

    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0002");
    expect(await readFile(path.join(agent.workspacePath, "generations", "gen_0002", "hello.txt"), "utf8")).toBe("hello\n");
    expect(await readdir(path.join(agent.workspacePath, "generations", "gen_0001"))).not.toContain("hello.txt");
    expect(await readdir(path.join(agent.workspacePath, "generations", "gen_0002"))).not.toContain("AGENTS.md");
  });

  it("blocks a protected-path change and preserves durable state", async () => {
    const service = await makeService({
      run: async (request) => {
        await mkdir(path.join(request.workspacePath, "config"), { recursive: true });
        await writeFile(path.join(request.workspacePath, "config", "production.json"), "unsafe", "utf8");
        return { output: "changed protected config", threadId: "must-not-persist", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Protected" });
    const { run } = await service.sendMessage(agent.id, "modify production config");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 15_000, interval: 25 }).toBe("failed");
    expect(service.getRun(run.id).gateFailures).toEqual([{ code: "PROTECTED_PATH", reason: expect.stringContaining("config/production.json") }]);
    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0001");
    expect(service.getAgent(agent.id).codexThreadId).toBeNull();
    expect(await readdir(path.join(agent.workspacePath, "staging"))).toEqual([]);
    await expect(readFile(path.join(agent.workspacePath, "generations", "gen_0001", "config", "production.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks when the trusted verifier fails, even for an otherwise safe diff", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "safe.txt"), "safe", "utf8");
        return { output: "safe change", threadId: "must-not-persist", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    }, {
      run: async () => ({ passed: false, output: "trusted verification failed", exitCode: 1 }),
    });
    const agent = await service.createAgent({ name: "Verifier" });
    const { run } = await service.sendMessage(agent.id, "make a safe change");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 15_000, interval: 25 }).toBe("failed");
    expect(service.getRun(run.id).gateFailures).toEqual([{ code: "VERIFICATION", reason: "trusted verification failed" }]);
    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0001");
    expect(service.getAgent(agent.id).codexThreadId).toBeNull();
  });

  it("rolls back failed execution and cleans staging", async () => {
    const service = await makeService({
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "partial.txt"), "must not persist", "utf8");
        throw new Error("fake runner failed");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Rollback" });
    const baselineFiles = await Promise.all([".gitignore", "README.md"].map((file) => readFile(path.join(agent.workspacePath, "generations", "gen_0001", file))));
    const { run } = await service.sendMessage(agent.id, "make a partial change");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 15_000, interval: 25 }).toBe("failed");

    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0001");
    expect(service.getRun(run.id).gateFailures).toEqual([{ code: "RUNTIME", reason: "fake runner failed" }]);
    expect(await Promise.all([".gitignore", "README.md"].map((file) => readFile(path.join(agent.workspacePath, "generations", "gen_0001", file))))).toEqual(baselineFiles);
    await expect(readFile(path.join(agent.workspacePath, "generations", "gen_0001", "partial.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(agent.workspacePath, "staging"))).toEqual([]);
  });

  it("rolls back a cancelled execution and preserves the prior thread", async () => {
    let runCount = 0;
    let started!: () => void;
    let cancelRun!: () => void;
    const runner: AgentRunner = {
      run: async (request) => {
        runCount += 1;
        if (runCount === 1) return { output: "first", threadId: "original-thread", usage: null };
        await writeFile(path.join(request.workspacePath, "cancelled.txt"), "discard", "utf8");
        started();
        await new Promise<never>((_, reject) => { cancelRun = () => reject(new RunCancelledError()); });
        throw new Error("unreachable");
      },
      cancel: async () => { cancelRun(); return true; },
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Canceller" });
    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");
    const second = await service.sendMessage(agent.id, "second");
    await new Promise<void>((resolve) => { started = resolve; });
    await service.stopAgent(agent.id);
    expect(service.getRun(second.run.id).status).toBe("cancelled");
    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0001");
    expect(service.getAgent(agent.id).codexThreadId).toBe("original-thread");
    await expect(readFile(path.join(agent.workspacePath, "generations", "gen_0001", "cancelled.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(agent.workspacePath, "staging"))).toEqual([]);
  });

  it("does not mint a generation for an empty diff", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "NoOp" });
    const { run } = await service.sendMessage(agent.id, "do nothing");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");
    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0001");
    expect(await readdir(path.join(agent.workspacePath, "generations"))).toEqual(["gen_0001"]);
  });

  it("keeps ACTIVE on the old generation after a crash before pointer publication", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Crash" });
    const workspaceRoot = path.dirname(agent.workspacePath);
    const projectRoot = path.dirname(workspaceRoot);
    const workspace = new WorkspaceManager(workspaceRoot);
    const prepared = await workspace.prepareStaging(agent, "crash-test");
    await writeFile(path.join(prepared.stagingPath, "orphan.txt"), "orphan", "utf8");
    await workspace.removeAgentsMd(prepared.stagingPath);
    await workspace.commitStaging(agent, prepared.stagingPath);

    const root = workspaceRoot;
    const restarted = new AgentService(
      loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(projectRoot, "data"), AGENT_WORKSPACE_ROOT: root, CODEX_HOME: path.join(projectRoot, "codex"), ARK_API_KEY: "test-key", ARK_MODEL: "ep-test" }),
      new JsonStore(path.join(projectRoot, "data", "db.json")),
      new WorkspaceManager(root),
      new FakeRunner(),
      new PassingVerificationRunner(),
    );
    await restarted.initialize();
    expect(restarted.getAgent(agent.id).activeGenerationId).toBe("gen_0001");
    expect(await readdir(path.join(agent.workspacePath, "generations"))).toEqual(["gen_0001", "gen_0002"]);
    expect(await readFile(path.join(agent.workspacePath, "generations", "gen_0001", "README.md"), "utf8")).toContain("workspace");
  });

  it("never stores AGENTS.md inside a generation and sweeps orphan staging on boot", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Control" });
    const workspaceRoot = path.dirname(agent.workspacePath);
    const projectRoot = path.dirname(workspaceRoot);
    await mkdir(path.join(agent.workspacePath, "staging", "tx-orphan"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "staging", "tx-orphan", "AGENTS.md"), "orphan", "utf8");
    const restarted = new AgentService(
      loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(projectRoot, "data"), AGENT_WORKSPACE_ROOT: workspaceRoot, CODEX_HOME: path.join(projectRoot, "codex"), ARK_API_KEY: "test-key", ARK_MODEL: "ep-test" }),
      new JsonStore(path.join(projectRoot, "data", "db.json")),
      new WorkspaceManager(workspaceRoot),
      new FakeRunner(),
      new PassingVerificationRunner(),
    );
    await restarted.initialize();
    expect(await readdir(path.join(agent.workspacePath, "generations", "gen_0001"))).not.toContain("AGENTS.md");
    await expect(readdir(path.join(agent.workspacePath, "staging"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes a Run whose Agent deleted its own AGENTS.md", async () => {
    const service = await makeService({
      run: async (request) => {
        // The demo's flagship prompt tells the Agent to aggressively remove
        // unnecessary files. AGENTS.md sits in the staging tree, so this is a
        // realistic thing for it to do — and it must not fail the Run.
        await rm(path.join(request.workspacePath, "AGENTS.md"), { force: true });
        await writeFile(path.join(request.workspacePath, "kept.txt"), "work\n", "utf8");
        return { output: "removed the control file", threadId: "tamper-thread", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Tamperer" });
    const { run } = await service.sendMessage(agent.id, "delete everything unnecessary");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");

    expect(service.getRun(run.id).error).toBeNull();
    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0002");
    expect(await readFile(path.join(agent.workspacePath, "generations", "gen_0002", "kept.txt"), "utf8")).toBe("work\n");
    // Deleting AGENTS.md must not surface as a world-state deletion: it was never
    // in the base generation, so the diff sees only the added file.
    expect(await readdir(path.join(agent.workspacePath, "generations", "gen_0002"))).not.toContain("AGENTS.md");
  });

  it("runs two sequential Runs on one Agent, each committing its own generation", async () => {
    const seenAgentIds: string[] = [];
    const service = await makeService({
      run: async (request) => {
        seenAgentIds.push(request.agentId);
        await writeFile(path.join(request.workspacePath, "step" + seenAgentIds.length + ".txt"), "x", "utf8");
        return { output: "step", threadId: "thread-" + seenAgentIds.length, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Sequential" });

    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");
    const second = await service.sendMessage(agent.id, "second");
    await expect.poll(() => service.getRun(second.run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");

    // Both executions used the real agentId. P2 validation reuses it too, running
    // baseline and candidate sequentially, so the per-Agent execution slot must be
    // released cleanly between runs rather than leaking.
    expect(seenAgentIds).toEqual([agent.id, agent.id]);
    expect(service.getAgent(agent.id).activeGenerationId).toBe("gen_0003");
    expect(await readdir(path.join(agent.workspacePath, "generations"))).toEqual(["gen_0001", "gen_0002", "gen_0003"]);
    expect(await readdir(path.join(agent.workspacePath, "generations", "gen_0003"))).toEqual(expect.arrayContaining(["step1.txt", "step2.txt"]));
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status, { timeout: 15_000, interval: 25 }).toBe("completed");
  });
});
