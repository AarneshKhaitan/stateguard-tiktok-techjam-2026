export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type GenerationId = string;

export interface GatePolicy {
  protectedPaths: string[];
  verificationCommand: string;
  changeBudget: number;
  policyHash: string;
}

export interface GateFailure {
  code: "PROTECTED_PATH" | "CHANGE_BUDGET" | "VERIFICATION" | "RUNTIME";
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
  policy: GatePolicy;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
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
  version: 3;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
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
