import type { Agent, AgentRelease, AgentRun, Message, SystemInfo, ValidationRecord } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    // Fastify puts the generic status name in `error` ("Conflict") and the actual
    // explanation in `message`. Preferring `error` threw away every reason the
    // backend takes care to state — a refused promotion showed only "Conflict"
    // instead of naming which context field drifted and from what to what.
    throw new ApiError(data.message ?? data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
  }),
  forkAgent: (id: string, generationId?: string, name?: string) => request<{ agent: Agent }>("/api/agents/" + id + "/fork", { method: "POST", body: JSON.stringify({ generationId, name }) }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
  ),
  releases: (id: string) => request<{ releases: AgentRelease[] }>("/api/agents/" + id + "/releases"),
  updatePolicy: (id: string, body: { protectedPaths: string[]; verificationCommand: string; changeBudget: number }) => request<{ agent: Agent }>("/api/agents/" + id + "/policy", { method: "PATCH", body: JSON.stringify(body) }),
  validate: (id: string, task: string) => request<{ validation: ValidationRecord }>("/api/agents/" + id + "/validations", { method: "POST", body: JSON.stringify({ task }) }),
  validations: (id: string) => request<{ validations: ValidationRecord[] }>("/api/agents/" + id + "/validations"),
  validation: (id: string) => request<{ validation: ValidationRecord }>("/api/validations/" + id),
  promote: (id: string, validationId: string) => request<{ agent: Agent }>("/api/agents/" + id + "/promote", { method: "POST", body: JSON.stringify({ validationId }) }),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
};
