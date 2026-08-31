import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildVerificationRunArgs,
  VerificationContainerRunner,
  verificationContainerName,
} from "./verification-runner.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function config() {
  return loadConfig({
    NODE_ENV: "test",
    RUNTIME_PROVIDER: "container",
    CONTAINER_ENGINE: "docker",
    CONTAINER_RUNTIME_IMAGE: "volc-agent-runtime:local",
    CODEX_HOME: path.join(tmpdir(), "must-not-mount"),
    ARK_API_KEY: "must-not-be-used",
    ARK_MODEL: "must-not-be-used",
    RUNTIME_INSTANCE_ID: "p2-test",
  });
}

const request = (workspacePath: string, command: string, agentId = "agent-a", runId = "run-1") =>
  ({ workspacePath, command, agentId, runId });

describe("independent verification runner", () => {
  it("mounts only the staging workspace and never includes Ark or Codex home", () => {
    const args = buildVerificationRunArgs(request("/tmp/staging", "sh -c 'exit 1'"), config());
    expect(args).toContain("type=bind,src=/tmp/staging,dst=/workspace,readonly");
    expect(args.join(" ")).not.toContain("ARK_API_KEY");
    expect(args.join(" ")).not.toContain("codex-home");
    expect(args.slice(-3)).toEqual(["sh", "-c", "sh -c 'exit 1'"]);
  });

  it("gives concurrent verifications distinct container names", () => {
    // Agents run concurrently — the busy guard is per-Agent — so a name keyed only
    // on the instance id makes Docker reject the second container with a name
    // conflict, which then surfaces as a VERIFICATION gate failure on a clean Run.
    const nameOf = (agentId: string, runId: string) => {
      const args = buildVerificationRunArgs(request("/tmp/staging", "exit 0", agentId, runId), config());
      return args[args.indexOf("--name") + 1];
    };
    const a = nameOf("agent-a", "run-1");
    const b = nameOf("agent-b", "run-2");
    const sameAgentLaterRun = nameOf("agent-a", "run-9");
    expect(a).not.toBe(b);
    expect(a).not.toBe(sameAgentLaterRun);
    for (const name of [a, b, sameAgentLaterRun]) expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  });

  it("runs the configured command rather than the Agent's package.json script", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "verifier-test-"));
    roots.push(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }), "utf8");
    const verifier = new VerificationContainerRunner(config());
    const result = await verifier.run(request(root, "sh -c 'exit 1'"));
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
  }, 120_000);

  it("reports a clean configured command as passing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "verifier-test-"));
    roots.push(root);
    const result = await new VerificationContainerRunner(config()).run(request(root, "sh -c 'exit 0'"));
    expect(result).toMatchObject({ passed: true, exitCode: 0 });
  }, 120_000);

  it("times out on its own budget and leaves no orphaned container", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "verifier-test-"));
    roots.push(root);
    const timed = { ...config(), verificationTimeoutMs: 2_000 };
    const name = verificationContainerName(timed.runtimeInstanceId, "agent-timeout", "run-t");

    const result = await new VerificationContainerRunner(timed).run(request(root, "sleep 120", "agent-timeout", "run-t"));
    expect(result).toMatchObject({ passed: false, exitCode: null });
    expect(result.output).toContain("timed out");
    // It must respect its own budget, not CODEX_TIMEOUT_MS, which is 600s by default.
    expect(timed.verificationTimeoutMs).toBeLessThan(timed.codexTimeoutMs);

    // The real invariant: killing the engine CLI does not stop the container, so
    // without an explicit force-remove a `sleep 120` container would still be running
    // here, consuming CPU/memory limits and holding its name. Run IDs are UUIDs, so
    // production never reuses a name — what matters is that nothing is left behind.
    const survivors = await new Promise<string>((resolve) =>
      execFile("docker", ["ps", "-a", "--filter", "name=" + name, "--format", "{{.Names}} {{.Status}}"], (_error, stdout) =>
        resolve((stdout ?? "").trim()),
      ),
    );
    expect(survivors).toBe("");
  }, 120_000);
});
