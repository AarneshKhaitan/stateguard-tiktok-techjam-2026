import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRelease,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
  GatePolicy,
  ValidationRecord,
  WorkspaceDiff,
  VerificationRunner,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { diffTrees } from "./diff.js";
import { defaultGatePolicy, evaluateAbsoluteGates, hashPolicy } from "./policy.js";
import { createRelease } from "./release.js";
import { newDestructiveDeletions } from "./differential.js";
import { createValidationContext } from "./validation-context.js";
import { referenceCacheKey } from "./reference-cache.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly baselineReferences = new Map<string, { diff: WorkspaceDiff; gates: ReturnType<typeof evaluateAbsoluteGates> }>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly verifier: VerificationRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
    for (const agent of this.store.snapshot().agents) await this.workspaces.migrateAgent(agent);
    await this.workspaces.sweepStaging();
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const fields = { name: input.name.trim(), description: input.description?.trim() ?? "", instructions: input.instructions?.trim() ?? "" };
    const release = createRelease(id, fields, 1, "active", null);
    const agent: Agent = {
      id, ...fields,
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      activeGenerationId: "gen_0001",
      activeReleaseId: release.id,
      candidateReleaseId: null,
      policy: defaultGatePolicy(),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => { database.agents.push(agent); database.releases.push(release); });
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      const previous = database.releases.find((release) => release.id === (agent.candidateReleaseId ?? agent.activeReleaseId));
      const fields = {
        name: input.name?.trim() ?? previous?.name ?? agent.name,
        description: input.description?.trim() ?? previous?.description ?? agent.description,
        instructions: input.instructions?.trim() ?? previous?.instructions ?? agent.instructions,
      };
      const version = Math.max(0, ...database.releases.filter((release) => release.agentId === id).map((release) => release.version)) + 1;
      for (const release of database.releases) if (release.id === agent.candidateReleaseId) release.status = "retired";
      const candidate = createRelease(id, fields, version, "candidate", previous?.id ?? null);
      database.releases.push(candidate);
      agent.name = fields.name; agent.description = fields.description; agent.instructions = fields.instructions;
      agent.candidateReleaseId = candidate.id;
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.releases = database.releases.filter((item) => item.agentId !== id);
      database.validations = database.validations.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async forkAgent(sourceId: string, generationId?: string, name?: string): Promise<Agent> {
    const source = this.getAgent(sourceId);
    const sourceGenerationPath = this.workspaces.generationPath(source, generationId ?? source.activeGenerationId);
    const sourceRelease = this.store.snapshot().releases.find((release) => release.id === source.activeReleaseId);
    if (!sourceRelease) throw new HttpError(409, "Source active release is missing");
    const timestamp = now();
    const id = randomUUID();
    const fields = { name: name?.trim() || sourceRelease.name + " fork", description: sourceRelease.description, instructions: sourceRelease.instructions };
    const release = createRelease(id, fields, 1, "active", null);
    const agent: Agent = { id, ...fields, status: "ready", workspacePath: this.workspaces.workspacePath(id), activeGenerationId: "gen_0001", activeReleaseId: release.id, candidateReleaseId: null, policy: structuredClone(source.policy), codexThreadId: null, lastError: null, createdAt: timestamp, updatedAt: timestamp };
    await this.workspaces.create(agent);
    try { await this.workspaces.forkGeneration(sourceGenerationPath, agent); }
    catch (error) { await this.workspaces.removeStaging(agent.workspacePath); throw error; }
    await this.store.mutate((database) => { database.agents.push(agent); database.releases.push(release); });
    return agent;
  }

  getReleases(agentId: string): AgentRelease[] {
    this.getAgent(agentId);
    return this.store.snapshot().releases.filter((release) => release.agentId === agentId).sort((a, b) => b.version - a.version);
  }

  async updatePolicy(id: string, input: Omit<GatePolicy, "policyHash">): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy") throw new HttpError(409, "Stop the active run before changing policy");
      const policy = { ...input, protectedPaths: input.protectedPaths.map((item) => item.trim()).filter(Boolean) };
      agent.policy = { ...policy, policyHash: hashPolicy(policy) };
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  async validateCandidate(agentId: string, task: string): Promise<ValidationRecord> {
    if (!task.trim()) throw new HttpError(400, "Validation task is required");
    const agent = this.getAgent(agentId);
    if (agent.status === "busy") throw new HttpError(409, "Stop the active run before validating");
    const database = this.store.snapshot();
    const candidate = database.releases.find((release) => release.id === agent.candidateReleaseId);
    const baseline = database.releases.find((release) => release.id === agent.activeReleaseId);
    if (!candidate || !baseline) throw new HttpError(409, "A candidate release is required");
    const validation: ValidationRecord = {
      id: randomUUID(), agentId, baselineRunId: randomUUID(), candidateRunId: randomUUID(), candidateReleaseId: candidate.id,
      status: "running", task: task.trim(),
      context: createValidationContext({
        baselineReleaseHash: baseline.releaseHash, candidateReleaseHash: candidate.releaseHash,
        generationId: agent.activeGenerationId, taskHash: this.hashTask(task.trim()), policyHash: agent.policy.policyHash,
        arkModel: this.config.arkModel, codexVersion: this.config.codexVersion,
      }),
      baselineDiff: this.emptyDiff(agent.activeGenerationId), candidateDiff: this.emptyDiff(agent.activeGenerationId),
      baselineGateFailures: [], candidateGateFailures: [], differentialDeletions: [], error: null,
      createdAt: now(), completedAt: null,
    };
    await this.store.mutate((db) => { db.validations.push(validation); const stored = db.agents.find((item) => item.id === agentId); if (stored) { stored.status = "busy"; stored.updatedAt = now(); } });
    // Fire-and-forget, exactly like sendMessage. A validation is two full Codex runs;
    // awaiting it here would hold the HTTP request open for minutes and time out in the
    // browser, despite the route answering 202. The client polls GET /api/validations/:id.
    const execution = this.executeValidation(agent, baseline, candidate, validation);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) this.activeExecutions.delete(agentId);
      })
      .catch(() => undefined);
    return validation;
  }

  private async executeValidation(agent: Agent, baseline: AgentRelease, candidate: AgentRelease, validation: ValidationRecord): Promise<void> {
    try {
      const basePath = this.workspaces.generationPath(agent);
      const referenceKey = referenceCacheKey({
        baselineReleaseHash: validation.context.baselineReleaseHash,
        generationId: validation.context.generationId,
        taskHash: validation.context.taskHash,
        policyHash: validation.context.policyHash,
        arkModel: validation.context.arkModel,
        codexVersion: validation.context.codexVersion,
      });
      const cachedReference = this.baselineReferences.get(referenceKey);
      const first = cachedReference
        ? structuredClone(cachedReference)
        : await this.runValidationExecution(agent, baseline, validation.baselineRunId, validation.task, basePath);
      if (!cachedReference) this.baselineReferences.set(referenceKey, structuredClone(first));
      const second = await this.runValidationExecution(agent, candidate, validation.candidateRunId, validation.task, basePath);
      const differentialDeletions = newDestructiveDeletions(first.diff, second.diff);
      // The baseline failing its own gates is not the candidate's fault. Reporting it as
      // "blocked" would attribute the active release's problem to the candidate, so it
      // gets its own status. Enforcement is the same — nothing is certified against an
      // unhealthy baseline — but the stated reason is honest.
      const baselineUnhealthy = first.gates.failures.length > 0;
      const blocked = second.gates.failures.length > 0 || differentialDeletions.length > 0;
      await this.store.mutate((db) => {
        const record = db.validations.find((item) => item.id === validation.id); const storedAgent = db.agents.find((item) => item.id === agent.id);
        if (!record || !storedAgent) return;
        record.status = baselineUnhealthy ? "baseline_unhealthy" : blocked ? "blocked" : "certified"; record.baselineDiff = first.diff; record.candidateDiff = second.diff;
        record.baselineGateFailures = first.gates.failures; record.candidateGateFailures = second.gates.failures; record.differentialDeletions = differentialDeletions; record.completedAt = now();
        storedAgent.status = "ready"; storedAgent.updatedAt = now();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((db) => { const record = db.validations.find((item) => item.id === validation.id); const storedAgent = db.agents.find((item) => item.id === agent.id); if (record) { record.status = "failed"; record.error = message; record.completedAt = now(); } if (storedAgent) { storedAgent.status = "error"; storedAgent.lastError = message; storedAgent.updatedAt = now(); } });
    }
  }

  private async runValidationExecution(agent: Agent, release: AgentRelease, runId: string, task: string, basePath: string): Promise<{ diff: WorkspaceDiff; gates: ReturnType<typeof evaluateAbsoluteGates> }> {
    const { stagingPath, agentsMdHash } = await this.workspaces.prepareStagingFrom(agent, runId, basePath, release);
    try {
      const result = await this.runner.run({ agentId: agent.id, workspacePath: stagingPath, prompt: task, threadId: null });
      const agentsMdAfterHash = await this.workspaces.hashAgentsMd(stagingPath);
      const agentsTampered = agentsMdAfterHash === null
        ? "Agent deleted platform-managed AGENTS.md"
        : agentsMdAfterHash !== agentsMdHash
          ? "Agent rewrote platform-managed AGENTS.md"
          : null;
      await this.workspaces.removeAgentsMd(stagingPath);
      const diff = await diffTrees(basePath, stagingPath, agent.activeGenerationId);
      let verification;
      try { verification = await this.verifier.run({ workspacePath: stagingPath, command: agent.policy.verificationCommand, agentId: agent.id, runId }); }
      catch (error) { verification = { passed: false, output: error instanceof Error ? error.message : String(error), exitCode: null }; }
      return { diff, gates: evaluateAbsoluteGates(diff, agent.policy, verification, null, agentsTampered) };
    } finally { await this.workspaces.removeStaging(stagingPath); }
  }

  private hashTask(task: string): string { return createHash("sha256").update(task).digest("hex"); }
  private emptyDiff(generationId: string): WorkspaceDiff { return { baseGenerationId: generationId, changes: [], addedCount: 0, modifiedCount: 0, deletedCount: 0, isEmpty: true }; }

  getValidations(agentId: string): ValidationRecord[] {
    this.getAgent(agentId);
    return this.store.snapshot().validations.filter((item) => item.agentId === agentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getValidation(id: string): ValidationRecord {
    const validation = this.store.snapshot().validations.find((item) => item.id === id);
    if (!validation) throw new HttpError(404, "Validation not found");
    return validation;
  }

  async promote(id: string, validationId?: string): Promise<Agent> {
    this.getAgent(id);
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      // Without this, promotion during an in-flight Run defeats the whole CAS: the
      // generation check passes because the Run has not committed yet, and the Run
      // then advances the generation immediately afterwards — leaving a release
      // promoted on evidence from a generation production has already left. Every
      // other mutating operation guards on busy; this one has to as well.
      if (agent.status === "busy") throw new HttpError(409, "Promotion refused: a Run is in flight; stop it or wait for it to finish");
      const validation = database.validations
        .filter((item) => item.agentId === id && (!validationId || item.id === validationId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!validation) throw new HttpError(409, "Promotion refused: no validation exists");
      if (validation.status !== "certified") throw new HttpError(409, `Promotion refused: validation is ${validation.status}, not CERTIFIED`);
      const active = database.releases.find((release) => release.id === agent.activeReleaseId);
      const candidate = database.releases.find((release) => release.id === validation.candidateReleaseId);
      if (!active || !candidate || agent.candidateReleaseId !== candidate.id) throw new HttpError(409, "Promotion refused: candidate release is no longer current; revalidation required");
      const actual = createValidationContext({
        baselineReleaseHash: active.releaseHash, candidateReleaseHash: candidate.releaseHash,
        generationId: agent.activeGenerationId, taskHash: this.hashTask(validation.task), policyHash: agent.policy.policyHash,
        arkModel: this.config.arkModel, codexVersion: this.config.codexVersion,
      });
      const fields: Array<keyof Omit<typeof actual, "contextHash">> = ["baselineReleaseHash", "candidateReleaseHash", "generationId", "taskHash", "policyHash", "arkModel", "codexVersion"];
      for (const field of fields) {
        if (actual[field] !== validation.context[field]) {
          throw new HttpError(409, `Promotion refused: ${field} drifted; revalidation required (${validation.context[field]} -> ${actual[field]})`);
        }
      }
      const previousActive = database.releases.find((release) => release.id === agent.activeReleaseId);
      if (previousActive) previousActive.status = "retired";
      candidate.status = "active";
      agent.activeReleaseId = candidate.id;
      agent.candidateReleaseId = null;
      agent.codexThreadId = null;
      agent.name = candidate.name; agent.description = candidate.description; agent.instructions = candidate.instructions;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      gateFailures: null,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const activeRelease = this.store.snapshot().releases.find((release) => release.id === agentAtStart.activeReleaseId);
      if (!activeRelease) throw new Error("Active release is missing");
      const { stagingPath, basePath, agentsMdHash } = await this.workspaces.prepareStaging(agentAtStart, run.id, activeRelease);
      try {
        const result = await this.runner.run({
          agentId: agentAtStart.id,
          workspacePath: stagingPath,
          prompt: run.prompt,
          threadId: agentAtStart.codexThreadId,
        });
        // AGENTS.md tamper detection. A null after-hash means the Agent deleted its
        // own control file; a differing hash means it rewrote it. Either is an
        // absolute gate failure — without this an Agent can rewrite the instructions
        // it is judged against, which makes every other gate advisory.
        const agentsMdAfterHash = await this.workspaces.hashAgentsMd(stagingPath);
        const agentsTampered = agentsMdAfterHash === null
          ? "Agent deleted platform-managed AGENTS.md"
          : agentsMdAfterHash !== agentsMdHash
            ? "Agent rewrote platform-managed AGENTS.md"
            : null;
        await this.workspaces.removeAgentsMd(stagingPath);
        const diff = await diffTrees(basePath, stagingPath, agentAtStart.activeGenerationId);
        let verification;
        try {
          verification = await this.verifier.run({
            workspacePath: stagingPath,
            command: agentAtStart.policy.verificationCommand,
            agentId: agentAtStart.id,
            runId: run.id,
          });
        } catch (error) {
          verification = { passed: false, output: error instanceof Error ? error.message : String(error), exitCode: null };
        }
        const gates = evaluateAbsoluteGates(diff, agentAtStart.policy, verification, null, agentsTampered);
        if (!gates.certified) {
          await this.workspaces.removeStaging(stagingPath);
          const completedAt = now();
          await this.store.mutate((database) => {
            const storedRun = database.runs.find((item) => item.id === run.id);
            const agent = database.agents.find((item) => item.id === agentAtStart.id);
            if (!storedRun || !agent) return;
            storedRun.status = "failed";
            storedRun.error = "Run blocked: " + gates.failures.map((failure) => failure.reason).join("; ");
            storedRun.gateFailures = gates.failures;
            storedRun.completedAt = completedAt;
            agent.status = "ready";
            agent.lastError = null;
            agent.updatedAt = completedAt;
          });
          return;
        }
        let nextGenerationId = agentAtStart.activeGenerationId;
        if (!diff.isEmpty) nextGenerationId = await this.workspaces.commitStaging(agentAtStart, stagingPath);
        else await this.workspaces.removeStaging(stagingPath);
        const completedAt = now();
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (!storedRun || !agent) return;
          storedRun.status = "completed";
          storedRun.output = result.output;
          storedRun.usage = result.usage;
          storedRun.completedAt = completedAt;
          storedRun.gateFailures = [];
          database.messages.push({ id: randomUUID(), agentId: agent.id, runId: run.id, role: "assistant", content: result.output, createdAt: completedAt });
          agent.status = "ready";
          agent.activeGenerationId = nextGenerationId;
          agent.codexThreadId = result.threadId;
          agent.lastError = null;
          agent.updatedAt = completedAt;
        });
      } catch (error) {
        await this.workspaces.removeStaging(stagingPath);
        throw error;
      }
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          if (!cancelled && (!storedRun.gateFailures || storedRun.gateFailures.length === 0)) {
            storedRun.gateFailures = [{ code: "RUNTIME", reason: message }];
          }
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
