import { spawn, type ChildProcess } from "node:child_process";
import type { AppConfig } from "./config.js";
import { buildRuntimeContainerArgs } from "./runtime-container-args.js";
import type { VerificationRequest, VerificationResult, VerificationRunner } from "./types.js";

export function verificationContainerName(instanceId: string): string {
  const safe = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  return "launchpad-verifier-" + safe;
}

export function buildVerificationRunArgs(request: VerificationRequest, config: AppConfig): string[] {
  return [
    ...buildRuntimeContainerArgs(
      { agentId: "verifier", workspacePath: request.workspacePath },
      config,
      verificationContainerName(config.runtimeInstanceId),
      { includeArk: false, includeCodexHome: false },
    ),
    "sh", "-c", request.command,
  ];
}

export class VerificationContainerRunner implements VerificationRunner {
  constructor(private readonly config: AppConfig) {}

  async run(request: VerificationRequest): Promise<VerificationResult> {
    const child = spawn(this.config.containerEngine, buildVerificationRunArgs(request, this.config), {
      cwd: request.workspacePath,
      env: { PATH: process.env.PATH, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
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
      child.once("error", (error) => finish({ passed: false, output: error.message, exitCode: null }));
      child.once("close", (code) => finish({ passed: code === 0, output: output.trim(), exitCode: code }));
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finish({ passed: false, output: "Verification timed out", exitCode: null });
      }, this.config.codexTimeoutMs);
      timeout.unref();
    });
  }
}
