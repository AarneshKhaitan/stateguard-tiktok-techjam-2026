import type { AppConfig } from "./config.js";
import type { RunnerRequest } from "./types.js";

export function buildRuntimeContainerArgs(
  request: Pick<RunnerRequest, "agentId" | "workspacePath">,
  config: AppConfig,
  name: string,
  options: { includeArk: boolean; includeCodexHome: boolean; readonlyWorkspace?: boolean },
): string[] {
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run", "--rm", "--init", "--name", name,
    "--label", "io.codejam.launchpad=agent-runtime",
    "--label", "io.codejam.agent-id=" + request.agentId,
    "--label", "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network", "bridge", "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "--cpus", String(config.containerCpuLimit), "--memory", config.containerMemoryLimit,
    "--pids-limit", String(config.containerPidsLimit), "--user", config.containerUser,
    ...(options.includeArk ? ["--env", "ARK_API_KEY"] : []),
    ...(options.includeCodexHome ? ["--env", "CODEX_HOME=/codex-home"] : []),
    "--env", "HOME=/tmp", "--env", "NO_COLOR=1",
    // The verifier mounts this read-only. It runs AFTER the authoritative diff is
    // computed and BEFORE the generation is published, so anything it wrote would be
    // committed without ever appearing in the diff or counting against the change
    // budget — silently breaking "only a verified diff becomes a generation".
    // The verifier observes the subject; it must not be able to alter it.
    "--mount", "type=bind,src=" + request.workspacePath + ",dst=/workspace" + (options.readonlyWorkspace ? ",readonly" : ""),
    ...(options.includeCodexHome ? ["--mount", "type=bind,src=" + config.codexHome + ",dst=/codex-home"] : []),
    "--workdir", "/workspace", config.containerRuntimeImage,
  ];
}
