import { execFile, spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import { buildRuntimeContainerArgs } from "./runtime-container-args.js";
import type { VerificationRequest, VerificationResult, VerificationRunner } from "./types.js";

const sanitize = (value: string, length: number) => value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, length);

/**
 * Unique per instance + Agent + Run. Keying on the instance id alone collides the
 * moment two Agents verify at the same time — Docker refuses a duplicate name and
 * the resulting error surfaces as a VERIFICATION gate failure, blocking a clean Run.
 */
export function verificationContainerName(instanceId: string, agentId: string, runId: string): string {
  return ["launchpad-verifier", sanitize(instanceId, 24), sanitize(agentId, 24), sanitize(runId, 12)].join("-");
}

export function buildVerificationRunArgs(request: VerificationRequest, config: AppConfig): string[] {
  return [
    ...buildRuntimeContainerArgs(
      { agentId: request.agentId, workspacePath: request.workspacePath },
      config,
      verificationContainerName(config.runtimeInstanceId, request.agentId, request.runId),
      { includeArk: false, includeCodexHome: false, readonlyWorkspace: true },
    ),
    "sh", "-c", request.command,
  ];
}

export class VerificationContainerRunner implements VerificationRunner {
  constructor(private readonly config: AppConfig) {}

  /**
   * Killing the engine CLI does not stop the container it started, so a timed-out
   * verification would otherwise leave the container running and holding its name.
   * Force-remove it the way ContainerCodexRunner does.
   */
  private removeContainer(name: string): Promise<void> {
    return new Promise((resolve) =>
      execFile(this.config.containerEngine, ["rm", "--force", name], () => resolve()),
    );
  }

  async run(request: VerificationRequest): Promise<VerificationResult> {
    const name = verificationContainerName(this.config.runtimeInstanceId, request.agentId, request.runId);
    const child = spawn(this.config.containerEngine, buildVerificationRunArgs(request, this.config), {
      cwd: request.workspacePath,
      env: { PATH: process.env.PATH, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      // Set before killing the child so the imminent "close" event does not resolve
      // first with a misleading signal exit code instead of the timeout result.
      let timedOut = false;
      const finish = (result: VerificationResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const append = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > 16_384) output = output.slice(-16_384);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      // Removal is awaited before resolving. Resolving first leaves a window where the
      // container still holds its name, so an immediate retry of the same verification
      // fails with a Docker name conflict (exit 125).
      child.once("error", (error) => {
        void this.removeContainer(name).then(() =>
          finish({ passed: false, output: error.message, exitCode: null }),
        );
      });
      child.once("close", (code) => {
        if (timedOut) return;
        finish({ passed: code === 0, output: output.trim(), exitCode: code });
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        void this.removeContainer(name).then(() =>
          finish({ passed: false, output: "Verification timed out", exitCode: null }),
        );
      }, this.config.verificationTimeoutMs);
      timeout.unref();
    });
  }
}
