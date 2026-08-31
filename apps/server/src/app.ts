import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const policyBody = z.object({
  protectedPaths: z.array(z.string().max(500)).max(100),
  verificationCommand: z.string().trim().min(1).max(2_000),
  changeBudget: z.number().int().min(0).max(100_000),
});
const validationBody = z.object({ task: z.string().trim().min(1).max(50_000) });
const reviewBody = z.object({ actor: z.string().trim().min(1).max(120), reason: z.string().trim().min(1).max(2_000) });

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.get("/api/worlds/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { world: service.getWorld(id) };
  });

  app.post("/api/agents/:id/world", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = z.object({ worldId: z.string().uuid() }).parse(request.body);
    return { agent: await service.attachAgentToWorld(id, body.worldId) };
  });

  app.get("/api/agents/:id/releases", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { releases: service.getReleases(id) };
  });

  app.patch("/api/agents/:id/policy", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.updatePolicy(id, policyBody.parse(request.body)) };
  });

  app.get("/api/agents/:id/validations", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { validations: service.getValidations(id) };
  });

  app.post("/api/agents/:id/validations", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    return reply.code(202).send({ validation: await service.validateCandidate(id, validationBody.parse(request.body).task) });
  });

  app.get("/api/validations/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { validation: service.getValidation(id) };
  });

  app.post("/api/validations/:id/acknowledge", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const body = reviewBody.parse(request.body);
    return { validation: await service.acknowledgeValidation(id, body.actor, body.reason) };
  });

  app.post("/api/validations/:id/bisect", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const body = z.object({ path: z.string().trim().min(1).max(2_000) }).parse(request.body);
    return { bisection: await service.bisectValidation(id, body.path) };
  });

  app.post("/api/agents/:id/promote", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = z.object({ validationId: z.string().uuid().optional(), actor: z.string().trim().max(120).optional(), reason: z.string().trim().max(2_000).optional() }).parse(request.body ?? {});
    return { agent: await service.promote(id, body.validationId, body.actor, body.reason) };
  });

  // A detected tamper is a successful verification, not a server fault. Returning 500
  // would read as "the app crashed" when in fact the mechanism did its job.
  app.get("/api/ledger/verify", async () => {
    try {
      await service.verifyLedger();
      return { valid: true, reason: null };
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/fork", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = z.object({ generationId: z.string().regex(/^gen_\d{4}$/).optional(), name: z.string().trim().min(1).max(80).optional() }).parse(request.body ?? {});
    return { agent: await service.forkAgent(id, body.generationId, body.name) };
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
