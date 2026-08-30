import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, AgentRelease, GenerationId } from "./types.js";

const initialGeneration: GenerationId = "gen_0001";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string { return path.join(this.root, agentId); }
  generationPath(agent: Agent, generationId = agent.activeGenerationId): string {
    return path.join(agent.workspacePath, "generations", generationId);
  }
  stagingRoot(agent: Agent): string { return path.join(agent.workspacePath, "staging"); }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    const generation = this.generationPath(agent, initialGeneration);
    await mkdir(generation, { recursive: true });
    await writeFile(path.join(generation, ".gitignore"), [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"), "utf8");
    await writeFile(path.join(generation, "README.md"), ["# " + agent.name + " workspace", "", "Files created or edited by the Agent live here.", ""].join("\n"), "utf8");
  }

  async migrateAgent(agent: Agent): Promise<void> {
    const generation = this.generationPath(agent);
    try { await stat(generation); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(generation, { recursive: true });
    for (const entry of await readdir(agent.workspacePath, { withFileTypes: true })) {
      if (["generations", "staging", "AGENTS.md"].includes(entry.name)) continue;
      await cp(path.join(agent.workspacePath, entry.name), path.join(generation, entry.name), { recursive: entry.isDirectory() });
    }
  }

  async prepareStaging(agent: Agent, runId: string, instructionsSource: Pick<AgentRelease, "name" | "description" | "instructions"> | Agent = agent): Promise<{ stagingPath: string; basePath: string; agentsMdHash: string }> {
    return this.prepareStagingFrom(agent, runId, this.generationPath(agent), instructionsSource);
  }

  async prepareStagingFrom(agent: Agent, runId: string, basePath: string, instructionsSource: Pick<AgentRelease, "name" | "description" | "instructions"> | Agent): Promise<{ stagingPath: string; basePath: string; agentsMdHash: string }> {
    const stagingPath = path.join(this.stagingRoot(agent), "tx_" + runId);
    await mkdir(this.stagingRoot(agent), { recursive: true });
    await cp(basePath, stagingPath, { recursive: true, force: false });
    const agentsMdHash = await this.synthesizeAgentsMd(stagingPath, instructionsSource);
    return { stagingPath, basePath, agentsMdHash };
  }

  async synthesizeAgentsMd(targetDir: string, agent: Pick<Agent, "name" | "description" | "instructions">): Promise<string> {
    const content = this.instructionsContent(agent);
    await writeFile(path.join(targetDir, "AGENTS.md"), content, "utf8");
    return createHash("sha256").update(content).digest("hex");
  }

  async removeStaging(stagingPath: string): Promise<void> { await rm(stagingPath, { recursive: true, force: true }); }
  async removeAgentsMd(stagingPath: string): Promise<void> { await rm(path.join(stagingPath, "AGENTS.md"), { force: true }); }
  /**
   * Returns null when the Agent deleted AGENTS.md during the Run. A missing control
   * file is a tamper signal, not a platform failure: the Run's own work may be
   * perfectly valid, so it must still be diffed and committed on its merits.
   */
  async hashAgentsMd(stagingPath: string): Promise<string | null> {
    try {
      return createHash("sha256").update(await readFile(path.join(stagingPath, "AGENTS.md"))).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async commitStaging(agent: Agent, stagingPath: string): Promise<GenerationId> {
    const entries = await readdir(path.join(agent.workspacePath, "generations"));
    const numbers = entries.map((entry) => /^gen_(\d+)$/.exec(entry)?.[1]).filter((value): value is string => value !== undefined).map(Number);
    const generationId = "gen_" + String(Math.max(0, ...numbers) + 1).padStart(4, "0");
    await rename(stagingPath, this.generationPath(agent, generationId));
    return generationId;
  }

  async sweepStaging(): Promise<void> {
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== ".deleted") await rm(path.join(this.root, entry.name, "staging"), { recursive: true, force: true });
    }
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(this.root, ".deleted", agent.id + "-" + timestamp);
    await rename(agent.workspacePath, destination);
    return destination;
  }

  private instructionsContent(agent: Pick<Agent, "name" | "description" | "instructions">): string {
    return [
      "# Platform-managed Agent instructions", "", "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "", "", "## Instructions", "",
      agent.instructions || "Help the user complete coding tasks in this workspace. Explain material results concisely.", "", "## Workspace rules", "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.", "- Preserve existing user files and avoid destructive operations.", "- Build and test changes when practical.", "- Never print environment variables or credentials.", "", "This file is regenerated when the Agent configuration is updated.", "",
    ].filter((line, index, lines) => !(line === "" && lines[index - 1] === "")).join("\n");
  }
}
