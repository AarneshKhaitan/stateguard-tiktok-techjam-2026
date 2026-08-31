export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type GenerationId = string;
export type ReleaseStatus = "active" | "candidate" | "retired";
/** `baseline_unhealthy` means the ACTIVE release failed its own gates on this task and
 *  generation, so the candidate cannot be judged against it. Enforcement matches
 *  `blocked` — nothing is certified — but the blame is attributed correctly. */
export type ValidationStatus = "running" | "certified" | "blocked" | "baseline_unhealthy" | "review_required" | "failed";

export interface GatePolicy {
  protectedPaths: string[];
  verificationCommand: string;
  changeBudget: number;
  policyHash: string;
}

export interface GateFailure {
  code: "PROTECTED_PATH" | "CHANGE_BUDGET" | "VERIFICATION" | "RUNTIME" | "AGENTS_TAMPERED";
  reason: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  activeGenerationId: GenerationId;
  activeReleaseId: string;
  candidateReleaseId: string | null;
  canaryPreviousReleaseId: string | null;
  canaryRunsRemaining: number;
  canaryConsecutiveFailures: number;
  policy: GatePolicy;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRelease {
  id: string;
  agentId: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  releaseHash: string;
  status: ReleaseStatus;
  parentReleaseId: string | null;
  createdAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  gateFailures?: GateFailure[] | null;
}

export interface Database {
  version: 4;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  releases: AgentRelease[];
  validations: ValidationRecord[];
}

export interface ValidationContext {
  baselineReleaseHash: string;
  candidateReleaseHash: string;
  generationId: string;
  taskHash: string;
  policyHash: string;
  arkModel: string;
  codexVersion: string;
  contextHash: string;
}

export interface ValidationRecord {
  id: string;
  agentId: string;
  baselineRunId: string;
  candidateRunId: string;
  candidateReleaseId: string;
  status: ValidationStatus;
  task: string;
  context: ValidationContext;
  baselineDiff: WorkspaceDiff;
  candidateDiff: WorkspaceDiff;
  baselineGateFailures: GateFailure[];
  candidateGateFailures: GateFailure[];
  differentialDeletions: string[];
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  reviewAcknowledgement: { actor: string; reason: string; acknowledgedAt: string } | null;
  promotionAudit: { actor: string; reason: string; promotedAt: string } | null;
  ghostJournal: import("./ghost-replay.js").GhostEvent[];
}

export interface FileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  beforeHash?: string;
  afterHash?: string;
  beforeSize?: number;
  afterSize?: number;
}

export interface WorkspaceDiff {
  baseGenerationId: GenerationId;
  changes: FileChange[];
  addedCount: number;
  modifiedCount: number;
  deletedCount: number;
  isEmpty: boolean;
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

export interface VerificationRequest {
  workspacePath: string;
  command: string;
  /** Container names must be unique per concurrent verification. Agents run
   *  concurrently (the busy guard is per-Agent), so a name keyed only on the
   *  instance id collides and Docker rejects the second one. */
  agentId: string;
  runId: string;
}

export interface VerificationResult {
  passed: boolean;
  output: string;
  exitCode: number | null;
}

export interface VerificationRunner {
  run(request: VerificationRequest): Promise<VerificationResult>;
}
