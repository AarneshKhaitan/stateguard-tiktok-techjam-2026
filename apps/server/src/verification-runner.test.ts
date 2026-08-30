import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { buildVerificationRunArgs, VerificationContainerRunner } from "./verification-runner.js";

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

describe("independent verification runner", () => {
  it("mounts only the staging workspace and never includes Ark or Codex home", () => {
    const args = buildVerificationRunArgs({ workspacePath: "/tmp/staging", command: "sh -c 'exit 1'" }, config());
    expect(args).toContain("type=bind,src=/tmp/staging,dst=/workspace");
    expect(args.join(" ")).not.toContain("ARK_API_KEY");
    expect(args.join(" ")).not.toContain("codex-home");
    expect(args.slice(-3)).toEqual(["sh", "-c", "sh -c 'exit 1'"]);
  });

  it("runs the configured command rather than the Agent's package.json script", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "verifier-test-"));
    roots.push(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }), "utf8");
    const verifier = new VerificationContainerRunner(config());
    const result = await verifier.run({ workspacePath: root, command: "sh -c 'exit 1'" });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
  }, 30_000);

  it("reports a clean configured command as passing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "verifier-test-"));
    roots.push(root);
    const result = await new VerificationContainerRunner(config()).run({ workspacePath: root, command: "sh -c 'exit 0'" });
    expect(result).toMatchObject({ passed: true, exitCode: 0 });
  }, 30_000);
});
