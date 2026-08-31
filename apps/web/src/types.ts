export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  activeGenerationId: string;
  activeReleaseId: string;
  candidateReleaseId: string | null;
  policy: GatePolicy;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GatePolicy { protectedPaths: string[]; verificationCommand: string; changeBudget: number; policyHash: string; }
export interface AgentRelease { id: string; agentId: string; version: number; name: string; description: string; instructions: string; releaseHash: string; status: "active" | "candidate" | "retired"; parentReleaseId: string | null; createdAt: string; }
export interface FileChange { path: string; kind: "added" | "modified" | "deleted"; }
export interface ValidationRecord { id: string; status: "running" | "certified" | "blocked" | "baseline_unhealthy" | "review_required" | "failed"; task: string; candidateReleaseId: string; baselineDiff: { changes: FileChange[] }; candidateDiff: { changes: FileChange[] }; baselineGateFailures: { code: string; reason: string }[]; candidateGateFailures: { code: string; reason: string }[]; differentialDeletions: string[]; context: { contextHash: string }; error: string | null; reviewAcknowledgement: { actor: string; reason: string; acknowledgedAt: string } | null; promotionAudit: { actor: string; reason: string; promotedAt: string } | null; }

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
  gateFailures?: { code: string; reason: string }[] | null;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
